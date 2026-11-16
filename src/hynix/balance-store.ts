// The H2 balance settings (docs/hynix.md 7.4) in hynix.sqlite beside the main database; an older version never opens it.
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_BALANCE_SETTINGS, parseBalanceSettings, type BalanceSettings } from './balance.ts';

export const HYNIX_DATABASE = 'hynix.sqlite';
export const HYNIX_SCHEMA_VERSION = 1;

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    const mode = (db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
    if (mode !== 'wal') throw new Error(`未能进入 WAL 模式：${mode}`);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > HYNIX_SCHEMA_VERSION) throw new Error(`库版本 ${version} 比本版本能读的 ${HYNIX_SCHEMA_VERSION} 新`);
    db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL)');
    const columns = (db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map(column => column.name).join(',');
    if (columns !== 'key,json') throw new Error(`settings 表结构不符：${columns}`);
    db.exec(`PRAGMA user_version=${HYNIX_SCHEMA_VERSION}`);
  } catch (error) { db.close(); throw error; }
  return db;
}

/**
 * Opens the store and reads the saved settings (the defaults before any save). A saved value that no longer parses leaves
 * the defaults in effect with `invalid` naming why, and the next save overwrites it; a file or table that is wrong throws.
 */
export function createBalanceStore(file: string) {
  const db = openDatabase(file);
  let current: BalanceSettings = { ...DEFAULT_BALANCE_SETTINGS }, invalid: string | null = null;
  try {
    const row = db.prepare('SELECT json FROM settings WHERE key = ?').get('balance') as { json: string } | undefined;
    if (row) {
      try { current = parseBalanceSettings(JSON.parse(row.json)); }
      catch (error) { invalid = `已保存的设置无效，暂按默认值；重新保存即可覆盖（${error instanceof Error ? error.message.slice(0, 120) : String(error)}）`; }
    }
  } catch (error) { db.close(); throw error; }
  const write = db.prepare('INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json');
  return {
    settings: (): BalanceSettings => ({ ...current }),
    invalid: (): string | null => invalid,
    save(body: unknown): BalanceSettings {
      const next = parseBalanceSettings(body);
      write.run('balance', JSON.stringify(next));
      current = next; invalid = null;
      return { ...current };
    },
    close: () => db.close(),
  };
}
export type BalanceStore = ReturnType<typeof createBalanceStore>;
