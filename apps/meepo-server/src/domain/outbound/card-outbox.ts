export interface CardProjection {
  runId: string;
  sessionId: string;
  channelId: string;
  text: string;
  /** Boundary of canonical assistant messages; deltas after it are replaceable. */
  committedTextLength?: number;
  thinking: string;
  tools: Record<string, { name: string; state: 'running' | 'completed' | 'failed' }>;
  failure?: string;
  sendStartedAt?: number;
  cardId?: string;
  replied?: boolean;
  sequence: number;
  part: number;
  offset: number;
  state: 'streaming' | 'completed' | 'failed';
  dirty: boolean;
  updatedAt: number;
}
export interface CardOutbox {
  get(runId: string): CardProjection | undefined;
  listPending(channelId: string): CardProjection[];
  save(projection: CardProjection): void;
}
