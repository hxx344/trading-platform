// The CrossEx module's database (docs/crossex.md §3): <dataDir>/crossex.sqlite with the interface the vendored market
// and live runtime use (the workbench store.mjs). It replaces the workbench store in two ways:
// - No key material is kept: there is no credentials.key, and the Gate key and secret stay in secrets.json. encrypt()
//   only turns the configured key or secret into a marker naming it, so the runtime's live_connection row holds
//   `secrets:gate.apiKey` / `secrets:gate.apiSecret`; decrypt() reads a marker back from secrets.json. Anything else
//   (say a Monitor password) is refused.
// - config() never answers more than config.json crossex.limits allow: notionalPerLeg, maxOpen and maxTotalNotional are
//   min(stored, cap), so the page's settings can lower the caps but never raise them.
// Paper-trading tables of the workbench (positions, executions, samples, events) are not created.
import { chmodSync, closeSync, openSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { join } from 'node:path';
import { defaults, type CrossexConfig } from '../vendor/crossex/model.mjs';
import { createStatementCache } from '../vendor/crossex/statement-cache.mjs';

export const CROSSEX_DATABASE = 'crossex.sqlite';
export const KEY_MARKER = 'secrets:gate.apiKey';
export const SECRET_MARKER = 'secrets:gate.apiSecret';
/** The page settings copied in by the workbench import (import-crossex.ts) and kept under the `config` key. */
export const PAGE_SETTING_KEYS = ['entryPaused', 'slippageBps', 'cooldownSeconds', 'feeBps', 'feeSchedule', 'minNetBps', 'notionalPerLeg', 'maxOpen', 'maxTotalNotional'] as const;

export interface CrossexLimits { notionalPerLeg: number; maxOpen: number; maxTotalNotional: number }
export interface GateSecret { apiKey: string; apiSecret: string }

export interface CrossexStore {
  db: DatabaseSync;
  prepare(sql: string): StatementSync;
  get<T = unknown>(name: string, fallback?: T): T;
  set(name: string, value: unknown): void;
  encrypt(value: string): string;
  decrypt(value: string | null | undefined): string;
  config(): CrossexConfig;
  transaction<T>(callback: () => T): T;
  close(): void;
}

/** The settings table and its pragmas; the import writer (crossex/import-writer.ts) uses the same. */
export function openCrossexDatabase(file: string): DatabaseSync {
  // Created owner-only before SQLite opens it; an existing file is tightened too.
  closeSync(openSync(file, 'a', 0o600));
  chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  try {
    const mode = (db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
    if (mode !== 'wal') throw new Error(`CrossEx 数据库未能进入 WAL 模式：${mode}`);
    db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  } catch (error) { db.close(); throw error; }
  return db;
}

export function openCrossexStore(dataDir: string, { secret, limits }: { secret: GateSecret; limits: CrossexLimits }): CrossexStore {
  const apiKey = secret.apiKey.trim(), apiSecret = secret.apiSecret.trim();
  const db = openCrossexDatabase(join(dataDir, CROSSEX_DATABASE));
  const statements = createStatementCache(db), prepare = statements.prepare;
  const get = <T>(name: string, fallback: T = null as T): T => {
    const row = prepare('SELECT value FROM settings WHERE key=?').get(name) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  };
  const set = (name: string, value: unknown): void => { prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value)); };
  return {
    db, prepare, get, set,
    encrypt(value) {
      // The runtime stores what it was given to connect with; only the configured key and secret have a name.
      if (value === apiKey) return KEY_MARKER;
      if (value === apiSecret) return SECRET_MARKER;
      throw new Error('本服务不保存密钥：只能保存 secrets.json 里 gate 的 apiKey / apiSecret');
    },
    decrypt(value) {
      if (!value) return '';
      if (value === KEY_MARKER) return apiKey;
      if (value === SECRET_MARKER) return apiSecret;
      throw new Error('CrossEx 数据库里的凭据标记无法识别，请重新导入或核对 secrets.json');
    },
    config() {
      const stored = { ...defaults, ...get<Record<string, unknown>>('config', {}) } as CrossexConfig;
      const cap = (value: unknown, limit: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(value, limit) : limit;
      return { ...stored, notionalPerLeg: cap(stored.notionalPerLeg, limits.notionalPerLeg), maxOpen: cap(stored.maxOpen, limits.maxOpen), maxTotalNotional: cap(stored.maxTotalNotional, limits.maxTotalNotional) };
    },
    transaction(callback) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { statements.clear(); db.close(); },
  };
}
