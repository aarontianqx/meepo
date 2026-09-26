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
