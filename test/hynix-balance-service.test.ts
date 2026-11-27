// SK hynix H2 service side (docs/hynix.md 7.4): the per-venue balance reading, the settings store, the page endpoints and the
// Feishu balance alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ContractError } from '../src/contracts.ts';
import { SIM_ACCOUNTS, SIM_BINDINGS, createSimulatedVenues } from '../src/simulation.ts';
import { createHynixMarket, RULES_READ_MS, type BalanceRow } from '../src/hynix/market.ts';
import { pushedBooks, type CollectorBook } from '../src/oil/pushed.ts';
import { DEFAULT_BALANCE_SETTINGS } from '../src/hynix/balance.ts';
import { createBalanceStore, HYNIX_DATABASE } from '../src/hynix/balance-store.ts';
import { BALANCE_ALERT_DELAY_MS, BALANCE_ALERT_REPEAT_MS, BALANCE_FAILURE_LOG_MS, createBalanceAlerts, fixed2 } from '../src/hynix/balance-alert.ts';
import { hynixBusy, hynixViews, oilLoops, openHynixBalance, type OilRuntime } from '../src/service/oil.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';

const code = (expected: string, status?: number) => (error: unknown) => error instanceof ContractError && error.code === expected && (status === undefined || error.status === status);
const START = Date.UTC(2026, 10, 16, 1, 0, 0);
const WIDE = { rebalancePercent: '2', hardPercent: '20', minGapUsdt: '50' };

function venues() {
  const clock = { now: START };
  const { binance, bybit } = createSimulatedVenues(() => clock.now);
  const market = createHynixMarket({ connectors: [binance, bybit], accounts: SIM_BINDINGS, now: () => clock.now });
  return { clock, binance, bybit, market, read: async () => { await market.refreshQuotes(); await market.refreshPositions(); } };
}
const row = (rows: BalanceRow[], venue: string) => rows.find(item => item.venue === venue)!;
const reason = (item: BalanceRow) => item.status === 'unavailable' ? item.reason : `(${item.status})`;

test('读数：成对给名义、净敞口、占比、级别与两个建议；不成对写原因与各腿；无持仓为正常；金额不取整', async () => {
  const v = venues();
  // ADR short 10 at mid 41.22 = 412.2; ordinary long 0.9 at mid 400.2 = 360.18: the short leg is 52.02 larger.
  v.binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short', '10');
  v.binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYNIXUSDT', 'long', '0.9');
  v.bybit.setPosition(SIM_ACCOUNTS.bybit, 'SKHYUSDT', 'long', '1');
  await v.read();
  const rows = v.market.balanceView(WIDE);
  assert.deepEqual(rows.map(item => item.venue), ['binance', 'bybit']);
  const paired = row(rows, 'binance');
  assert.equal(paired.status, 'paired', reason(paired));
  if (paired.status !== 'paired') return;
  assert.deepEqual([paired.long.symbol, paired.long.quantity, paired.long.notional, paired.short.symbol, paired.short.notional], ['SKHYNIXUSDT', '0.9', '360.18', 'SKHYUSDT', '412.2']);
  assert.equal(paired.gap, '52.02');
  assert.equal(paired.netSide, 'short');
  assert.equal(Number(paired.percent).toFixed(6), (52.02 / 412.2 * 100).toFixed(6));
  assert.equal(paired.level, 'rebalance');
  assert.equal(paired.positionsAt, START);
  assert.equal(paired.quotesAt, START);
  // Reduce: 52.02 ÷ 41.22 = 1.262… floored to 0.01; add: 52.02 ÷ 400.2 = 0.1299… floored to 0.001.
  assert.deepEqual(paired.suggest, { reduce: { symbol: 'SKHYUSDT', side: 'short', action: 'close', quantity: '1.26' }, add: { symbol: 'SKHYNIXUSDT', side: 'long', action: 'open', quantity: '0.129' } });
  assert.equal((row(v.market.balanceView(DEFAULT_BALANCE_SETTINGS), 'binance') as { level?: string }).level, 'hard', '默认硬上限 5%');

  const unpaired = row(rows, 'bybit');
  assert.equal(unpaired.status, 'unpaired');
  if (unpaired.status !== 'unpaired') return;
  assert.equal(unpaired.reason, '只有单腿持仓，另一腿为空');
  assert.deepEqual(unpaired.legs.map(item => [item.symbol, item.side, item.quantity, item.notional]), [['SKHYUSDT', 'long', '1', '41.24']]);
  assert.equal(unpaired.level, 'hard');
  assert.equal('suggest' in unpaired, false);

  v.bybit.setPosition(SIM_ACCOUNTS.bybit, 'SKHYUSDT', 'long', '0');
  await v.read();
  const flat = row(v.market.balanceView(WIDE), 'bybit');
  assert.deepEqual([flat.status, (flat as { level?: string }).level], ['none', 'ok']);
});

test('读数不可用：持仓未读到、读取失败或过期，盘口缺失、失败或过期，合约规则未读到；不可用时不给读数与建议', async () => {
  const v = venues();
  v.binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short', '10');
  v.binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYNIXUSDT', 'long', '0.9');
  const binance = () => row(v.market.balanceView(WIDE), 'binance');
  assert.match(reason(binance()), /^持仓尚未读到$/);
  await v.market.refreshPositions();
  assert.match(reason(binance()), /SKHYUSDT 盘口未取得/);
  await v.market.refreshQuotes();
  assert.equal(binance().status, 'paired');
  assert.deepEqual(Object.keys(binance()).filter(key => key === 'suggest' || key === 'reason'), ['suggest']);

  v.binance.inject({ operation: 'account', mode: 'read-fail' });
  await v.market.refreshPositions();
  const failed = binance();
  assert.equal(failed.status, 'unavailable');
  assert.match(reason(failed), /持仓最近一次读取失败：模拟account读取失败/);
  assert.deepEqual(Object.keys(failed).sort(), ['positionsAt', 'quotesAt', 'reason', 'status', 'venue']);
  await v.market.refreshPositions();
  assert.equal(binance().status, 'paired');

  v.binance.inject({ operation: 'quote', mode: 'read-fail' });
  await v.market.refreshQuotes();
  assert.match(reason(binance()), /盘口最近一次读取失败/);
  await v.market.refreshQuotes();
  assert.equal(binance().status, 'paired');

  // Books older than 2 × 3 s + 3 s.
  v.binance.setBook('SKHYNIXUSDT', { ageMs: 9_001 });
  await v.market.refreshQuotes();
  assert.match(reason(binance()), /^SKHYNIXUSDT 盘口已过期$/);
  v.binance.setBook('SKHYNIXUSDT', { ageMs: 0 });
  await v.market.refreshQuotes();
  assert.equal(binance().status, 'paired');

  // Positions older than 2 × 15 s + 10 s; the books kept fresh meanwhile.
  v.clock.now += 40_001;
  await v.market.refreshQuotes();
  assert.match(reason(binance()), /^持仓读数已过期$/);
  await v.market.refreshPositions();
  assert.equal(binance().status, 'paired');
});

test('读数（独立行情服务）：两轮读取之间推送盘口过了 3 秒，读数照常给出；采集器不再持有该腿盘口才不可用', async () => {
  const clock = { now: START };
  const { binance, bybit } = createSimulatedVenues(() => clock.now);
  const books: Record<string, CollectorBook> = {
    'binance:SKHYUSDT': { bid: 41.2, ask: 41.24, at: START - 2_500, multiplier: 1 },
    'bybit:SKHYNIXUSDT': { bid: 400.1, ask: 400.3, at: START - 2_500, multiplier: 1 },
  };
  const market = createHynixMarket({ connectors: [binance, bybit], accounts: SIM_BINDINGS, now: () => clock.now, marketEpoch: () => 'a/1',
    pushed: pushedBooks(() => ({ book: (exchange, symbol) => books[`${exchange}:${symbol}`] ?? null }), () => clock.now) });
  binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short', '10');
  binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYNIXUSDT', 'long', '0.9');
  await market.refreshQuotes(); await market.refreshPositions();
  assert.deepEqual(market.view().books.filter(item => item.source === 'pushed').map(item => `${item.venue}:${item.symbol}`), ['binance:SKHYUSDT', 'bybit:SKHYNIXUSDT']);
  clock.now += 1_000;
  const rows = market.balanceView(WIDE);
  assert.deepEqual([row(rows, 'binance').status, row(rows, 'bybit').status], ['paired', 'none'], `${reason(row(rows, 'binance'))} / ${reason(row(rows, 'bybit'))}`);
  delete books['bybit:SKHYNIXUSDT'];
  const after = market.balanceView(WIDE);
  assert.equal(row(after, 'binance').status, 'paired');
  assert.equal(reason(row(after, 'bybit')), 'SKHYNIXUSDT 盘口最近一次读取失败：原盘口来源已失效，等待新盘口');
});

test('合约规则：随持仓读取读一次，10 分钟内不重读；没读到时不可用；重读失败保留上次的值，下一轮再读', async () => {
  const v = venues();
  v.binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short', '10');
  v.binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYNIXUSDT', 'long', '0.9');
  v.binance.inject({ operation: 'instrument', mode: 'read-fail', times: 2 });
  await v.read();
  assert.match(reason(row(v.market.balanceView(WIDE), 'binance')), /^Binance SKHYUSDT 合约规则未读到（模拟instrument读取失败）$/);
  assert.equal(row(v.market.balanceView(WIDE), 'bybit').status, 'none', '另一所的规则照常读到');
  assert.equal(v.binance.calls.instrument, 2);
  // A failed read is tried again on the next round.
  await v.read();
  assert.equal(v.binance.calls.instrument, 4);
  assert.equal(row(v.market.balanceView(WIDE), 'binance').status, 'paired');
  await v.market.refreshQuotes();
  for (let i = 0; i < 3; i++) await v.read();
  assert.equal(v.binance.calls.instrument, 4, '盘口循环与 10 分钟内的持仓轮都不读规则');
  assert.equal(v.bybit.calls.instrument, 2);

  v.clock.now += RULES_READ_MS;
  v.binance.inject({ operation: 'instrument', mode: 'read-fail', times: 2 });
  await v.read();
  assert.equal(v.binance.calls.instrument, 6);
  assert.equal(row(v.market.balanceView(WIDE), 'binance').status, 'paired', '重读失败保留上次的规则');
  await v.read();
  assert.equal(v.binance.calls.instrument, 8);
  await v.read();
  assert.equal(v.binance.calls.instrument, 8);
});

test('设置库：保存后重开读回；文件打不开或表结构不对时降级为默认值、写明原因、保存拒绝 503', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-hynix-balance-'));
  try {
    const file = join(dir, HYNIX_DATABASE);
    const store = createBalanceStore(file);
    assert.deepEqual(store.settings(), DEFAULT_BALANCE_SETTINGS);
    assert.throws(() => store.save({ rebalancePercent: '5', hardPercent: '5', minGapUsdt: '0' }), code('invalid_value', 400));
    assert.throws(() => store.save({ rebalancePercent: '1', hardPercent: '5' }), code('missing_field', 400));
    assert.deepEqual(store.save({ rebalancePercent: '1.50', hardPercent: '10', minGapUsdt: '0' }), { rebalancePercent: '1.5', hardPercent: '10', minGapUsdt: '0' });
    store.close();
    const again = openHynixBalance(dir, { log: () => assert.fail('不应记录失败') });
    assert.equal(again.available, true);
    assert.deepEqual(again.settings(), { rebalancePercent: '1.5', hardPercent: '10', minGapUsdt: '0' });
    again.close();

    const logs: string[] = [];
    const missing = openHynixBalance(join(dir, 'missing', 'deeper'), { log: line => logs.push(line) });
    assert.equal(missing.available, false);
    assert.deepEqual(missing.settings(), DEFAULT_BALANCE_SETTINGS);
    assert.match(missing.error ?? '', /^海力士设置库无法打开/);
    assert.throws(() => missing.save(DEFAULT_BALANCE_SETTINGS), code('settings_unavailable', 503));
    assert.equal(logs.length, 1);

    const otherDir = join(dir, 'other');
    mkdirSync(otherDir);
    const foreign = new DatabaseSync(join(otherDir, HYNIX_DATABASE));
    foreign.exec('CREATE TABLE settings (name TEXT, value TEXT)');
    foreign.close();
    const wrongTable = openHynixBalance(otherDir, { log: line => logs.push(line) });
    assert.equal(wrongTable.available, false);
    assert.match(wrongTable.error ?? '', /settings 表结构不符/);
    assert.throws(() => wrongTable.save(DEFAULT_BALANCE_SETTINGS), code('settings_unavailable', 503));
    assert.equal(logs.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('设置库：已保存的内容无效时按默认值、可用并写明原因，重新保存覆盖这一行；打开与保存各记一行日志', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-hynix-balance-'));
  try {
    const file = join(dir, HYNIX_DATABASE);
    createBalanceStore(file).close();
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO settings (key, json) VALUES (?, ?)').run('balance', '{"rebalancePercent":"9","hardPercent":"3","minGapUsdt":"0"}');
    db.close();
    const logs: string[] = [];
    const balance = openHynixBalance(dir, { log: line => logs.push(line) });
    try {
      assert.equal(balance.available, true);
      assert.deepEqual(balance.settings(), DEFAULT_BALANCE_SETTINGS);
      assert.equal(balance.error, '已保存的设置无效，暂按默认值；重新保存即可覆盖（调平线须低于硬上限）');
      assert.equal(logs.length, 1);
      assert.match(logs[0]!, /已保存的设置无效/);
      assert.deepEqual(balance.save({ rebalancePercent: '3', hardPercent: '8', minGapUsdt: '10' }), { rebalancePercent: '3', hardPercent: '8', minGapUsdt: '10' });
      assert.equal(balance.error, null);
      assert.equal(logs[1], '海力士两腿平衡设置已修改：调平线 2% / 硬上限 5% / 最小差额 50 USDT → 调平线 3% / 硬上限 8% / 最小差额 10 USDT');
    } finally { balance.close(); }
    const again = openHynixBalance(dir, { log: line => logs.push(line) });
    try {
      assert.deepEqual([again.available, again.error, again.settings()], [true, null, { rebalancePercent: '3', hardPercent: '8', minGapUsdt: '10' }]);
      assert.equal(logs.length, 2);
    } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('接口：state 带 balance；保存设置须登录与页面标记、未配置 404、校验失败 400、库不可用 503、保存后 state 更新', async () => {
  const h = createHarness();
  const dir = mkdtempSync(join(tmpdir(), 'tp-hynix-http-'));
  const balance = openHynixBalance(dir), broken = openHynixBalance(join(dir, 'missing', 'deeper'), { log: () => undefined });
  const market = createHynixMarket({ connectors: [h.binance, h.bybit], accounts: SIM_BINDINGS, now: () => h.clock.now });
  const oil = { hynix: market } as unknown as OilRuntime;
  const servers = [hynixViews(oil, h.ex, balance), hynixViews(oil, h.ex, broken), undefined].map(hynix => createExecutorServer({ executor: h.ex, accessToken: 'hynix-token-0001', session: 'hynix-session-0001', views: hynix ? { hynix } : {}, log: () => undefined }));
  try {
    const [main, unavailable, bare] = await Promise.all(servers.map(async server => {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const cookie = ((await fetch(`${base}/login?token=hynix-token-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
      const headers = { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' };
      return {
        base,
        get: async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, body: await response.json() as Record<string, any> }; },
        post: async (path: string, body: string, extra: Record<string, string> = headers) => { const response = await fetch(base + path, { method: 'POST', headers: extra, body }); return { status: response.status, body: await response.json() as Record<string, any> }; },
        headers,
      };
    }));
    await market.refreshQuotes();
    await market.refreshPositions();
    const state = await main!.get('/api/hynix/state');
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.balance.settings, DEFAULT_BALANCE_SETTINGS);
    assert.equal(state.body.balance.settingsAvailable, true);
    assert.equal(state.body.balance.settingsError, null);
    assert.deepEqual(state.body.balance.venues.map((item: { venue: string; status: string }) => [item.venue, item.status]), [['binance', 'none'], ['bybit', 'none']]);
    assert.doesNotMatch(JSON.stringify(state.body.balance), new RegExp(`${SIM_ACCOUNTS.binance}|${SIM_ACCOUNTS.bybit}`));

    const path = '/api/hynix/balance/settings', good = JSON.stringify({ rebalancePercent: '3', hardPercent: '8.5', minGapUsdt: '100' });
    assert.equal((await fetch(main!.base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pa-executor': '1' }, body: good })).status, 401);
    assert.equal((await main!.post(path, good, { cookie: main!.headers.cookie, 'content-type': 'application/json' })).status, 403);
    assert.deepEqual(await bare!.post(path, good), { status: 404, body: { code: 'not_found', message: '本服务没有配置海力士执行（与原油共用执行账户）' } });
    assert.deepEqual(await main!.post(path, '{'), { status: 400, body: { code: 'invalid_json', message: '请求体不是有效 JSON' } });
    assert.deepEqual((await main!.post(path, JSON.stringify({ rebalancePercent: '3', hardPercent: '60', minGapUsdt: '0' }))).body, { code: 'invalid_value', message: '硬上限不能高于 50%' });
    assert.equal((await main!.post(path, JSON.stringify({ rebalancePercent: 3, hardPercent: '8', minGapUsdt: '0' }))).status, 400);
    assert.equal((await main!.post(path, JSON.stringify({ rebalancePercent: '3', hardPercent: '8', minGapUsdt: '0', extra: 1 }))).body.code, 'unknown_field');
    assert.equal((await main!.post(path, 'x'.repeat(2_000_000))).status, 413);
    const refused = await unavailable!.post(path, good);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, 'settings_unavailable');
    assert.equal((await unavailable!.get('/api/hynix/state')).body.balance.settingsAvailable, false);

    const saved = await main!.post(path, good);
    assert.deepEqual(saved, { status: 200, body: { rebalancePercent: '3', hardPercent: '8.5', minGapUsdt: '100' } });
    assert.deepEqual((await main!.get('/api/hynix/state')).body.balance.settings, saved.body);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    balance.close();
    h.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Rows as the market gives them, built by hand so the alert's timing is all that varies.
const leg = (symbol: string, side: 'long' | 'short', quantity: string, notional: string) => ({ symbol, side, quantity, price: '1', notional });
const pairedRow = (level: 'ok' | 'rebalance' | 'hard', venue: 'binance' | 'bybit' = 'binance'): BalanceRow => ({
  venue, positionsAt: 0, quotesAt: 0, status: 'paired', level, long: leg('SKHYNIXUSDT', 'long', '0.9', '360.18'), short: leg('SKHYUSDT', 'short', '10', '412.2'),
  gap: '52.02', netSide: 'short', percent: '12.620087336244541484', suggest: { reduce: { symbol: 'SKHYUSDT', side: 'short', action: 'close', quantity: '1.26' }, add: { error: '两腿名义差额 52.02 USDT 不足 SKHYNIXUSDT 最小下单量 1' } },
});
const unavailableRow = (venue: 'binance' | 'bybit' = 'binance'): BalanceRow => ({ venue, positionsAt: null, quotesAt: null, status: 'unavailable', reason: '持仓读数已过期' });
const noneRow = (venue: 'binance' | 'bybit' = 'binance'): BalanceRow => ({ venue, positionsAt: 0, quotesAt: 0, status: 'none', level: 'ok' });

function alerts({ failing = false } = {}) {
  const clock = { now: START }, sent: string[] = [], logs: string[] = [], busy = new Set<string>();
  let fail = failing;
  const alert = createBalanceAlerts({ notify: text => { if (fail) throw new Error('出站队列写入失败'); sent.push(text); }, busy: venue => busy.has(venue), now: () => clock.now, log: line => logs.push(line) });
  return { clock, sent, logs, busy, judge: (...rows: BalanceRow[]) => alert.judge(rows, WIDE), heal: () => { fail = false; } };
}

test('告警：满 60 秒才发，30 分钟重复，升到尽快处理立即再发，正常满 60 秒才通知恢复且只一次；文案写清两腿、净敞口、占比、阈值与建议', () => {
  const a = alerts();
  a.judge(pairedRow('rebalance'));
  a.clock.now += BALANCE_ALERT_DELAY_MS - 1;
  a.judge(pairedRow('rebalance'));
  assert.equal(a.sent.length, 0, '不足 60 秒不发');
  a.clock.now += 1;
  a.judge(pairedRow('rebalance'));
  assert.equal(a.sent.length, 1);
  assert.equal(a.sent[0], '【海力士两腿失衡·建议调平】Binance 多头腿 SKHYNIXUSDT 0.9（名义 360.18 USDT），空头腿 SKHYUSDT 10（名义 412.20 USDT）；净敞口 52.02 USDT（空头腿较大，净空），占较大一腿 12.62%；'
    + '调平线 2%、硬上限 20%、最小差额 50 USDT；建议：减仓调平 平空 SKHYUSDT 1.26；加仓调平 不提供（两腿名义差额 52.02 USDT 不足 SKHYNIXUSDT 最小下单量 1）');
  a.clock.now += BALANCE_ALERT_REPEAT_MS - 1;
  a.judge(pairedRow('rebalance'));
  assert.equal(a.sent.length, 1);
  a.clock.now += 1;
  a.judge(pairedRow('rebalance'));
  assert.equal(a.sent.length, 2);
  assert.match(a.sent[1]!, /^【海力士两腿失衡·建议调平】.*（持续 31 分钟未恢复）$/);
  a.clock.now += 15_000;
  a.judge(pairedRow('hard'));
  assert.equal(a.sent.length, 3, '升到尽快处理立即再发');
  assert.match(a.sent[2]!, /^【海力士两腿失衡升级·尽快处理】Binance /);
  a.clock.now += 15_000;
  a.judge(pairedRow('hard'));
  a.judge(pairedRow('rebalance'));
  assert.equal(a.sent.length, 3);
  a.judge(pairedRow('ok'));
  a.clock.now += BALANCE_ALERT_DELAY_MS - 1;
  a.judge(pairedRow('ok'));
  assert.equal(a.sent.length, 3, '正常不足 60 秒不发恢复');
  a.judge(pairedRow('rebalance'));
  a.clock.now += BALANCE_ALERT_DELAY_MS;
  a.judge(pairedRow('ok'));
  assert.equal(a.sent.length, 3, '中间又失衡过：恢复重新计时，也不重发告警');
  a.clock.now += BALANCE_ALERT_DELAY_MS;
  a.judge(pairedRow('ok'));
  assert.equal(a.sent.length, 4);
  assert.match(a.sent[3]!, /^【海力士两腿已恢复平衡】Binance 多头腿/);
  a.judge(pairedRow('ok'));
  assert.equal(a.sent.length, 4, '恢复只通知一次');
  // Flat counts as recovered too.
  a.judge(pairedRow('hard'));
  a.clock.now += BALANCE_ALERT_DELAY_MS;
  a.judge(pairedRow('hard'));
  assert.match(a.sent[4]!, /^【海力士两腿失衡·尽快处理】/);
  a.judge(noneRow());
  a.clock.now += BALANCE_ALERT_DELAY_MS;
  a.judge(noneRow());
  assert.equal(a.sent[5], '【海力士两腿已恢复平衡】Binance 海力士持仓已全部平掉');
  assert.doesNotMatch(a.sent.join('\n'), new RegExp(`${SIM_ACCOUNTS.binance}|\\*\\*\\*`));
});

test('告警：没告警过就恢复不通知；不可用与有未结束任务时保持状态、不清零计时；不成对按尽快处理；各所分开计时', () => {
  const a = alerts();
  a.judge(pairedRow('rebalance'));
  a.clock.now += 30_000;
  a.judge(pairedRow('ok'));
  a.clock.now += 60_000;
  a.judge(pairedRow('ok'));
  assert.equal(a.sent.length, 0, '没告警过的恢复不通知');

  a.judge(pairedRow('rebalance'));
  a.clock.now += 30_000;
  a.judge(unavailableRow());
  a.busy.add('binance');
  a.judge(pairedRow('ok'));
  a.busy.delete('binance');
  a.clock.now += 30_000;
  a.judge(pairedRow('rebalance'));
  assert.equal(a.sent.length, 1, '不可用与任务期间不清零：从第一次看到算满 60 秒');

  // Alerted, then unreadable or busy for a long while: no recovery, no repeat.
  a.clock.now += BALANCE_ALERT_REPEAT_MS;
  a.judge(unavailableRow());
  a.busy.add('binance');
  a.judge(pairedRow('ok'));
  a.judge(pairedRow('hard'));
  assert.equal(a.sent.length, 1);
  a.busy.delete('binance');
  a.judge(pairedRow('ok'));
  a.clock.now += BALANCE_ALERT_DELAY_MS;
  a.judge(unavailableRow());
  assert.equal(a.sent.length, 1, '不可用时不发恢复');
  a.judge(pairedRow('ok'));
  assert.match(a.sent[1]!, /^【海力士两腿已恢复平衡】/);

  const unpaired: BalanceRow = { venue: 'bybit', positionsAt: 0, quotesAt: 0, status: 'unpaired', level: 'hard', reason: '只有单腿持仓，另一腿为空', legs: [leg('SKHYUSDT', 'long', '1', '41.24')] };
  a.judge(unpaired, pairedRow('ok'));
  a.clock.now += BALANCE_ALERT_DELAY_MS;
  a.judge(unpaired, pairedRow('ok'));
  assert.equal(a.sent[2], '【海力士两腿失衡·尽快处理】Bybit 两腿不成对：只有单腿持仓，另一腿为空；持仓 多 SKHYUSDT 1（名义 41.24 USDT）；不提供调平建议，请先人工处理（调平线 2%、硬上限 20%、最小差额 50 USDT）');
  assert.equal(a.sent.length, 3);
});

test('告警：通知抛错只记日志、不当作已发，下一轮再发；循环里告警判断失败只记日志，持仓读取继续', async () => {
  const a = alerts({ failing: true });
  a.judge(pairedRow('hard'));
  a.clock.now += BALANCE_ALERT_DELAY_MS;
  assert.doesNotThrow(() => a.judge(pairedRow('hard')));
  assert.equal(a.sent.length, 0);
  assert.match(a.logs[0]!, /^海力士两腿平衡告警发送失败（Binance）：出站队列写入失败$/);
  a.heal();
  a.clock.now += 15_000;
  a.judge(pairedRow('hard'));
  assert.equal(a.sent.length, 1);

  const logs: string[] = [];
  let positions = 0, checks = 0;
  const oil = { market: { refreshQuotes: async () => {}, refreshPositions: async () => {} }, hynix: { refreshQuotes: async () => {}, refreshPositions: async () => { positions++; } }, goldoil: { refreshQuotes: async () => {}, refreshPositions: async () => {} } } as unknown as OilRuntime;
  let rounds = 0;
  const context = { stopped: () => checks >= 2 || rounds >= 100, pause: async () => { rounds++; } };
  await Promise.all(oilLoops(oil, context, line => logs.push(line), undefined, undefined, () => { checks++; throw new Error('坏了'); }));
  assert.ok(checks >= 2 && positions >= checks, '判断在每轮持仓读取之后，失败后继续下一轮');
  assert.ok(logs.includes('海力士两腿平衡告警判断失败：坏了'));
  assert.equal(logs.filter(line => line.startsWith('海力士持仓读取失败')).length, 0);
});

test('告警：同一交易所同一失败原因 10 分钟内只记一次日志；原因变了或发送成功后再失败立即记', () => {
  const clock = { now: START }, logs: string[] = [];
  let failure: string | null = '出站队列写入失败';
  const alert = createBalanceAlerts({ notify: () => { if (failure) throw new Error(failure); }, busy: () => false, now: () => clock.now, log: line => logs.push(line) });
  const judge = () => alert.judge([pairedRow('hard'), pairedRow('hard', 'bybit')], WIDE);
  judge();
  clock.now += BALANCE_ALERT_DELAY_MS;
  for (let i = 0; i < 39; i++) { judge(); clock.now += 15_000; }
  assert.deepEqual(logs, ['海力士两腿平衡告警发送失败（Binance）：出站队列写入失败', '海力士两腿平衡告警发送失败（Bybit）：出站队列写入失败'], '9 分 45 秒内每所只记一次');
  clock.now = START + BALANCE_ALERT_DELAY_MS + BALANCE_FAILURE_LOG_MS;
  judge();
  assert.equal(logs.length, 4, '满 10 分钟再记一次');
  failure = '磁盘已满';
  judge();
  assert.equal(logs.length, 6, '原因变了立即记');
  assert.match(logs[5]!, /（Bybit）：磁盘已满$/);
  failure = null;
  judge();
  failure = '磁盘已满';
  clock.now += 15_000;
  alert.judge([pairedRow('ok')], WIDE);
  assert.equal(logs.length, 6, '正常不足 60 秒不发恢复');
  clock.now += BALANCE_ALERT_DELAY_MS;
  alert.judge([pairedRow('ok')], WIDE);
  assert.equal(logs.length, 7, '发送成功后再失败立即记');
});

test('有未结束任务：只看海力士任务及其腿所在交易所，单腿调平任务不取第二条腿', () => {
  const jobs: Record<string, { market: string; legs: { venue: string }[] }> = {
    a: { market: 'oil', legs: [{ venue: 'bybit' }, { venue: 'bybit' }] },
    b: { market: 'hynix', legs: [{ venue: 'binance' }] },
  };
  const busy = hynixBusy({ unfinished: () => Object.keys(jobs), jobView: (id: string) => jobs[id] } as never);
  assert.equal(busy('binance'), true);
  assert.equal(busy('bybit'), false, '原油任务不算');
  jobs.c = { market: 'hynix', legs: [{ venue: 'binance' }, { venue: 'bybit' }] };
  assert.equal(busy('bybit'), true, '跨所海力士任务两所都算');
});

test('金额显示：两位小数四舍五入', () => {
  assert.deepEqual(['412.2', '0.005', '0.004999', '-1.235', '0', '12.620087336244541484'].map(fixed2), ['412.20', '0.01', '0.00', '-1.24', '0.00', '12.62']);
});
