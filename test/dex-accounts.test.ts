// DEX 价差模块账户资产、持仓、成交、资金费与盈亏汇总（docs/dexspread.md 第 14 节）：
// 覆盖完整账户解析、Entropy/Lighter 历史解析与有界翻页、401 重试、SQLite 快照隔离与清理、
// 引擎刷新冷却与在途失效（L089/L207）、隐私脱敏与只读令牌隔离（D4）。全部使用替身应答，不连外网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DexAccountsState } from '../src/dex/keys.ts';
import { routePage, varLighterViews } from '../src/dex/host.ts';
import { readTokenAllows } from '../src/read-token.ts';
import {
  ACCOUNT_MANUAL_REFRESH_COOLDOWN_MS, ACCOUNT_SNAPSHOT_GAP_MS, ACCOUNT_STALE_MS, createVarLighterEngine,
} from '../src/varlighter/engine.ts';
import {
  fetchAccountHistory, parseEntropyAccount, parseEntropyFunding, parseEntropyTrades,
  parseLighterAccount, parseLighterFunding, parseLighterPnl, parseLighterTrades,
} from '../src/varlighter/accounts.ts';
import type { SocketLike } from '../src/varlighter/feeds.ts';
import { createLiveKeysStore } from '../src/varlighter/livekeys.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';

const T0 = Date.parse('2026-11-27T15:00:00Z');
const ACCOUNT = 987654, RH_ACCOUNT = 876543;
const ADDRESS = '0x00000000000000000000000000000000000000ab';
const LIGHTER_KEY = 'ab'.repeat(40), ENTROPY_KEY = '0x' + '11'.repeat(32);
const AUTH_SECRET = 'lighter-secret-auth-token-998877';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const silent = (): SocketLike => { const s: SocketLike = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() { s.readyState = 3; } }; return s; };

test('完整账户解析：Lighter 权益/杠杆/强平价/资产与异常可选字段回退', () => {
  const lighter = parseLighterAccount({
    code: 200,
    accounts: [{
      account_index: ACCOUNT,
      collateral: '300.25',
      available_balance: '250.50',
      total_asset_value: '312.80',
      assets: [
        { symbol: 'USDC', balance: '300.25', locked_balance: '12.5' },
        { asset_id: 2, balance: '0', locked_balance: '0' },
      ],
      positions: [
        {
          market_id: 0, symbol: 'ETH', sign: 1, position: '0.1', avg_entry_price: '3400', position_value: '352.5',
          unrealized_pnl: '12.55', realized_pnl: '3.2', initial_margin_fraction: '10.00', liquidation_price: '0', margin_mode: 0, allocated_margin: '35.25',
        },
        { market_id: 1, symbol: 'BTC', sign: -1, position: '0', position_value: '0' },
      ],
    }],
  }, ACCOUNT);
  assert.deepEqual(lighter, {
    collateral: 300.25, available: 250.5, equity: 312.8, marginUsed: 35.25, unrealizedPnl: 12.55,
    assets: [{ symbol: 'USDC', balance: 300.25, locked: 12.5 }],
    positions: [{
      symbol: 'ETH', size: 0.1, valueUsd: 352.5, entryPrice: 3400, unrealizedPnl: 12.55, realizedPnl: 3.2,
      liquidationPrice: null, leverage: 10, marginMode: 'cross', marketId: 0,
    }],
  });

  // 可选字段坏值不拖垮持仓读取，保守降级为 null。
  const degraded = parseLighterAccount({
    code: 200,
    accounts: [{
      account_index: 1, collateral: '100', available_balance: '90', total_asset_value: 'bad',
      positions: [{ market_id: -1, symbol: 'NVDA', sign: -1, position: '1', position_value: '-180', unrealized_pnl: 'bad', initial_margin_fraction: '0', liquidation_price: '250', margin_mode: 9 }],
    }],
  }, 1);
  assert.equal(degraded.equity, 100);
  assert.equal(degraded.unrealizedPnl, null);
  assert.equal(degraded.marginUsed, null);
  assert.equal(degraded.positions[0]!.leverage, null);
  assert.equal(degraded.positions[0]!.liquidationPrice, 250);
  assert.equal(degraded.positions[0]!.marginMode, null);

  const entropy = parseEntropyAccount({
    marginSummary: { accountValue: '512.40', totalMarginUsed: '18.20' },
    withdrawable: '480.10',
    assetPositions: [{
      type: 'oneWay',
      position: { coin: 'io:NVDA', szi: '-0.2', positionValue: '36.40', entryPx: '183.5', unrealizedPnl: '0.3', liquidationPx: '240', leverage: { type: 'isolated', value: 5 } },
    }],
  });
  assert.deepEqual(entropy, {
    collateral: 512.4, available: 480.1, equity: 512.4, marginUsed: 18.2, unrealizedPnl: 0.3, assets: [],
    positions: [{
      symbol: 'io:NVDA', size: -0.2, valueUsd: 36.4, entryPrice: 183.5, unrealizedPnl: 0.3, realizedPnl: null,
      liquidationPrice: 240, leverage: 5, marginMode: 'isolated', marketId: null,
    }],
  });
});

test('成交与资金费解析：Entropy 仅保留 io:、非 USDC 手续费置空；Lighter 身份与角色核对', () => {
  const fills = parseEntropyTrades([
    { tid: 1, coin: 'io:NVDA', px: '180.5', sz: '0.5', side: 'A', dir: 'Open Short', crossed: true, fee: '0.04', feeToken: 'USDC', closedPnl: '0', time: T0 },
    { tid: 2, coin: 'io:AAPL', px: '220', sz: '0.2', side: 'B', dir: 'Close Short', crossed: false, fee: '0.001', feeToken: 'HYPE', closedPnl: '1.2', time: T0 + 1000 },
    { tid: 3, coin: 'BTC', px: '98000', sz: '0.1', side: 'B', crossed: true, fee: '2', feeToken: 'USDC', closedPnl: '5', time: T0 + 2000 },
    { tid: 4, coin: 'xyz:NVDA', px: '180', sz: '0.1', side: 'B', crossed: true, fee: '0.1', feeToken: 'USDC', closedPnl: '0', time: T0 + 3000 },
  ]);
  assert.equal(fills.length, 2);
  assert.deepEqual(fills[0], {
    id: 'entropy:1', venue: 'entropy', symbol: 'io:NVDA', side: 'sell', dir: 'Open Short', role: 'taker',
    price: 180.5, qty: 0.5, notionalUsd: 90.25, feeUsd: 0.04, realizedPnlUsd: 0, at: T0,
  });
  assert.equal(fills[1]!.role, 'maker');
  assert.equal(fills[1]!.feeUsd, null, '非 USDC 手续费不误当 USDC');
  assert.throws(() => parseEntropyTrades({ bad: true }), /格式无效/);

  const eFunding = parseEntropyFunding([
    { time: T0, hash: '0x1', delta: { type: 'funding', coin: 'io:NVDA', usdc: '0.025', szi: '-0.5', fundingRate: '0.0001' } },
    { time: T0, hash: '0x2', delta: { type: 'funding', coin: 'BTC', usdc: '-1.5', szi: '0.1', fundingRate: '0.0001' } },
  ]);
  assert.equal(eFunding.length, 1);
  assert.deepEqual(eFunding[0], { id: 'entropy-f:0x1:io:NVDA:1795791600000', venue: 'entropy', symbol: 'io:NVDA', side: 'short', positionSize: -0.5, rate: 0.0001, amountUsd: 0.025, at: T0 });

  const names = new Map([[0, 'ETH'], [110, 'NVDA']]);
  const lTrades = parseLighterTrades({
    code: 200,
    next_cursor: 'c1',
    trades: [
      { trade_id: 10, market_id: 0, size: '0.2', price: '3500', usd_amount: '700', bid_account_id: ACCOUNT, ask_account_id: 22, is_maker_ask: true, taker_fee: '0', maker_fee: '0', timestamp: Math.floor(T0 / 1000), bid_account_pnl: '-1.25', ask_account_pnl: '9' },
      { trade_id: 11, market_id: 110, size: '1', price: '180', bid_account_id: 33, ask_account_id: ACCOUNT, is_maker_ask: true, taker_fee: '50', maker_fee: '20', timestamp: T0 + 1000, bid_account_pnl: '7', ask_account_pnl: '0.5' },
      { trade_id: 12, market_id: 0, size: '1', price: '3500', bid_account_id: 99, ask_account_id: 88, is_maker_ask: false, timestamp: T0 + 2000 },
    ],
  }, ACCOUNT, names, 'lighter');
  assert.equal(lTrades.truncated, true);
  assert.equal(lTrades.trades.length, 2, '非本账户成交被跳过');
  assert.deepEqual([lTrades.trades[0]!.symbol, lTrades.trades[0]!.side, lTrades.trades[0]!.role, lTrades.trades[0]!.feeUsd, lTrades.trades[0]!.at], ['ETH', 'buy', 'taker', 0, T0]);
  assert.deepEqual([lTrades.trades[1]!.symbol, lTrades.trades[1]!.side, lTrades.trades[1]!.role, lTrades.trades[1]!.feeUsd], ['NVDA', 'sell', 'maker', null]);
  assert.deepEqual(lTrades.trades.map(trade => trade.realizedPnlUsd), [-1.25, 0.5], '已实现盈亏取本账户一侧：买入取 bid_account_pnl，卖出取 ask_account_pnl');

  const lFunding = parseLighterFunding({
    code: 200,
    position_fundings: [{ funding_id: 5, market_id: 0, timestamp: Math.floor(T0 / 1000), position_side: 'long', position_size: '0.2', rate: '0.0001', change: '-0.07' }],
  }, names, 'rh');
  assert.equal(lFunding.truncated, false);
  assert.deepEqual(lFunding.funding[0], { id: 'rh-f:5', venue: 'rh', symbol: 'ETH', side: 'long', positionSize: 0.2, rate: 0.0001, amountUsd: -0.07, at: T0 });

  const lPnl = parseLighterPnl({ code: 200, pnl: [{ timestamp: Math.floor((T0 + 86_400_000) / 1000), trade_pnl: '4.5' }, { timestamp: Math.floor(T0 / 1000), trade_pnl: '-1.2' }] });
  assert.deepEqual(lPnl, [{ at: T0, pnlUsd: -1.2, equityUsd: null }, { at: T0 + 86_400_000, pnlUsd: 4.5, equityUsd: null }]);
});

test('history 拉取：Entropy 满页翻页与不前进截断（L093）；Lighter 无鉴权不发请求、401 刷新重试', async () => {
  const signalFor = () => new AbortController().signal;
  // Entropy：第一页 2000 条（含主盘 BTC）且时间推进，第二页 1 条且 funding 失败（部分失败不丢成交，pnlSeries 置空）。
  let fillPage = 0;
  const entropyFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { type: string; startTime: number };
    if (body.type === 'userFillsByTime') {
      fillPage++;
      if (fillPage === 1) {
        return json([
          { tid: 1, coin: 'io:NVDA', px: '100', sz: '1', side: 'B', crossed: true, fee: '0.05', feeToken: 'USDC', closedPnl: '0', time: T0 - 5000 },
          ...Array.from({ length: 1999 }, (_, i) => ({ tid: 100 + i, coin: 'BTC', px: '90000', sz: '0.01', side: 'B', crossed: true, fee: '0.1', feeToken: 'USDC', closedPnl: '0', time: T0 - 4000 })),
        ]);
      }
      return json([{ tid: 2, coin: 'io:NVDA', px: '102', sz: '1', side: 'A', crossed: true, fee: '0.05', feeToken: 'USDC', closedPnl: '2.0', time: T0 - 1000 }]);
    }
    return json({}, 500);
  }) as unknown as typeof fetch;

  const partial = await fetchAccountHistory({ fetchImpl: entropyFetch, signalFor, venue: 'entropy', accounts: { entropy: { address: ADDRESS } }, now: T0 });
  assert.equal(partial.trades.length, 2);
  assert.equal(partial.tradesTruncated, false);
  assert.equal(partial.fundingError, 'HTTP 500');
  assert.equal(partial.pnlError, 'HTTP 500');
  assert.deepEqual(partial.pnlSeries, []);
  assert.deepEqual(partial.summary, { tradeCount: 2, volumeUsd: 202, feeUsd: 0.1, realizedPnlUsd: 2, fundingUsd: null });

  // 满页且降序排列：按整页最大时间戳推进，不误判截断。
  let descPage = 0;
  let secondStart = 0;
  const descFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { type: string; startTime: number };
    if (body.type === 'userFillsByTime') {
      descPage++;
      if (descPage === 1) {
        return json([
          { tid: 1, coin: 'io:NVDA', px: '100', sz: '0.2', side: 'B', crossed: true, fee: '0', feeToken: 'USDC', closedPnl: '0', time: T0 - 2000 },
          ...Array.from({ length: 1998 }, (_, i) => ({ tid: 10 + i, coin: 'BTC', px: '90000', sz: '0.01', side: 'B', crossed: true, fee: '0', feeToken: 'USDC', closedPnl: '0', time: T0 - 3000 })),
          { tid: 2, coin: 'io:NVDA', px: '101', sz: '0.2', side: 'A', crossed: true, fee: '0', feeToken: 'USDC', closedPnl: '0.2', time: body.startTime },
        ]);
      }
      secondStart = body.startTime;
      return json([{ tid: 3, coin: 'io:NVDA', px: '102', sz: '0.2', side: 'B', crossed: true, fee: '0', feeToken: 'USDC', closedPnl: '0', time: T0 - 1000 }]);
    }
    return json([]);
  }) as unknown as typeof fetch;
  const desc = await fetchAccountHistory({ fetchImpl: descFetch, signalFor, venue: 'entropy', accounts: { entropy: { address: ADDRESS } }, now: T0 });
  assert.equal(desc.tradesTruncated, false);
  assert.equal(secondStart, T0 - 2000);
  assert.equal(desc.trades.length, 3);

  // 满页且时间戳不前进：判定截断（L093）。
  const stuckFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { type: string; startTime: number };
    if (body.type === 'userFillsByTime') {
      return json(Array.from({ length: 2000 }, (_, i) => ({ tid: i, coin: 'io:NVDA', px: '100', sz: '0.1', side: 'B', crossed: true, fee: '0', feeToken: 'USDC', closedPnl: '0', time: body.startTime })));
    }
    return json([]);
  }) as unknown as typeof fetch;
  const stuck = await fetchAccountHistory({ fetchImpl: stuckFetch, signalFor, venue: 'entropy', accounts: { entropy: { address: ADDRESS } }, now: T0 });
  assert.equal(stuck.tradesTruncated, true);

  // Lighter：没有 authToken 时不发任何请求。
  let calls = 0;
  const noAuth = await fetchAccountHistory({ fetchImpl: (async () => { calls++; return json({}); }) as unknown as typeof fetch, signalFor, venue: 'lighter', accounts: { lighter: { accountIndex: ACCOUNT } }, now: T0 });
  assert.equal(calls, 0);
  assert.equal(noAuth.authRequired, true);

  // Lighter：401 时调用 authToken(true) 刷新并重试一次；错误中长数字与地址脱敏。
  const tokensSeen: string[] = [];
  let tokenVersion = 1;
  const lighterFetch = (async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    tokensSeen.push(auth);
    if (auth === 'token-v1') return json({}, 401);
    if (url.includes('/trades')) return json({ code: 200, trades: [{ trade_id: 1, market_id: 0, size: '0.5', price: '100', usd_amount: '50', bid_account_id: ACCOUNT, ask_account_id: 1, is_maker_ask: false, taker_fee: '0', maker_fee: '0', timestamp: T0 }] });
    if (url.includes('/positionFunding')) return new Response('denied account ' + ACCOUNT, { status: 500 });
    return json({ code: 200, pnl: [{ timestamp: Math.floor(T0 / 1000), trade_pnl: '3.5' }] });
  }) as unknown as typeof fetch;
  const res = await fetchAccountHistory({
    fetchImpl: lighterFetch, signalFor, venue: 'lighter', accounts: { lighter: { accountIndex: ACCOUNT } }, now: T0,
    marketNames: new Map([[0, 'ETH']]),
    authToken: async force => { if (force) tokenVersion = 2; return `token-v${tokenVersion}`; },
  });
  assert.ok(tokensSeen.includes('token-v1') && tokensSeen.includes('token-v2'));
  assert.equal(res.trades.length, 1);
  assert.equal(res.trades[0]!.symbol, 'ETH');
  assert.equal(res.pnlSeries.length, 1);
  assert.ok(res.fundingError && !res.fundingError.includes(String(ACCOUNT)));
});

test('SQLite 账户快照：写入、按 account_hash 隔离与 30 天清理', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-acc-store-'));
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.addAccountSnapshot({ venue: 'lighter', accountHash: 'h1', at: T0 - 40 * 86_400_000, equity: 100, collateral: 100, available: 90, unrealizedPnl: 0, positions: 0 });
  store.addAccountSnapshot({ venue: 'lighter', accountHash: 'h1', at: T0 - 3_600_000, equity: 120, collateral: 118, available: 95, unrealizedPnl: 2, positions: 1 });
  store.addAccountSnapshot({ venue: 'lighter', accountHash: 'h1', at: T0 - 3_600_000, equity: 999, collateral: 999, available: 999, unrealizedPnl: 0, positions: 0 });
  store.addAccountSnapshot({ venue: 'lighter', accountHash: 'h2', at: T0 - 1_800_000, equity: 500, collateral: 500, available: 500, unrealizedPnl: 0, positions: 0 });
  assert.deepEqual(store.accountSnapshots('lighter', 'h1', T0 - 50 * 86_400_000).map(r => r.equity), [100, 120], '同时间戳保留先写入且按账户哈希隔离');
  store.pruneAccountSnapshots(T0);
  assert.deepEqual(store.accountSnapshots('lighter', 'h1', 0).map(r => r.equity), [120], '清理 30 天前快照');
  assert.deepEqual(store.accountSnapshots('lighter', 'h2', 0).map(r => r.equity), [500]);
});

test('引擎与接口：汇总完整性、凭据切换使在途读取失效（L089）、手动刷新冷却、脱敏与只读令牌拒绝', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-acc-engine-'));
  let clock = T0;
  let releaseLighter!: () => void;
  let holdLighter = false;
  const envState: DexAccountsState = { accounts: { rh: { accountIndex: RH_ACCOUNT } }, problem: null };
  const liveKeys = createLiveKeysStore(dir);
  liveKeys.set('lighter', { accountIndex: ACCOUNT, apiKeyIndex: 5, privateKey: LIGHTER_KEY });
  liveKeys.set('entropy', { address: ADDRESS, privateKey: ENTROPY_KEY });

  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.includes('mainnet.zklighter') && url.includes('/account')) {
      if (holdLighter) await new Promise<void>(resolve => { releaseLighter = resolve; });
      return json({ code: 200, accounts: [{ account_index: ACCOUNT, collateral: '300', available_balance: '250', total_asset_value: '305', positions: [{ market_id: 0, symbol: 'ETH', sign: 1, position: '0.1', position_value: '350', avg_entry_price: '3450', unrealized_pnl: '5' }] }] });
    }
    if (url.includes('api.rh.lighter.xyz') && url.includes('/account')) {
      return json({ code: 200, accounts: [{ account_index: RH_ACCOUNT, collateral: '80', available_balance: '80', positions: [] }] });
    }
    if (url.includes('mainnet.zklighter') && url.includes('/trades')) return json({ code: 200, trades: [] });
    if (url.includes('mainnet.zklighter') && url.includes('/positionFunding')) return json({ code: 200, position_fundings: [] });
    if (url.includes('mainnet.zklighter') && url.includes('/pnl')) return json({ code: 200, pnl: [] });
    if (url.includes('hyperliquid.xyz/info')) {
      const body = JSON.parse(String(init.body)) as { type: string };
      if (body.type === 'clearinghouseState') return json({ marginSummary: { accountValue: '200', totalMarginUsed: '20' }, withdrawable: '180', assetPositions: [{ type: 'oneWay', position: { coin: 'io:NVDA', szi: '-0.5', positionValue: '90', unrealizedPnl: '-2' } }] });
      if (body.type === 'userAbstraction') return json('default');
      if (body.type === 'userFillsByTime') return json([{ tid: 9, coin: 'io:NVDA', px: '180', sz: '0.5', side: 'A', dir: 'Open Short', crossed: true, fee: '0.04', feeToken: 'USDC', closedPnl: '0', time: clock - 1000 }]);
      if (body.type === 'userFunding') return json([{ time: clock - 500, hash: '0x9', delta: { type: 'funding', coin: 'io:NVDA', usdc: '0.02', szi: '-0.5', fundingRate: '0.0001' } }]);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  const engine = createVarLighterEngine({
    store, fetchImpl, connect: silent, now: () => clock,
    accounts: () => envState, liveKeys, signerProblem: () => null,
    lighterAuth: async venue => venue === 'lighter' ? AUTH_SECRET : null,
  });
  t.after(() => { engine.close(); rmSync(dir, { recursive: true, force: true }); });
  const signalFor = () => new AbortController().signal;

  await engine.refreshAccounts(signalFor);
  await engine.refreshAccountHistory(signalFor);
  clock += ACCOUNT_SNAPSHOT_GAP_MS;
  await engine.refreshAccounts(signalFor);

  const view = engine.views.accounts();
  assert.equal(view.totals.configured, 3);
  assert.equal(view.totals.fresh, 3);
  assert.equal(view.totals.complete, true);
  assert.equal(view.totals.equityUsd, 305 + 80 + 200);
  assert.equal(view.totals.positionsCount, 2);
  assert.equal(view.totals.fundingUsd30d, 0.02);
  assert.equal(view.totals.realizedPnlUsd30d, 0);
  assert.equal(view.equityComplete, true);
  assert.equal(view.equityCurve.length, 2);
  assert.equal(view.venues.find(item => item.venue === 'rh')!.authRequired, true, 'RH 仅有只读账户');
  assert.equal('livePositions' in view, false, 'AccountsView 不传输未被前端使用的 livePositions');

  // D4 隐私检查：输出不含任何账户编号、地址、私钥或鉴权令牌。
  const serialized = JSON.stringify(view);
  for (const secret of [String(ACCOUNT), String(RH_ACCOUNT), ADDRESS.slice(2), LIGHTER_KEY.slice(0, 16), ENTROPY_KEY.slice(2, 18), AUTH_SECRET]) {
    assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false, `应答不得包含 ${secret}`);
  }

  // 只读令牌禁止读取账户资产接口。
  assert.equal(readTokenAllows(new URL('http://localhost/api/varlighter/accounts')), false);
  assert.equal(readTokenAllows(new URL('http://localhost/api/varlighter/accounts/refresh')), false);

  // host 路由与手动刷新冷却检查（不阻塞、10 秒内拒重复触发）。
  const views = varLighterViews({ engine, error: null });
  assert.equal((await routePage(views, { method: 'GET', path: 'accounts', query: [] }, () => {})).status, 200);
  const r1 = await routePage(views, { method: 'POST', path: 'accounts/refresh', query: [], body: {} }, () => {});
  assert.equal(r1.status, 200);
  assert.equal((r1.body as { triggered: boolean }).triggered, true);
  const r2 = await routePage(views, { method: 'POST', path: 'accounts/refresh', query: [], body: {} }, () => {});
  assert.equal((r2.body as { triggered: boolean; cooldownMs: number }).triggered, false);
  assert.ok((r2.body as { cooldownMs: number }).cooldownMs > 0);
  clock += ACCOUNT_MANUAL_REFRESH_COOLDOWN_MS + 1;
  // 等上一次后台刷新收尾后测试 L089 在途失效。
  await new Promise(resolve => setTimeout(resolve, 20));

  holdLighter = true;
  const inflight = engine.refreshAccounts(signalFor);
  await new Promise(resolve => setImmediate(resolve));
  liveKeys.remove('lighter');
  releaseLighter();
  await inflight;
  assert.equal(engine.views.accounts().venues.find(item => item.venue === 'lighter')!.configured, false, '移除凭据后迟到的旧读取被丢弃（L089）');
  assert.equal(engine.views.accounts().venues.find(item => item.venue === 'lighter')!.at, null);

  // 过期检测。
  clock += ACCOUNT_STALE_MS + 1;
  assert.equal(engine.views.accounts().totals.complete, false);
});

test('L049：慢应答时账户资产与历史时间戳均记录请求发起时刻', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-acc-l049-'));
  let clock = T0;
  const historyFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { type: string };
    clock += 30_000;
    if (body.type === 'clearinghouseState') {
      return json({ marginSummary: { accountValue: '150', totalMarginUsed: '0' }, withdrawable: '150', assetPositions: [] });
    }
    if (body.type === 'userAbstraction') return json('default');
    return json([]);
  }) as unknown as typeof fetch;
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  const engine = createVarLighterEngine({
    store, fetchImpl: historyFetch, connect: silent, now: () => clock,
    accounts: () => ({ accounts: { entropy: { address: ADDRESS } }, problem: null }),
    signerProblem: () => null,
  });
  t.after(() => { engine.close(); rmSync(dir, { recursive: true, force: true }); });
  const signalFor = () => new AbortController().signal;

  const accStart = clock;
  await engine.refreshAccounts(signalFor);
  const histStart = clock;
  await engine.refreshAccountHistory(signalFor);

  const view = engine.views.accounts();
  const entropy = view.venues.find(item => item.venue === 'entropy')!;
  assert.equal(entropy.at, accStart);
  assert.equal(entropy.historyAt, histStart);
  assert.equal(view.equityCurve.length, 1);
  assert.equal(view.equityCurve[0]!.t, accStart);
});

test('并发竞争与下采样：每场所序号防止旧读取/旧失败覆盖，换密钥不影响无关场所，pnlCurve 限 300 点', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-acc-race-'));
  let clock = T0;
  let releaseOldLighter!: () => void;
  let holdFirstLighter = true;
  let releaseOldHistory!: () => void;
  let holdFirstHistory = true;
  let entropyHold = false;
  let releaseEntropy!: () => void;
  let lighterCall = 0;
  let entropyHistCall = 0;

  const liveKeys = createLiveKeysStore(dir);
  liveKeys.set('lighter', { accountIndex: ACCOUNT, apiKeyIndex: 5, privateKey: LIGHTER_KEY });
  liveKeys.set('entropy', { address: ADDRESS, privateKey: ENTROPY_KEY });

  const manyFills = Array.from({ length: 450 }, (_, index) => ({
    tid: index + 1,
    coin: 'io:NVDA',
    px: '100',
    sz: '0.1',
    side: 'B',
    dir: 'Open Long',
    crossed: true,
    fee: '0.01',
    feeToken: 'USDC',
    closedPnl: '0.05',
    time: T0 - (450 - index) * 10_000,
  }));

  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.includes('mainnet.zklighter') && url.includes('/account')) {
      lighterCall++;
      const callNo = lighterCall;
      if (callNo === 1 && holdFirstLighter) {
        await new Promise<void>(resolve => { releaseOldLighter = resolve; });
        return new Response('slow boom ' + ACCOUNT, { status: 500 });
      }
      return json({ code: 200, accounts: [{ account_index: ACCOUNT, collateral: '500', available_balance: '480', total_asset_value: '510', positions: [] }] });
    }
    if (url.includes('mainnet.zklighter')) return json({ code: 200, trades: [], position_fundings: [], pnl: [] });
    if (url.includes('hyperliquid.xyz/info')) {
      const body = JSON.parse(String(init.body)) as { type: string };
      if (body.type === 'clearinghouseState') {
        if (entropyHold) await new Promise<void>(resolve => { releaseEntropy = resolve; });
        return json({ marginSummary: { accountValue: '250', totalMarginUsed: '0' }, withdrawable: '250', assetPositions: [] });
      }
      if (body.type === 'userAbstraction') return json('default');
      if (body.type === 'userFillsByTime') {
        entropyHistCall++;
        const callNo = entropyHistCall;
        if (callNo === 1 && holdFirstHistory) {
          await new Promise<void>(resolve => { releaseOldHistory = resolve; });
          return json([{ tid: 9999, coin: 'io:NVDA', px: '100', sz: '1', side: 'B', crossed: true, fee: '0', feeToken: 'USDC', closedPnl: '99', time: T0 - 1000 }]);
        }
        return json(manyFills);
      }
      return json([]);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  const engine = createVarLighterEngine({
    store, fetchImpl, connect: silent, now: () => clock,
    accounts: () => ({ accounts: { rh: { accountIndex: RH_ACCOUNT } }, problem: null }),
    liveKeys, signerProblem: () => null,
    lighterAuth: async () => AUTH_SECRET,
  });
  t.after(() => { engine.close(); rmSync(dir, { recursive: true, force: true }); });
  const signalFor = () => new AbortController().signal;

  // 1. 先发起旧的账户与历史请求（在途挂起），接着推进时钟发起新请求并完成，最后放行旧请求（带失败或旧数据）。
  const oldAcc = engine.refreshAccounts(signalFor);
  const oldHist = engine.refreshAccountHistory(signalFor);
  await new Promise(resolve => setImmediate(resolve));
  holdFirstLighter = false;
  holdFirstHistory = false;
  clock += 5_000;
  await engine.refreshAccounts(signalFor);
  await engine.refreshAccountHistory(signalFor);

  releaseOldLighter();
  releaseOldHistory();
  await Promise.all([oldAcc, oldHist]);

  const afterRace = engine.views.accounts();
  const lighterView = afterRace.venues.find(item => item.venue === 'lighter')!;
  const entropyView = afterRace.venues.find(item => item.venue === 'entropy')!;
  assert.equal(lighterView.equity, 510, '新读取结果不被迟到的旧失败覆盖');
  assert.equal(lighterView.error, null, '迟到的旧 500 不覆写新成功状态');
  assert.equal(entropyView.summary.tradeCount, 450, '新历史不被迟到的旧响应覆盖');
  assert.ok(entropyView.pnlCurve.length <= 300 && entropyView.pnlCurve.length > 2, 'Entropy pnlCurve 限制在 300 点内');

  // 2. 在 entropy 读取在途期间更换/移除 lighter 凭据（有 RH keys.env 回退路径不受影响），entropy 读取不被连带丢弃。
  entropyHold = true;
  const inflightEntropy = engine.refreshAccounts(signalFor);
  await new Promise(resolve => setImmediate(resolve));
  engine.views.liveKeysRemove({ venue: 'lighter' });
  entropyHold = false;
  releaseEntropy();
  await inflightEntropy;
  const afterKeyRemoval = engine.views.accounts();
  assert.equal(afterKeyRemoval.venues.find(item => item.venue === 'lighter')!.configured, false);
  assert.equal(afterKeyRemoval.venues.find(item => item.venue === 'entropy')!.equity, 250, '移除 lighter 凭据不丢弃无关场所 entropy 的在途读取');
});

test('账户资产视图：Entropy 统一账户从现货账本汇总权益、可用余额与现货明细，写入快照且不泄露地址', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-acc-unified-'));
  let clock = T0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.includes('hyperliquid.xyz/info')) {
      const body = JSON.parse(String(init.body)) as { type: string };
      if (body.type === 'clearinghouseState') {
        return json({
          marginSummary: { accountValue: '0.0', totalMarginUsed: '20' },
          withdrawable: '0.0',
          assetPositions: [{ type: 'oneWay', position: { coin: 'io:NVDA', szi: '-0.5', positionValue: '90', unrealizedPnl: '-2' } }],
        });
      }
      if (body.type === 'userAbstraction') return json('unifiedAccount');
      if (body.type === 'spotClearinghouseState') {
        return json({
          balances: [
            { coin: 'USDC', token: 0, total: '1000.10', hold: '140.35' },
            { coin: 'HYPE', token: 150, total: '0.5', hold: '0' },
          ],
        });
      }
      if (body.type === 'userFillsByTime' || body.type === 'userFunding') return json([]);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  const engine = createVarLighterEngine({
    store, fetchImpl, connect: silent, now: () => clock,
    accounts: () => ({ accounts: { entropy: { address: ADDRESS } }, problem: null }),
    signerProblem: () => null,
  });
  t.after(() => { engine.close(); rmSync(dir, { recursive: true, force: true }); });
  const signalFor = () => new AbortController().signal;

  await engine.refreshAccounts(signalFor);
  clock += ACCOUNT_SNAPSHOT_GAP_MS;
  await engine.refreshAccounts(signalFor);

  const view = engine.views.accounts();
  const entropy = view.venues.find(item => item.venue === 'entropy')!;
  assert.equal(entropy.configured, true);
  assert.equal(entropy.error, null);
  assert.equal(entropy.equity, 1000.1);
  assert.equal(entropy.collateral, 1000.1);
  assert.equal(entropy.available, 859.75);
  assert.equal(entropy.marginUsed, 20);
  assert.equal(entropy.positionsCount, 1);
  assert.deepEqual(entropy.assets, [{ symbol: 'USDC', balance: 1000.1, locked: 140.35 }, { symbol: 'HYPE', balance: 0.5, locked: 0 }]);
  assert.equal(view.equityCurve.length, 2);
  assert.deepEqual(view.equityCurve.map(point => point.equity), [1000.1, 1000.1]);
  assert.equal(JSON.stringify(view).toLowerCase().includes(ADDRESS.slice(2).toLowerCase()), false, '账户资产视图不得泄露钱包地址');
});
