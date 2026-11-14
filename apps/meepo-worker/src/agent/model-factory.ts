import type { ModelConfig, ReasoningEffort } from '@meepo/protocol';
import type { Model } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import type { StreamFn } from '@earendil-works/pi-agent-core';

/**
 * Build the pi-ai model literal for a space's OpenAI-completions-compatible
 * endpoint. The apiKey is deliberately not stored on the model — it is passed
 * per request via the stream function (see {@link createStreamFn}). Limits and
 * reasoning support come from the server-supplied ModelConfig, never from a
 * local guess by model name.
 */
export function createModel(config: ModelConfig): Model<'openai-completions'> {
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoningEfforts.length > 0,
    input: config.imageInput ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat: { supportsDeveloperRole: false },
  };
}

/**
 * Bind a ModelConfig to a pi StreamFn that calls the openai-completions
 * `stream` directly, injecting the apiKey and thinking effort per request.
 */
export function createStreamFn(config: ModelConfig): StreamFn {
  const effort = effectiveEffort(config);
  return (model, context, options) =>
    stream(model as Model<'openai-completions'>, context, {
      ...options,
      apiKey: config.apiKey,
      reasoningEffort: effort,
    });
}

/**
 * The requested thinking level when the model supports it. The worker's global default level is
 * merged into `thinkingLevel` after the server has filtered it, so it may name a strength this
 * model does not offer.
 */
export function supportedLevel(config: ModelConfig): ReasoningEffort | undefined {
  const wanted = config.thinkingLevel;
  return wanted && config.reasoningEfforts.includes(wanted) ? wanted : undefined;
}

/** The strength a turn requests: none for a non-reasoning model, else the supported level or the default. */
export function effectiveEffort(config: ModelConfig): ReasoningEffort | undefined {
  if (config.reasoningEfforts.length === 0) return undefined;
  return supportedLevel(config) ?? config.defaultEffort;
}
