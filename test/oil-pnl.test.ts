// O4 (docs/oil.md section 9): the Binance and Bybit PnL and ledger reads against stand-in venues, and the oil PnL store
// (cutoffs, ledger coverage, re-reads, conflicts, gaps) against scripted connectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinanceConnector } from '../src/live/binance.ts';
import { createBybitConnector } from '../src/live/bybit.ts';
import { createOilPnl, LEDGER_LOOKBACK_MS, LEDGER_REREAD_MS } from '../src/oil/pnl.ts';
import type { LedgerEntry, PnlPosition, VenueConnector } from '../src/connector.ts';
import type { AccountBinding } from '../src/contracts.ts';
import * as fb from './live-fake-binance.ts';
import * as fy from './live-fake-bybit.ts';

const binanceSetup = () => {
  const venue = new fb.FakeBinance();
  return { venue, connector: createBinanceConnector({ credentials: () => ({ apiKey: fb.KEY, apiSecret: fb.SECRET }), fetchImpl: venue.fetch, now: () => venue.clock }) };
};
const bybitSetup = () => {
  const venue = new fy.FakeBybit();
  return { venue, connector: createBybitConnector({ credentials: () => ({ apiKey: fy.KEY, apiSecret: fy.SECRET }), fetchImpl: venue.fetch, now: () => venue.clock }) };
};
const income = (overrides: fb.Row = {}): fb.Row => ({ symbol: 'CLUSDT', incomeType: 'FUNDING_FEE', income: '-0.12', asset: 'USDT', info: '', time: fb.NOW - 1000, tranId: 9_007_199_254_740_993n, tradeId: '', ...overrides });

test('Binance 盈亏读取：持仓带开仓均价、标记价与浮盈亏，零仓跳过；账单按类型归类，满页对半重读并去重，未知类型、非 USDT 与越界时间读取失败', async () => {
  const { venue, connector } = binanceSetup();
  venue.script('GET /fapi/v3/positionRisk',
    () => fb.json([{ symbol: 'BZUSDT', positionSide: 'BOTH', positionAmt: '-3', entryPrice: '74.5', markPrice: '74.1', unRealizedProfit: '1.2', marginAsset: 'USDT' }]),
    () => fb.json([{ symbol: 'CLUSDT', positionSide: 'BOTH', positionAmt: '0', entryPrice: '0', markPrice: '70.1', unRealizedProfit: '0', marginAsset: 'USDT' }]));
  const snapshot = await connector.pnlPositions!(fb.binding(), ['BZUSDT', 'CLUSDT'], { signal: fb.signal() });
  assert.deepEqual(snapshot, { venue: 'binance', accountId: '123456789', receivedAt: fb.NOW, positions: [{ symbol: 'BZUSDT', side: 'short', quantity: '3', entryPrice: '74.5', markPrice: '74.1', unrealizedPnl: '1.2' }] });

  const from = fb.NOW - 10_000, to = fb.NOW;
  venue.script('GET /fapi/v1/income', () => fb.json([
    income(), income({ incomeType: 'REALIZED_PNL', income: '5', tranId: 7, time: from }), income({ incomeType: 'COMMISSION', income: '-0.3', tranId: 7, time: to }),
  ]));
  const entries = await connector.ledger!(fb.binding(), 'CLUSDT', { from, to }, { signal: fb.signal() });
  assert.deepEqual(entries.map(entry => [entry.id, entry.kind, entry.amount, entry.time]), [
    ['CLUSDT:REALIZED_PNL:7', 'realized', '5', from], ['CLUSDT:FUNDING_FEE:9007199254740993', 'funding', '-0.12', fb.NOW - 1000], ['CLUSDT:COMMISSION:7', 'fee', '-0.3', to]]);
  const call = venue.calls.at(-1)!;
  assert.deepEqual([call.params.get('symbol'), call.params.get('startTime'), call.params.get('endTime'), call.params.get('limit')], ['CLUSDT', String(from), String(to), '1000']);

  // A full page is thrown away and read again as two halves sharing the midpoint; a row read twice counts once.
  const full = Array.from({ length: 1000 }, (_, index) => income({ tranId: index, time: from + 1 }));
  venue.script('GET /fapi/v1/income', () => fb.json(full), () => fb.json([income({ tranId: 1, time: from + 5000 })]), () => fb.json([income({ tranId: 1, time: from + 5000 }), income({ tranId: 2, time: to })]));
  const before = venue.count('GET /fapi/v1/income');
  const split = await connector.ledger!(fb.binding(), 'CLUSDT', { from, to }, { signal: fb.signal() });
  assert.equal(venue.count('GET /fapi/v1/income') - before, 3);
  assert.deepEqual(split.map(entry => entry.id), ['CLUSDT:FUNDING_FEE:1', 'CLUSDT:FUNDING_FEE:2']);
  const halves = venue.calls.slice(-2).map(item => [item.params.get('startTime'), item.params.get('endTime')]);
  assert.deepEqual(halves, [[String(from), String(from + 5000)], [String(from + 5000), String(to)]]);

  for (const bad of [income({ incomeType: 'TRANSFER' }), income({ asset: 'BNB' }), income({ time: to + 1 }), income({ symbol: 'BZUSDT' })]) {
    venue.script('GET /fapi/v1/income', () => fb.json([bad]));
    await assert.rejects(connector.ledger!(fb.binding(), 'CLUSDT', { from, to }, { signal: fb.signal() }), fb.kind('read-failed'));
  }
  venue.script('GET /fapi/v1/income', () => fb.json([income({ tranId: 3 }), income({ tranId: 3, income: '-0.5' })]));
  await assert.rejects(connector.ledger!(fb.binding(), 'CLUSDT', { from, to }, { signal: fb.signal() }), fb.kind('read-failed'));
  // A window of at most 2 ms that still fills a page cannot be read in full.
  venue.script('GET /fapi/v1/income', () => fb.json(full));
  await assert.rejects(connector.ledger!(fb.binding(), 'CLUSDT', { from: to - 2, to }, { signal: fb.signal() }), fb.kind('read-failed'));
});

const logRow = (overrides: fy.Row = {}): fy.Row => ({ id: '592324_XRPUSDT_161440249321', symbol: 'CLUSDT', category: 'linear', side: 'Sell', transactionTime: String(fy.NOW - 1000), type: 'SETTLEMENT', qty: '2', size: '-2',
  currency: 'USDT', tradePrice: '70', funding: '-0.05', fee: '', cashFlow: '0', change: '-0.05', cashBalance: '100', feeRate: '0.0001', ...overrides });

test('Bybit 盈亏读取：持仓带均价、标记价与浮盈亏；交易日志按 7 天一段、游标翻页，拆成平仓盈亏、资金费、手续费三类，变动对不上时读取失败', async () => {
  const { venue, connector } = bybitSetup();
  venue.positions = [{ symbol: 'CLUSDT', positionIdx: 0, side: 'Buy', size: '2', avgPrice: '70.11', markPrice: '70.5', unrealisedPnl: '7.8E-1' }];
  const snapshot = await connector.pnlPositions!(fy.binding(), ['CLUSDT'], { signal: fy.signal() });
  assert.deepEqual(snapshot.positions, [{ symbol: 'CLUSDT', side: 'long', quantity: '2', entryPrice: '70.11', markPrice: '70.5', unrealizedPnl: '0.78' }]);
  assert.equal(snapshot.accountId, fy.binding().accountId);

  const to = fy.NOW, from = to - 8 * 86_400_000;
  venue.script('GET /v5/account/transaction-log',
    () => fy.ok({ list: [logRow({ id: 'a', transactionTime: String(from + 5) }), logRow({ id: 'other', symbol: 'CLUSDT-26DEC25' })], nextPageCursor: 'next1' }),
    () => fy.ok({ list: [logRow({ id: 'b', type: 'TRADE', funding: '', fee: '0.03', cashFlow: '4.5', change: '4.47', transactionTime: String(from + 6) })], nextPageCursor: '' }),
    () => fy.ok({ list: [], nextPageCursor: '' }));
  const entries = await connector.ledger!(fy.binding(), 'CLUSDT', { from, to }, { signal: fy.signal() });
  assert.deepEqual(entries.map(entry => [entry.id, entry.kind, entry.amount]), [['a:funding', 'funding', '-0.05'], ['b:fee', 'fee', '-0.03'], ['b:realized', 'realized', '4.5']]);
  const calls = venue.calls.filter(call => call.path === '/v5/account/transaction-log');
  assert.equal(calls.length, 3);
  assert.deepEqual([calls[0]!.params.get('baseCoin'), calls[0]!.params.get('accountType'), calls[0]!.params.get('currency'), calls[1]!.params.get('cursor')], ['CL', 'UNIFIED', 'USDT', 'next1']);
  assert.ok(Number(calls[2]!.params.get('startTime')) > from && calls[2]!.params.get('endTime') === String(to));

  for (const bad of [logRow({ change: '-0.06' }), logRow({ type: 'TRANSFER_IN' }), logRow({ currency: 'USDC' }), logRow({ transactionTime: String(to + 1) })]) {
    venue.script('GET /v5/account/transaction-log', () => fy.ok({ list: [bad], nextPageCursor: '' }));
    await assert.rejects(connector.ledger!(fy.binding(), 'CLUSDT', { from: to - 10_000, to }, { signal: fy.signal() }), fy.kind('read-failed'));
  }
  venue.script('GET /v5/account/transaction-log', () => fy.ok({ list: [logRow()], nextPageCursor: 'loop' }), () => fy.ok({ list: [logRow()], nextPageCursor: 'loop' }));
  await assert.rejects(connector.ledger!(fy.binding(), 'CLUSDT', { from: to - 10_000, to }, { signal: fy.signal() }), fy.kind('read-failed'));
  // An empty page that still carries a new cursor goes on to the next page; only a repeated cursor fails.
  venue.script('GET /v5/account/transaction-log', () => fy.ok({ list: [], nextPageCursor: 'p2' }), () => fy.ok({ list: [logRow()], nextPageCursor: '' }));
  assert.deepEqual((await connector.ledger!(fy.binding(), 'CLUSDT', { from: to - 10_000, to }, { signal: fy.signal() })).map(entry => entry.id), ['592324_XRPUSDT_161440249321:funding']);
});

// ---- the store, against scripted connectors ----
const MINUTE = 60_000, T0 = 1_800_000_000_000;
const accountOf = (venue: 'binance' | 'bybit'): AccountBinding => venue === 'binance' ? fb.binding() : fy.binding();
interface Scripted { positions: PnlPosition[]; readAt: (now: number) => number; fail: string | null; ledger: LedgerEntry[]; ledgerFail: string | null; windows: { symbol: string; from: number; to: number }[] }
function scripted(venue: 'binance' | 'bybit', clock: { now: number }) {
  const state: Scripted = { positions: [], readAt: now => now, fail: null, ledger: [], ledgerFail: null, windows: [] };
  const connector = {
    venue,
    pnlPositions: async (binding: AccountBinding) => {
      if (state.fail) throw new Error(state.fail);
      return { venue, accountId: binding.accountId, positions: state.positions, receivedAt: state.readAt(clock.now) };
    },
    ledger: async (_binding: AccountBinding, symbol: string, window: { from: number; to: number }) => {
      state.windows.push({ symbol, ...window });
      if (state.ledgerFail) throw new Error(state.ledgerFail);
      return state.ledger.filter(entry => entry.symbol === symbol && entry.time >= window.from && entry.time <= window.to);
    },
  } as unknown as VenueConnector;
  return { state, connector };
}
function storeSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'oil-pnl-')), clock = { now: T0 };
  const a = scripted('binance', clock), b = scripted('bybit', clock);
  const open = () => createOilPnl({ file: join(dir, 'oil-pnl.sqlite'), connectors: [a.connector, b.connector], accounts: [accountOf('binance'), accountOf('bybit')], now: () => clock.now });
  return { dir, clock, a: a.state, b: b.state, open, done: () => rmSync(dir, { recursive: true, force: true }) };
}
type View = { status: string; start: number; points: { time: number; totalPnl: string | null; unrealizedPnl: string | null; fundingPnl: string | null; realizedPnl: string | null; feePnl: string | null }[];
  latest: { totalPnl: string | null } | null; totals: { funding: string; realized: string; fee: string } | null; entries: { total: number; pages: number; page: number; rows: { id: string; amount: string }[] };
  accounts: { ledger: { coveredUntil: number | null; error: string | null }; positions: { error: string | null }; symbols: { symbol: string; funding: string; unrealized: string | null }[] }[] };
const pos = (unrealizedPnl: string, symbol = 'CLUSDT'): PnlPosition => ({ symbol, side: 'long', quantity: '1', entryPrice: '70', markPrice: '71', unrealizedPnl });
const entry = (id: string, time: number, kind: LedgerEntry['kind'], amount: string, symbol = 'CLUSDT'): LedgerEntry => ({ id, time, symbol, kind, amount });

test('原油盈亏库：首次同步回溯 30 天（每窗不超过 7 天）；每个采样点只累计到各账户自己的持仓读取时刻；账单未覆盖到的采样点没有总盈亏', async () => {
  const s = storeSetup();
  try {
    const pnl = s.open();
    s.a.ledger = [entry('f1', T0 - 2 * 86_400_000, 'funding', '-1.5'), entry('r1', T0 - 3 * MINUTE, 'realized', '10', 'BZUSDT'), entry('c1', T0 - 3 * MINUTE, 'fee', '-0.25', 'BZUSDT')];
    s.b.ledger = [entry('x:funding', T0 - 86_400_000, 'funding', '0.5')];
    await pnl.syncLedgers();
    const windows = s.a.windows.filter(window => window.symbol === 'CLUSDT');
    assert.equal(windows[0]!.from, T0 - LEDGER_LOOKBACK_MS);
    assert.equal(windows.at(-1)!.to, T0);
    assert.ok(windows.every(window => window.to - window.from <= 7 * 86_400_000) && windows.length === 5);

    // Binance read 20 s before Bybit: a Binance fee booked at its read time is not in this sample (only rows before a read count).
    s.a.readAt = now => now - 20_000;
    s.a.positions = [pos('2')]; s.b.positions = [pos('-0.5')];
    s.a.ledger.push(entry('c2', T0 - 10_000, 'fee', '-1'));
    s.clock.now = T0 + 10_000;
    await pnl.sample();
    s.clock.now = T0 + 15_000;
    await pnl.syncLedgers();
    let view = pnl.read({ range: '7d' }) as View;
    assert.equal(view.status, 'ready');
    assert.deepEqual(view.points.map(point => [point.unrealizedPnl, point.fundingPnl, point.realizedPnl, point.feePnl, point.totalPnl]), [['1.5', '-1', '10', '-0.25', '10.25']]);
    assert.deepEqual(view.totals, { funding: '-1', realized: '10', fee: '-1.25' });
    assert.equal(view.entries.total, 5);
    assert.deepEqual(view.accounts[0]!.symbols.map(leg => [leg.symbol, leg.funding, leg.unrealized]), [['CLUSDT', '-1.5', '2'], ['BZUSDT', '0', '0']]);

    // A minute later, without a new ledger sync: the sample is past the ledgers' coverage, so it has no total.
    s.clock.now = T0 + 70_000;
    await pnl.sample();
    view = pnl.read({ range: '7d' }) as View;
    assert.equal(view.status, 'incomplete');
    assert.equal(view.latest!.totalPnl, null);
    assert.equal(view.points.at(-1)!.unrealizedPnl, '1.5');
    // The next sync covers it; this sample counts that fee (booked at T0 − 10 s, before Binance's read at T0 + 50 s).
    await pnl.syncLedgers();
    view = pnl.read({ range: '7d' }) as View;
    assert.equal(view.status, 'ready');
    assert.equal(view.latest!.totalPnl, '9.25');
    pnl.close();
  } finally { s.done(); }
});

test('原油盈亏库：同步从上次截止前 10 分钟重读，重复记录只记一次；同一编号内容变了不写入并记下原因，截止点不前进；读失败只停这个合约', async () => {
  const s = storeSetup();
  try {
    const pnl = s.open();
    s.a.ledger = [entry('f1', T0 - MINUTE, 'funding', '-1')];
    await pnl.syncLedgers();
    s.clock.now = T0 + 5 * MINUTE; s.a.windows = [];
    await pnl.syncLedgers();
    assert.deepEqual(s.a.windows.map(window => [window.symbol, window.from, window.to]), [['CLUSDT', T0 - LEDGER_REREAD_MS, T0 + 5 * MINUTE], ['BZUSDT', T0 - LEDGER_REREAD_MS, T0 + 5 * MINUTE]]);
    let view = pnl.read({ range: '1d' }) as View;
    assert.equal(view.entries.total, 1);

    s.a.ledger = [entry('f1', T0 - MINUTE, 'funding', '-2')];
    s.clock.now = T0 + 10 * MINUTE;
    await pnl.syncLedgers();
    view = pnl.read({ range: '1d' }) as View;
    assert.match(view.accounts[0]!.ledger.error!, /同一编号/);
    assert.equal(view.accounts[0]!.ledger.coveredUntil, T0 + 5 * MINUTE);
    assert.deepEqual(view.entries.rows.map(row => row.amount), ['-1']);

    s.a.ledger = []; s.a.ledgerFail = 'timeout';
    s.clock.now = T0 + 15 * MINUTE;
    await pnl.syncLedgers();
    view = pnl.read({ range: '1d' }) as View;
    assert.match(view.accounts[0]!.ledger.error!, /timeout/);
    assert.equal(view.accounts[1]!.ledger.error, null);
    assert.equal(view.accounts[1]!.ledger.coveredUntil, T0 + 15 * MINUTE);
    pnl.close();
  } finally { s.done(); }
});

test('原油盈亏库：任一账户读失败或两边读取相隔超过 45 秒时不记采样；采样间隔过大处断线；重开后采样与账单仍在；分页按时间倒序', async () => {
  const s = storeSetup();
  try {
    let pnl = s.open();
    await pnl.syncLedgers();
    s.b.fail = '503';
    await pnl.sample();
    let view = pnl.read({ range: '1d' }) as View;
    assert.equal(view.status, 'collecting');
    assert.match(view.accounts[1]!.positions.error!, /503/);
    s.b.fail = null; s.a.readAt = now => now - 46_000;
    await pnl.sample();
    assert.equal((pnl.read({ range: '1d' }) as View).status, 'collecting');
    s.a.readAt = now => now;
    s.clock.now = T0 + MINUTE; await pnl.sample();
    s.clock.now = T0 + 2 * MINUTE; await pnl.sample();
    s.clock.now = T0 + 10 * MINUTE; await pnl.sample();
    pnl.close();

    s.a.ledger = Array.from({ length: 120 }, (_, index) => entry(`f${index}`, T0 + index * 1000, 'funding', '0.01'));
    pnl = s.open();
    await pnl.syncLedgers();
    view = pnl.read({ range: '1d' }) as View;
    assert.deepEqual(view.points.map(point => point.time - T0), [MINUTE, 2 * MINUTE, 3 * MINUTE, 10 * MINUTE]);
    assert.equal(view.points[2]!.unrealizedPnl, null);
    assert.deepEqual([view.entries.total, view.entries.pages, view.entries.rows[0]!.id], [120, 3, 'f119']);
    const last = pnl.read({ range: '1d', page: 9 }) as View;
    assert.deepEqual([last.entries.page, last.entries.rows.length, last.entries.rows.at(-1)!.id], [2, 20, 'f0']);
    pnl.close();
  } finally { s.done(); }
});

test('模拟交易所：每笔成交按 5 个基点记手续费，平仓按平均开仓价记平仓盈亏；盈亏库据此给出总盈亏', async () => {
  const { createSimulatedVenues, SIM_BINDINGS } = await import('../src/simulation.ts');
  const dir = mkdtempSync(join(tmpdir(), 'oil-pnl-sim-')), clock = { now: T0 };
  try {
    const { binance } = createSimulatedVenues(() => clock.now);
    const account = SIM_BINDINGS[0] as unknown as AccountBinding;
    const send = { signal: fb.signal(), beforeSend: () => undefined };
    await binance.place(account, fb.order({ clientOrderId: 'pa1-0123456789abcdef01234567-1', quantity: '2', limitPrice: '70.10' }), send);
    clock.now += 1000;
    binance.setBook('CLUSDT', { bid: '71.00', ask: '71.02' });
    let snapshot = await binance.pnlPositions!(account, ['CLUSDT', 'BZUSDT'], { signal: fb.signal() });
    assert.deepEqual(snapshot.positions.map(row => [row.symbol, row.side, row.quantity, row.entryPrice, row.markPrice, row.unrealizedPnl]), [['CLUSDT', 'long', '2', '70.02', '71.01', '1.98']]);
    await binance.place(account, fb.order({ clientOrderId: 'pa1-0123456789abcdef01234567-2', side: 'sell', quantity: '1', limitPrice: '70.90', reduceOnly: true }), send);
    const ledger = await binance.ledger!(account, 'CLUSDT', { from: T0, to: clock.now }, { signal: fb.signal() });
    assert.deepEqual(ledger.map(row => [row.kind, row.amount]), [['fee', '-0.07002'], ['fee', '-0.0355'], ['realized', '0.98']]);
    snapshot = await binance.pnlPositions!(account, ['CLUSDT'], { signal: fb.signal() });
    assert.equal(snapshot.positions[0]!.unrealizedPnl, '0.99');

    const pnl = createOilPnl({ file: join(dir, 'oil-pnl.sqlite'), connectors: [binance], accounts: [account], now: () => clock.now });
    clock.now += 1000;
    await pnl.sample();
    clock.now += 1000;
    await pnl.syncLedgers();
    const view = pnl.read({ range: '1d' }) as View;
    assert.equal(view.latest!.totalPnl, '1.86448');
    pnl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('原油盈亏库：采样里的持仓读取时刻按账户记，调换配置中账户的顺序后每个账户仍按自己的读取时刻累计账单', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oil-pnl-')), clock = { now: T0 };
  const a = scripted('binance', clock), b = scripted('bybit', clock), file = join(dir, 'oil-pnl.sqlite');
  const open = (accounts: AccountBinding[]) => createOilPnl({ file, connectors: [a.connector, b.connector], accounts, now: () => clock.now });
  try {
    // Binance read 20 s before Bybit: Binance's row 10 s before the sample is after its own read and not counted; Bybit's is.
    a.state.readAt = now => now - 20_000;
    a.state.ledger = [entry('y', T0 + MINUTE - 10_000, 'funding', '10')];
    b.state.ledger = [entry('x', T0 + MINUTE - 10_000, 'funding', '1')];
    let pnl = open([accountOf('binance'), accountOf('bybit')]);
    await pnl.syncLedgers();
    clock.now = T0 + MINUTE; await pnl.sample();
    clock.now = T0 + 2 * MINUTE; await pnl.syncLedgers();
    const total = (view: View) => view.points.filter(point => point.totalPnl !== null).map(point => Number(point.totalPnl));
    assert.deepEqual(total(pnl.read({ range: '1d' }) as View), [1]);
    pnl.close();
    pnl = open([accountOf('bybit'), accountOf('binance')]);
    assert.deepEqual(total(pnl.read({ range: '1d' }) as View), [1]);
    pnl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
