// Monitor M-5b1: the perpetual collector's recoverable public-data cache, in a file of its own (perpetual-cache.sqlite).
// The tables and their writes are the workbench's publicCache (modules/monitor/server/perpetual-store.mjs, c84ba27): one gzip
// JSON entry per contract, the newest 5000 kept, a corrupt entry read as a miss. Kept apart from monitor.sqlite so the
// frequent cache writes never wait on (or hold up) the alert, switch and import writes there; busy_timeout is the
// workbench's 100 ms, a busy write fails quickly and the service retries its dirty entry. Only the service process writes
// it; losing the file loses only cached public figures, which the venues serve again. M-5b2 adds funding_history_cache (the
// settled-funding histories), M-5c price_history_cache (hourly trade closes for the pair chart); M-5d adds quality_samples.
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { PerpetualContractCacheEntry } from '../vendor/perpetual-market-metrics-service.mjs';

export const PERPETUAL_CACHE_FILE = 'perpetual-cache.sqlite';
const MAX_ROWS = 5000, MAX_ENTRY_BYTES = 1_000_000;

export interface PerpetualCacheTable {
  /** One entry by key, or the newest `limit` (at most 5000) without one. */
  load(key?: string, limit?: number): PerpetualContractCacheEntry[];
  save(entry: PerpetualContractCacheEntry): void;
}
export interface PerpetualCache {
  loadContractMetrics: PerpetualCacheTable['load'];
  saveContractMetrics: PerpetualCacheTable['save'];
  loadFundingHistory: PerpetualCacheTable['load'];
  saveFundingHistory: PerpetualCacheTable['save'];
  loadPriceHistory: PerpetualCacheTable['load'];
  savePriceHistory: PerpetualCacheTable['save'];
  close(): void;
}

export function openPerpetualCache(file: string): PerpetualCache {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=4194304;');
    db.exec('CREATE TABLE IF NOT EXISTS contract_metrics_cache (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS funding_history_cache (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS price_history_cache (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload BLOB NOT NULL);');
    function publicCache(table: string): PerpetualCacheTable {
      db.exec(`CREATE INDEX IF NOT EXISTS ${table}_updated_at ON ${table}(updated_at DESC)`);
      const selectOne = db.prepare(`SELECT payload FROM ${table} WHERE id=?`);
      const selectRecent = db.prepare(`SELECT payload FROM ${table} ORDER BY updated_at DESC LIMIT ?`);
      const write = db.prepare(`INSERT INTO ${table}(id,updated_at,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload`);
      const trim = db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY updated_at DESC LIMIT ${MAX_ROWS})`);
      const size = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`);
      return {
        load(key, limit = 500) {
          const rows = key === undefined ? selectRecent.all(Math.max(1, Math.min(MAX_ROWS, Math.trunc(limit) || 500))) : selectOne.all(key);
          return rows.flatMap(row => {
            try { return [JSON.parse(gunzipSync(row.payload as Uint8Array, { maxOutputLength: MAX_ENTRY_BYTES }).toString()) as PerpetualContractCacheEntry]; }
            catch { return []; } // A corrupt recoverable cache is a miss, never invented data.
          });
        },
        save(entry) {
          if (!entry || typeof entry.key !== 'string' || !entry.key || entry.key.length > 200 || !Number.isSafeInteger(entry.lastAccessAt) || entry.lastAccessAt < 0) throw new Error('Invalid contract cache entry');
          const json = JSON.stringify(entry);
          if (Buffer.byteLength(json) > MAX_ENTRY_BYTES) throw new Error('Contract cache entry exceeds size limit');
          const payload = gzipSync(json, { level: 1 });
          db.exec('BEGIN IMMEDIATE');
          try { write.run(entry.key, entry.lastAccessAt, payload); if ((size.get() as { count: number }).count > MAX_ROWS) trim.run(); db.exec('COMMIT'); }
          catch (error) { db.exec('ROLLBACK'); throw error; }
        },
      };
    }
    const metrics = publicCache('contract_metrics_cache'), funding = publicCache('funding_history_cache'), price = publicCache('price_history_cache');
    let closed = false;
    return {
      loadContractMetrics: metrics.load,
      saveContractMetrics: metrics.save,
      loadFundingHistory: funding.load,
      saveFundingHistory: funding.save,
      loadPriceHistory: price.load,
      savePriceHistory: price.save,
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
}
