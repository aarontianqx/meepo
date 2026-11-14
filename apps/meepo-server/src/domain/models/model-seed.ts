import { suggestCapabilities } from './model-capabilities.js';
import type { ModelEntry, ModelRegistry, Provider } from './model-registry.js';

/** One seeded model in the flat shape that carries its own credentials (environment variables). */
export interface ModelSeedEntry {
  id: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  imageInput?: boolean;
}

/** The flat seed shape: no providers, every entry repeats its endpoint and key. */
export interface ModelSeed {
  entries: ModelSeedEntry[];
  defaultModelId?: string;
}

/**
 * Builds the Provider -> Model registry from flat seed entries. Entries sharing
 * `(baseUrl, apiKey, provider)` share one Provider; `provider` is part of the key because it
 * changes request behavior, so each seeded model resolves to the endpoint and key it declared.
 */
export function registryFromSeed(seed: ModelSeed): ModelRegistry {
  const providers: Provider[] = [];
  const providerIdByGroup = new Map<string, string>();
  const entries: ModelEntry[] = seed.entries.map((entry) => {
    const group = JSON.stringify([entry.baseUrl, entry.apiKey, entry.provider]);
    let providerId = providerIdByGroup.get(group);
    if (!providerId) {
      const name = uniqueName(providers, hostOf(entry.baseUrl));
      providerId = uniqueId(providers, slug(name));
      providers.push({
        id: providerId,
        name,
        kind: entry.provider,
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey,
      });
      providerIdByGroup.set(group, providerId);
    }
    return {
      id: entry.id,
      providerId,
      model: entry.model,
      ...suggestCapabilities(entry.model),
      // An explicit flag in the seed entry wins over the name-based suggestion.
      ...(entry.imageInput === undefined ? {} : { imageInput: entry.imageInput }),
    };
  });
  return { providers, entries, defaultModelId: seed.defaultModelId };
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    // Env-supplied text may not be a URL; keep it recognizable instead of failing the upgrade.
    return baseUrl;
  }
}

function uniqueName(taken: Provider[], base: string): string {
  let name = base;
  for (let n = 2; taken.some((p) => p.name === name); n++) name = `${base} (${n})`;
  return name;
}

function uniqueId(taken: Provider[], base: string): string {
  let id = base;
  for (let n = 2; taken.some((p) => p.id === id); n++) id = `${base}-${n}`;
  return id;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'provider'
  );
}
