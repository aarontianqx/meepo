/** UTF-8 limits shared by producers and durable ingestion. */
export const TOOL_PAYLOAD_BYTES = 64 * 1024;
export function boundedText(text: string, maxBytes = TOOL_PAYLOAD_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const marker = `\n[内容已截断 / truncated; originalBytes=${bytes.length}]\n`;
  const budget = Math.max(0, maxBytes - new TextEncoder().encode(marker).length - 16);
  const half = Math.floor(budget / 2),
    decode = new TextDecoder();
  return decode.decode(bytes.slice(0, half)) + marker + decode.decode(bytes.slice(-half));
}
export function boundedPayload(value: unknown): unknown {
  const json = JSON.stringify(value) ?? 'null';
  const bytes = new TextEncoder().encode(json).length;
  if (bytes <= TOOL_PAYLOAD_BYTES) return value;
  // JSON escaping can expand characters up to six times; reserve envelope overhead.
  return {
    truncated: true,
    originalBytes: bytes,
    preview: boundedText(json, Math.floor((TOOL_PAYLOAD_BYTES - 256) / 6)),
  };
}
