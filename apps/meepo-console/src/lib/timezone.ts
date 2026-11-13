/** IANA timezone helpers for pickers. */

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** All supported zones, with the given ones guaranteed present and listed first. */
export function timezoneOptions(...include: string[]): string[] {
  const all = Intl.supportedValuesOf('timeZone');
  const head = [...new Set(['UTC', ...include])];
  return [...head, ...all.filter((zone) => !head.includes(zone))];
}
