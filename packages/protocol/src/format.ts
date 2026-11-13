/** Shared presentation helpers for user utterances across server and worker. */

/**
 * The unified presentation for user messages, used for the current turn's
 * prompt (server) and transcript rehydration (worker).
 */
export function formatUserMessage(
  content: string,
  speaker: { author?: string; authorOpenId?: string; chatLabel?: string; timestamp?: number }
): string {
  const attrs: string[] = [];
  if (speaker.author) attrs.push(`sender="${escapeAttr(speaker.author)}"`);
  if (speaker.authorOpenId) attrs.push(`open_id="${escapeAttr(speaker.authorOpenId)}"`);
  if (speaker.timestamp !== undefined) {
    attrs.push(`time="${escapeAttr(formatTime(speaker.timestamp))}"`);
  }
  if (speaker.chatLabel) attrs.push(`chat="${escapeAttr(speaker.chatLabel)}"`);
  return `<message ${attrs.join(' ')}>\n${content}\n</message>`;
}

/** A parent message the user replied to, as shown to the agent and the console. */
export interface QuotedMessage {
  sender: string;
  body: string;
}

/** Prepends the quoted parent to the user's text: `<quoted_message>{json}</quoted_message>`. */
export function formatQuotedMessage(quote: QuotedMessage, text: string): string {
  return `<quoted_message>\n${JSON.stringify(quote)}\n</quoted_message>\n${text}`;
}

const QUOTED_PREFIX = /^<quoted_message>\n(.*)\n<\/quoted_message>\n([\s\S]*)$/;

/**
 * Splits content built by `formatQuotedMessage` back into quote and text. Content without a
 * well-formed quote prefix is returned unchanged, so stored transcripts never fail to render.
 */
export function splitQuotedMessage(content: string): { quote?: QuotedMessage; text: string } {
  const match = QUOTED_PREFIX.exec(content);
  if (!match) return { text: content };
  try {
    const parsed = JSON.parse(match[1]) as Partial<QuotedMessage>;
    if (typeof parsed.sender !== 'string' || typeof parsed.body !== 'string')
      return { text: content };
    return { quote: { sender: parsed.sender, body: parsed.body }, text: match[2] };
  } catch {
    return { text: content };
  }
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
