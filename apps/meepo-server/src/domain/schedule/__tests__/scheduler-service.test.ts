import { beforeEach, describe, expect, it } from 'vitest';

import type { CronJob, Reminder, Session, Space } from '@meepo/core';

import { DomainError } from '../../errors.js';
import {
  CRON_STALE_THRESHOLD_MS,
  MAX_CRON_JOBS_PER_SESSION,
  SchedulerService,
} from '../scheduler-service.js';
import { MemoryCronRepository } from '../../../store/memory/cron-memory.js';
import { MemoryReminderRepository } from '../../../store/memory/reminder-memory.js';
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
    kind: 'task',
    chatId: 'chat',
    threadId: 'thread',
    status: 'active',
    createdAt: NOW,
    lastActiveAt: NOW,
  };
}

describe('SchedulerService', () => {
  let reminders: MemoryReminderRepository;
  let crons: MemoryCronRepository;
  let sessions: MemorySessionRepository;
  let spaces: MemorySpaceRepository;
  let service: SchedulerService;

  beforeEach(async () => {
    reminders = new MemoryReminderRepository();
    crons = new MemoryCronRepository();
    sessions = new MemorySessionRepository();
    spaces = new MemorySpaceRepository();
    service = new SchedulerService(reminders, crons, sessions, spaces);
    await spaces.save(makeSpace('sp1'));
    await sessions.save(makeSession('se1', 'sp1'));
  });

  describe('createReminder', () => {
    it('rejects unknown space, bad timezone, 6-field cron, empty objective', async () => {
      await expect(
        service.createReminder(
          { spaceId: 'ghost', objective: 'x', trigger: { kind: 'delay', delayMs: 1000 } },
          'u1'
        )
      ).rejects.toThrow(DomainError);
      await expect(
        service.createReminder(
          {
            spaceId: 'sp1',
            objective: 'x',
            trigger: { kind: 'delay', delayMs: 1000 },
            timezone: 'Mars/Olympus',
          },
          'u1'
        )
      ).rejects.toThrow(DomainError);
      await expect(
        service.createReminder(
          { spaceId: 'sp1', objective: 'x', trigger: { kind: 'cron', cron: '0 9 * * * *' } },
          'u1'
        )
      ).rejects.toThrow(DomainError);
      await expect(
        service.createReminder(
          { spaceId: 'sp1', objective: '  ', trigger: { kind: 'delay', delayMs: 1000 } },
          'u1'
        )
      ).rejects.toThrow(DomainError);
    });

    it('defaults timezone to the space timezone', async () => {
      const reminder = await service.createReminder(
        { spaceId: 'sp1', objective: 'audit', trigger: { kind: 'delay', delayMs: 60_000 } },
        'u1'
      );
      expect(reminder.timezone).toBe('Asia/Shanghai');
      expect(reminder.status).toBe('scheduled');
    });
  });

  describe('reminder firing', () => {
    it('fires a due delay reminder exactly once', async () => {
      const reminder: Reminder = {
        id: 'r1',
        spaceId: 'sp1',
        objective: 'audit',
        requiredTags: [],
        trigger: { kind: 'delay', delayMs: 60_000 },
        timezone: 'UTC',
        status: 'scheduled',
        createdByUserId: 'u1',
        createdAt: NOW - 120_000,
      };
      await reminders.save(reminder);

      const fires = await service.collectDueFires(NOW);
      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({ kind: 'reminder', coalescedCount: 1 });
      expect((await reminders.getById('r1'))?.status).toBe('fired');

      expect(await service.collectDueFires(NOW + 60_000)).toHaveLength(0);
    });

    it('does not fire a delay reminder before its time', async () => {
      await reminders.save({
        id: 'r2',
        spaceId: 'sp1',
        objective: 'audit',
        requiredTags: [],
        trigger: { kind: 'delay', delayMs: 60_000 },
        timezone: 'UTC',
        status: 'scheduled',
        createdByUserId: 'u1',
        createdAt: NOW - 30_000,
      });
      expect(await service.collectDueFires(NOW)).toHaveLength(0);
    });

    it('coalesces missed cron-trigger fires into one', async () => {
      await reminders.save({
        id: 'r3',
        spaceId: 'sp1',
        objective: 'audit',
        requiredTags: [],
        trigger: { kind: 'cron', cron: '* * * * *' },
        timezone: 'UTC',
        status: 'scheduled',
        createdByUserId: 'u1',
        createdAt: NOW - 3_600_000,
      });
      const fires = await service.collectDueFires(NOW);
      expect(fires).toHaveLength(1);
      const fire = fires[0] as { coalescedCount: number };
      expect(fire.coalescedCount).toBeGreaterThanOrEqual(55);
      expect(fire.coalescedCount).toBeLessThanOrEqual(60);
    });
  });

  describe('createCron', () => {
    it('rejects unknown session and caps jobs per session', async () => {
      await expect(
        service.createCron({ sessionId: 'ghost', cron: '* * * * *', prompt: 'x', recurring: true })
      ).rejects.toThrow(DomainError);

      for (let i = 0; i < MAX_CRON_JOBS_PER_SESSION; i += 1) {
        await crons.save({
          id: `j${i}`,
          sessionId: 'se1',
          spaceId: 'sp1',
          cron: '0 9 * * *',
          prompt: 'x',
          recurring: true,
          timezone: 'UTC',
          status: 'active',
          createdAt: NOW,
        });
      }
      await expect(
        service.createCron({ sessionId: 'se1', cron: '* * * * *', prompt: 'x', recurring: true })
      ).rejects.toThrow(DomainError);
    });

    it('returns a view with a future nextFireAt', async () => {
      const view = await service.createCron({
        sessionId: 'se1',
        cron: '0 9 * * *',
        prompt: 'standup',
        recurring: true,
      });
      expect(view.timezone).toBe('Asia/Shanghai');
      expect(view.nextFireAt).toBeGreaterThan(Date.now());
    });
  });

  describe('cron firing', () => {
    it('fires a one-shot cron once then deletes it', async () => {
      await crons.save({
        id: 'c1',
        sessionId: 'se1',
        spaceId: 'sp1',
        cron: '* * * * *',
        prompt: 'check',
        recurring: false,
        timezone: 'UTC',
        status: 'active',
        createdAt: NOW - 120_000,
      });
      const fires = await service.collectDueFires(NOW);
      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({ kind: 'cron', stale: false });
      expect(await crons.listActiveBySession('se1')).toHaveLength(0);
    });

    it('advances a recurring cron without deleting it', async () => {
      await crons.save({
        id: 'c2',
        sessionId: 'se1',
        spaceId: 'sp1',
        cron: '* * * * *',
        prompt: 'check',
        recurring: true,
        timezone: 'UTC',
        status: 'active',
        createdAt: NOW - 120_000,
      });
      const fires = await service.collectDueFires(NOW);
      expect(fires).toHaveLength(1);
      const job = await crons.getById('c2');
      expect(job?.status).toBe('active');
      expect(job?.lastFiredAt).toBe(NOW);
    });

    it('fires a stale recurring cron one final time then deletes it', async () => {
      const job: CronJob = {
        id: 'c3',
        sessionId: 'se1',
        spaceId: 'sp1',
        cron: '* * * * *',
        prompt: 'check',
        recurring: true,
        timezone: 'UTC',
        status: 'active',
        createdAt: NOW - CRON_STALE_THRESHOLD_MS - 60_000,
      };
      await crons.save(job);
      const fires = await service.collectDueFires(NOW);
      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({ kind: 'cron', stale: true });
      expect((await crons.getById('c3'))?.status).toBe('deleted');
    });
  });

  describe('deleteCron', () => {
    it('deletes only within the owning session', async () => {
      const view = await service.createCron({
        sessionId: 'se1',
        cron: '0 9 * * *',
        prompt: 'x',
        recurring: true,
      });
      await expect(service.deleteCron('other-session', view.id)).rejects.toThrow(DomainError);
      await service.deleteCron('se1', view.id);
      expect(await service.listCrons('se1')).toHaveLength(0);
    });
  });
});
