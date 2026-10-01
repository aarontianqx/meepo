import type { ModelConfig } from '@meepo/protocol';
/** One globally available model: credentials plus the wire-protocol discriminator. */
export interface ModelEntry {
  imageInput?: boolean;
  id: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Registry of globally available models, resolved from server config. */
export interface ModelRegistry {
  entries: ModelEntry[];
  defaultModelId?: string;
}

/** Resolves a registry entry to a full ModelConfig (with optional effort override). */
export function resolveModel(
  registry: ModelRegistry,
  modelId: string,
  thinkingLevel?: ModelConfig['thinkingLevel']
): ModelConfig | undefined {
  const entry = registry.entries.find((e) => e.id === modelId);
  if (!entry) return undefined;
  return {
    imageInput: entry.imageInput,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    model: entry.model,
    thinkingLevel,
  };
}
