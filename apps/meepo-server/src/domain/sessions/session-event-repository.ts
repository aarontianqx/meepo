export interface SessionEventRecord {
  sessionId: string;
  seq: number;
  type: string;
  payload: unknown;
  timestamp: number;
}

/** Append-only event stream backing a session's transcript. */
export interface SessionEventRepository {
  append(
    sessionId: string,
    type: string,
    payload: unknown,
    timestamp?: number
  ): Promise<SessionEventRecord>;
  listBySession(sessionId: string): Promise<SessionEventRecord[]>;
  latestSeq(sessionId: string): Promise<number>;
}
