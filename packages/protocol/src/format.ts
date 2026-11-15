/** Shared presentation helpers for user utterances across server and worker. */

/**
 * The unified presentation for user messages, used for the current turn's
 * prompt (server) and transcript rehydration (worker).
 */
export function formatUserMessage(
  content: string,
  speaker: {
    author?: string;
    authorOpenId?: string;
    chatLabel?: string;
    timestamp?: number;
    /** IANA timezone the session froze at creation; absent renders UTC. */
    timezone?: string;
  }
): string {
  const attrs: string[] = [];
  if (speaker.author) attrs.push(`sender="${escapeAttr(speaker.author)}"`);
  if (speaker.authorOpenId) attrs.push(`open_id="${escapeAttr(speaker.authorOpenId)}"`);
  if (speaker.timestamp !== undefined) {
    attrs.push(`time="${escapeAttr(formatInstant(speaker.timestamp, speaker.timezone))}"`);
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

/**
 * ISO 8601 to the second with a UTC offset, e.g. `2026-11-15T10:18:00+08:00` in
 * `Asia/Shanghai`. Without a timezone the instant is rendered in UTC (`...Z`). Every
 * model-visible timestamp goes through here so one session always shows one clock.
 */
export function formatInstant(timestamp: number, timezone?: string): string {
  if (!timezone) return `${new Date(timestamp).toISOString().slice(0, 19)}Z`;
  const parts: Record<string, string> = {};
  for (const part of instantFormat(timezone).formatToParts(new Date(timestamp)))
    parts[part.type] = part.value;
  // `longOffset` renders "GMT+08:00"; at offset zero engines emit "GMT" or "GMT+00:00".
  const offset = parts.timeZoneName.slice(3);
  const suffix = offset === '' || offset === '+00:00' ? 'Z' : offset;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${suffix}`;
}

const INSTANT_FORMATS = new Map<string, Intl.DateTimeFormat>();

// Building a formatter costs far more than using one, and the timezone set is tiny.
function instantFormat(timezone: string): Intl.DateTimeFormat {
  let format = INSTANT_FORMATS.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    });
    INSTANT_FORMATS.set(timezone, format);
  }
  return format;
}

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses an ISO 8601 timestamp that carries an explicit offset (`Z` or `+08:00`) into epoch
 * milliseconds. A time without an offset is rejected: its meaning would depend on a guessed zone.
 */
export function parseInstant(text: string): number {
  const value = text.trim();
  const match = ISO_WITH_OFFSET.exec(value);
  const timestamp = match ? Date.parse(value) : Number.NaN;
  // Date.parse rolls impossible days over (Feb 30 becomes Mar 2), so check the calendar day.
  const dayExists =
    match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])).getUTCDate() === +match[3];
  if (Number.isNaN(timestamp) || !dayExists)
    throw new Error(
      `Invalid time ${JSON.stringify(text)}: use ISO 8601 with a UTC offset, e.g. "2026-11-17T09:00:00+08:00"`
    );
  return timestamp;
}
