import { describe, expect, it } from 'vitest';

import { registryFromSeed, type ModelSeedEntry, type ModelSeed } from '../model-seed.js';
import { resolveModel } from '../model-registry.js';

const seed = (over: Partial<ModelSeedEntry> & Pick<ModelSeedEntry, 'id'>): ModelSeedEntry => ({
  provider: 'openai-completions',
  baseUrl: 'https://api.moonshot.cn/v1',
  apiKey: 'key-a',
  model: over.id,
  ...over,
});

/** What a seed entry declares: its endpoint and key, and its explicit image flag if any. */
function declared(registry: ModelSeed, id: string) {
  const e = registry.entries.find((x) => x.id === id)!;
  return {
    // An omitted flag takes the model-name suggestion.
    imageInput: e.imageInput ?? e.model.startsWith('kimi-k'),
    provider: e.provider,
    baseUrl: e.baseUrl,
    apiKey: e.apiKey,
    model: e.model,
  };
}

/** The same fields taken from the built registry's resolution. */
function routingOf(config: NonNullable<ReturnType<typeof resolveModel>>) {
  const { imageInput, provider, baseUrl, apiKey, model } = config;
  return { imageInput, provider, baseUrl, apiKey, model };
}

describe('registryFromSeed', () => {
  it('groups entries by (baseUrl, apiKey, provider) and keeps ids and the default', () => {
    const seeded: ModelSeed = {
      entries: [
        seed({ id: 'k2' }),
        seed({ id: 'k3', imageInput: true }),
        seed({
          id: 'gpt',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'key-b',
          provider: 'openai',
        }),
      ],
      defaultModelId: 'k3',
    };
    const next = registryFromSeed(seeded);
    expect(next.providers).toHaveLength(2);
    expect(next.entries.map((e) => e.id)).toEqual(['k2', 'k3', 'gpt']);
    expect(next.entries[0].providerId).toBe(next.entries[1].providerId);
    expect(next.entries[2].providerId).not.toBe(next.entries[0].providerId);
    expect(next.defaultModelId).toBe('k3');
    expect(next.providers[0]).toMatchObject({
      name: 'api.moonshot.cn',
      kind: 'openai-completions',
    });
  });

  it('does not merge entries that differ in provider, key or base URL', () => {
    const next = registryFromSeed({
      entries: [
        seed({ id: 'a' }),
        seed({ id: 'b', provider: 'moonshotai' }),
        seed({ id: 'c', apiKey: 'key-b' }),
        seed({ id: 'd', baseUrl: 'https://api.moonshot.cn/other' }),
      ],
    });
    expect(new Set(next.entries.map((e) => e.providerId)).size).toBe(4);
    expect(new Set(next.providers.map((p) => p.name)).size).toBe(4);
    expect(new Set(next.providers.map((p) => p.id)).size).toBe(4);
  });

  it('resolves every seeded model id to the endpoint, key and image flag the seed declared', () => {
    const seeded: ModelSeed = {
      entries: [
        seed({ id: 'k2' }),
        seed({ id: 'k3', imageInput: true }),
        seed({
          id: 'gpt',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'key-b',
          provider: 'openai',
        }),
        seed({ id: 'odd', baseUrl: 'not a url', apiKey: 'key-c' }),
      ],
      defaultModelId: 'k2',
    };
    const next = registryFromSeed(seeded);
    for (const { id } of seeded.entries) {
      expect(JSON.stringify(routingOf(resolveModel(next, id)!))).toBe(
        JSON.stringify(declared(seeded, id))
      );
    }
  });

  it('stores suggested capabilities on every seeded entry', () => {
    const next = registryFromSeed({
      entries: [seed({ id: 'k3', model: 'kimi-k3' }), seed({ id: 'other', model: 'qwen3-max' })],
    });
    expect(next.entries[0]).toMatchObject({ contextWindow: 1_048_576, defaultEffort: 'max' });
    expect(next.entries[1]).toMatchObject({
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoningEfforts: [],
    });
  });
});
