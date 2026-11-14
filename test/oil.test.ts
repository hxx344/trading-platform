// Oil module O1a: same-venue BZ/CL jobs, barrels, the rolling 24-hour open cap, the service's oil wiring and job alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractError, parseIntent } from '../src/contracts.ts';
import { cmp } from '../src/decimal.ts';
import { createExecutor, OPEN_WINDOW_MS } from '../src/executor.ts';
import { SIM_ACCOUNTS } from '../src/simulation.ts';
import { nearestBarrels, quantityForBarrels } from '../src/barrels.ts';
import { parseServiceConfig, parseServiceSecrets } from '../src/service/config.ts';
import { oilSummary, type OilConfig } from '../src/service/oil-config.ts';
import { strandedOilJobs } from '../src/service/oil.ts';
import { createNotifier, describeJob } from '../src/service/feishu.ts';
import { SESSION, bindAccounts, createHarness, openIntent, previewAndConfirm, settle, type Harness } from './harness.ts';
import { FakeBinance, KEY, SECRET, symbolInfo } from './live-fake-binance.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
const leg = (venue: string, symbol: string, side: 'long' | 'short', amount: { quantity?: string | null; barrels?: string | null }) => ({ venue, symbol, side, orderType: 'market', ...amount });
/** Short the spread on one venue: sell BZ, buy CL. */
const sameIntent = ({ venue = 'binance', barrels = '1', action = 'open' }: { venue?: string; barrels?: string; action?: 'open' | 'close' } = {}) => ({
  market: 'oil', preset: 'same-exchange', action, timeoutMs: 60_000,
  legs: [leg(venue, 'BZUSDT', 'short', { barrels }), leg(venue, 'CLUSDT', 'long', { barrels })],
});
async function withHarness(run: (h: Harness) => Promise<void>, notionalLimits?: Parameters<typeof createHarness>[0] extends infer O ? O extends { notionalLimits?: infer N } ? N : never : never) {
  const h = createHarness(notionalLimits ? { notionalLimits } : {});
  try { await run(h); } finally { h.dispose(); }
}

test('意图：同所双腿须同一交易所、一腿 BZ 一腿 CL、方向相反；数量与桶数二选一且两腿一致；跨所写法不变', () => {
  const same = parseIntent(sameIntent());
  assert.equal(same.preset, 'same-exchange');
  assert.equal(same.symbol, null);
  assert.deepEqual(same.legs.map(item => [item.venue, item.symbol, item.side, item.quantity, item.barrels]), [['binance', 'BZUSDT', 'short', null, '1'], ['binance', 'CLUSDT', 'long', null, '1']]);
  const cross = parseIntent(openIntent());
  assert.deepEqual([cross.preset, cross.symbol, cross.legs.map(item => [item.symbol, item.quantity, item.barrels])], ['cross-exchange', 'CLUSDT', [['CLUSDT', '1', null], ['CLUSDT', '1', null]]]);
  const base = sameIntent();
  assert.throws(() => parseIntent({ ...base, symbol: 'CLUSDT' }), code('unknown_field'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], leg('bybit', 'CLUSDT', 'long', { barrels: '1' })] }), code('cross_venue'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], leg('binance', 'BZUSDT', 'long', { barrels: '1' })] }), code('same_symbol'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], leg('binance', 'CLUSDT', 'short', { barrels: '1' })] }), code('same_side'));
  assert.throws(() => parseIntent({ ...base, legs: [leg('binance', 'BZUSDT', 'short', { barrels: '1', quantity: '1' }), base.legs[1]] }), code('quantity_or_barrels'));
  assert.throws(() => parseIntent({ ...base, legs: [leg('binance', 'BZUSDT', 'short', { quantity: '1' }), base.legs[1]] }), code('quantity_mode'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], leg('binance', 'CLUSDT', 'long', { barrels: '2' })] }), code('unbalanced'));
  assert.throws(() => parseIntent({ ...base, legs: [{ venue: 'binance', side: 'short', orderType: 'market', barrels: '1' }, base.legs[1]] }), code('missing_field'));
  // null is the same as leaving the field out, so a form that sends both keys still parses.
  const nulls = parseIntent({ ...base, legs: [leg('binance', 'BZUSDT', 'short', { barrels: '1', quantity: null }), leg('binance', 'CLUSDT', 'long', { barrels: '1', quantity: null })] });
  assert.deepEqual(nulls.legs.map(item => [item.quantity, item.barrels]), [[null, '1'], [null, '1']]);
  assert.throws(() => parseIntent({ ...base, legs: [leg('binance', 'BZUSDT', 'short', { barrels: null, quantity: null }), base.legs[1]] }), code('missing_field'));
  // Cross-exchange keeps one top-level symbol and legs without one.
  const { symbol: _symbol, ...noSymbol } = openIntent();
  assert.throws(() => parseIntent(noSymbol), code('missing_field'));
  assert.throws(() => parseIntent({ ...openIntent(), legs: openIntent().legs.map(item => ({ ...item, symbol: 'CLUSDT' })) }), code('unknown_field'));
});

test('桶数换算：按合约乘数与步长换成下单数量；换不成整数步长时拒绝并给出两个最近的可用桶数', async () => {
  const instrument = { symbol: 'CLUSDT', contractSize: '1', quantityStep: '0.1', minQuantity: '0.1', priceTick: '0.01', minNotional: '5' } as never;
  assert.equal(quantityForBarrels('2.3', instrument), '2.3');
  assert.equal(quantityForBarrels('2.35', instrument), null);
  assert.equal(quantityForBarrels('100', { ...(instrument as object), contractSize: '10', quantityStep: '1' } as never), '10');
  assert.deepEqual(nearestBarrels('2.35', [instrument, { ...(instrument as object), quantityStep: '0.01', minQuantity: '0.01' } as never]), ['2.3', '2.4']);
  assert.deepEqual(nearestBarrels('0.05', [instrument]), ['0.1', '0.2'], '低于最小数量时给出最小的两个');

  await withHarness(async h => {
    bindAccounts(h.ex);
    // Binance steps 0.01, Bybit 0.1: across venues 0.15 barrels fits Binance only.
    const barrelsCross = (barrels: string) => ({ ...openIntent(), legs: openIntent().legs.map(({ quantity: _quantity, ...rest }) => ({ ...rest, barrels })) });
    await assert.rejects(h.ex.preview(barrelsCross('0.15'), SESSION), (error: unknown) => code('barrels_step')(error) && /0\.15 桶.*按步长最近的桶数为 0\.1 或 0\.2/.test((error as Error).message));
    const preview = await h.ex.preview(barrelsCross('2'), SESSION);
    assert.deepEqual(preview.legs.map(item => [item.venue, item.symbol, item.quantity]), [['binance', 'CLUSDT', '2'], ['bybit', 'CLUSDT', '2']]);
    assert.equal(preview.barrels, '2');
    assert.equal(h.binance.calls.place + h.bybit.calls.place, 0);
  });
});

test('同所 BZ/CL：开仓与平仓都走同一交易所两腿，按桶数核对两腿暴露；跨所任务照旧', () => withHarness(async h => {
  bindAccounts(h.ex);
  const preview = await h.ex.preview(sameIntent({ barrels: '1.5' }), SESSION);
  assert.deepEqual(preview.legs.map(item => [item.venue, item.symbol, item.side, item.quantity]), [['binance', 'BZUSDT', 'short', '1.5'], ['binance', 'CLUSDT', 'long', '1.5']]);
  assert.ok(preview.notes.some(note => note.includes('Binance BZUSDT')), preview.notes.join('\n'));
  const opened = await settle(h, (await previewAndConfirm(h, sameIntent({ barrels: '1.5' }))).jobId);
  assert.equal(opened.status, 'completed', opened.reason ?? '');
  assert.equal(opened.preset, 'same-exchange');
  assert.deepEqual(opened.legs.map(item => [item.symbol, item.filledBarrels]), [['BZUSDT', '1.5'], ['CLUSDT', '1.5']]);
  assert.ok(opened.legs.every(item => item.averagePrice !== null));
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '1.5');
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'long'), '1.5');
  assert.equal(h.bybit.calls.place, 0, '同所任务不碰另一个交易所');

  const closed = await settle(h, (await previewAndConfirm(h, sameIntent({ barrels: '1.5', action: 'close' }))).jobId);
  assert.equal(closed.status, 'completed', closed.reason ?? '');
  assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '0'), 0);
  assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'long'), '0'), 0);

  // Cross-exchange regression: the old intent shape opens one contract on both venues.
  const cross = await settle(h, (await previewAndConfirm(h, openIntent())).jobId);
  assert.equal(cross.status, 'completed', cross.reason ?? '');
  assert.equal(cross.preset, 'cross-exchange');
  assert.deepEqual(cross.legs.map(item => [item.venue, item.symbol, item.filledBarrels]), [['binance', 'CLUSDT', '1'], ['bybit', 'CLUSDT', '1']]);
}));

test('24 小时开仓上限：按确认时间滚动计算，平仓不受限，满 24 小时后释放；与累计上限互斥', () => withHarness(async h => {
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance], notionalLimits: { perJob: '100', totalOpen: '500', openPer24h: '500' } as never }), code('invalid_value'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance], notionalLimits: { perJob: '600', openPer24h: '500' } as never }), code('invalid_value'));
  bindAccounts(h.ex);
  const first = await settle(h, (await previewAndConfirm(h, openIntent({ quantity: ['2', '2'] }))).jobId);
  assert.equal(first.status, 'completed');
  const view = h.ex.notionalLimits() as { openPer24h: string; openUsed: string; windowMs: number; nextReleaseAt: number | null };
  assert.equal(view.openPer24h, '250');
  assert.equal(view.windowMs, OPEN_WINDOW_MS);
  assert.equal(view.nextReleaseAt, first.createdAt + OPEN_WINDOW_MS);
  assert.ok(cmp(view.openUsed, '140') > 0);
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['2', '2'] }), SESSION), code('notional_24h_cap'));
  // Closing is never limited and does not count.
  const closed = await settle(h, (await previewAndConfirm(h, openIntent({ quantity: ['1', '1'], action: 'close' }))).jobId);
  assert.equal(closed.status, 'completed', closed.reason ?? '');
  assert.equal((h.ex.notionalLimits() as { openUsed: string }).openUsed, view.openUsed);
  // One millisecond short of 24 hours the first job still counts; at 24 hours it leaves the window.
  // A long idle gap: the lease has lapsed, so a fresh instance takes over (the window lives in the database, not in memory).
  h.clock.now = first.createdAt + OPEN_WINDOW_MS - 1;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['2', '2'] }), SESSION), code('notional_24h_cap'));
  h.advance(1);
  assert.equal(cmp((h.ex.notionalLimits() as { openUsed: string }).openUsed, '0'), 0);
  const again = await settle(h, (await previewAndConfirm(h, openIntent({ quantity: ['2', '2'] }))).jobId);
  assert.equal(again.status, 'completed', again.reason ?? '');
}, { perJob: '200', openPer24h: '250' } as never));

test('旧格式任务记录（无价格界限、无对冲等待字段）重启后照常恢复并给出新视图字段', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { jobId } = await previewAndConfirm(h, openIntent());
  await h.ex.tick();
  const row = h.store.db.prepare('SELECT json FROM jobs WHERE id = ?').get(jobId) as { json: string };
  const job = JSON.parse(row.json) as { legs: Record<string, unknown>[]; hedgeWaitSince?: unknown };
  delete job.hedgeWaitSince;
  for (const item of job.legs) delete item.priceBound;
  h.store.db.prepare('UPDATE jobs SET json = ? WHERE id = ?').run(JSON.stringify(job), jobId);
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.deepEqual(view.legs.map(item => [item.priceBound, item.plannedBarrels, item.filledBarrels]), [[null, '1', '1'], [null, '1', '1']]);
  assert.equal(view.preset, 'cross-exchange');
}));

test('飞书：原油任务的确认、完成各发一次，同一任务同一状态的重复事件不再发；文本带交易所、合约、方向、桶数、均价与价差', () => withHarness(async h => {
  bindAccounts(h.ex);
  const file = join(h.dir, 'notify.sqlite');
  const events = (after: number, limit: number) => h.store.db.prepare('SELECT seq, type, at, json, job_id AS jobId FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as never;
  const latestSeq = () => (h.store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  const notifier = createNotifier({ file, events, latestSeq, pairs: () => [], incidentPair: () => null, job: id => h.ex.jobView(id), feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh', secret: 'sec' }, fetchImpl: async () => { throw new Error('不发送'); }, now: () => h.clock.now, log: () => undefined });
  const texts = () => { const db = new DatabaseSync(file); try { return (db.prepare('SELECT text FROM outbox ORDER BY id').all() as { text: string }[]).map(row => row.text); } finally { db.close(); } };
  try {
    notifier.poll();
    const { jobId } = await previewAndConfirm(h, sameIntent({ barrels: '2' }));
    notifier.poll();
    const view = await settle(h, jobId);
    assert.equal(view.status, 'completed');
    notifier.poll();
    // The same state written again (a replay) and a poll from a fresh cursor do not send twice.
    h.store.db.prepare('INSERT INTO events(job_id, type, at, json) VALUES (?, ?, ?, ?)').run(jobId, 'job-finished', h.clock.now, JSON.stringify({ status: 'completed', reason: null }));
    notifier.poll();
    const sent = texts();
    assert.equal(sent.length, 2, sent.join('\n'));
    assert.match(sent[0]!, /【原油任务已确认】Binance 同所 开仓 做空价差（空 BZUSDT、多 CLUSDT），每腿 2 桶；预览可成交价 BZUSDT 74\.1 \/ CLUSDT 70\.02，价差 BZ−CL 4\.08 USDT\/桶/);
    assert.match(sent[1]!, /【原油任务完成】Binance 同所 开仓 做空价差.*成交 BZUSDT 2 桶 均价 [\d.]+、CLUSDT 2 桶 均价 [\d.]+；成交价差 BZ−CL [\d.-]+ USDT\/桶/);
    // Without the job reader (the service with no oil) these events say nothing.
    assert.equal(describeJob(null, 'abcdef123456', 'failed', '对冲腿未成交').includes('详情读取失败'), true);
  } finally { notifier.close(); }
}));

test('服务配置：oil 可选；有 oil 时 pairs 可省略、密钥须含对应交易所；没有 oil 时不接受交易所密钥；报错不回显密钥', () => {
  const oil = { notionalLimits: { perJob: '200', openPer24h: '1000' }, accounts: [{ venue: 'binance', accountId: '123456789', accountMode: 'standard', credentialVersion: 1 }] };
  const plain = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', pairs: [] });
  assert.equal(plain.oil, undefined);
  assert.equal(oilSummary(plain.oil), '');
  assert.throws(() => parseServiceConfig({ secretsFile: '/etc/tp/secrets.json' }), /pairs/);
  assert.throws(() => parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', pairs: [], oil: undefined, extra: 1 }), /不支持的字段/);
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', oil });
  assert.deepEqual(config.pairs, []);
  assert.deepEqual(config.oil!.notionalLimits, { perJob: '200', openPer24h: '1000' });
  assert.equal(config.oil!.accounts[0]!.environment, 'mainnet');
  assert.match(oilSummary(config.oil), /原油执行账户 Binance \*\*\*6789（standard，凭据版本 1），名义金额上限 单笔 200 \/ 24 小时开仓 1000 USDT/);
  assert.throws(() => parseServiceConfig({ secretsFile: '/x/s.json', oil: { ...oil, notionalLimits: { perJob: '200', totalOpen: '1000' } } }), /oil\.notionalLimits 无效/);
  assert.throws(() => parseServiceConfig({ secretsFile: '/x/s.json', oil: { ...oil, accounts: [oil.accounts[0], oil.accounts[0]] } }), /每个交易所至多一个账户/);
  assert.throws(() => parseServiceConfig({ secretsFile: '/x/s.json', oil: { ...oil, accounts: [] } }), /1–2 个执行账户/);

  const secret = 'Zx9-very-secret-value';
  assert.throws(() => parseServiceSecrets({ accounts: {}, binance: { apiKey: KEY, apiSecret: SECRET } }, []), /不支持的字段/);
  const secrets = parseServiceSecrets({ accounts: {}, binance: { apiKey: KEY, apiSecret: SECRET } }, [], ['binance']);
  assert.deepEqual(secrets.exchanges!.get('binance'), { apiKey: KEY, apiSecret: SECRET });
  assert.throws(() => parseServiceSecrets({ accounts: {} }, [], ['binance']), /缺少 binance 的密钥/);
  for (const bad of [{ apiKey: KEY, [secret]: SECRET }, { apiKey: `${secret}\n`, apiSecret: SECRET }, { apiKey: KEY, apiSecret: '' }]) {
    assert.throws(() => parseServiceSecrets({ accounts: {}, binance: bad }, [], ['binance']), (error: unknown) => error instanceof Error && !error.message.includes(secret) && /binance/.test(error.message), JSON.stringify(Object.keys(bad)));
  }
});

test('服务进程：配置 oil 时启动检查失败则拒绝启动并释放账户锁；通过后提供原油行情、状态与盈亏接口并运行两腿任务循环', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-oil-'));
  const binance = new FakeBinance();
  binance.info = [symbolInfo(), symbolInfo({ symbol: 'BZUSDT' })];
  // The service signs with the wall clock; the stand-in checks against its own.
  Object.defineProperty(binance, 'clock', { get: () => Date.now(), set: () => undefined });
  const { createServer } = await import('node:net');
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const { startService } = await import('../src/service/main.ts');
  const { readFileSync } = await import('node:fs');
  const app = { index: Buffer.from('<!doctype html><title>t</title>'), assets: new Map() };
  const oil = { notionalLimits: { perJob: '200', openPer24h: '1000' }, accounts: [{ venue: 'binance', accountId: '123456789', accountMode: 'standard', credentialVersion: 1 }] };
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', oil });
  const secrets = parseServiceSecrets({ accounts: {}, binance: { apiKey: KEY, apiSecret: SECRET } }, [], ['binance']);
  const start = () => startService({ config, secrets, dir: join(dir, 'data'), port, app, oilFetch: binance.fetch });
  try {
    binance.restrictions = { ...binance.restrictions, enableWithdrawals: true };
    await assert.rejects(start(), /原油执行账户启动检查未通过，拒绝启动：binance 账户 123456789 启动检查未通过：.*允许提现/);
    binance.restrictions = { ...binance.restrictions, enableWithdrawals: false };
    // The failed start let go of the account lock and the database: a corrected start goes through.
    const run = await start();
    try {
      let link = '';
      for (let i = 0; i < 100 && !link; i++) { try { link = readFileSync(join(dir, 'data', 'access-url'), 'utf8').trim(); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
      const cookie = (await fetch(link, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
      const get = async (path: string) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie } }); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
      let market = await get('/api/oil/market');
      for (let i = 0; i < 100 && (market.body.readAt === null); i++) { await new Promise(resolve => setTimeout(resolve, 20)); market = await get('/api/oil/market'); }
      assert.equal(market.status, 200);
      const same = (market.body.sameExchange as { venue: string; sell: string | null; buy: string | null }[])[0]!;
      assert.equal(same.venue, 'binance');
      assert.equal(same.sell, '-0.02', '同一假盘口：BZ 买一 70.10 − CL 卖一 70.12');
      assert.deepEqual(market.body.crossExchange, []);
      const state = await get('/api/oil/state');
      assert.equal(state.status, 200);
      assert.deepEqual((state.body.accounts as { venue: string }[]).map(item => item.venue), ['binance']);
      assert.deepEqual(state.body.notionalLimits, { perJob: '200', openPer24h: '1000', openUsed: '0', windowMs: OPEN_WINDOW_MS, nextReleaseAt: null });
      assert.deepEqual(state.body.jobs, []);
      // A same-venue preview through the page goes to the live connector with each leg's own contract.
      const previewed = await fetch(`http://127.0.0.1:${port}/api/preview`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(sameIntent()) });
      const preview = await previewed.json() as { legs: { venue: string; symbol: string; quantity: string; accountId: string }[]; barrels: string };
      assert.equal(previewed.status, 200, JSON.stringify(preview));
      assert.deepEqual(preview.legs.map(item => [item.venue, item.symbol, item.quantity, item.accountId]), [['binance', 'BZUSDT', '1', '***6789'], ['binance', 'CLUSDT', '1', '***6789']]);
      assert.equal(preview.barrels, '1');
      // Spread rules: their own file, revision-checked writes.
      const post = async (path: string, body: unknown) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
      assert.deepEqual((await get('/api/oil/rules')).body.rules, []);
      const rule = { name: '', venue: 'binance', direction: 'short', openThreshold: '-1', closeThreshold: '-2', barrels: '1', confirmSamples: 1, maxOpensPerDay: 1 };
      assert.equal((await post('/api/oil/rules', { config: { ...rule, venue: 'bybit' }, observing: true })).body.code, 'venue_not_configured');
      const created = await post('/api/oil/rules', { config: rule, observing: true });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const saved = (created.body.rules as { id: string; revision: number; observing: boolean; title: string }[])[0]!;
      assert.deepEqual([saved.observing, saved.title], [true, 'Binance 原油做空价差']);
      assert.ok(existsSync(join(dir, 'data', 'oil-rules.sqlite')));
      assert.equal((await post(`/api/oil/rules/${saved.id}/stop`, { revision: saved.revision + 1 })).status, 409);
      // Live mode is wired to the executor; going live needs the explicit confirmation (not sent here, so nothing trades).
      assert.equal((await get('/api/oil/rules')).body.liveAvailable, true);
      assert.equal((await post(`/api/oil/rules/${saved.id}/live`, { revision: saved.revision })).body.code, 'confirm_required');
      assert.equal((await post(`/api/oil/rules/${saved.id}/other`, { revision: saved.revision })).status, 404);
      assert.equal((await post(`/api/oil/rules/${saved.id}/stop`, { revision: saved.revision })).status, 200);
      // PnL (O4): its own file; positions sampled every minute and the ledgers synced at start, then every five minutes.
      let pnl = await get('/api/oil/pnl?range=1d');
      for (let i = 0; i < 100 && (pnl.body.pointCount === 0 || (pnl.body.accounts as { ledger: { coveredUntil: number | null } }[])[0]!.ledger.coveredUntil === null); i++) { await new Promise(resolve => setTimeout(resolve, 20)); pnl = await get('/api/oil/pnl?range=1d'); }
      assert.equal(pnl.status, 200);
      assert.equal(pnl.body.pointCount, 1);
      assert.ok(['ready', 'incomplete'].includes(pnl.body.status as string), String(pnl.body.status));
      assert.deepEqual(pnl.body.totals, { funding: '0', realized: '0', fee: '0' });
      assert.ok(existsSync(join(dir, 'data', 'oil-pnl.sqlite')));
      assert.equal((await get('/api/oil/pnl?range=2d')).status, 400);
      assert.equal((await get('/api/oil/pnl?range=toString')).status, 400);
      assert.equal((await get('/api/oil/pnl?page=-1')).status, 400);
      const health = (await get('/api/status')).body.health as { loops: { name: string }[] };
      assert.ok(health.loops.some(loop => loop.name === '两腿任务循环'), JSON.stringify(health.loops));
      assert.ok(!health.loops.some(loop => loop.name === '历史清理'), '两腿任务循环自带历史清理');
      // A second process on the same account is refused at the lock.
      await assert.rejects(startService({ config, secrets, dir: join(dir, 'other'), port: port + 1, app, oilFetch: binance.fetch }), /已被本机另一个实盘执行器占用/);
    } finally { await run.shutdown(); await run.done; }
  } finally {
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('导入工作台：已有只含 oil 的配置时追加 ASTER 配对，oil 与交易所密钥原样保留', async () => {
  const { planImport, previewImport } = await import('../src/service/import-workbench.ts');
  const oil = { notionalLimits: { perJob: '200', openPer24h: '1000' }, accounts: [{ venue: 'binance', accountId: '123456789', accountMode: 'standard', credentialVersion: 1 }] };
  const existing = { config: { secretsFile: '/x/secrets.json', oil }, secrets: { accounts: {}, binance: { apiKey: KEY, apiSecret: SECRET } } };
  const plan = planImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json' });
  assert.deepEqual(plan.config.oil, oil);
  assert.deepEqual(plan.config.pairs, []);
  assert.deepEqual(plan.secrets.binance, { apiKey: KEY, apiSecret: SECRET });
  assert.deepEqual(previewImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json' }).items, []);
  // Exchange keys without oil accounts in config.json stay refused, as before.
  assert.throws(() => planImport({ pairs: [], accounts: [], env: {} }, { config: { secretsFile: '/x/secrets.json', pairs: [] }, secrets: existing.secrets }, { secretsFile: '/x/secrets.json' }), /现有密钥文件未通过检查/);
});

test('启动提示：未结束的原油任务所在交易所不在配置里（或整个 oil 已删）时逐条告警，配置齐全时不提示', () => {
  const jobs: Record<string, string[]> = { 'job-same': ['binance', 'binance'], 'job-cross': ['binance', 'bybit'] };
  const executor = { unfinished: () => Object.keys(jobs), jobView: (id: string) => ({ legs: jobs[id]!.map(venue => ({ venue })) }) } as unknown as Parameters<typeof strandedOilJobs>[0];
  const account = (venue: string) => ({ venue, accountId: '1', accountMode: 'standard', credentialVersion: 1 });
  const config = (venues: string[]) => ({ notionalLimits: { perJob: '1', openPer24h: '1' }, accounts: venues.map(account) }) as unknown as OilConfig;
  assert.deepEqual(strandedOilJobs(executor, config(['binance', 'bybit'])), []);
  const onlyBinance = strandedOilJobs(executor, config(['binance']));
  assert.equal(onlyBinance.length, 1);
  assert.match(onlyBinance[0]!, /原油任务 job-cross 尚未结束，但配置里没有 Bybit 执行账户/);
  const none = strandedOilJobs(executor, undefined);
  assert.equal(none.length, 2);
  assert.ok(none.every(line => /配置里已没有 oil/.test(line)), none.join('\n'));
});
