// The options module's durable state: one JSON document in its own database (options.sqlite), written whole on every
// change, as the workbench writes engine_state.json atomically. The main database is untouched, so rolling back to a
// version without the module needs no migration. A document that does not parse, has another version or belongs to
// another Bybit account refuses start. G2b adds two tables beside the document: the fills ledger (every execution of the
// service's own orders, uncapped) and the 收益 samples (append-only); an older version does not read them.
import { DatabaseSync } from 'node:sqlite';
import type { ExecutionRecord } from './account.ts';
import type { Sample } from './performance.ts';

export const OPTIONS_STATE_VERSION = 1;

export interface OptionsStore {
  load(): unknown | null;
  save(document: unknown): void;
  /** Inserts or replaces ledger rows by execution id, all in one transaction. */
  saveExecutions(records: readonly ExecutionRecord[]): void;
  executions(): ExecutionRecord[];
  addSample(groupId: string, sample: Sample): void;
  samples(): Map<string, Sample[]>;
  close(): void;
}

export function openOptionsStore(file: string): OptionsStore {
  const db = new DatabaseSync(file);
  try {
    const mode = (db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
    if (mode !== 'wal') throw new Error(`期权状态库未能进入 WAL 模式：${mode}`);
    db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL); '
      + 'CREATE TABLE IF NOT EXISTS executions (exec_id TEXT PRIMARY KEY, exec_time INTEGER NOT NULL, json TEXT NOT NULL); '
      + 'CREATE TABLE IF NOT EXISTS samples (group_id TEXT NOT NULL, time INTEGER NOT NULL, pnl TEXT NOT NULL, PRIMARY KEY (group_id, time))');
  } catch (error) { db.close(); throw error; }
  const read = db.prepare('SELECT version, json FROM state WHERE id = 1');
  const write = db.prepare('INSERT INTO state (id, version, json, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at');
  const writeExecution = db.prepare('INSERT INTO executions (exec_id, exec_time, json) VALUES (?, ?, ?) ON CONFLICT(exec_id) DO UPDATE SET exec_time = excluded.exec_time, json = excluded.json');
  const readExecutions = db.prepare('SELECT json FROM executions ORDER BY exec_time, exec_id');
  const writeSample = db.prepare('INSERT OR REPLACE INTO samples (group_id, time, pnl) VALUES (?, ?, ?)');
  const readSamples = db.prepare('SELECT group_id, time, pnl FROM samples ORDER BY group_id, time');
  return {
    load() {
      const row = read.get() as { version: number; json: string } | undefined;
      if (!row) return null;
      if (row.version !== OPTIONS_STATE_VERSION) throw new Error(`期权状态库版本 ${row.version} 不是本版本能读的 ${OPTIONS_STATE_VERSION}`);
      try { return JSON.parse(row.json); } catch { throw new Error('期权状态库内容无法解析'); }
    },
    save(document) { write.run(OPTIONS_STATE_VERSION, JSON.stringify(document), Date.now()); },
    saveExecutions(records) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const record of records) writeExecution.run(record.execId, record.execTime, JSON.stringify(record));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    executions() {
      return (readExecutions.all() as { json: string }[]).map(row => { try { return JSON.parse(row.json) as ExecutionRecord; } catch { throw new Error('期权成交台账内容无法解析'); } });
    },
    addSample(groupId, sample) { writeSample.run(groupId, sample.time, sample.pnl); },
    samples() {
      const result = new Map<string, Sample[]>();
      for (const row of readSamples.all() as { group_id: string; time: number; pnl: string }[]) {
        const list = result.get(row.group_id) ?? [];
        list.push({ time: Number(row.time), pnl: row.pnl });
        result.set(row.group_id, list);
      }
      return result;
    },
    close() { db.close(); },
  };
}
