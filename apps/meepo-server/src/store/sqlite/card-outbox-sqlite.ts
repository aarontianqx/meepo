import { isTerminalRun } from '@meepo/core';
import { rowToRun, type RunRow } from './run-sqlite.js';
import type { Database } from 'better-sqlite3';
import type { CardOutbox, CardProjection } from '../../domain/outbound/card-outbox.js';
export class SqliteCardOutbox implements CardOutbox {
  private readonly terminalCursors = new Map<string, number>();
  constructor(private readonly db: Database) {}
  /** Rebuild render work lost between journal commit and the in-memory render hook. */
  reconcile(channelId: string): void {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM runs r JOIN sessions s ON s.id=json_extract(r.work,'$.turnRef.sessionId')
         WHERE s.channel_id=? AND r.status='running'
         UNION SELECT r.* FROM runs r JOIN sessions s ON s.id=json_extract(r.work,'$.turnRef.sessionId')
         WHERE s.channel_id=? AND r.status IN ('completed','failed') AND r.completed_at>=?
         UNION SELECT r.* FROM card_outbox c JOIN runs r ON r.id=c.run_id WHERE c.channel_id=? AND c.pending=1`
      )
      .all(channelId, channelId, this.terminalCursors.get(channelId) ?? 0, channelId) as RunRow[];
    this.terminalCursors.set(
      channelId,
      rows.reduce(
        (max, r) => Math.max(max, r.completed_at ?? 0),
        this.terminalCursors.get(channelId) ?? 0
      )
    );
    for (const row of rows) {
      const run = rowToRun(row);
      if (run.work.kind !== 'turn') continue;
      let p = this.get(run.id);
      if (
        p &&
        (p.state !== 'streaming' ||
          (!isTerminalRun(run.status) && p.committedTextLength !== undefined))
      )
        continue;
      const events = this.db
        .prepare('SELECT type,payload FROM run_events WHERE run_id=? ORDER BY client_seq')
        .all(run.id) as { type: string; payload: string }[];
      p ??= {
        runId: run.id,
        sessionId: run.work.turnRef.sessionId,
        channelId,
        text: '',
        thinking: '',
        tools: {},
        sequence: 0,
        part: 0,
        offset: 0,
        state: 'streaming',
        dirty: false,
        updatedAt: Date.now(),
      };
      const texts: string[] = [];
      for (const e of events) {
        const payload = JSON.parse(e.payload) as {
          content?: string;
          toolCallId?: string;
          toolName?: string;
          isError?: boolean;
        };
        if (e.type === 'assistant_text') texts.push(payload.content ?? '');
        if (e.type === 'tool_call' && payload.toolCallId)
          p.tools[payload.toolCallId] = { name: payload.toolName ?? 'tool', state: 'running' };
        if (e.type === 'tool_result' && payload.toolCallId && p.tools[payload.toolCallId])
          p.tools[payload.toolCallId].state = payload.isError ? 'failed' : 'completed';
      }
      const canonicalText = texts.join('\n\n');
      if (run.status === 'completed' || canonicalText.length > p.text.length)
        p.text = canonicalText;
      p.committedTextLength = canonicalText.length;
      if (run.status === 'failed') {
        p.state = 'failed';
        p.failure = run.terminalReason ?? 'failed';
      }
      if (run.status === 'completed') p.state = 'completed';
      p.dirty = true;
      this.save(p);
    }
  }
  get(runId: string): CardProjection | undefined {
    const row = this.db.prepare('SELECT data FROM card_outbox WHERE run_id=?').get(runId) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as CardProjection) : undefined;
  }
  listPending(channelId: string): CardProjection[] {
    return (
      this.db
        .prepare('SELECT data FROM card_outbox WHERE channel_id=? AND pending=1')
        .all(channelId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as CardProjection);
  }
  save(p: CardProjection): void {
    this.db
      .prepare(
        'INSERT INTO card_outbox(run_id,channel_id,data,pending) VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data,pending=excluded.pending'
      )
      .run(p.runId, p.channelId, JSON.stringify(p), +(p.dirty || p.state === 'streaming'));
  }
}
