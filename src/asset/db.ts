// asset.sqlite: the workbench ledger tables without the owner column (this service has one user). The statement
// wrapper keeps the shape of project_aggregation modules/asset/lib/sqlite.ts (0014655) so the copied readers run as they
// are; the migrations, the batch helper and the backup are not copied. Two writers share the file (WAL): import.ts
// replaces the whole ledger in one transaction, and the service (store.ts, since A-2) edits it under the sync lock
// (sync-lock.ts). The lock table is the workbench's sync_locks without its owner column: one row, id 1. The connections
// table (A-3/A-4) is the workbench's without its owner column: one sealed credential per connection name
// (credentials.ts); the import replaces it with the ledger. The fill_cache table (A-5) is the workbench's
// (drizzle/0002_fill_cache.sql at 7745181) without its owner column: the fills of one account and scope (slot) stored under
// the credential revision they were read with (fills-service.ts); the import empties it with the connections. A version
// before A-5 never reads it and leaves it alone. The service answers its reads from a second, read-only connection
// (mode `snapshot`), each answer in one short read transaction (snapshot() below), so an import committed between two of
// its statements cannot mix two ledgers in one answer (issue #11).
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { QueryDatabase, QueryStatement, QueryValue } from './query.ts';
import { HISTORY_TABLE } from './history-cache.ts';
import { POSITION_SNAPSHOT_TABLE } from './position-snapshots.ts';

export const ASSET_DB_FILE = 'asset.sqlite';
const LOCK_TABLE = 'CREATE TABLE IF NOT EXISTS sync_locks (id INTEGER PRIMARY KEY CHECK (id = 1), expires INTEGER NOT NULL, token TEXT NOT NULL);';
const CONNECTIONS_TABLE = 'CREATE TABLE IF NOT EXISTS connections (exchange TEXT PRIMARY KEY NOT NULL, encrypted TEXT NOT NULL, updated_at TEXT NOT NULL);';
const FILL_CACHE_TABLE = 'CREATE TABLE IF NOT EXISTS fill_cache (account TEXT NOT NULL, scope TEXT NOT NULL, revision TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (account, scope));';
const SCHEMA = `CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (date TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
${LOCK_TABLE}
${CONNECTIONS_TABLE}
${FILL_CACHE_TABLE}
${POSITION_SNAPSHOT_TABLE}
${HISTORY_TABLE}`;

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

/** Thrown by a statement of a snapshot read started after its transaction ended (a reader that awaited before a query). */
export const SNAPSHOT_CLOSED = '资产库读取事务已结束：一次应答的查询必须在同一读取事务里同步发出';

/** A statement of one snapshot read: it runs only while that read transaction is open. */
class SnapshotStatement implements QueryStatement {
  private inner: Statement;
  private live: () => void;
  constructor(inner: Statement, live: () => void) { this.inner = inner; this.live = live; }
  bind(...values: QueryValue[]): SnapshotStatement { return new SnapshotStatement(this.inner.bind(...values), this.live); }
  async first<T = Record<string, unknown>>(): Promise<T | null> { this.live(); return this.inner.get<T>(); }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> { this.live(); return { results: this.inner.rows<T>() }; }
  get<T = Record<string, unknown>>(): T | null { this.live(); return this.inner.get<T>(); }
  rows<T = Record<string, unknown>>(): T[] { this.live(); return this.inner.rows<T>(); }
}
/** The database a snapshot read sees: the async readers (QueryDatabase) and synchronous get/rows. */
export interface SnapshotDb extends QueryDatabase { prepare(sql: string): SnapshotStatement }

export interface AssetDb extends QueryDatabase {
  prepare(sql: string): Statement;
  /**
   * Runs `read` in one deferred read transaction: every statement it issues before returning sees the same committed
   * state of the file. `read` may return a promise (the async readers), but their statements must all start before it
   * returns: one issued after the transaction ended throws SNAPSHOT_CLOSED instead of reading a later state. The
   * transaction never spans an await, so it neither holds the connection across other work nor blocks a writer (WAL);
   * an exception rolls it back before it propagates.
   */
  snapshot<T>(read: (database: SnapshotDb) => T): T;
  /** Runs `run` in one immediate transaction (BEGIN IMMEDIATE waits up to busy_timeout for the other writer); it must stay synchronous. */
  transaction<T>(run: () => T): T;
  /** The import's name for transaction(). */
  replace(write: () => void): void;
  close(): void;
}

/**
 * `import` (the default) creates the tables and WAL; `read` opens an existing file without creating it or touching its
 * schema; `service` opens an existing file for the service's edits: it only adds the lock, connections and fill_cache tables
 * (a file imported before A-3 has no connections table, one before A-5 no fill_cache) and proves it can write
 * (a file the service account cannot write opens read-only in SQLite and fails only at the first write); `snapshot` is
 * `read` for the service's answers (store.ts): it waits at most a second, like `service`, because node:sqlite waits on
 * the event loop.
 */
export type AssetDbMode = 'import' | 'read' | 'service' | 'snapshot';
const SETUP: Record<AssetDbMode, string> = {
  import: `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; ${SCHEMA}`,
  read: 'PRAGMA busy_timeout = 5000;',
  snapshot: 'PRAGMA busy_timeout = 1000;',
  // node:sqlite waits synchronously, so the service, which also runs ADL and transfers, waits at most a second for an
  // import's transaction (the import itself waits 5 s); a write that cannot get the file in time answers 503.
  service: `PRAGMA busy_timeout = 1000; ${LOCK_TABLE} ${CONNECTIONS_TABLE} ${FILL_CACHE_TABLE} ${POSITION_SNAPSHOT_TABLE} ${HISTORY_TABLE} DELETE FROM sync_locks WHERE 0;`,
};

export function openAssetDb(file: string, { readOnly = false, mode = readOnly ? 'read' : 'import' }: { readOnly?: boolean; mode?: AssetDbMode } = {}): AssetDb {
  const connection = mode === 'read' || mode === 'snapshot' ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
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
  const snapshot = <T>(read: (database: SnapshotDb) => T): T => {
    connection.exec('BEGIN');
    let open = true;
    const live = () => { if (!open) throw new Error(SNAPSHOT_CLOSED); };
    try {
      const result = read({ prepare: sql => new SnapshotStatement(new Statement(connection, sql), live) });
      open = false;
      connection.exec('COMMIT');
      return result;
    } catch (error) {
      open = false;
      try { connection.exec('ROLLBACK'); } catch { /* nothing left to roll back */ }
      throw error;
    }
  };
  return {
    prepare: sql => new Statement(connection, sql),
    snapshot,
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
