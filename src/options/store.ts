// The options module's durable state: one JSON document in its own database (options.sqlite), written whole on every
// change, as the workbench writes engine_state.json atomically. The main database is untouched, so rolling back to a
// version without the module needs no migration. A document that does not parse, has another version or belongs to
// another Bybit account refuses start.
import { DatabaseSync } from 'node:sqlite';

export const OPTIONS_STATE_VERSION = 1;

export interface OptionsStore {
  load(): unknown | null;
  save(document: unknown): void;
  close(): void;
}

export function openOptionsStore(file: string): OptionsStore {
  const db = new DatabaseSync(file);
  try {
    const mode = (db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
    if (mode !== 'wal') throw new Error(`期权状态库未能进入 WAL 模式：${mode}`);
    db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  } catch (error) { db.close(); throw error; }
  const read = db.prepare('SELECT version, json FROM state WHERE id = 1');
  const write = db.prepare('INSERT INTO state (id, version, json, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at');
  return {
    load() {
      const row = read.get() as { version: number; json: string } | undefined;
      if (!row) return null;
      if (row.version !== OPTIONS_STATE_VERSION) throw new Error(`期权状态库版本 ${row.version} 不是本版本能读的 ${OPTIONS_STATE_VERSION}`);
      try { return JSON.parse(row.json); } catch { throw new Error('期权状态库内容无法解析'); }
    },
    save(document) { write.run(OPTIONS_STATE_VERSION, JSON.stringify(document), Date.now()); },
    close() { db.close(); },
  };
}
