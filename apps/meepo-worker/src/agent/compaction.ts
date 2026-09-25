import {
  BACKGROUND_CONTEXT,
  estimateContextTokens,
  estimateTokens,
  generateSummary,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
} from '@earendil-works/pi-agent-core';
import { createModels, createProvider, type Models } from '@earendil-works/pi-ai';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { ModelConfig } from '@meepo/protocol';

import { createModel } from './model-factory.js';
import type { SessionCompactor } from './session-runner.js';

/** Compact when estimated context exceeds 80% of the model's context window. */
const THRESHOLD_RATIO = 0.8;
/** Approximate recent-context tokens retained after compaction. */
const KEEP_RECENT_RATIO = 0.2;

/** Walk back from the newest message, keeping approximately `tokenBudget` tokens (at least one). */
export function keepRecentByTokens(messages: AgentMessage[], tokenBudget: number): AgentMessage[] {
  const kept: AgentMessage[] = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const messageTokens = estimateTokens(messages[i]);
    if (kept.length > 0 && tokens + messageTokens > tokenBudget) break;
    kept.unshift(messages[i]);
    tokens += messageTokens;
  }
  return kept;
}

/**
 * Build the pi-ai `Models` collection for a space model config, used only by
 * the compaction summarizer (which resolves auth through `Models`, unlike the
 * agent's direct stream function). The apiKey resolves from the envelope, per
 * request, never from process env.
 */
export function createSummaryModels(config: ModelConfig): Models {
  const model = createModel(config);
  const models = createModels();
  models.setProvider(
    createProvider({
      id: config.provider,
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: 'Meepo space model key',
          resolve: () => Promise.resolve({ auth: { apiKey: config.apiKey }, source: 'dispatch' }),
        },
      },
      models: [model],
      api: { stream, streamSimple },
    })
  );
  return models;
}

/**
 * Threshold compactor over pi-agent-core's harness/compaction helpers:
 * `estimateContextTokens` + `shouldCompact` decide, `generateSummary` (an LLM
 * call through the space's own model) produces the summary, and the history is
 * replaced with the summary plus a token-budgeted recent tail. Returns
 * undefined from `compact` when summarization fails so the caller can fall
 * back to crude truncation.
 */
export function createCompactor(config: ModelConfig): SessionCompactor {
  const model = createModel(config);
  const models = createSummaryModels(config);
  const settings: CompactionSettings = {
    enabled: true,
    reserveTokens: Math.floor(model.contextWindow * (1 - THRESHOLD_RATIO)),
    keepRecentTokens: Math.floor(model.contextWindow * KEEP_RECENT_RATIO),
  };
  return {
    estimate: (messages) => estimateContextTokens(messages).tokens,
    shouldCompact: (tokens) => shouldCompact(tokens, model.contextWindow, settings),
    compact: async (messages) => {
      try {
        const result = await generateSummary(
          messages,
          models,
          model,
          settings.reserveTokens,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          BACKGROUND_CONTEXT
        );
        if (!result.ok) return undefined;
        const summaryMessage: AgentMessage = {
          role: 'user',
          content: `[Summary of the earlier conversation]\n${result.value}`,
          timestamp: Date.now(),
        };
        return [summaryMessage, ...keepRecentByTokens(messages, settings.keepRecentTokens)];
      } catch {
        return undefined;
      }
    },
  };
}
