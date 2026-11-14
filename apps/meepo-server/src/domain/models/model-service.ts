import { conflict, notFound, validation } from '../errors.js';
import { completeCapabilities, type ModelCapabilities } from './model-capabilities.js';
import type { ModelEntry, ModelRegistry, Provider } from './model-registry.js';

export interface ModelRepository {
  load(): ModelRegistry | undefined;
  save(registry: ModelRegistry): void;
}

/** Consumer-defined port: how many Spaces explicitly select a model. */
export interface ModelUsage {
  countSpacesUsing(modelId: string): Promise<number>;
}

/** Provider as shown to administrators: never carries the key. */
export interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: true;
  modelCount: number;
}

/** Model as shown to any signed-in user (selector) and to administrators: no credentials, no URL. */
export interface ModelView extends ModelCapabilities {
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  isDefault: boolean;
}

export interface ProviderInput {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  /** Empty or absent keeps the stored key. */
  apiKey?: string;
}

/** Omitted capability fields keep the stored values, or take the suggestion for a new model. */
export interface ModelInput extends Partial<ModelCapabilities> {
  id: string;
  providerId: string;
  model: string;
  isDefault?: boolean;
}

export class ModelService {
  constructor(
    readonly registry: ModelRegistry,
    private readonly repo: ModelRepository,
    private readonly usage: ModelUsage
  ) {
    const stored = repo.load();
    if (stored) {
      registry.providers = stored.providers;
      registry.entries = stored.entries;
      registry.defaultModelId = stored.defaultModelId;
    } else repo.save(registry);
  }

  listProviders(): ProviderView[] {
    return this.registry.providers.map(({ apiKey: _key, ...p }) => ({
      ...p,
      hasApiKey: true,
      modelCount: this.registry.entries.filter((e) => e.providerId === p.id).length,
    }));
  }

  listModels(): ModelView[] {
    const names = new Map(this.registry.providers.map((p) => [p.id, p.name]));
    return this.registry.entries.map((e) => ({
      ...e,
      // Invariant: putProvider/deleteProvider keep every entry's providerId resolvable.
      providerName: names.get(e.providerId)!,
      isDefault: e.id === this.registry.defaultModelId,
    }));
  }

  putProvider(input: ProviderInput): ProviderView {
    requireText(input, ['id', 'name', 'kind', 'baseUrl']);
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string')
      throw validation('apiKey must be a string');
    const previous = this.registry.providers.find((p) => p.id === input.id);
    const apiKey = input.apiKey || previous?.apiKey;
    if (!apiKey) throw validation('API key is required for a new provider');
    requireHttpUrl(input.baseUrl);
    if (this.registry.providers.some((p) => p.id !== input.id && p.name === input.name))
      throw conflict(`Provider name already in use: ${input.name}`);
    const provider: Provider = {
      id: input.id,
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      apiKey,
    };
    this.commit({
      ...this.registry,
      providers: upsertById(this.registry.providers, provider),
    });
    return this.listProviders().find((p) => p.id === provider.id)!;
  }

  deleteProvider(id: string): void {
    if (!this.registry.providers.some((p) => p.id === id)) throw notFound(`Provider ${id}`);
    const models = this.registry.entries.filter((e) => e.providerId === id).length;
    if (models > 0) throw conflict(`Provider still has ${models} model(s); delete them first`);
    this.commit({
      ...this.registry,
      providers: this.registry.providers.filter((p) => p.id !== id),
    });
  }

  putModel(input: ModelInput): ModelView {
    requireText(input, ['id', 'providerId', 'model']);
    if (!this.registry.providers.some((p) => p.id === input.providerId))
      throw validation(`Unknown provider: ${input.providerId}`);
    const previous = this.registry.entries.find((e) => e.id === input.id);
    const entry: ModelEntry = {
      id: input.id,
      providerId: input.providerId,
      model: input.model,
      ...completeCapabilities(input.model, input, previous),
    };
    this.commit({
      ...this.registry,
      entries: upsertById(this.registry.entries, entry),
      defaultModelId:
        input.isDefault || !this.registry.defaultModelId ? entry.id : this.registry.defaultModelId,
    });
    return this.listModels().find((m) => m.id === entry.id)!;
  }

  async deleteModel(id: string): Promise<void> {
    if (!this.registry.entries.some((e) => e.id === id)) throw notFound(`Model ${id}`);
    // The last model may go even though it is the default; otherwise the model and its provider
    // could never be removed.
    const wasDefault = this.registry.defaultModelId === id;
    if (wasDefault && this.registry.entries.length > 1)
      throw conflict('Select another default before deleting this model');
    const spaces = await this.usage.countSpacesUsing(id);
    if (spaces > 0) throw conflict(`Model is selected by ${spaces} space(s)`);
    this.commit({
      ...this.registry,
      entries: this.registry.entries.filter((e) => e.id !== id),
      defaultModelId: wasDefault ? undefined : this.registry.defaultModelId,
    });
  }

  private commit(next: ModelRegistry): void {
    this.repo.save(next);
    Object.assign(this.registry, next);
  }
}

// HTTP request bodies are the trust boundary here: fields arrive as untyped JSON.
function requireText<T extends object>(input: T, fields: (keyof T & string)[]): void {
  for (const field of fields) {
    const value: unknown = input[field];
    if (typeof value !== 'string' || !value.trim())
      throw validation(`${field} must be a nonempty string`);
  }
}

function requireHttpUrl(baseUrl: string): void {
  try {
    if (!['https:', 'http:'].includes(new URL(baseUrl).protocol)) throw new Error();
  } catch {
    throw validation('Invalid provider base URL');
  }
}

/** Replaces the item with the same id in place (so lists keep their order) or appends it. */
function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((i) => i.id === item.id)
    ? items.map((i) => (i.id === item.id ? item : i))
    : [...items, item];
}
