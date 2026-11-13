/** HTTP transport for the control-plane API: identity header, error envelope, JSON parsing. */

const USER_STORAGE_KEY = 'meepo.userId';

let currentUserId: string = localStorage.getItem(USER_STORAGE_KEY) ?? '';

export function getUserId(): string {
  return currentUserId;
}

/** Persists the acting user (development header authenticator). */
export function setUserId(userId: string): void {
  currentUserId = userId.trim();
  localStorage.setItem(USER_STORAGE_KEY, currentUserId);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentRevision?: number;

  constructor(status: number, code: string, message: string, currentRevision?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string; currentRevision?: number };
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      // Without a locally chosen identity send none: the server (or an SSO proxy in front of it)
      // decides who the caller is, and GET /api/me reports the result.
      ...(currentUserId ? { 'x-meepo-user-id': currentUserId } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `${method} ${path} failed with status ${res.status}`;
    let currentRevision: number | undefined;
    try {
      const payload = (await res.json()) as ErrorPayload;
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
      currentRevision = payload.error?.currentRevision;
    } catch {
      // error body was not JSON; keep defaults
    }
    throw new ApiError(res.status, code, message, currentRevision);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(res.status, 'bad_response', `${method} ${path} returned a non-JSON body`);
  }
}

/** Human-friendly message for any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const enc = encodeURIComponent;
