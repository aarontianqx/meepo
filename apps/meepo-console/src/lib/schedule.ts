/** Plain-language summaries of schedules. */

import type { Schedule } from '@meepo/core';

import { describeCron } from './cron';
import { absoluteTime } from './format';

export function timingLabel(timing: Schedule['timing']): string {
  return timing.kind === 'at'
    ? `Once, ${absoluteTime(timing.at)}`
    : describeCron(timing.expression);
}

/** What the schedule does when it fires. */
export function actionLabel(action: Schedule['action']): string {
  return action.kind === 'create_ticket' ? action.objective : action.prompt;
}

export function actionKindLabel(action: Schedule['action']): string {
  return action.kind === 'create_ticket' ? 'Creates a ticket' : 'Resumes a conversation';
}
