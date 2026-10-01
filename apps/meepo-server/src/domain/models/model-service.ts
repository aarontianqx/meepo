import { conflict, validation } from '../errors.js';
import type { ModelEntry, ModelRegistry } from './model-registry.js';
export interface ModelRepository {
  load(): ModelRegistry | undefined;
  save(registry: ModelRegistry): void;
}
export class ModelService {
  constructor(
    readonly registry: ModelRegistry,
    private readonly repo: ModelRepository
  ) {
    const stored = repo.load();
    if (stored) {
      registry.entries = stored.entries;
      registry.defaultModelId = stored.defaultModelId;
    } else repo.save(registry);
  }
  list() {
    return this.registry.entries.map(({ apiKey: _key, ...m }) => ({
      ...m,
      hasApiKey: true,
      isDefault: m.id === this.registry.defaultModelId,
    }));
  }
  put(
    input: Omit<ModelEntry, 'apiKey' | 'imageInput'> & {
      apiKey?: string;
      isDefault?: boolean;
      imageInput?: boolean | null;
    }
  ) {
    if (
      input.imageInput !== undefined &&
      input.imageInput !== null &&
      typeof input.imageInput !== 'boolean'
    )
      throw validation('imageInput must be boolean or null');
    for (const field of ['id', 'provider', 'model', 'baseUrl'] as const)
      if (typeof input[field] !== 'string' || !input[field].trim())
        throw validation(`${field} must be a nonempty string`);
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string')
      throw validation('apiKey must be a string');
    const previous = this.registry.entries.find((e) => e.id === input.id);
    const key = input.apiKey || previous?.apiKey;
    if (!input.id || !input.provider || !input.model || !key)
      throw validation('Model id, provider, model and API key are required');
    try {
      const url = new URL(input.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
    } catch {
      throw validation('Invalid model base URL');
    }
    const entry: ModelEntry = {
      imageInput:
        input.imageInput === null ? undefined : (input.imageInput ?? previous?.imageInput),
      id: input.id,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      apiKey: key,
    };
    const next = {
      entries: [...this.registry.entries.filter((e) => e.id !== entry.id), entry],
      defaultModelId:
        input.isDefault || !this.registry.defaultModelId ? entry.id : this.registry.defaultModelId,
    };
    this.repo.save(next);
    Object.assign(this.registry, next);
    return this.list().find((e) => e.id === entry.id);
  }
  delete(id: string) {
    if (this.registry.defaultModelId === id)
      throw conflict('Select another default before deleting this model');
    const next = { ...this.registry, entries: this.registry.entries.filter((e) => e.id !== id) };
    this.repo.save(next);
    Object.assign(this.registry, next);
  }
}
