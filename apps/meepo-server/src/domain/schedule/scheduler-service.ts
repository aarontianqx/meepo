import { randomUUID } from 'node:crypto';

import type { Schedule, ScheduleAction, ScheduleTiming } from '@meepo/core';
import type { ScheduleView } from '@meepo/protocol';

import { notFound, validation } from '../errors.js';
import type { SessionRepository } from '../sessions/session-repository.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import { assertValidCron, assertValidTimezone, nextFireAfter } from './cron-expression.js';
import type { ScheduleRepository } from './schedule-repository.js';

export const MAX_SCHEDULES_PER_SESSION = 50;
export const SCHEDULE_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COALESCE_ITERATIONS = 10_000;
const MAX_JITTER_MS = 15 * 60_000;

export interface CreateScheduleInput {
  spaceId: string;
  timing: ScheduleTiming;
  action: ScheduleAction;
}

export interface DueFire {
  schedule: Schedule;
  coalescedCount: number;
  stale: boolean;
}

/**
 * Owns the single scheduling entity. A schedule is `timing` + `action`:
 * `at` fires once and completes; `cron` recurs, coalescing missed fires
 * behind a deterministic per-schedule jitter. `resume_session` schedules
 * older than {@link SCHEDULE_STALE_THRESHOLD_MS} fire one final time marked
 * stale, then complete — forgotten automation must not run forever.
 */
export class SchedulerService {
  constructor(
    private readonly schedules: ScheduleRepository,
    private readonly sessions: SessionRepository,
    private readonly spaces: SpaceRepository
  ) {}

  async createSchedule(input: CreateScheduleInput, userId: string): Promise<Schedule> {
    const space = await this.spaces.getById(input.spaceId);
    if (!space) throw validation(`Unknown space: ${input.spaceId}`);
    const timing = validateTiming(input.timing, space.timezone);
    await this.validateAction(input.spaceId, input.action);
    const schedule: Schedule = {
      id: randomUUID(),
      spaceId: input.spaceId,
      timing,
      action: input.action,
      status: 'active',
      createdByUserId: userId,
      createdAt: Date.now(),
    };
    await this.schedules.save(schedule);
    return schedule;
  }

  async listSchedules(spaceId?: string): Promise<Schedule[]> {
    return spaceId ? this.schedules.listBySpace(spaceId) : this.schedules.list();
  }

  async cancelSchedule(id: string): Promise<Schedule> {
    const schedule = await this.schedules.getById(id);
    if (!schedule) throw notFound(`Schedule not found: ${id}`);
    schedule.status = 'deleted';
    await this.schedules.save(schedule);
    return schedule;
  }

  /** Active `resume_session` schedules of a session, as agent-facing views. */
  async listSessionSchedules(sessionId: string): Promise<ScheduleView[]> {
    const active = await this.schedules.listActive();
    return active
      .filter(
        (schedule) =>
          schedule.action.kind === 'resume_session' && schedule.action.sessionId === sessionId
      )
      .map((schedule) => this.toView(schedule));
  }

  /** Deletes a session's `resume_session` schedule; scoped to the owning session. */
  async deleteSessionSchedule(sessionId: string, scheduleId: string): Promise<void> {
    const schedule = await this.schedules.getById(scheduleId);
    if (
      !schedule ||
      schedule.status !== 'active' ||
      schedule.action.kind !== 'resume_session' ||
      schedule.action.sessionId !== sessionId
    ) {
      throw notFound(`Schedule not found in session ${sessionId}: ${scheduleId}`);
    }
    schedule.status = 'deleted';
    await this.schedules.save(schedule);
  }

  /**
   * Advances all active schedules to `now` and returns the fires to dispatch.
   * Each due schedule fires at most once per call; missed ideal fires coalesce.
   */
  async collectDueFires(now: number = Date.now()): Promise<DueFire[]> {
    const fires: DueFire[] = [];
    for (const schedule of await this.schedules.listActive()) {
      const fire = await this.collect(schedule, now);
      if (fire) fires.push(fire);
    }
    return fires;
  }

  toView(schedule: Schedule): ScheduleView {
    return {
      id: schedule.id,
      action: schedule.action.kind,
      timing: schedule.timing,
      prompt: schedule.action.kind === 'resume_session' ? schedule.action.prompt : undefined,
      objective: schedule.action.kind === 'create_ticket' ? schedule.action.objective : undefined,
      nextFireAt: schedule.status === 'active' ? nextFireOf(schedule) : null,
      createdAt: schedule.createdAt,
      lastFiredAt: schedule.lastFiredAt,
    };
  }

  private async collect(schedule: Schedule, now: number): Promise<DueFire | null> {
    const timing = schedule.timing;
    if (timing.kind === 'at') {
      if (now < timing.at) return null;
      schedule.status = 'done';
      schedule.lastFiredAt = now;
      await this.schedules.save(schedule);
      return { schedule, coalescedCount: 1, stale: false };
    }
    const missed = countMissedFires(
      timing.expression,
      schedule.id,
      schedule.createdAt,
      schedule.lastFiredAt,
      timing.timezone ?? 'UTC',
      now
    );
    if (missed === 0) return null;
    const stale =
      schedule.action.kind === 'resume_session' &&
      now - schedule.createdAt > SCHEDULE_STALE_THRESHOLD_MS;
    schedule.lastFiredAt = now;
    if (stale) schedule.status = 'done';
    await this.schedules.save(schedule);
    return { schedule, coalescedCount: missed, stale };
  }

  private async validateAction(spaceId: string, action: ScheduleAction): Promise<void> {
    if (action.kind === 'create_ticket') {
      if (!action.objective.trim()) throw validation('Schedule objective must not be empty');
      return;
    }
    if (!action.prompt.trim()) throw validation('Schedule prompt must not be empty');
    const session = await this.sessions.getById(action.sessionId);
    if (!session || session.spaceId !== spaceId) {
      throw validation(`Unknown session: ${action.sessionId}`);
    }
    const existing = await this.listSessionSchedules(action.sessionId);
    if (existing.length >= MAX_SCHEDULES_PER_SESSION) {
      throw validation(
        `Session ${action.sessionId} already has ${MAX_SCHEDULES_PER_SESSION} schedules`
      );
    }
  }
}

/** Validates timing; cron timezones default to the space timezone. */
function validateTiming(timing: ScheduleTiming, spaceTimezone: string): ScheduleTiming {
  if (timing.kind === 'at') {
    if (!Number.isFinite(timing.at)) throw validation('at must be a finite timestamp');
    return timing;
  }
  assertValidCron(timing.expression);
  const timezone = timing.timezone ?? spaceTimezone;
  assertValidTimezone(timezone);
  return { kind: 'cron', expression: timing.expression, timezone };
}

function nextFireOf(schedule: Schedule): number | null {
  const timing = schedule.timing;
  if (timing.kind === 'at') return timing.at;
  const next = nextJitteredFire(
    timing.expression,
    schedule.id,
    schedule.lastFiredAt ?? schedule.createdAt,
    timing.timezone ?? 'UTC'
  );
  return next?.getTime() ?? null;
}

/**
 * Counts ideal fire times (plus deterministic jitter) in (base, now].
 * The base is the later of creation and the last fire.
 */
function countMissedFires(
  expression: string,
  scheduleId: string,
  createdAt: number,
  lastFiredAt: number | undefined,
  timezone: string,
  now: number
): number {
  let cursor = new Date(lastFiredAt ?? createdAt);
  const jitter = jitterMs(scheduleId, expression, timezone, cursor);
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
  scheduleId: string,
  base: number,
  timezone: string
): Date | null {
  const next = nextFireAfter(expression, new Date(base), timezone);
  if (!next) return null;
  return new Date(next.getTime() + jitterMs(scheduleId, expression, timezone, new Date(base)));
}

/** Deterministic per-schedule offset, capped at min(10% of the period, 15min). */
function jitterMs(scheduleId: string, expression: string, timezone: string, base: Date): number {
  const first = nextFireAfter(expression, base, timezone);
  if (!first) return 0;
  const second = nextFireAfter(expression, first, timezone);
  if (!second) return 0;
  const periodMs = second.getTime() - first.getTime();
  const cap = Math.min(periodMs * 0.1, MAX_JITTER_MS);
  if (cap < 1) return 0;
  let hash = 0;
  for (const ch of scheduleId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % Math.floor(cap);
}
