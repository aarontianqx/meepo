import type { Space, SpaceMember, Ticket, WorkerEnrollmentToken, WorkerNode } from '@meepo/core';

const USER_STORAGE_KEY = 'meepo.userId';

let currentUserId: string = localStorage.getItem(USER_STORAGE_KEY) ?? '';

export function getUserId(): string {
  return currentUserId;
}

export function setUserId(userId: string): void {
  currentUserId = userId.trim();
  localStorage.setItem(USER_STORAGE_KEY, currentUserId);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      'x-meepo-user-id': currentUserId,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `${method} ${path} failed with status ${res.status}`;
    try {
      const payload = (await res.json()) as ErrorPayload;
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
    } catch {
      // error body was not JSON; keep defaults
    }
    throw new ApiError(res.status, code, message);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(res.status, 'bad_response', `${method} ${path} returned non-JSON body`);
  }
}

export interface HealthStatus {
  status: string;
  uptimeSeconds: number;
  timestamp: number;
}

export interface CreateSpaceInput {
  name: string;
  repoUrl: string;
  description?: string;
  defaultBranch?: string;
  requiredTags?: string[];
  timezone?: string;
}

export interface IssueEnrollmentInput {
  spaceIds: string[];
  label?: string;
  expiresAt?: number;
}

export interface CreateTicketInput {
  spaceId: string;
  title: string;
  objective: string;
  contextSummary?: string;
  requiredTags?: string[];
}

export const api = {
  health: () => request<HealthStatus>('GET', '/healthz'),

  listSpaces: () => request<Space[]>('GET', '/api/spaces'),
  createSpace: (input: CreateSpaceInput) => request<Space>('POST', '/api/spaces', input),
  getSpace: (spaceId: string) =>
    request<Space>('GET', `/api/spaces/${encodeURIComponent(spaceId)}`),
  bindChat: (spaceId: string, chatId: string) =>
    request<Space>('POST', `/api/spaces/${encodeURIComponent(spaceId)}/chats`, { chatId }),
  unbindChat: (spaceId: string, chatId: string) =>
    request<Space>(
      'DELETE',
      `/api/spaces/${encodeURIComponent(spaceId)}/chats/${encodeURIComponent(chatId)}`
    ),
  updateMemory: (spaceId: string, longTermMemory: string) =>
    request<Space>('PUT', `/api/spaces/${encodeURIComponent(spaceId)}/memory`, { longTermMemory }),
  switchBinding: (spaceId: string, workerId: string) =>
    request<Space>('POST', `/api/spaces/${encodeURIComponent(spaceId)}/binding`, { workerId }),

  listMembers: (spaceId: string) =>
    request<SpaceMember[]>('GET', `/api/spaces/${encodeURIComponent(spaceId)}/members`),
  addMember: (spaceId: string, userId: string) =>
    request<SpaceMember>('POST', `/api/spaces/${encodeURIComponent(spaceId)}/members`, { userId }),

  issueEnrollment: (input: IssueEnrollmentInput) =>
    request<WorkerEnrollmentToken>('POST', '/api/enrollments', input),

  listWorkers: (spaceId?: string) =>
    request<WorkerNode[]>(
      'GET',
      spaceId ? `/api/workers?spaceId=${encodeURIComponent(spaceId)}` : '/api/workers'
    ),

  listTickets: (spaceId?: string) =>
    request<Ticket[]>(
      'GET',
      spaceId ? `/api/tickets?spaceId=${encodeURIComponent(spaceId)}` : '/api/tickets'
    ),
  createTicket: (input: CreateTicketInput) => request<Ticket>('POST', '/api/tickets', input),
};
