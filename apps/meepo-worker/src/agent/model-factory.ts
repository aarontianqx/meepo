import type { ModelConfig } from '@meepo/protocol';
import type { Model } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import type { StreamFn } from '@earendil-works/pi-agent-core';

export interface ModelCapabilities {
  contextWindow: number;
  maxTokens: number;
  supportedEfforts: ('low' | 'high' | 'max')[];
  defaultEffort: 'low' | 'high' | 'max';
}

const K3_DEFAULTS: ModelCapabilities = {
  contextWindow: 1_048_576,
  maxTokens: 128_000,
  supportedEfforts: ['low', 'high', 'max'],
  defaultEffort: 'max',
};

/** Hardcoded capability table for the models we run (from ~/.kimi-code/config.toml). */
export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'kimi-k2.8-0825': K3_DEFAULTS,
  'kimi-k3': K3_DEFAULTS,
  'kimi-k3-0829': K3_DEFAULTS,
  'kimi-k3-highspeed': K3_DEFAULTS,
  'kimi-k3-highspeed-2x': K3_DEFAULTS,
  'kimi-k3-0829-highspeed': K3_DEFAULTS,
  'gpt-5.6-luna': {
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    supportedEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  'gpt-5.6-sol': {
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    supportedEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
};

function capabilitiesOf(modelId: string): ModelCapabilities {
  return MODEL_CAPABILITIES[modelId] ?? K3_DEFAULTS;
}

/**
 * Build the pi-ai model literal for a space's OpenAI-completions-compatible
 * endpoint. The apiKey is deliberately not stored on the model — it is passed
 * per request via the stream function (see {@link createStreamFn}).
 */
export function createModel(config: ModelConfig): Model<'openai-completions'> {
  const capabilities = capabilitiesOf(config.model);
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: capabilities.contextWindow,
    maxTokens: capabilities.maxTokens,
    compat: { supportsDeveloperRole: false },
  };
}

/**
 * Bind a ModelConfig to a pi StreamFn that calls the openai-completions
 * streamSimple directly, injecting the apiKey and thinking effort per request.
 */
export function createStreamFn(config: ModelConfig): StreamFn {
  const capabilities = capabilitiesOf(config.model);
  const effort = config.thinkingLevel ?? capabilities.defaultEffort;
  return (model, context, options) =>
    stream(model as Model<'openai-completions'>, context, {
      ...options,
      apiKey: config.apiKey,
      reasoningEffort: effort,
    });
}
