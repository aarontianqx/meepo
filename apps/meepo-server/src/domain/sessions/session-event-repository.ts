export interface SessionEventRecord {
  sessionId: string;
  runId?: string;
  clientSeq?: number;
  seq: number;
  type: string;
  payload: unknown;
  timestamp: number;
}

export interface EventQuery {
  afterSeq?: number;
  beforeSeq?: number;
  beforeTimestamp?: number;
  limit?: number;
  type?: string;
  includeHistoryNotes?: boolean;
}
/** Append-only event stream backing a session's transcript. */
export interface SessionEventRepository {
  hasImage(sessionId: string, messageId: string, fileKey: string): Promise<boolean>;
  append(
    sessionId: string,
    type: string,
    payload: unknown,
    timestamp?: number
  ): Promise<SessionEventRecord>;
  listBySession(sessionId: string, query?: EventQuery): Promise<SessionEventRecord[]>;
  latestSeq(sessionId: string): Promise<number>;
}
