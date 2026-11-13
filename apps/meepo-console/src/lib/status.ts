/** Maps domain statuses to a display label and a visual tone. */

import type { Run, Session, Ticket, WorkerNode } from '@meepo/core';

export type Tone = 'neutral' | 'info' | 'accent' | 'ok' | 'warn' | 'danger';

export interface StatusView {
  label: string;
  tone: Tone;
  /** Pulsing indicator for in-flight work. */
  live?: boolean;
}

const TICKET: Record<Ticket['status'], StatusView> = {
  pending: { label: 'Queued', tone: 'neutral' },
  claimed: { label: 'Dispatching', tone: 'info', live: true },
  running: { label: 'Running', tone: 'accent', live: true },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  manual_review: { label: 'Needs review', tone: 'warn' },
};

const RUN: Record<Run['status'], StatusView> = {
  queued: { label: 'Queued', tone: 'neutral' },
  dispatched: { label: 'Dispatched', tone: 'info', live: true },
  running: { label: 'Running', tone: 'accent', live: true },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  merged: { label: 'Merged', tone: 'neutral' },
  dropped: { label: 'Dropped', tone: 'neutral' },
};

const SESSION: Record<Session['status'], StatusView> = {
  active: { label: 'Active', tone: 'ok' },
  idle: { label: 'Idle', tone: 'neutral' },
  closed: { label: 'Closed', tone: 'neutral' },
};

const WORKER: Record<WorkerNode['status'], StatusView> = {
  online: { label: 'Online', tone: 'ok' },
  busy: { label: 'Busy', tone: 'warn' },
  offline: { label: 'Offline', tone: 'neutral' },
};

export const ticketStatus = (status: Ticket['status']): StatusView => TICKET[status];
export const runStatus = (status: Run['status']): StatusView => RUN[status];
export const sessionStatus = (status: Session['status']): StatusView => SESSION[status];
export const workerStatus = (status: WorkerNode['status']): StatusView => WORKER[status];

/** Statuses a ticket can still be cancelled from. */
export const CANCELLABLE_TICKET: ReadonlySet<Ticket['status']> = new Set([
  'pending',
  'claimed',
  'running',
  'manual_review',
]);

export const ACTIVE_TICKET: ReadonlySet<Ticket['status']> = new Set([
  'pending',
  'claimed',
  'running',
]);

export const ACTIVE_RUN: ReadonlySet<Run['status']> = new Set(['queued', 'dispatched', 'running']);

/** Spec limit: automatic and manual retries stop after this many attempts. */
export const MAX_TICKET_ATTEMPTS = 3;

const REASONS: Record<string, string> = {
  lease_lost: 'Worker connection lost mid-run; outcome unknown',
  worker_lost: 'Worker connection lost before the run started',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled by an operator',
  abandoned: 'Abandoned after review',
  unclaimed: 'No worker claimed it within 24 hours',
  max_attempts: 'Gave up after 3 attempts',
  error: 'Agent error',
};

/** Plain-language reason for a terminal run/ticket outcome; unknown codes pass through. */
export function terminalReason(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return REASONS[code] ?? code;
}

export type SessionFlavor = 'private' | 'group' | 'thread' | 'console';

/** Classifies a session by its window addressing. */
export function sessionFlavor(session: Session): SessionFlavor {
  if (session.chatId.startsWith('console:')) return 'console';
  if (session.kind === 'thread') return 'thread';
  return session.threadId === '_group' ? 'group' : 'private';
}

export const FLAVOR_LABEL: Record<SessionFlavor, string> = {
  private: 'Private chat',
  group: 'Group chat',
  thread: 'Thread',
  console: 'Console',
};
