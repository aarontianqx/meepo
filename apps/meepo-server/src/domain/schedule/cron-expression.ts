import { Cron } from 'croner';

import { validation } from '../errors.js';

/** Validates a strictly 5-field cron expression. */
export function assertValidCron(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw validation(`Cron expression must have exactly 5 fields: "${expression}"`);
  }
  try {
    new Cron(expression);
  } catch {
    throw validation(`Invalid cron expression: "${expression}"`);
  }
}

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw validation(`Unknown timezone: "${timezone}"`);
  }
}

/** Next fire time of `expression` strictly after `after`, interpreted in `timezone`. */
export function nextFireAfter(expression: string, after: Date, timezone: string): Date | null {
  return new Cron(expression, { timezone }).nextRun(after);
}
