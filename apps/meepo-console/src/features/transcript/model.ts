// Turns the durable event stream into display items for the transcript.

import { splitQuotedMessage, type CanonicalEvent, type QuotedMessage } from '@meepo/protocol';

export type TimelineItem =
  | {
      kind: 'user';
      key: string;
      at: number;
      author?: string;
      content: string;
      /** The message this one replied to, when the user quoted one. */
      quote?: QuotedMessage;
      imageCount: number;
    }
  | { kind: 'assistant'; key: string; at: number; content: string }
  | { kind: 'note'; key: string; at: number; content: string; from?: string }
  | { kind: 'tool'; key: string; at: number; tool: ToolItem }
  | { kind: 'setup'; key: string; at: number; prompt: string }
  | {
      kind: 'run';
      key: string;
      at: number;
      outcome: 'started' | 'completed' | 'failed';
      text?: string;
    };

export interface ToolItem {
  callId: string;
  name: string;
  args: unknown;
  /** Undefined while the call is still running. */
  result?: { text: string; isError: boolean };
  durationMs?: number;
}

interface ContentPayload {
  content?: string;
}

/** `[Console message from <name>]\nhello` -> from "<name>", content "hello". */
const CONSOLE_NOTE = /^\[Console message from ([^\]]+)\]\n?([\s\S]*)$/;

/** Builds display items in event order, pairing tool calls with their results. */
export function buildTimeline(events: CanonicalEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  // Some model gateways restart call ids at call_0 every turn, so pairing is scoped to the run.
  const toolByCall = new Map<
    string,
    { item: Extract<TimelineItem, { kind: 'tool' }>; startedAt: number }
  >();
  let sawSetup = false;

  for (const event of events) {
    const key = `${event.seq}`;
    const payload = event.payload as Record<string, unknown> | null;
    switch (event.type) {
      case 'user_message':
      case 'message': {
        const message = payload as {
          role?: string;
          content?: string;
          author?: string;
          authorOpenId?: string;
          images?: unknown[];
        } | null;
        if (!message || typeof message.content !== 'string') break;
        if (message.role === 'assistant') {
          items.push({ kind: 'assistant', key, at: event.timestamp, content: message.content });
        } else if (message.role === 'tool') {
          break;
        } else {
          const { quote, text } = splitQuotedMessage(message.content);
          items.push({
            kind: 'user',
            key,
            at: event.timestamp,
            author: message.author ?? message.authorOpenId,
            content: text,
            quote,
            imageCount: message.images?.length ?? 0,
          });
        }
        break;
      }
      case 'assistant_text': {
        const content = (payload as ContentPayload | null)?.content;
        if (content) items.push({ kind: 'assistant', key, at: event.timestamp, content });
        break;
      }
      case 'system_note': {
        const content = (payload as ContentPayload | null)?.content;
        if (!content) break;
        const consoleNote = CONSOLE_NOTE.exec(content);
        items.push(
          consoleNote
            ? {
                kind: 'note',
                key,
                at: event.timestamp,
                content: consoleNote[2],
                from: consoleNote[1],
              }
            : { kind: 'note', key, at: event.timestamp, content }
        );
        break;
      }
      case 'tool_call': {
        const call = payload as { toolCallId: string; toolName: string; args: unknown };
        const item: Extract<TimelineItem, { kind: 'tool' }> = {
          kind: 'tool',
          key,
          at: event.timestamp,
          tool: { callId: call.toolCallId, name: call.toolName, args: call.args },
        };
        toolByCall.set(callKey(event.runId, call.toolCallId), { item, startedAt: event.timestamp });
        items.push(item);
        break;
      }
      case 'tool_result': {
        const done = payload as { toolCallId: string; result: unknown; isError?: boolean };
        const pending = toolByCall.get(callKey(event.runId, done.toolCallId));
        if (!pending) break;
        pending.item.tool.result = {
          text: resultText(done.result),
          isError: done.isError === true,
        };
        pending.item.tool.durationMs = Math.max(0, event.timestamp - pending.startedAt);
        break;
      }
      case 'prompt_identity':
      case 'prompt_snapshot': {
        // Both carry the same base prompt; show it once as a collapsed setup row.
        if (sawSetup) break;
        const base = (payload as { base?: string } | null)?.base;
        if (base) {
          sawSetup = true;
          items.push({ kind: 'setup', key, at: event.timestamp, prompt: base });
        }
        break;
      }
      case 'run_started':
        items.push({ kind: 'run', key, at: event.timestamp, outcome: 'started' });
        break;
      case 'run_completed':
        items.push({ kind: 'run', key, at: event.timestamp, outcome: 'completed' });
        break;
      case 'run_failed': {
        const error = (payload as { error?: string } | null)?.error;
        items.push({ kind: 'run', key, at: event.timestamp, outcome: 'failed', text: error });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

function callKey(runId: string | undefined, toolCallId: string): string {
  return `${runId ?? ''}:${toolCallId}`;
}

/** Plain text of a tool result: joined text parts, a bare string, or pretty JSON. */
export function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const parts = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  if (Array.isArray(parts)) {
    return parts
      .map((part) =>
        part.type === 'text' && typeof part.text === 'string'
          ? part.text
          : `[${part.type ?? 'item'}]`
      )
      .join('\n');
  }
  return result === undefined ? '' : JSON.stringify(result, null, 2);
}

/** One-line description of a tool call's arguments for the collapsed row. */
export function argsSummary(args: unknown): string {
  if (args === null || typeof args !== 'object') return args === undefined ? '' : String(args);
  const record = args as Record<string, unknown>;
  const preferred = [
    'command',
    'path',
    'prefix',
    'query',
    'url',
    'pattern',
    'file_path',
    'objective',
    'description',
  ];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === 'string' && value) return value.replace(/\s+/g, ' ').trim();
  }
  const first = Object.values(record).find((value) => typeof value === 'string' && value) as
    string | undefined;
  if (first) return first.replace(/\s+/g, ' ').trim();
  const json = JSON.stringify(args);
  return json === '{}' ? '' : json;
}
