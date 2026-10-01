import { randomUUID } from 'node:crypto';
import type { Run, Session } from '@meepo/core';
import type { CanonicalEvent } from '@meepo/protocol';
import type { WorkerSender } from '../dispatch/worker-sender.js';

export interface LifecycleEffects {
  interrupted: Run[];
  detached: { sessionId: string; workerId: string }[];
  notes: { sessionId: string; workerId: string; event: CanonicalEvent }[];
}
export interface SessionLifecycleRepository {
  TxReset(
    sessionId: string,
    newId: string,
    anchorMessageId: string,
    ingress: { channelId: string; messageId: string },
    now: number
  ): { session: Session; effects: LifecycleEffects; duplicate: boolean };
  TxDeleteSpace(spaceId: string, now: number): LifecycleEffects;
  TxRebind(spaceId: string, workerId: string, now: number): LifecycleEffects;
  TxClose(sessionId: string, now: number): { session: Session; effects: LifecycleEffects };
}
export interface SessionBindingPort {
  rebind(spaceId: string, workerId: string): Promise<void>;
}
export interface SessionClosingPort {
  reset(
    sessionId: string,
    anchorMessageId: string,
    ingress: { channelId: string; messageId: string }
  ): Promise<{ session: Session; duplicate: boolean }>;
  close(sessionId: string): Promise<Session>;
}

export class SessionLifecycle implements SessionBindingPort, SessionClosingPort {
  constructor(
    private readonly repository: SessionLifecycleRepository,
    private readonly sender: WorkerSender,
    private readonly interrupted: (run: Run) => void,
    private readonly now: () => number = Date.now
  ) {}
  async reset(
    sessionId: string,
    anchorMessageId: string,
    ingress: { channelId: string; messageId: string }
  ) {
    const result = this.repository.TxReset(
      sessionId,
      randomUUID(),
      anchorMessageId,
      ingress,
      this.now()
    );
    this.deliver(result.effects);
    return { session: result.session, duplicate: result.duplicate };
  }
  async deleteSpace(spaceId: string): Promise<void> {
    this.deliver(this.repository.TxDeleteSpace(spaceId, this.now()));
  }

  async rebind(spaceId: string, workerId: string): Promise<void> {
    this.deliver(this.repository.TxRebind(spaceId, workerId, this.now()));
  }
  async close(sessionId: string): Promise<Session> {
    const result = this.repository.TxClose(sessionId, this.now());
    this.deliver(result.effects);
    return result.session;
  }
  private deliver(effects: LifecycleEffects): void {
    for (const run of effects.interrupted) {
      if (run.workerId)
        this.sender.sendToWorker(run.workerId, {
          kind: 'notification',
          event: 'run.abort',
          payload: { runId: run.id, reason: 'session changed' },
        });
      this.interrupted(run);
    }
    for (const item of effects.detached)
      this.sender.sendToWorker(item.workerId, {
        kind: 'notification',
        event: 'session.closed',
        payload: { sessionId: item.sessionId },
      });
    for (const item of effects.notes)
      this.sender.sendToWorker(item.workerId, {
        kind: 'notification',
        event: 'context.append',
        payload: { sessionId: item.sessionId, events: [item.event] },
      });
  }
}
