import type { ModelConfig } from '@meepo/protocol';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { StreamFn } from '@earendil-works/pi-agent-core';

/**
 * Build the pi-ai model literal for a space's OpenAI-completions-compatible
 * endpoint. The apiKey is deliberately not stored on the model — it is passed
 * per request via the stream function (see {@link createStreamFn}).
 */
export function createModel(config: ModelConfig): Model<'openai-completions'> {
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 128_000,
    compat: { supportsDeveloperRole: false },
  };
}

/**
 * Bind a ModelConfig to a pi StreamFn that calls the openai-completions
 * streamSimple directly, injecting the apiKey on every request.
 */
export function createStreamFn(config: ModelConfig): StreamFn {
  return (model, context, options) =>
    streamSimple(model as Model<'openai-completions'>, context, {
      ...options,
      apiKey: config.apiKey,
    });
}
