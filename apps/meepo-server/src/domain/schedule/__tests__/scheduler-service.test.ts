import { beforeEach, describe, expect, it } from 'vitest';

import type { Schedule, Session, Space } from '@meepo/core';

import { DomainError } from '../../errors.js';
import {
  MAX_SCHEDULES_PER_SESSION,
  SCHEDULE_STALE_THRESHOLD_MS,
  SchedulerService,
} from '../scheduler-service.js';
import { MemoryScheduleRepository } from '../../../store/memory/schedule-memory.js';
import { MemorySessionRepository } from '../../../store/memory/session-memory.js';
import { MemorySpaceRepository } from '../../../store/memory/space-memory.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

function makeSpace(id: string): Space {
  return {
    id,
    name: id,
    repoUrl: 'https://example.com/repo',
    defaultBranch: 'main',
    timezone: 'Asia/Shanghai',
    boundChatIds: [],
    requiredTags: [],
    longTermMemory: '',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeSession(id: string, spaceId: string): Session {
  return {
    id,
    spaceId,
    kind: 'thread',
    chatId: 'chat',
    threadId: 'thread',
    status: 'active',
    createdAt: NOW,
    lastActiveAt: NOW,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sc1',
    spaceId: 'sp1',
    timing: { kind: 'at', at: NOW - 1000 },
    action: { kind: 'create_ticket', objective: 'audit' },
    status: 'active',
    createdByUserId: 'u1',
    createdAt: NOW - 60_000,
    ...overrides,
  };
}

describe('SchedulerService', () => {
  let schedules: MemoryScheduleRepository;
  let sessions: MemorySessionRepository;
  let spaces: MemorySpaceRepository;
  let service: SchedulerService;

  beforeEach(async () => {
    schedules = new MemoryScheduleRepository();
    sessions = new MemorySessionRepository();
    spaces = new MemorySpaceRepository();
    service = new SchedulerService(schedules, sessions, spaces);
    await spaces.save(makeSpace('sp1'));
    await sessions.save(makeSession('se1', 'sp1'));
  });

  describe('createSchedule', () => {
    it('rejects unknown space, non-finite at, 6-field cron, bad timezone', async () => {
      const action = { kind: 'create_ticket', objective: 'x' } as const;
      await expect(
        service.createSchedule({ spaceId: 'ghost', timing: { kind: 'at', at: 1 }, action }, 'u1')
      ).rejects.toThrow(DomainError);
      await expect(
        service.createSchedule(
          { spaceId: 'sp1', timing: { kind: 'at', at: Number.NaN }, action },
          'u1'
        )
      ).rejects.toThrow(DomainError);
      await expect(
        service.createSchedule(
          { spaceId: 'sp1', timing: { kind: 'cron', expression: '0 9 * * * *' }, action },
          'u1'
        )
      ).rejects.toThrow(DomainError);
      await expect(
        service.createSchedule(
          {
            spaceId: 'sp1',
            timing: { kind: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
            action,
          },
          'u1'
        )
      ).rejects.toThrow(DomainError);
    });

    it('rejects an empty objective and an empty prompt', async () => {
      await expect(
        service.createSchedule(
          {
            spaceId: 'sp1',
            timing: { kind: 'at', at: NOW },
            action: { kind: 'create_ticket', objective: '  ' },
          },
          'u1'
        )
      ).rejects.toThrow(DomainError);
      await expect(
        service.createSchedule(
          {
            spaceId: 'sp1',
            timing: { kind: 'at', at: NOW },
            action: { kind: 'resume_session', sessionId: 'se1', prompt: ' ' },
          },
          'u1'
        )
      ).rejects.toThrow(DomainError);
    });

    it('rejects resume_session for a missing or foreign session', async () => {
      await spaces.save(makeSpace('sp2'));
      await sessions.save(makeSession('se2', 'sp2'));
      const timing = { kind: 'at', at: NOW } as const;
      await expect(
        service.createSchedule(
          {
            spaceId: 'sp1',
            timing,
            action: { kind: 'resume_session', sessionId: 'ghost', prompt: 'x' },
          },
          'u1'
        )
      ).rejects.toThrow(DomainError);
      await expect(
        service.createSchedule(
          {
            spaceId: 'sp1',
            timing,
            action: { kind: 'resume_session', sessionId: 'se2', prompt: 'x' },
          },
          'u1'
        )
      ).rejects.toThrow(DomainError);
    });

    it('caps resume_session schedules per session', async () => {
      for (let i = 0; i < MAX_SCHEDULES_PER_SESSION; i += 1) {
        await schedules.save(
          makeSchedule({
            id: `sc${i}`,
            timing: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
            action: { kind: 'resume_session', sessionId: 'se1', prompt: 'x' },
          })
        );
      }
      await expect(
        service.createSchedule(
          {
            spaceId: 'sp1',
            timing: { kind: 'cron', expression: '0 10 * * *' },
            action: { kind: 'resume_session', sessionId: 'se1', prompt: 'x' },
          },
          'u1'
        )
      ).rejects.toThrow(DomainError);
    });

    it('defaults the cron timezone to the space timezone', async () => {
      const schedule = await service.createSchedule(
        {
          spaceId: 'sp1',
          timing: { kind: 'cron', expression: '0 9 * * *' },
          action: { kind: 'create_ticket', objective: 'audit' },
        },
        'u1'
      );
      expect(schedule.timing).toEqual({
        kind: 'cron',
        expression: '0 9 * * *',
        timezone: 'Asia/Shanghai',
      });
      expect(schedule.status).toBe('active');
    });
  });

  describe('at schedules', () => {
    it('fires a due at schedule exactly once, then completes it', async () => {
      await schedules.save(makeSchedule({ id: 'a1', timing: { kind: 'at', at: NOW - 1000 } }));

      const fires = await service.collectDueFires(NOW);
      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({ coalescedCount: 1, stale: false });
      expect((await schedules.getById('a1'))?.status).toBe('done');

      expect(await service.collectDueFires(NOW + 60_000)).toHaveLength(0);
    });

    it('does not fire before its time', async () => {
      await schedules.save(makeSchedule({ id: 'a2', timing: { kind: 'at', at: NOW + 1000 } }));
      expect(await service.collectDueFires(NOW)).toHaveLength(0);
    });
  });

  describe('cron schedules', () => {
    it('coalesces missed fires into one', async () => {
      await schedules.save(
        makeSchedule({
          id: 'c1',
          timing: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
          createdAt: NOW - 3_600_000,
        })
      );
      const fires = await service.collectDueFires(NOW);
      expect(fires).toHaveLength(1);
      expect(fires[0].coalescedCount).toBeGreaterThanOrEqual(55);
      expect(fires[0].coalescedCount).toBeLessThanOrEqual(60);
      expect((await schedules.getById('c1'))?.lastFiredAt).toBe(NOW);
    });

    it('fires a stale resume_session schedule one final time, then completes it', async () => {
      await schedules.save(
        makeSchedule({
          id: 'c2',
          timing: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
          action: { kind: 'resume_session', sessionId: 'se1', prompt: 'check' },
          createdAt: NOW - SCHEDULE_STALE_THRESHOLD_MS - 60_000,
        })
      );
      const fires = await service.collectDueFires(NOW);
      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({ stale: true });
      expect((await schedules.getById('c2'))?.status).toBe('done');
    });

    it('never goes stale for create_ticket schedules', async () => {
      await schedules.save(
        makeSchedule({
          id: 'c3',
          timing: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
          createdAt: NOW - SCHEDULE_STALE_THRESHOLD_MS - 60_000,
        })
      );
      const fires = await service.collectDueFires(NOW);
      expect(fires).toHaveLength(1);
      expect(fires[0].stale).toBe(false);
      expect((await schedules.getById('c3'))?.status).toBe('active');
    });
  });

  describe('cancelSchedule', () => {
    it('marks the schedule deleted and stops it from firing', async () => {
      const schedule = await service.createSchedule(
        {
          spaceId: 'sp1',
          timing: { kind: 'at', at: NOW - 1000 },
          action: { kind: 'create_ticket', objective: 'audit' },
        },
        'u1'
      );
      const cancelled = await service.cancelSchedule(schedule.id);
      expect(cancelled.status).toBe('deleted');
      expect(await service.collectDueFires(NOW)).toHaveLength(0);
    });

    it('rejects an unknown schedule', async () => {
      await expect(service.cancelSchedule('ghost')).rejects.toThrow(DomainError);
    });
  });

  describe('views', () => {
    it('maps an at schedule with its fire time as nextFireAt', async () => {
      await schedules.save(makeSchedule({ id: 'v1', timing: { kind: 'at', at: NOW + 60_000 } }));
      const schedule = await schedules.getById('v1');
      const view = service.toView(schedule!);
      expect(view).toMatchObject({
        id: 'v1',
        action: 'create_ticket',
        objective: 'audit',
        nextFireAt: NOW + 60_000,
      });
    });

    it('maps a cron schedule with a future nextFireAt and null after completion', async () => {
      const schedule = await service.createSchedule(
        {
          spaceId: 'sp1',
          timing: { kind: 'cron', expression: '0 9 * * *' },
          action: { kind: 'resume_session', sessionId: 'se1', prompt: 'standup' },
        },
        'u1'
      );
      const view = service.toView(schedule);
      expect(view.action).toBe('resume_session');
      expect(view.prompt).toBe('standup');
      expect(view.nextFireAt).toBeGreaterThan(Date.now());

      schedule.status = 'done';
      expect(service.toView(schedule).nextFireAt).toBeNull();
    });
  });

  describe('session schedules', () => {
    it('lists only active resume_session schedules of the session', async () => {
      await schedules.save(
        makeSchedule({
          id: 's1',
          timing: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
          action: { kind: 'resume_session', sessionId: 'se1', prompt: 'wake' },
        })
      );
      await schedules.save(
        makeSchedule({
          id: 's2',
          timing: { kind: 'cron', expression: '0 10 * * *', timezone: 'UTC' },
          action: { kind: 'resume_session', sessionId: 'se1', prompt: 'wake' },
          status: 'deleted',
        })
      );
      await schedules.save(makeSchedule({ id: 's3' }));

      const views = await service.listSessionSchedules('se1');
      expect(views.map((view) => view.id)).toEqual(['s1']);
    });

    it('deletes only within the owning session', async () => {
      await schedules.save(
        makeSchedule({
          id: 's4',
          timing: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
          action: { kind: 'resume_session', sessionId: 'se1', prompt: 'wake' },
        })
      );
      await expect(service.deleteSessionSchedule('other-session', 's4')).rejects.toThrow(
        DomainError
      );
      await service.deleteSessionSchedule('se1', 's4');
      expect((await schedules.getById('s4'))?.status).toBe('deleted');
    });
  });
});
