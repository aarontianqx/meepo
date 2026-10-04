import type { Database } from 'better-sqlite3';
import type { CompactionSnapshot } from '@meepo/protocol';
import type { CompactionRepository } from '../../domain/sessions/compaction-repository.js';
export class SqliteCompactionRepository implements CompactionRepository {
  constructor(private readonly db: Database) {}
  latest(sessionId: string, beforeSeq: number): CompactionSnapshot | undefined {
    return this.db
      .prepare(
        'SELECT summary,covers_through_seq AS coversThroughSeq FROM session_compactions WHERE session_id=? AND covers_through_seq<? AND degraded=0 ORDER BY covers_through_seq DESC LIMIT 1'
      )
      .get(sessionId, beforeSeq) as CompactionSnapshot | undefined;
  }
  TxSave(sessionId: string, snapshot: CompactionSnapshot, degraded: boolean): void {
    this.db.transaction(() => {
      const saved = degraded
        ? this.db
            .prepare(
              'INSERT OR IGNORE INTO session_compactions(session_id,covers_through_seq,summary,created_at,degraded) VALUES(?,?,?,?,?)'
            )
            .run(sessionId, snapshot.coversThroughSeq, snapshot.summary, Date.now(), 1)
        : this.db
            .prepare(
              'INSERT OR REPLACE INTO session_compactions(session_id,covers_through_seq,summary,created_at,degraded) VALUES(?,?,?,?,?)'
            )
            .run(sessionId, snapshot.coversThroughSeq, snapshot.summary, Date.now(), 0);
      if (saved.changes && degraded)
        this.db
          .prepare(
            `INSERT INTO session_events(session_id,seq,type,payload,timestamp)
        VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM session_events WHERE session_id=?),'system_note',?,?)`
          )
          .run(
            sessionId,
            sessionId,
            JSON.stringify({
              content: '历史摘要生成失败，部分早期上下文已截断。原始事件仍可在 Console 查询。',
              coversThroughSeq: snapshot.coversThroughSeq,
            }),
            Date.now()
          );
    })();
  }
}
