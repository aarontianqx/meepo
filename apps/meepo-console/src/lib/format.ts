/** Pure formatting helpers shared by every page. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "5m ago" / "in 2h" relative to `now`; falls back to a short date beyond 30 days. */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const delta = timestamp - now;
  const abs = Math.abs(delta);
  if (abs < 10_000) return 'just now';
  const unit = (n: number, label: string): string => {
    const rounded = Math.floor(n);
    return delta < 0 ? `${rounded}${label} ago` : `in ${rounded}${label}`;
  };
  if (abs < MINUTE) return unit(abs / 1000, 's');
  if (abs < HOUR) return unit(abs / MINUTE, 'm');
  if (abs < DAY) return unit(abs / HOUR, 'h');
  if (abs < 30 * DAY) return unit(abs / DAY, 'd');
  return new Date(timestamp).toLocaleDateString();
}

/** Full local timestamp for tooltips. */
export function absoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Clock time for transcript rows ("14:03"). */
export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Day separator label for transcripts ("Today", "Yesterday", "Nov 12"). */
export function dayLabel(timestamp: number, now: number = Date.now()): string {
  const day = new Date(timestamp);
  const today = new Date(now);
  const startOf = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Stable key for grouping events by calendar day. */
export function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "1m 12s" style duration for run summaries. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** 1.2k / 3.4M style counts. */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** First N characters of a string on one line, with an ellipsis when truncated. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Last 6 characters of a UUID-like id, for compact display next to a name. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Parses a comma/whitespace separated tag list into a clean, de-duplicated array. */
export function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    ),
  ];
}

/** Drops empty/whitespace-only values so optional fields stay undefined. */
export function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Hostname of a URL for compact display; returns the input when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Deterministic hue (0-359) for avatars derived from a string. */
export function hueOf(text: string): number {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}
