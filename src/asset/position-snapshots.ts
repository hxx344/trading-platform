import type { AssetDb } from './db.ts';
import type { HistoryGeneration } from './history-cache.ts';
import type { DatabaseSource, SourceAccount } from './positions-service.ts';
import type { Position } from './positions-types.ts';
import { decimal, POSITIONS_FAILED, PositionsPermissionError, rows, uniquePositions } from './positions-values.ts';
import { untilAborted } from './sources/shared-reads.ts';
import { anySignal } from '../any-signal.mjs';

export const POSITION_TTL = 5_000;
export const POSITION_DISPLAY_AGE = 24 * 60 * 60_000;
const MAX_BYTES = 2 * 1024 * 1024;
export const POSITION_SNAPSHOT_TABLE = `CREATE TABLE IF NOT EXISTS asset_position_snapshots (
  account TEXT NOT NULL, scope TEXT NOT NULL, revision TEXT NOT NULL,
  started_at INTEGER NOT NULL, completed_at INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(account,scope)
) WITHOUT ROWID;`;

type Snapshot = { positions: Position[]; startedAt: number; completedAt: number };
type Stored = { started_at: number; completed_at: number; data: string };
type Context = { database: DatabaseSource; account: SourceAccount; scope: string; revision: string; generation: HistoryGeneration;
  now: () => number; signal: AbortSignal; maxAge?: number };
type Pending = { result: Promise<Snapshot>; controller: AbortController; waiters: number };
type ScopeCache = { pending?: Pending; unwritten?: Snapshot };
// Each generation belongs to a single open database, account and credential. Revocation aborts its readers.
const caches = new WeakMap<AbortSignal, Map<string, ScopeCache>>();
const writeFailure = new WeakMap<Pick<AssetDb, 'prepare'>, number>();

const TEXT = ['id', 'symbol', 'instrumentId', 'quantityUnit'] as const;
const DECIMALS = ['contractSize', 'entryPrice', 'markPrice', 'notional', 'unrealizedPnl', 'leverage', 'liquidationPrice'] as const;
const LABELS = ['priceCurrency', 'notionalCurrency', 'pnlCurrency', 'marginMode', 'sourceUpdatedAt'] as const;
// Only venue-normalized fields enter the file. Cycle history has its own permission and freshness rules.
const FIELDS = [...TEXT, ...DECIMALS, ...LABELS, 'quantity', 'side', 'positionSide'];
function decode(data: string): Position[] {
  const positions = rows(JSON.parse(data)).map(row => {
    if (Object.keys(row).some(key => !FIELDS.includes(key)) || !TEXT.every(key => typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 192)
      || !LABELS.every(key => row[key] === null || (typeof row[key] === 'string' && row[key].length <= 192))
      || (row.side !== 'long' && row.side !== 'short') || (row.positionSide !== undefined && row.positionSide !== 'long' && row.positionSide !== 'short' && row.positionSide !== 'net')
      || !/[1-9]/.test(decimal(row.quantity)) || (row.quantity as string).startsWith('-')) throw new Error(POSITIONS_FAILED);
    for (const key of DECIMALS) if (row[key] !== null) decimal(row[key]);
    return row as Position;
  });
  return uniquePositions(positions);
}

function load(file: Pick<AssetDb, 'prepare'>, ctx: Context, tick: number, maxAge: number): Snapshot | null {
  try {
    const row = file.prepare(`SELECT started_at,completed_at,data FROM asset_position_snapshots
      WHERE account=? AND scope=? AND revision=? AND started_at>? AND completed_at<=? AND length(CAST(data AS BLOB))<=?`)
      .bind(ctx.account.key, ctx.scope, ctx.revision, tick - maxAge, tick, MAX_BYTES).get<Stored>();
    if (!row || !Number.isSafeInteger(row.started_at) || !Number.isSafeInteger(row.completed_at) || row.started_at < 0 || row.started_at > row.completed_at) return null;
    return { startedAt: row.started_at, completedAt: row.completed_at, positions: decode(row.data) };
  } catch { return null; } // Missing on older read-only files; an incomplete or malformed row is a cache miss.
}

function save(file: Pick<AssetDb, 'prepare'>, ctx: Context, snapshot: Snapshot, cache: ScopeCache) {
  const { startedAt, completedAt, positions } = snapshot;
  const data = JSON.stringify(positions, FIELDS);
  if (Buffer.byteLength(data) > MAX_BYTES) return;
  // When the importer holds the writer lock, other scopes can still share a result without each waiting on SQLite.
  const failedAt = writeFailure.get(file);
  if (failedAt === undefined || completedAt < failedAt || completedAt - failedAt >= POSITION_TTL) {
    try {
      // The connection can also be replaced by an external importer. Check it inside the write.
      file.prepare(`INSERT INTO asset_position_snapshots(account,scope,revision,started_at,completed_at,data)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM connections WHERE exchange=? AND encrypted=?)
        ON CONFLICT(account,scope) DO UPDATE SET revision=excluded.revision, started_at=excluded.started_at,
        completed_at=excluded.completed_at,data=excluded.data
        WHERE revision<>excluded.revision OR (started_at,completed_at)<=(excluded.started_at,excluded.completed_at)`)
        .bind(ctx.account.key, ctx.scope, ctx.revision, startedAt, completedAt, data, ctx.account.key, ctx.account.row!.encrypted).run();
      writeFailure.delete(file); delete cache.unwritten;
      return;
    } catch { writeFailure.set(file, completedAt); }
  }
  cache.unwritten = snapshot;
}

/** A replay needs the real start of the position request, including when another page made it. */
export async function verifiedPositionSnapshot(ctx: Context, read: (signal: AbortSignal) => Promise<Position[]>, stale?: (snapshot: Snapshot) => void) {
  const file = ctx.database(), encrypted = ctx.account.row?.encrypted;
  const check = () => {
    ctx.generation.assertVerified();
    if (!file || !encrypted || file.prepare('SELECT encrypted FROM connections WHERE exchange=?').bind(ctx.account.key)
      .get<{ encrypted: string }>()?.encrypted !== encrypted) throw new Error(POSITIONS_FAILED);
  };
  ctx.signal.throwIfAborted(); check();
  const tick = ctx.now(), ttl = Math.min(ctx.maxAge ?? POSITION_TTL, POSITION_TTL);
  const key = ctx.generation.signal, scopes = caches.get(key) ?? new Map<string, ScopeCache>();
  caches.set(key, scopes);
  const cache: ScopeCache = scopes.get(ctx.scope) ?? {};
  if (cache.unwritten && (tick < cache.unwritten.completedAt || tick - cache.unwritten.startedAt >= POSITION_DISPLAY_AGE)) delete cache.unwritten;
  const saved = cache.unwritten ?? load(file!, ctx, tick, stale ? POSITION_DISPLAY_AGE : ttl);
  if (saved) {
    if (tick - saved.startedAt < ttl) return { ...saved, restored: true };
    stale?.(saved);
  }

  scopes.set(ctx.scope, cache);
  let job = cache.pending;
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController(), signal = anySignal([key, controller.signal]);
    const result = (async () => {
      const startedAt = ctx.now();
      const positions = await read(signal).catch(error => {
        // The last waiter can have left before the exchange returns a definite credential refusal.
        if (ctx.account.exchange === 'binance' && error instanceof PositionsPermissionError) ctx.generation.deny(error);
        throw error;
      }), completedAt = ctx.now();
      signal.throwIfAborted(); check();
      if (completedAt < startedAt) throw new Error(POSITIONS_FAILED);
      const snapshot = { positions, startedAt, completedAt };
      save(file!, ctx, snapshot, cache);
      return snapshot;
    })();
    job = cache.pending = { controller, result, waiters: 0 };
  }
  job.waiters++;
  try {
    const value = await untilAborted(job.result, ctx.signal);
    ctx.signal.throwIfAborted(); check();
    return { ...value, restored: false };
  } finally {
    if (--job.waiters === 0) {
      job.controller.abort();
      if (cache.pending === job) {
        delete cache.pending;
        if (!cache.unwritten) scopes.delete(ctx.scope);
      }
    }
  }
}
