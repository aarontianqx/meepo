/** Typed wrappers for every control-plane endpoint the console uses. */

import type {
  Run,
  Schedule,
  ScheduleAction,
  ScheduleTiming,
  Session,
  Space,
  SpaceMember,
  SpaceModelRef,
  Ticket,
  WorkerEnrollmentToken,
  WorkerNode,
} from '@meepo/core';
import type { CanonicalEvent } from '@meepo/protocol';

import { enc, request } from './client';
import type {
  Channel,
  ChannelInput,
  EnrollmentRecord,
  HealthStatus,
  MemoryEntry,
  MemoryMeta,
  MemorySearchHit,
  MemoryWriteBody,
  Me,
  ModelEntry,
  ModelInput,
  ModelOption,
  ScheduleItem,
  SessionItem,
  SpaceUsage,
} from './types';

export interface CreateSpaceInput {
  name: string;
  description?: string;
  requiredTags?: string[];
  timezone?: string;
  promptPreset?: 'general' | 'coding';
}

export type UpdateSpaceInput = Partial<CreateSpaceInput>;

export interface CreateTicketInput {
  spaceId: string;
  title: string;
  objective: string;
  contextSummary?: string;
  requiredTags?: string[];
}

export interface CreateScheduleInput {
  spaceId: string;
  timing: ScheduleTiming;
  action: ScheduleAction;
}

/** A ticket attempt together with its recorded event trace. */
export interface TicketRun extends Run {
  events: CanonicalEvent[];
}

const space = (id: string): string => `/api/spaces/${enc(id)}`;

export const api = {
  health: () => request<HealthStatus>('GET', '/healthz'),
  me: () => request<Me>('GET', '/api/me'),

  // Spaces
  listSpaces: () => request<Space[]>('GET', '/api/spaces'),
  getSpace: (id: string) => request<Space>('GET', space(id)),
  createSpace: (input: CreateSpaceInput) => request<Space>('POST', '/api/spaces', input),
  updateSpace: (id: string, input: UpdateSpaceInput) => request<Space>('PATCH', space(id), input),
  deleteSpace: (id: string) => request<{ deleted: true }>('DELETE', space(id)),
  updateSpaceModel: (id: string, model: SpaceModelRef | undefined) =>
    request<Space>('PUT', `${space(id)}/model`, { model }),
  switchBinding: (id: string, workerId: string) =>
    request<Space>('POST', `${space(id)}/binding`, { workerId }),
  spaceUsage: (id: string) => request<SpaceUsage>('GET', `${space(id)}/usage`),
  spaceChannels: (id: string) => request<Channel[]>('GET', `${space(id)}/channels`),
  bindChats: (id: string, channelId: string, chatIds: string[]) =>
    request<{ saved: true }>('PUT', `${space(id)}/channels/${enc(channelId)}/chats`, { chatIds }),
  issueWebhookToken: (id: string) =>
    request<{ token: string }>('POST', `${space(id)}/webhook-token`),
  revokeWebhookToken: (id: string) =>
    request<{ revoked: true }>('DELETE', `${space(id)}/webhook-token`),

  // Members
  listMembers: (id: string) => request<SpaceMember[]>('GET', `${space(id)}/members`),
  addMember: (id: string, userId: string) =>
    request<SpaceMember>('POST', `${space(id)}/members`, { userId }),
  removeMember: (id: string, userId: string) =>
    request<{ removed: true }>('DELETE', `${space(id)}/members/${enc(userId)}`),
  transferOwner: (id: string, userId: string) =>
    request<{ transferred: true }>('POST', `${space(id)}/owner`, { userId }),

  // Workers and enrollment
  listWorkers: (spaceId?: string) =>
    request<WorkerNode[]>('GET', spaceId ? `/api/workers?spaceId=${enc(spaceId)}` : '/api/workers'),
  listEnrollments: (spaceId: string) =>
    request<EnrollmentRecord[]>('GET', `/api/enrollments?spaceId=${enc(spaceId)}`),
  /** Every token the caller issued, in any space. */
  listMyEnrollments: () => request<EnrollmentRecord[]>('GET', '/api/enrollments'),
  /** Lets the worker behind a token serve one more space, without restarting it. */
  addEnrollmentSpace: (id: string, spaceId: string) =>
    request<EnrollmentRecord>('POST', `/api/enrollments/${enc(id)}/spaces`, { spaceId }),
  issueEnrollment: (input: { spaceIds: string[]; label?: string; expiresAt?: number }) =>
    request<WorkerEnrollmentToken>('POST', '/api/enrollments', input),
  revokeEnrollment: (id: string) =>
    request<{ revoked: true }>('POST', `/api/enrollments/${enc(id)}/revoke`),

  // Sessions
  listSessions: (spaceId: string) =>
    request<SessionItem[]>('GET', `/api/sessions?spaceId=${enc(spaceId)}`),
  getSession: (id: string) => request<Session>('GET', `/api/sessions/${enc(id)}`),
  sessionEvents: (id: string, afterSeq: number) =>
    request<CanonicalEvent[]>('GET', `/api/sessions/${enc(id)}/events?afterSeq=${afterSeq}`),
  sessionRuns: (id: string) => request<Run[]>('GET', `/api/sessions/${enc(id)}/runs`),
  streamToken: (id: string) =>
    request<{ token: string }>('POST', `/api/sessions/${enc(id)}/stream-token`),
  sendMailbox: (id: string, content: string) =>
    request<unknown>('POST', `/api/sessions/${enc(id)}/mailbox`, { content }),
  abortRun: (sessionId: string, runId: string) =>
    request<{ interrupted: boolean }>(
      'POST',
      `/api/sessions/${enc(sessionId)}/runs/${enc(runId)}/abort`
    ),
  closeSession: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/close`),

  // Tickets
  listTickets: (spaceId?: string) =>
    request<Ticket[]>('GET', spaceId ? `/api/tickets?spaceId=${enc(spaceId)}` : '/api/tickets'),
  getTicket: (id: string) => request<Ticket>('GET', `/api/tickets/${enc(id)}`),
  ticketRuns: (id: string) => request<TicketRun[]>('GET', `/api/tickets/${enc(id)}/runs`),
  createTicket: (input: CreateTicketInput) => request<Ticket>('POST', '/api/tickets', input),
  ticketAction: (id: string, action: 'cancel' | 'requeue' | 'abandon') =>
    request<Ticket>('POST', `/api/tickets/${enc(id)}/${action}`),

  // Schedules
  listSchedules: (spaceId: string) =>
    request<ScheduleItem[]>('GET', `/api/schedules?spaceId=${enc(spaceId)}`),
  createSchedule: (input: CreateScheduleInput) =>
    request<Schedule>('POST', '/api/schedules', input),
  cancelSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/cancel`),

  // Memory
  listMemory: (spaceId: string) =>
    request<MemoryMeta[]>('GET', `/api/memory?spaceId=${enc(spaceId)}&limit=500`),
  searchMemory: (spaceId: string, query: string) =>
    request<MemorySearchHit[]>(
      'GET',
      `/api/memory/search?spaceId=${enc(spaceId)}&q=${enc(query)}&limit=50`
    ),
  /** Reads a full entry, following byte-window pagination until the body is complete. */
  readMemory: async (spaceId: string, path: string): Promise<MemoryEntry> => {
    const url = (offset: number): string =>
      `/api/memory/${path.split('/').map(enc).join('/')}?spaceId=${enc(spaceId)}&offset=${offset}`;
    type Window = MemoryEntry & { nextOffset: number; totalBytes: number };
    const first = await request<Window>('GET', url(0));
    let content = first.content;
    let offset = first.nextOffset;
    while (offset < first.totalBytes) {
      const next = await request<Window>('GET', url(offset));
      if (next.revision !== first.revision)
        throw new Error('The entry changed while loading. Reload it to continue.');
      if (next.nextOffset <= offset) throw new Error('Memory read did not advance');
      content += next.content;
      offset = next.nextOffset;
    }
    const { nextOffset: _next, totalBytes: _total, ...entry } = first;
    return { ...entry, content };
  },
  writeMemory: (spaceId: string, path: string, body: MemoryWriteBody) =>
    request<MemoryMeta>(
      'PUT',
      `/api/memory/${path.split('/').map(enc).join('/')}?spaceId=${enc(spaceId)}`,
      body
    ),
  deleteMemory: (spaceId: string, path: string, revision: number) =>
    request<{ revision: number }>(
      'DELETE',
      `/api/memory/${path.split('/').map(enc).join('/')}?spaceId=${enc(spaceId)}&expected_revision=${revision}`
    ),

  // Global registries (admin)
  modelOptions: () => request<ModelOption[]>('GET', '/api/model-options'),
  listModels: () => request<ModelEntry[]>('GET', '/api/models'),
  saveModel: (input: ModelInput) => request<ModelEntry>('PUT', '/api/models', input),
  deleteModel: (id: string) => request<{ deleted: true }>('DELETE', `/api/models/${enc(id)}`),
  listChannels: () => request<Channel[]>('GET', '/api/channels'),
  createChannel: (input: ChannelInput) => request<Channel>('POST', '/api/channels', input),
  updateChannel: (id: string, input: Partial<ChannelInput>) =>
    request<Channel>('PATCH', `/api/channels/${enc(id)}`, input),
  deleteChannel: (id: string) => request<{ deleted: true }>('DELETE', `/api/channels/${enc(id)}`),
};
