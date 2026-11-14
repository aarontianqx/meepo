import type { ModelConfig } from '@meepo/protocol';

import type { ModelCapabilities } from './model-capabilities.js';

/** One upstream service: credentials shared by every model hosted there. */
export interface Provider {
  id: string;
  /** Display name only. */
  name: string;
  /** Client-compatibility identifier handed to workers as `ModelConfig.provider`; it changes request behavior. */
  kind: string;
  baseUrl: string;
  apiKey: string;
}

/** One globally available model; Spaces reference it by `id`. */
export interface ModelEntry extends ModelCapabilities {
  id: string;
  providerId: string;
  /** Upstream model name. */
  model: string;
}

/** Registry of globally available providers and models, resolved from server config. */
export interface ModelRegistry {
  providers: Provider[];
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
  const provider = registry.providers.find((p) => p.id === entry?.providerId);
  if (!entry || !provider) return undefined;
  return {
    imageInput: entry.imageInput,
    provider: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: entry.model,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    reasoningEfforts: entry.reasoningEfforts,
    defaultEffort: entry.defaultEffort,
    // A strength the model does not support is dropped so the worker uses the model's default.
    thinkingLevel:
      thinkingLevel && entry.reasoningEfforts.includes(thinkingLevel) ? thinkingLevel : undefined,
  };
}
