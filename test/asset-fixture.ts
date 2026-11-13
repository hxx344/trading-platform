// A workbench ledger.sqlite in the layout of project_aggregation modules/asset (0014655): every table keyed by owner,
// credentials in the connections table, account identifiers in the Aster accounts and exchange statuses, and settings
// that only the workbench uses. The asset import tests and scripts/asset-demo.ts build their sources with it; the
// figures are made up.
import { DatabaseSync } from 'node:sqlite';
import { amendCashFlows, parseCashFlow, type CashFlowRecord } from '../src/asset/cash-flows.ts';

export const OWNER = 'alice';
export const OTHER_OWNER = 'bob';
/** Strings that must never reach asset.sqlite. */
export const WALLET = '0x' + 'ab'.repeat(20);
export const KEY_TAIL = 'tail-k3y9';
export const CIPHERTEXT = 'ciphertext-' + 'Z'.repeat(32);
export const WORKBENCH_ONLY_KEYS = ['sync-state', 'import-hash'];

const DAY_MS = 86_400_000;
/** The Beijing calendar day `days` before `now`. */
export const dayBefore = (now: number, days: number): string => new Date(now + 8 * 3_600_000 - days * DAY_MS).toISOString().slice(0, 10);

type Row = { id: string; project: string; kind: string; quantity: number | null; price: number | null; value: number | null; cell: string };
const row = (id: string, project: string, kind: string, value: number | null, quantity: number | null = null, price: number | null = null): Row =>
  ({ id, project, kind, quantity, price, value, cell: 'D' + (Number(id.slice(4)) + 1) });

/** The rows of one day; `step` grows the exchange balances day by day. */
function rowsOf(step: number): Row[] {
  return [
    row('row-1', 'bybit', '交易所', 10_000 + 120 * step),
    row('row-2', 'aster', '交易所', 5_000 + 40 * step),
    row('row-3', '冷钱包', 'USDC', 3_000),
    row('row-4', 'virtual', 'BTC', 600 + 5 * step, 0.01, 60_000 + 500 * step),
    row('row-5', '积分', '空投积分', 200),
    row('row-6', '出金', '出金', 500),
  ];
}
const total = (rows: Row[]): number => rows.reduce((sum, item) => sum + (item.value ?? 0), 0);

function sourceLedger(now: number, owner: string) {
  const baselineDate = dayBefore(now, 40), rows = rowsOf(0), base = total(rows);
  const later = rowsOf(10);
  return {
    source: `${owner} 的资产表.xlsx`, sheet: '资产', startedAt: baselineDate, baselineId: 'P1', baselineDate, fx: 7.1,
    periods: [
      { id: 'P1', date: baselineDate, total: base, fx: 7.1, cny: base * 7.1, rows, future: false, rowSum: base, difference: 0 },
      { id: 'P2', date: dayBefore(now, 25), total: total(later), fx: 7.12, cny: total(later) * 7.12, rows: later, future: false, rowSum: total(later), difference: 0 },
    ],
  };
}

function cashFlowAudit(now: number): CashFlowRecord[] {
  const kept = '6c5e7f0a-2b1d-4c3e-9f8a-1a2b3c4d5e6f', voided = '7d6f8a1b-3c2e-4d4f-8a9b-2b3c4d5e6f70';
  const base = { account: 'account-a', currency: 'USD', kind: 'external' as const, transferId: null, usdRate: null, rateAt: null, reference: 'statement:1', reason: '核对流水', void: false };
  let audit: CashFlowRecord[] = [];
  audit = amendCashFlows(audit, parseCashFlow({ ...base, id: kept, revision: 0, date: dayBefore(now, 4), amount: '1000' }, now), now - 3 * DAY_MS);
  audit = amendCashFlows(audit, parseCashFlow({ ...base, id: voided, revision: 0, date: dayBefore(now, 3), amount: '-200' }, now), now - 2 * DAY_MS);
  audit = amendCashFlows(audit, parseCashFlow({ ...base, id: voided, revision: 1, date: dayBefore(now, 3), amount: '-200', reason: '重复登记', void: true }, now), now - DAY_MS);
  return audit;
}

/** Writes the workbench file for `alice` (a full ledger) and `bob` (one asset, one snapshot). */
export function writeWorkbenchLedger(file: string, { now = Date.now() }: { now?: number } = {}): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE assets (owner TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner, id));
      CREATE TABLE connections (owner TEXT NOT NULL, exchange TEXT NOT NULL, encrypted TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner, exchange));
      CREATE TABLE sync_locks (owner TEXT PRIMARY KEY NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE settings (owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner, key));
      CREATE TABLE snapshots (owner TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner, date));`);
    const insert = (table: string, owner: string, key: string, value: unknown) =>
      db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(owner, key, typeof value === 'string' ? value : JSON.stringify(value));
    const recent = new Date(now - 60_000).toISOString();
    const current = rowsOf(30);
    const assets = current.map(item => {
      const mode = item.project === 'bybit' ? 'bybit' : item.project === 'aster' ? 'aster' : item.project === 'virtual' ? 'market' : 'manual';
      const status = mode === 'manual' ? '手动估值' : mode === 'market' ? '行情已更新' : '已同步';
      const details = mode === 'bybit' ? [{ coin: 'USDT', account: '统一账户', quantity: item.value! - 1_000, value: item.value! - 1_000, price: 1 }, { coin: 'USDC', account: '资金账户', quantity: 1_000, value: 1_000, price: 1 }]
        : mode === 'aster' ? [{ coin: 'USDT', account: '合约账户', quantity: item.value!, value: item.value!, price: 1 }] : undefined;
      return { ...item, mode, updatedAt: mode === 'manual' ? dayBefore(now, 40) + 'T00:00:00+08:00' : recent, status, ...(details ? { details } : {}) };
    });
    for (const asset of assets) insert('assets', OWNER, asset.id, asset);
    for (let days = 9; days >= 1; days--) {
      const rows = rowsOf(30 - days).map(item => ({ ...item, mode: 'manual', updatedAt: recent, status: '手动估值' }));
      const date = dayBefore(now, days), sum = total(rows);
      insert('snapshots', OWNER, date, { id: `daily-${date}`, date, total: sum, fx: 7.1, cny: sum * 7.1, future: false, difference: 0, assets: rows });
    }
    const archived = dayBefore(now, 60);
    insert('snapshots', OWNER, 'archive-0f1e2d3c-4b5a-4968-8776-655443322110-1', { id: 'archive-0f1e2d3c-4b5a-4968-8776-655443322110-1', date: archived, total: 1_000, fx: 7, cny: 7_000, future: false, difference: 0, archived: true, assets: [] });
    insert('settings', OWNER, 'initialized', '1');
    insert('settings', OWNER, 'fx', '7.1');
    insert('settings', OWNER, 'fx-status', { source: 'Coinbase', fetchedAt: recent, rateDate: null, error: null });
    insert('settings', OWNER, 'source-ledger', sourceLedger(now, OWNER));
    insert('settings', OWNER, 'withdrawals', [{ id: '8e7a9b2c-4d3f-4e5a-9b0c-3c4d5e6f7081', date: dayBefore(now, 5), amount: 300, note: '提现到银行卡', createdAt: recent, updatedAt: recent }]);
    insert('settings', OWNER, 'cash-flow-audit-v1', cashFlowAudit(now));
    insert('settings', OWNER, 'aster-accounts', [{ id: 'aster-1', name: '主号', value: assets[1]!.value, details: assets[1]!.details, updatedAt: recent, includeSpot: false, configured: true, lastSync: recent, error: null, scope: '合约账户', walletAddress: WALLET, label: KEY_TAIL }]);
    insert('settings', OWNER, 'aster-status', { configured: true, lastSync: recent, error: null, scope: '合约账户', label: KEY_TAIL });
    insert('settings', OWNER, 'bybit-status', { configured: true, lastSync: recent, error: null, scope: '统一账户 + 资金账户', label: KEY_TAIL });
    insert('settings', OWNER, 'last-attempt', recent);
    for (const key of WORKBENCH_ONLY_KEYS) insert('settings', OWNER, key, { at: recent });
    db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?)').run(OWNER, 'bybit', CIPHERTEXT, recent);
    // The other user of the same workbench.
    const other = rowsOf(0).slice(0, 1).map(item => ({ ...item, mode: 'manual', updatedAt: recent, status: '手动估值' }));
    insert('assets', OTHER_OWNER, 'row-1', other[0]);
    insert('snapshots', OTHER_OWNER, dayBefore(now, 1), { id: `daily-${dayBefore(now, 1)}`, date: dayBefore(now, 1), total: total(other), fx: 7.1, cny: total(other) * 7.1, future: false, difference: 0, assets: other });
    insert('settings', OTHER_OWNER, 'source-ledger', sourceLedger(now, OTHER_OWNER));
  } finally { db.close(); }
}
