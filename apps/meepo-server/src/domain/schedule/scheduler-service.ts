import { randomUUID } from 'node:crypto';

import type { CronJob, Reminder, ScheduleTrigger } from '@meepo/core';
import type { CronCreateParams, CronJobView } from '@meepo/protocol';

import { notFound, validation } from '../errors.js';
import type { SessionRepository } from '../sessions/session-repository.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import { assertValidCron, assertValidTimezone, nextFireAfter } from './cron-expression.js';
import type { CronRepository } from './cron-repository.js';
import type { ReminderRepository } from './reminder-repository.js';

export const MAX_CRON_JOBS_PER_SESSION = 50;
export const CRON_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COALESCE_ITERATIONS = 10_000;
const MAX_JITTER_MS = 15 * 60_000;

export type DueFire =
  | { kind: 'cron'; job: CronJob; coalescedCount: number; stale: boolean }
  | { kind: 'reminder'; reminder: Reminder; coalescedCount: number };

export interface CreateReminderInput {
  spaceId: string;
  objective: string;
  contextSummary?: string;
  requiredTags?: string[];
  trigger: ScheduleTrigger;
  timezone?: string;
}

export class SchedulerService {
  constructor(
    private readonly reminders: ReminderRepository,
    private readonly crons: CronRepository,
    private readonly sessions: SessionRepository,
    private readonly spaces: SpaceRepository
  ) {}

  async createReminder(input: CreateReminderInput, userId: string): Promise<Reminder> {
    const space = await this.spaces.getById(input.spaceId);
    if (!space) throw validation(`Unknown space: ${input.spaceId}`);
    if (!input.objective.trim()) throw validation('Reminder objective must not be empty');
    const timezone = input.timezone ?? space.timezone;
    assertValidTimezone(timezone);
    validateTrigger(input.trigger);
    const reminder: Reminder = {
      id: randomUUID(),
      spaceId: input.spaceId,
      objective: input.objective.trim(),
      contextSummary: input.contextSummary,
      requiredTags: input.requiredTags ?? space.requiredTags,
      trigger: input.trigger,
      timezone,
      status: 'scheduled',
      createdByUserId: userId,
      createdAt: Date.now(),
    };
    await this.reminders.save(reminder);
    return reminder;
  }

  async cancelReminder(id: string): Promise<Reminder> {
    const reminder = await this.reminders.getById(id);
    if (!reminder) throw notFound(`Reminder not found: ${id}`);
    reminder.status = 'cancelled';
    await this.reminders.save(reminder);
    return reminder;
  }

  async listRemindersBySpace(spaceId: string): Promise<Reminder[]> {
    return this.reminders.listBySpace(spaceId);
  }

  async createCron(params: CronCreateParams): Promise<CronJobView> {
    const session = await this.sessions.getById(params.sessionId);
    if (!session) throw validation(`Unknown session: ${params.sessionId}`);
    const space = await this.spaces.getById(session.spaceId);
    if (!space) throw validation(`Unknown space: ${session.spaceId}`);
    assertValidCron(params.cron);
    if (!params.prompt.trim()) throw validation('Cron prompt must not be empty');
    const timezone = params.timezone ?? space.timezone;
    assertValidTimezone(timezone);
    const active = await this.crons.listActiveBySession(params.sessionId);
    if (active.length >= MAX_CRON_JOBS_PER_SESSION) {
      throw validation(
        `Session ${params.sessionId} already has ${MAX_CRON_JOBS_PER_SESSION} crons`
      );
    }
    const job: CronJob = {
      id: randomUUID(),
      sessionId: params.sessionId,
      spaceId: session.spaceId,
      cron: params.cron,
      prompt: params.prompt,
      recurring: params.recurring,
      timezone,
      status: 'active',
      createdAt: Date.now(),
    };
    await this.crons.save(job);
    return this.toView(job);
  }

  async listCrons(sessionId: string): Promise<CronJobView[]> {
    const jobs = await this.crons.listActiveBySession(sessionId);
    return Promise.all(jobs.map((job) => this.toView(job)));
  }

  async deleteCron(sessionId: string, jobId: string): Promise<void> {
    const job = await this.crons.getById(jobId);
    if (!job || job.sessionId !== sessionId || job.status !== 'active') {
      throw notFound(`Cron not found in session ${sessionId}: ${jobId}`);
    }
    job.status = 'deleted';
    await this.crons.save(job);
  }

  /**
   * Advances all schedules to `now` and returns the fires to dispatch.
   * Each due job fires at most once per call; missed ideal fires coalesce.
   */
  async collectDueFires(now: number = Date.now()): Promise<DueFire[]> {
    const fires: DueFire[] = [];
    for (const reminder of await this.reminders.listScheduled()) {
      const fire = await this.collectReminder(reminder, now);
      if (fire) fires.push(fire);
    }
    for (const job of await this.crons.listActive()) {
      const fire = await this.collectCron(job, now);
      if (fire) fires.push(fire);
    }
    return fires;
  }

  private async collectReminder(reminder: Reminder, now: number): Promise<DueFire | null> {
    const trigger = reminder.trigger;
    if (trigger.kind === 'delay') {
      if (now < reminder.createdAt + trigger.delayMs) return null;
      reminder.status = 'fired';
      reminder.lastFiredAt = now;
      await this.reminders.save(reminder);
      return { kind: 'reminder', reminder, coalescedCount: 1 };
    }
    if (trigger.kind === 'at') {
      if (now < trigger.at) return null;
      reminder.status = 'fired';
      reminder.lastFiredAt = now;
      await this.reminders.save(reminder);
      return { kind: 'reminder', reminder, coalescedCount: 1 };
    }
    const missed = countMissedFires(
      trigger.cron,
      reminder.id,
      reminder.createdAt,
      reminder.lastFiredAt,
      reminder.timezone,
      now
    );
    if (missed === 0) return null;
    reminder.lastFiredAt = now;
    await this.reminders.save(reminder);
    return { kind: 'reminder', reminder, coalescedCount: missed };
  }

  private async collectCron(job: CronJob, now: number): Promise<DueFire | null> {
    const missed = countMissedFires(
      job.cron,
      job.id,
      job.createdAt,
      job.lastFiredAt,
      job.timezone,
      now
    );
    if (missed === 0) return null;
    const stale = job.recurring && now - job.createdAt > CRON_STALE_THRESHOLD_MS;
    if (!job.recurring || stale) {
      job.status = 'deleted';
      job.lastFiredAt = now;
      await this.crons.save(job);
      return { kind: 'cron', job, coalescedCount: missed, stale };
    }
    job.lastFiredAt = now;
    await this.crons.save(job);
    return { kind: 'cron', job, coalescedCount: missed, stale: false };
  }

  private async toView(job: CronJob): Promise<CronJobView> {
    return {
      id: job.id,
      sessionId: job.sessionId,
      cron: job.cron,
      prompt: job.prompt,
      recurring: job.recurring,
      timezone: job.timezone,
      nextFireAt:
        nextJitteredFire(
          job.cron,
          job.id,
          job.lastFiredAt ?? job.createdAt,
          job.timezone
        )?.getTime() ?? null,
      createdAt: job.createdAt,
      lastFiredAt: job.lastFiredAt,
    };
  }
}

function validateTrigger(trigger: ScheduleTrigger): void {
  switch (trigger.kind) {
    case 'delay':
      if (!Number.isFinite(trigger.delayMs) || trigger.delayMs <= 0) {
        throw validation('delayMs must be a positive number');
      }
      return;
    case 'at':
      if (!Number.isFinite(trigger.at)) throw validation('at must be a timestamp');
      return;
    case 'cron':
      assertValidCron(trigger.cron);
      return;
  }
}

/**
 * Counts ideal fire times (plus deterministic jitter) in (base, now].
 * The base is the later of creation and the last fire.
 */
function countMissedFires(
  expression: string,
  jobId: string,
  createdAt: number,
  lastFiredAt: number | undefined,
  timezone: string,
  now: number
): number {
  let cursor = new Date(lastFiredAt ?? createdAt);
  const jitter = jitterMs(jobId, expression, timezone, cursor);
  let count = 0;
  for (let i = 0; i < MAX_COALESCE_ITERATIONS; i += 1) {
    const next = nextFireAfter(expression, cursor, timezone);
    if (!next || next.getTime() + jitter > now) break;
    count += 1;
    cursor = next;
  }
  return count;
}

function nextJitteredFire(
  expression: string,
  jobId: string,
  base: number,
  timezone: string
): Date | null {
  const next = nextFireAfter(expression, new Date(base), timezone);
  if (!next) return null;
  return new Date(next.getTime() + jitterMs(jobId, expression, timezone, new Date(base)));
}

/** Deterministic per-job offset, capped at min(10% of the period, 15min). */
function jitterMs(jobId: string, expression: string, timezone: string, base: Date): number {
  const first = nextFireAfter(expression, base, timezone);
  if (!first) return 0;
  const second = nextFireAfter(expression, first, timezone);
  if (!second) return 0;
  const periodMs = second.getTime() - first.getTime();
  const cap = Math.min(periodMs * 0.1, MAX_JITTER_MS);
  if (cap < 1) return 0;
  let hash = 0;
  for (const ch of jobId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % Math.floor(cap);
}
