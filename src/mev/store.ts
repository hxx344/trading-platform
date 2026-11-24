// MEV 模块自己的数据库（mev.sqlite，docs/mev.md 第 4 节）：代币白名单、池子目录、机会记录、交易台账与参数。
// 只有本模块写。丢掉这个文件丢的是记录与白名单；链上已发出的交易不受影响，但未结清的交易会失去台账，
// 所以交易在发送之前先写进这里。
import { DatabaseSync } from 'node:sqlite';
import type { Pool } from './pools.ts';
import type { TokenInfo } from './chain.ts';

export const MEV_FILE = 'mev.sqlite';
export const OPPORTUNITY_RETENTION_DAYS = 14;
const OPPORTUNITY_MAX_ROWS = 20_000;

/**
 * 交易状态。未结清：`recorded`（已入库，还没发）、`sent`（节点已接受）、`unknown`（发送结果不明或被节点拒绝）、
 * `expired`（过了 deadlineBlock 仍没上链，上链也只会回滚；它的 nonce 可以被新交易替换）。
 * 已结清：`success`、`reverted`、`replaced`（同 nonce 的另一笔上链了）、`lost`（nonce 被占用但本模块的交易都没有回执）。
 */
export type TxStatus = 'recorded' | 'sent' | 'unknown' | 'expired' | 'success' | 'reverted' | 'replaced' | 'lost';
export const OPEN_STATUSES: readonly TxStatus[] = ['recorded', 'sent', 'unknown', 'expired'];

export interface StoredTx {
  hash: string;
  nonce: number;
  raw: string;
  createdAt: number;
  deadlineBlock: number;
  status: TxStatus;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  worstCostWei: bigint;
  opportunityId: number | null;
  start: string;
  path: string;
  expectedProfit: bigint;
  error: string | null;
  settledAt: number | null;
  block: number | null;
  feeWei: bigint | null;
  profit: bigint | null;
  /** nonce 已被占用但查不到回执的连续次数。 */
  missingChecks: number;
}

export type OpportunityOutcome = 'observed' | 'sent' | 'blocked' | 'thin';
export interface StoredOpportunity {
  id: number;
  at: number;
  block: number;
  cycleId: string;
  path: string;
  start: string;
  edgeBps: number;
  amountIn: bigint;
  profit: bigint;
  profitUsd: number;
  costUsd: number;
  netUsd: number;
  outcome: OpportunityOutcome;
  reason: string | null;
}

type TxRow = Record<string, unknown>;
const big = (value: unknown): bigint => BigInt(value as string);
const optionalBig = (value: unknown): bigint | null => typeof value === 'string' ? BigInt(value) : null;
const txOf = (row: TxRow): StoredTx => ({
  hash: row.hash as string, nonce: row.nonce as number, raw: row.raw as string, createdAt: row.created_at as number, deadlineBlock: row.deadline_block as number,
  status: row.status as TxStatus, maxFeePerGas: big(row.max_fee), maxPriorityFeePerGas: big(row.max_tip), worstCostWei: big(row.worst_cost),
  opportunityId: row.opportunity_id as number | null, start: row.start as string, path: row.path as string, expectedProfit: big(row.expected_profit), error: row.error as string | null,
  settledAt: row.settled_at as number | null, block: row.block as number | null, feeWei: optionalBig(row.fee_wei), profit: optionalBig(row.profit), missingChecks: row.missing_checks as number,
});
const opportunityOf = (row: TxRow): StoredOpportunity => ({
  id: row.id as number, at: row.at as number, block: row.block as number, cycleId: row.cycle_id as string, path: row.path as string, start: row.start as string,
  edgeBps: row.edge_bps as number, amountIn: big(row.amount_in), profit: big(row.profit), profitUsd: row.profit_usd as number, costUsd: row.cost_usd as number,
  netUsd: row.net_usd as number, outcome: row.outcome as OpportunityOutcome, reason: row.reason as string | null,
});

export type MevStore = ReturnType<typeof openMevStore>;

export function openMevStore(file: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY, symbol TEXT NOT NULL, decimals INTEGER NOT NULL, added_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pools (address TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS opportunities (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, block INTEGER NOT NULL, cycle_id TEXT NOT NULL, path TEXT NOT NULL,
      start TEXT NOT NULL, edge_bps REAL NOT NULL, amount_in TEXT NOT NULL, profit TEXT NOT NULL, profit_usd REAL NOT NULL, cost_usd REAL NOT NULL, net_usd REAL NOT NULL,
      outcome TEXT NOT NULL, reason TEXT);
    CREATE INDEX IF NOT EXISTS opportunities_at ON opportunities(at);
    CREATE TABLE IF NOT EXISTS transactions (hash TEXT PRIMARY KEY, nonce INTEGER NOT NULL, raw TEXT NOT NULL, created_at INTEGER NOT NULL, deadline_block INTEGER NOT NULL,
      status TEXT NOT NULL, max_fee TEXT NOT NULL, max_tip TEXT NOT NULL, worst_cost TEXT NOT NULL, opportunity_id INTEGER, start TEXT NOT NULL, path TEXT NOT NULL,
      expected_profit TEXT NOT NULL, error TEXT, settled_at INTEGER, block INTEGER, fee_wei TEXT, profit TEXT, missing_checks INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS transactions_created ON transactions(created_at);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  } catch (error) { db.close(); throw error; }

  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const placeholders = OPEN_STATUSES.map(() => '?').join(', ');
  const upsertToken = db.prepare('INSERT INTO tokens(address, symbol, decimals, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals');
  const deleteToken = db.prepare('DELETE FROM tokens WHERE address = ?');
  const allTokens = db.prepare('SELECT address, symbol, decimals FROM tokens ORDER BY added_at, address');
  const clearPools = db.prepare('DELETE FROM pools');
  const insertPool = db.prepare('INSERT INTO pools(address, json, updated_at) VALUES (?, ?, ?)');
  const allPools = db.prepare('SELECT json FROM pools ORDER BY address');
  const insertOpportunity = db.prepare(`INSERT INTO opportunities(at, block, cycle_id, path, start, edge_bps, amount_in, profit, profit_usd, cost_usd, net_usd, outcome, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const setOutcome = db.prepare('UPDATE opportunities SET outcome = ?, reason = ? WHERE id = ?');
  const recentOpportunities = db.prepare('SELECT * FROM opportunities ORDER BY id DESC LIMIT ?');
  const opportunityStats = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(net_usd), 0) AS net FROM opportunities WHERE at >= ? AND net_usd > 0');
  const pruneOld = db.prepare('DELETE FROM opportunities WHERE at < ?');
  const pruneExcess = db.prepare('DELETE FROM opportunities WHERE id <= (SELECT MAX(id) FROM opportunities) - ?');
  const insertTx = db.prepare(`INSERT INTO transactions(hash, nonce, raw, created_at, deadline_block, status, max_fee, max_tip, worst_cost, opportunity_id, start, path, expected_profit)
    VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?, ?, ?, ?)`);
  const setStatus = db.prepare('UPDATE transactions SET status = ?, error = ? WHERE hash = ?');
  const settleTx = db.prepare('UPDATE transactions SET status = ?, settled_at = ?, block = ?, fee_wei = ?, profit = ?, error = ? WHERE hash = ?');
  const setMissing = db.prepare('UPDATE transactions SET missing_checks = ? WHERE hash = ?');
  const openTxs = db.prepare(`SELECT * FROM transactions WHERE status IN (${placeholders}) ORDER BY nonce, created_at`);
  const recentTxs = db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?');
  const settledSince = db.prepare("SELECT fee_wei, profit, start, status FROM transactions WHERE settled_at >= ? AND status IN ('success', 'reverted')");
  const maxMined = db.prepare("SELECT MAX(nonce) AS n FROM transactions WHERE status IN ('success', 'reverted') AND created_at >= ?");
  const totals = db.prepare("SELECT status, COUNT(*) AS n FROM transactions GROUP BY status");
  const readState = db.prepare('SELECT json FROM state WHERE key = ?');
  const writeState = db.prepare('INSERT INTO state(key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at');

  return {
    tokens: (): TokenInfo[] => (allTokens.all() as unknown as TokenInfo[]).map(row => ({ address: row.address, symbol: row.symbol, decimals: row.decimals })),
    putToken(token: TokenInfo, at: number): void { upsertToken.run(token.address, token.symbol, token.decimals, at); },
    removeToken(address: string): boolean { return Number(deleteToken.run(address).changes) > 0; },
    /** 整份替换池子目录。 */
    replacePools(pools: readonly Pool[], at: number): void {
      transaction(() => { clearPools.run(); for (const pool of pools) insertPool.run(pool.address, JSON.stringify(pool), at); });
    },
    pools: (): Pool[] => (allPools.all() as { json: string }[]).map(row => JSON.parse(row.json) as Pool),
    addOpportunity(entry: Omit<StoredOpportunity, 'id'>): number {
      return Number(insertOpportunity.run(entry.at, entry.block, entry.cycleId, entry.path, entry.start, entry.edgeBps, entry.amountIn.toString(), entry.profit.toString(),
        entry.profitUsd, entry.costUsd, entry.netUsd, entry.outcome, entry.reason).lastInsertRowid);
    },
    setOpportunityOutcome(id: number, outcome: OpportunityOutcome, reason: string | null): void { setOutcome.run(outcome, reason, id); },
    recentOpportunities: (limit: number): StoredOpportunity[] => (recentOpportunities.all(limit) as TxRow[]).map(opportunityOf),
    /** `since` 以来净利为正的机会数与模拟净利合计（观察口径的上限，不是实际收益）。 */
    opportunityStats(since: number): { count: number; netUsd: number } {
      const row = opportunityStats.get(since) as { n: number; net: number };
      return { count: row.n, netUsd: row.net };
    },
    prune(now: number): void {
      pruneOld.run(now - OPPORTUNITY_RETENTION_DAYS * 86_400_000);
      pruneExcess.run(OPPORTUNITY_MAX_ROWS);
    },
    /** 交易在发送之前先入库（状态 recorded）。 */
    recordTx(tx: Pick<StoredTx, 'hash' | 'nonce' | 'raw' | 'createdAt' | 'deadlineBlock' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'worstCostWei' | 'opportunityId' | 'start' | 'path' | 'expectedProfit'>): void {
      insertTx.run(tx.hash, tx.nonce, tx.raw, tx.createdAt, tx.deadlineBlock, tx.maxFeePerGas.toString(), tx.maxPriorityFeePerGas.toString(), tx.worstCostWei.toString(),
        tx.opportunityId, tx.start, tx.path, tx.expectedProfit.toString());
    },
    setTxStatus(hash: string, status: TxStatus, error: string | null = null): void { setStatus.run(status, error, hash); },
    settleTx(hash: string, status: TxStatus, at: number, detail: { block?: number | null; feeWei?: bigint | null; profit?: bigint | null; error?: string | null } = {}): void {
      settleTx.run(status, at, detail.block ?? null, detail.feeWei?.toString() ?? null, detail.profit?.toString() ?? null, detail.error ?? null, hash);
    },
    setMissingChecks(hash: string, count: number): void { setMissing.run(count, hash); },
    openTxs: (): StoredTx[] => (openTxs.all(...OPEN_STATUSES) as TxRow[]).map(txOf),
    recentTxs: (limit: number): StoredTx[] => (recentTxs.all(limit) as TxRow[]).map(txOf),
    /** `since` 以来上链（成功或回滚）的交易：gas 支出合计与各起始代币的利润合计。 */
    settledSince(since: number): { feeWei: bigint; profits: Map<string, bigint>; success: number; reverted: number } {
      let feeWei = 0n, success = 0, reverted = 0;
      const profits = new Map<string, bigint>();
      for (const row of settledSince.all(since) as { fee_wei: string | null; profit: string | null; start: string; status: string }[]) {
        if (row.fee_wei) feeWei += BigInt(row.fee_wei);
        if (row.status === 'success') { success++; if (row.profit) profits.set(row.start, (profits.get(row.start) ?? 0n) + BigInt(row.profit)); } else reverted++;
      }
      return { feeWei, profits, success, reverted };
    },
    /** 本模块已上链（成功或回滚）的交易里最大的 nonce；没有时为 null。 */
    /** 当前热钱包已上链交易的最大 nonce：只算换上这把热钱包（state 的 identityAt）之后入库的交易，旧钱包的 nonce 不相干。 */
    maxMinedNonce(): number | null {
      const row = readState.get('identityAt') as { json: string } | undefined;
      return (maxMined.get(row ? Number(JSON.parse(row.json)) : 0) as { n: number | null }).n;
    },
    txTotals(): Record<string, number> { return Object.fromEntries((totals.all() as { status: string; n: number }[]).map(row => [row.status, row.n])); },
    readState<T>(key: string): T | null {
      const row = readState.get(key) as { json: string } | undefined;
      if (!row) return null;
      try { return JSON.parse(row.json) as T; } catch { return null; }
    },
    writeState(key: string, value: unknown, at: number): void { writeState.run(key, JSON.stringify(value), at); },
    transaction,
    close(): void { db.close(); },
  };
}
