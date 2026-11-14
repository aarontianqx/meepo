import { MIN_CONTEXT_WINDOW, REASONING_EFFORTS, type ReasoningEffort } from '@meepo/protocol';

import { validation } from '../errors.js';

/** What a model can do; stored explicitly on every ModelEntry and handed to workers as-is. */
export interface ModelCapabilities {
  contextWindow: number;
  maxTokens: number;
  /** Supported thinking strengths; empty for a non-reasoning model. */
  reasoningEfforts: ReasoningEffort[];
  /** Present exactly when `reasoningEfforts` is not empty. */
  defaultEffort?: ReasoningEffort;
  /** Whether the model accepts image content parts. */
  imageInput: boolean;
}

/**
 * Suggested capabilities for an upstream model name. Used once, when an entry is written; the
 * stored values are authoritative afterwards. Unknown names get a conservative profile so a wrong
 * guess compacts early instead of exceeding the real window.
 */
export function suggestCapabilities(model: string): ModelCapabilities {
  if (model.startsWith('kimi-k'))
    return {
      contextWindow: 1_048_576,
      maxTokens: 128_000,
      reasoningEfforts: [...REASONING_EFFORTS],
      defaultEffort: 'max',
      imageInput: true,
    };
  if (model.startsWith('gpt-5.6'))
    return {
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      reasoningEfforts: [...REASONING_EFFORTS],
      defaultEffort: 'high',
      imageInput: true,
    };
  return { contextWindow: 128_000, maxTokens: 16_384, reasoningEfforts: [], imageInput: false };
}

/**
 * Completes and validates capabilities for an entry write. Omitted fields keep `previous` when the
 * entry exists and take the suggestion for the model name otherwise.
 */
export function completeCapabilities(
  model: string,
  input: Partial<ModelCapabilities>,
  previous?: ModelCapabilities
): ModelCapabilities {
  const base = previous ?? suggestCapabilities(model);
  const contextWindow = input.contextWindow ?? base.contextWindow;
  const maxTokens = input.maxTokens ?? base.maxTokens;
  const reasoningEfforts = input.reasoningEfforts ?? base.reasoningEfforts;
  const imageInput = input.imageInput ?? base.imageInput;
  // HTTP request bodies are the trust boundary: fields arrive as untyped JSON.
  if (typeof imageInput !== 'boolean') throw validation('imageInput must be a boolean');
  if (!Number.isInteger(contextWindow) || contextWindow < MIN_CONTEXT_WINDOW)
    throw validation(`contextWindow must be an integer of at least ${MIN_CONTEXT_WINDOW}`);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0)
    throw validation('maxTokens must be a positive integer');
  if (maxTokens >= contextWindow) throw validation('maxTokens must be below contextWindow');
  if (
    !Array.isArray(reasoningEfforts) ||
    reasoningEfforts.some((e) => !REASONING_EFFORTS.includes(e)) ||
    new Set(reasoningEfforts).size !== reasoningEfforts.length
  )
    throw validation('reasoningEfforts must be a unique subset of low, high, max');
  if (reasoningEfforts.length === 0) {
    if (input.defaultEffort !== undefined)
      throw validation('defaultEffort requires a reasoning model');
    return { contextWindow, maxTokens, reasoningEfforts, imageInput };
  }
  const defaultEffort = input.defaultEffort ?? pickDefault(reasoningEfforts, base.defaultEffort);
  if (!reasoningEfforts.includes(defaultEffort))
    throw validation('defaultEffort must be one of reasoningEfforts');
  return { contextWindow, maxTokens, reasoningEfforts, defaultEffort, imageInput };
}

function pickDefault(
  efforts: ReasoningEffort[],
  preferred: ReasoningEffort | undefined
): ReasoningEffort {
  return preferred && efforts.includes(preferred) ? preferred : efforts[efforts.length - 1];
}
