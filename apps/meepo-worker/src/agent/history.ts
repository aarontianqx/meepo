import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { formatUserMessage } from '@meepo/protocol';
import type { CanonicalEvent, ModelConfig, TranscriptMessage } from '@meepo/protocol';

/**
 * A user message as the model sees it in history. With a known speaker it carries who, when and
 * where, so consecutive messages from different people in a group stay apart. `timezone` is the
 * session's frozen timezone; without one, times render in UTC.
 */
export function historicUserContent(
  message: TranscriptMessage,
  timestamp: number,
  timezone?: string
): string {
  return message.author
    ? formatUserMessage(message.content, {
        author: message.author,
        authorOpenId: message.authorOpenId,
        chatLabel: message.chatLabel,
        timestamp,
        timezone,
      })
    : message.content;
}

export function assistantMessage(model: ModelConfig, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: model.provider,
    model: model.model,
    stopReason: 'stop',
    timestamp,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/** Rebuild actual tool-call/result pairs, preserving IDs across worker restarts. */
export function restoreEvents(
  events: CanonicalEvent[],
  model: ModelConfig,
  timezone?: string
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const results = new Map<string, CanonicalEvent>();
  const keyOf = (event: CanonicalEvent) =>
    JSON.stringify([event.runId ?? '', (event.payload as { toolCallId: string }).toolCallId]);
  for (const e of events) if (e.type === 'tool_result') results.set(keyOf(e), e);
  const restoredCalls = new Set<string>();
  const usedModelIds = new Set<string>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'message' || event.type === 'user_message') {
      const old = payload as unknown as TranscriptMessage;
      if (old.role === 'assistant') {
        const message = assistantMessage(model, event.timestamp);
        message.content = [{ type: 'text', text: old.content }];
        messages.push(message);
      } else if (old.role === 'user') {
        messages.push({
          role: 'user',
          content: historicUserContent(old, event.timestamp, timezone),
          timestamp: event.timestamp,
        });
      }
    } else if (event.type === 'system_note') {
      messages.push({
        role: 'user',
        content: `<system_note>${String(payload.content ?? '')}</system_note>`,
        timestamp: event.timestamp,
      });
    } else if (event.type === 'assistant_text') {
      const message = assistantMessage(model, event.timestamp);
      message.content = [{ type: 'text', text: String(payload.content ?? '') }];
      messages.push(message);
    } else if (event.type === 'tool_call') {
      const message = assistantMessage(model, event.timestamp);
      const key = keyOf(event);
      if (restoredCalls.has(key)) continue;
      restoredCalls.add(key);
      let id = String(payload.toolCallId);
      // Providers may reuse IDs in different runs. Keep pairing run-scoped and
      // disambiguate only collisions in the rehydrated model transcript.
      if (usedModelIds.has(id)) id = `${id.slice(0, 48)}_${event.seq}`;
      while (usedModelIds.has(id)) id += '_';
      usedModelIds.add(id);
      const name = String(payload.toolName);
      message.content = [
        { type: 'toolCall', id, name, arguments: payload.args as ToolCall['arguments'] },
      ];
      message.stopReason = 'toolUse';
      messages.push(message);
      const resultEvent = results.get(key);
      const resultPayload = resultEvent?.payload as
        { result?: unknown; isError?: boolean } | undefined;
      messages.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: name,
        content: [
          {
            type: 'text',
            text: resultEvent
              ? (JSON.stringify(resultPayload?.result) ?? '')
              : 'Outcome unknown: worker stopped before the result was confirmed. Do not blindly repeat this operation; inspect its effects or ask the user.',
          },
        ],
        isError: resultEvent ? !!resultPayload?.isError : true,
        timestamp: resultEvent?.timestamp ?? event.timestamp,
      });
    }
  }
  return messages;
}
