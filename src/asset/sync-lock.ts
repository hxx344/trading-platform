// Adapted from project_aggregation modules/asset/lib/sync-lock.ts at 0014655. The lease semantics are unchanged (a
// random token per acquisition, TTL 120 s renewed every 30 s up to 600 s in all, every write re-checks the token in its
// transaction, release only removes its own lock). Changes:
// - no owner: sync_locks holds one row (id 1);
// - the import (import.ts) replaces the ledger without taking the lock, so the lease also keeps the `import-info`
//   setting it saw when it was acquired, and a write refuses once that changed (the ledger was imported again);
// - acquiring needs an imported ledger (import-info present), otherwise nothing is locked;
// - the refusals are AssetConflict errors (409) carrying the workbench's messages;
// - the database is asset.sqlite (db.ts): synchronous statements, transactions with BEGIN IMMEDIATE.
import { randomUUID } from 'node:crypto';
import type { AssetDb } from './db.ts';

type Database = Pick<AssetDb, 'prepare' | 'transaction'>;
export const LOCK_TTL_MS = 120_000;
export const LOCK_RENEW_MS = 30_000;
/** A task holding the lock longer than this stops renewing; once the TTL runs out it can no longer write. */
export const LOCK_MAX_HOLD_MS = 600_000;
export const LOCK_BUSY = '资产正在更新，请稍后重试';
export const LOCK_LOST = '资产更新超时或已被其他操作接替，本次结果未保存';
export const LEDGER_REIMPORTED = '资产账本刚被重新导入，本次修改未保存，请刷新后重试';
export const NOT_IMPORTED = '尚未导入资产账本';

export type AssetConflictCode = 'not_imported' | 'read_only' | 'busy' | 'lease_lost' | 'reimported';
/** A write refused because of the ledger's state rather than its input: answered 409. */
export class AssetConflict extends Error {
  readonly code: AssetConflictCode;
  constructor(code: AssetConflictCode, message: string) { super(message); this.name = 'AssetConflict'; this.code = code; }
}

export type SyncLease = {
  readonly token: string;
  /** Verify ownership and run the synchronous writes in one transaction; throws LOCK_LOST (or LEDGER_REIMPORTED) and writes nothing once ownership is gone. */
  write<T>(run: () => Synchronous<T>): T;
  release(): Promise<void>;
};
/** Writes run inside a transaction, so an async callback (writing after an await, outside it) is a type error. */
export type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;
type Options = { now?: () => number; ttlMs?: number; renewMs?: number; maxHoldMs?: number };

const IMPORT_INFO = "SELECT value FROM settings WHERE key = 'import-info'";

/**
 * Ledger lock with a per-acquisition token. Expiry lets a new task in but does not stop the old one, so every write
 * re-checks the token and expiry, and release only removes its own lock.
 */
export async function acquireSyncLock(database: Database, options: Options = {}): Promise<SyncLease> {
  const now = options.now ?? Date.now, ttl = options.ttlMs ?? LOCK_TTL_MS, maxHold = options.maxHoldMs ?? LOCK_MAX_HOLD_MS;
  const token = randomUUID(), acquiredAt = now();
  // The lock and the import record it guards are taken in one transaction, so no import can land in between.
  const imported = database.transaction(() => {
    const info = database.prepare(IMPORT_INFO).get<{ value: string }>()?.value;
    if (info === undefined) throw new AssetConflict('not_imported', NOT_IMPORTED);
    const changes = database.prepare('INSERT INTO sync_locks(id,expires,token) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,token=excluded.token WHERE sync_locks.expires < ?')
      .bind(acquiredAt + ttl, token, acquiredAt).run();
    if (!changes) throw new AssetConflict('busy', LOCK_BUSY);
    return info;
  });
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    const at = now();
    // Past the hold limit the lease is left to expire; a stuck task cannot keep others out forever.
    if (at - acquiredAt >= maxHold) return stop();
    // A failed renewal (busy or closed database) must not escape the timer and crash the process;
    // the lease then simply expires and later writes are refused.
    try {
      const renewed = database.prepare('UPDATE sync_locks SET expires = ? WHERE id = 1 AND token = ? AND expires >= ?').bind(Math.min(at + ttl, acquiredAt + maxHold), token, at).run();
      if (!renewed) stop();
    } catch { stop(); }
  }, options.renewMs ?? LOCK_RENEW_MS);
  timer.unref?.();
  function stop() { clearInterval(timer); timer = undefined; }
  return {
    token,
    write(run) {
      return database.transaction(() => {
        const held = database.prepare('SELECT 1 AS held FROM sync_locks WHERE id = 1 AND token = ? AND expires >= ?').bind(token, now()).get();
        if (!held) throw new AssetConflict('lease_lost', LOCK_LOST);
        if (database.prepare(IMPORT_INFO).get<{ value: string }>()?.value !== imported) throw new AssetConflict('reimported', LEDGER_REIMPORTED);
        return run();
      });
    },
    async release() {
      stop();
      database.prepare('DELETE FROM sync_locks WHERE id = 1 AND token = ?').bind(token).run();
    },
  };
}
