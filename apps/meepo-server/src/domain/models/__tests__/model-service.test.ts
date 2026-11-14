import { beforeEach, describe, expect, it } from 'vitest';

import { resolveModel, type ModelRegistry } from '../model-registry.js';
import { ModelService, type ModelRepository, type ModelUsage } from '../model-service.js';

class MemoryModelRepository implements ModelRepository {
  saved?: ModelRegistry;
  load(): ModelRegistry | undefined {
    return undefined;
  }
  save(registry: ModelRegistry): void {
    this.saved = structuredClone(registry);
  }
}

describe('ModelService', () => {
  let repo: MemoryModelRepository;
  let usage: Map<string, number>;
  let service: ModelService;
  const provider = { id: 'moonshot', name: 'Moonshot', kind: 'openai-completions' };
  const key = 'sk-secret-value';

  beforeEach(() => {
    repo = new MemoryModelRepository();
    usage = new Map();
    const port: ModelUsage = { countSpacesUsing: async (id) => usage.get(id) ?? 0 };
    service = new ModelService({ providers: [], entries: [] }, repo, port);
    service.putProvider({ ...provider, baseUrl: 'https://api.moonshot.cn/v1', apiKey: key });
  });

  it('keeps the stored key when an upsert leaves apiKey empty, and never lists it', () => {
    service.putProvider({
      ...provider,
      name: 'Moonshot CN',
      baseUrl: 'https://api.moonshot.cn/v1',
    });
    expect(repo.saved!.providers[0]).toMatchObject({ name: 'Moonshot CN', apiKey: key });
    expect(JSON.stringify(service.listProviders())).not.toContain(key);
    expect(service.listProviders()[0]).toMatchObject({ hasApiKey: true, modelCount: 0 });
  });

  it('requires a key for a new provider and rejects bad URLs and duplicate names', () => {
    const base = { id: 'p2', name: 'Other', kind: 'openai', baseUrl: 'https://x.test' };
    expect(() => service.putProvider(base)).toThrow(/API key/);
    expect(() => service.putProvider({ ...base, apiKey: 'k', baseUrl: 'ftp://x' })).toThrow(/URL/);
    expect(() => service.putProvider({ ...base, apiKey: 'k', name: 'Moonshot' })).toThrow(/in use/);
  });

  it('adds models under a provider and resolves them through the provider kind', () => {
    service.putModel({ id: 'k3', providerId: 'moonshot', model: 'kimi-k3', imageInput: true });
    expect(service.listModels()).toEqual([
      expect.objectContaining({ id: 'k3', providerName: 'Moonshot', isDefault: true }),
    ]);
    expect(resolveModel(service.registry, 'k3', 'high')).toEqual({
      imageInput: true,
      provider: 'openai-completions',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: key,
      model: 'kimi-k3',
      contextWindow: 1_048_576,
      maxTokens: 128_000,
      reasoningEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      thinkingLevel: 'high',
    });
    // A strength the model does not support is dropped; a non-reasoning model never keeps one.
    service.putModel({ id: 'plain', providerId: 'moonshot', model: 'qwen3-max' });
    expect(resolveModel(service.registry, 'plain', 'high')?.thinkingLevel).toBeUndefined();
    service.putModel({
      id: 'k3',
      providerId: 'moonshot',
      model: 'kimi-k3',
      reasoningEfforts: ['low'],
    });
    expect(resolveModel(service.registry, 'k3', 'max')?.thinkingLevel).toBeUndefined();
    expect(() => service.putModel({ id: 'x', providerId: 'nope', model: 'm' })).toThrow(/provider/);
  });

  it('keeps list order when a provider or model is edited', () => {
    service.putProvider({
      id: 'b',
      name: 'B',
      kind: 'openai',
      baseUrl: 'https://b.test',
      apiKey: 'k',
    });
    service.putModel({ id: 'm1', providerId: 'moonshot', model: 'm1' });
    service.putModel({ id: 'm2', providerId: 'moonshot', model: 'm2' });
    service.putProvider({ ...provider, name: 'Moonshot 2', baseUrl: 'https://api.moonshot.cn/v1' });
    service.putModel({ id: 'm1', providerId: 'moonshot', model: 'm1-renamed' });
    expect(service.listProviders().map((p) => p.id)).toEqual(['moonshot', 'b']);
    expect(service.listModels().map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('stores capabilities on the entry: suggested when new, kept on update, explicit when given', () => {
    service.putModel({ id: 'k3', providerId: 'moonshot', model: 'kimi-k3' });
    service.putModel({ id: 'q', providerId: 'moonshot', model: 'qwen3-max' });
    const stored = (id: string) => service.registry.entries.find((e) => e.id === id)!;
    expect(stored('k3')).toMatchObject({ contextWindow: 1_048_576, defaultEffort: 'max' });
    expect(stored('q')).toMatchObject({ contextWindow: 128_000, reasoningEfforts: [] });
    service.putModel({
      id: 'q',
      providerId: 'moonshot',
      model: 'qwen3-max',
      contextWindow: 65_536,
    });
    service.putModel({ id: 'q', providerId: 'moonshot', model: 'qwen3-max', imageInput: true });
    expect(stored('q')).toMatchObject({
      contextWindow: 65_536,
      maxTokens: 16_384,
      imageInput: true,
    });
    expect(service.listModels().find((m) => m.id === 'q')).toMatchObject({ contextWindow: 65_536 });
    expect(() =>
      service.putModel({ id: 'q', providerId: 'moonshot', model: 'qwen3-max', maxTokens: 65_536 })
    ).toThrow(/below contextWindow/);
  });

  it('rotating a provider key changes every model that uses it', () => {
    service.putModel({ id: 'a', providerId: 'moonshot', model: 'a' });
    service.putModel({ id: 'b', providerId: 'moonshot', model: 'b' });
    service.putProvider({ ...provider, baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'rotated' });
    expect(resolveModel(service.registry, 'a')?.apiKey).toBe('rotated');
    expect(resolveModel(service.registry, 'b')?.apiKey).toBe('rotated');
  });

  it('refuses to delete a provider that still has models', () => {
    service.putModel({ id: 'a', providerId: 'moonshot', model: 'a' });
    expect(() => service.deleteProvider('moonshot')).toThrow(/still has 1 model/);
    expect(() => service.deleteProvider('missing')).toThrow(/Provider missing/);
  });

  it('refuses to delete the default model or a model a space selects', async () => {
    service.putModel({ id: 'a', providerId: 'moonshot', model: 'a' });
    service.putModel({ id: 'b', providerId: 'moonshot', model: 'b' });
    await expect(service.deleteModel('a')).rejects.toThrow(/default/);
    usage.set('b', 2);
    await expect(service.deleteModel('b')).rejects.toThrow(/2 space/);
    usage.delete('b');
    await service.deleteModel('b');
    expect(service.listModels().map((m) => m.id)).toEqual(['a']);
  });

  it('lets the last model go and clears the default so its provider can be removed too', async () => {
    service.putModel({ id: 'only', providerId: 'moonshot', model: 'only' });
    expect(service.registry.defaultModelId).toBe('only');
    usage.set('only', 1);
    await expect(service.deleteModel('only')).rejects.toThrow(/1 space/);
    usage.delete('only');
    await service.deleteModel('only');
    expect(service.registry.defaultModelId).toBeUndefined();
    service.deleteProvider('moonshot');
    expect(service.listProviders()).toEqual([]);
  });

  it('reports an unknown model id instead of silently succeeding', async () => {
    await expect(service.deleteModel('missing')).rejects.toThrow(/Model missing/);
  });
});
