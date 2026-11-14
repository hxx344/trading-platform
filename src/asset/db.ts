// asset.sqlite: the workbench ledger tables without the owner column (this service has one user). The statement
// wrapper keeps the shape of project_aggregation modules/asset/lib/sqlite.ts (0014655) so the copied readers run as they
// are; the migrations, the batch helper and the backup are not copied. Two writers share the file (WAL): import.ts
// replaces the whole ledger in one transaction, and the service (store.ts, since A-2) edits it under the sync lock
// (sync-lock.ts). The lock table is the workbench's sync_locks without its owner column: one row, id 1. The connections
// table (A-3/A-4) is the workbench's without its owner column: one sealed credential per connection name
// (credentials.ts); the import replaces it with the ledger.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { QueryDatabase, QueryStatement, QueryValue } from './query.ts';

export const ASSET_DB_FILE = 'asset.sqlite';
const LOCK_TABLE = 'CREATE TABLE IF NOT EXISTS sync_locks (id INTEGER PRIMARY KEY CHECK (id = 1), expires INTEGER NOT NULL, token TEXT NOT NULL);';
const CONNECTIONS_TABLE = 'CREATE TABLE IF NOT EXISTS connections (exchange TEXT PRIMARY KEY NOT NULL, encrypted TEXT NOT NULL, updated_at TEXT NOT NULL);';
const SCHEMA = `CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (date TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
${LOCK_TABLE}
${CONNECTIONS_TABLE}`;

class Statement implements QueryStatement {
  private connection: DatabaseSync;
  private sql: string;
  private values: QueryValue[];
  constructor(connection: DatabaseSync, sql: string, values: QueryValue[] = []) {
    this.connection = connection; this.sql = sql; this.values = values;
  }
  bind(...values: QueryValue[]): Statement { return new Statement(this.connection, this.sql, values); }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.connection.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.connection.prepare(this.sql).all(...this.values) as T[] };
  }
  /** Synchronous reads for code inside a transaction (the sync lock), which must not await. */
  get<T = Record<string, unknown>>(): T | null {
    return (this.connection.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  /** Synchronous form of all() for code inside a transaction. */
  rows<T = Record<string, unknown>>(): T[] { return this.connection.prepare(this.sql).all(...this.values) as T[]; }
  run(): number { return Number(this.connection.prepare(this.sql).run(...this.values).changes); }
}

export interface AssetDb extends QueryDatabase {
  prepare(sql: string): Statement;
  /** Runs `run` in one immediate transaction (BEGIN IMMEDIATE waits up to busy_timeout for the other writer); it must stay synchronous. */
  transaction<T>(run: () => T): T;
  /** The import's name for transaction(). */
  replace(write: () => void): void;
  close(): void;
}

/**
 * `import` (the default) creates the tables and WAL; `read` opens an existing file without creating it or touching its
 * schema; `service` opens an existing file for the service's edits: it only adds the lock and connections tables (a file
 * imported before A-3 has no connections table) and proves it can write
 * (a file the service account cannot write opens read-only in SQLite and fails only at the first write).
 */
export type AssetDbMode = 'import' | 'read' | 'service';
const SETUP: Record<AssetDbMode, string> = {
  import: `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; ${SCHEMA}`,
  read: 'PRAGMA busy_timeout = 5000;',
  // node:sqlite waits synchronously, so the service, which also runs ADL and transfers, waits at most a second for an
  // import's transaction (the import itself waits 5 s); a write that cannot get the file in time answers 503.
  service: `PRAGMA busy_timeout = 1000; ${LOCK_TABLE} ${CONNECTIONS_TABLE} DELETE FROM sync_locks WHERE 0;`,
};

export function openAssetDb(file: string, { readOnly = false, mode = readOnly ? 'read' : 'import' }: { readOnly?: boolean; mode?: AssetDbMode } = {}): AssetDb {
  const connection = mode === 'read' ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
  try { connection.exec(SETUP[mode]); } catch (error) { connection.close(); throw error; }
  const transaction = <T>(run: () => T): T => {
    connection.exec('BEGIN IMMEDIATE');
    try { const result = run(); connection.exec('COMMIT'); return result; }
    catch (error) {
      // SQLite may have rolled back already; the first error is the one to report.
      try { connection.exec('ROLLBACK'); } catch { /* nothing left to roll back */ }
      throw error;
    }
  };
  return {
    prepare: sql => new Statement(connection, sql),
    transaction,
    replace: write => transaction(write),
    close: () => connection.close(),
  };
}

/** asset.sqlite and its side files must be plain files of this account: one left by root (a hand import) is not taken over. */
export function assertOwnFiles(dataDir: string, uid = process.getuid?.()): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = join(dataDir, ASSET_DB_FILE + suffix);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) throw new Error(`${path} 不是普通文件，未改动`);
    if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} 归 uid ${stat.uid}，不归服务账户（uid ${uid}），未改动；请把它改回服务账户所有（chown）后重试`);
  }
}
