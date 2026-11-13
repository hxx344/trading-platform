// asset.sqlite: the workbench ledger tables without the owner column (this service has one user). The statement
// wrapper keeps the shape of project_aggregation modules/asset/lib/sqlite.ts (0014655) so the copied readers run as they
// are; the migrations, the batch/transaction helpers and the backup are not copied. The service only reads; import.ts
// is the one writer.
import { DatabaseSync } from 'node:sqlite';
import type { QueryDatabase, QueryStatement, QueryValue } from './query.ts';

export const ASSET_DB_FILE = 'asset.sqlite';
const SCHEMA = `CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (date TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);`;

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
  run(): number { return Number(this.connection.prepare(this.sql).run(...this.values).changes); }
}

export interface AssetDb extends QueryDatabase {
  prepare(sql: string): Statement;
  /** Runs `write` in one immediate transaction; it must stay synchronous. */
  replace(write: () => void): void;
  close(): void;
}

/** `readOnly` opens an existing file without creating it or touching its schema (the service). */
export function openAssetDb(file: string, { readOnly = false }: { readOnly?: boolean } = {}): AssetDb {
  const connection = readOnly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
  try {
    connection.exec(readOnly ? 'PRAGMA busy_timeout = 5000;' : `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; ${SCHEMA}`);
  } catch (error) { connection.close(); throw error; }
  return {
    prepare: sql => new Statement(connection, sql),
    replace(write) {
      connection.exec('BEGIN IMMEDIATE');
      try { write(); connection.exec('COMMIT'); }
      catch (error) { connection.exec('ROLLBACK'); throw error; }
    },
    close: () => connection.close(),
  };
}
