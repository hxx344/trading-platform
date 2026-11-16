// SK hynix two-leg trading (docs/hynix.md): the intent, notional sizing, settlement in the planned proportion, the market
// view, the per-market job lists and the Feishu text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ContractError, parseIntent } from '../src/contracts.ts';
import { cmp } from '../src/decimal.ts';
import { SIM_ACCOUNTS, SIM_BINDINGS } from '../src/simulation.ts';
import { midOf, premiumPercent, quantityForNotional } from '../src/hynix/sizing.ts';
import { createHynixMarket } from '../src/hynix/market.ts';
import { createNotifier } from '../src/service/feishu.ts';
import { strandedOilJobs } from '../src/service/oil.ts';
import { SESSION, bindAccounts, createHarness, previewAndConfirm, settle, type Harness } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
const leg = (venue: string, symbol: string, side: 'long' | 'short', amount: { quantity?: string; notional?: string; barrels?: string }) => ({ venue, symbol, side, orderType: 'market', ...amount });
/** Short the premium on one venue: sell the ADR, buy the ordinary share, equal notional. */
const sameIntent = ({ venue = 'binance', notional = '100', action = 'open', lead = 'SKHYUSDT' }: { venue?: string; notional?: string; action?: 'open' | 'close'; lead?: string } = {}) => {
  const adr = leg(venue, 'SKHYUSDT', 'short', { notional }), ordinary = leg(venue, 'SKHYNIXUSDT', 'long', { notional });
  return { market: 'hynix', preset: 'same-exchange', action, timeoutMs: 60_000, legs: lead === 'SKHYUSDT' ? [adr, ordinary] : [ordinary, adr] };
};
async function withHarness(run: (h: Harness) => Promise<void>) {
  const h = createHarness();
  try { await run(h); } finally { h.dispose(); }
}

test('意图：海力士同所须一腿 ADR 一腿正股；每腿名义金额或数量二选一、金额须相等；不收桶数与分批；不能混用原油合约', () => {
  const same = parseIntent(sameIntent());
  assert.equal(same.market, 'hynix');
  assert.deepEqual(same.legs.map(item => [item.symbol, item.side, item.quantity, item.notional]), [['SKHYUSDT', 'short', null, '100'], ['SKHYNIXUSDT', 'long', null, '100']]);
  const base = sameIntent();
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], leg('binance', 'SKHYUSDT', 'long', { notional: '100' })] }), code('same_symbol'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], leg('binance', 'CLUSDT', 'long', { notional: '100' })] }), code('invalid_value'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], leg('binance', 'SKHYNIXUSDT', 'long', { notional: '90' })] }), code('unbalanced'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], leg('binance', 'SKHYNIXUSDT', 'long', { quantity: '0.2' })] }), code('quantity_mode'));
  assert.throws(() => parseIntent({ ...base, legs: [leg('binance', 'SKHYUSDT', 'short', { barrels: '1' }), base.legs[1]] }), code('unknown_field'));
  assert.throws(() => parseIntent({ ...base, batches: { count: 2, intervalMs: 0 } }), code('batch_unsupported'));
  // Opening per-leg quantities could put almost all of it on one side: open is by equal notional only.
  assert.throws(() => parseIntent({ ...base, legs: [leg('binance', 'SKHYUSDT', 'short', { quantity: '100' }), leg('binance', 'SKHYNIXUSDT', 'long', { quantity: '0.001' })] }), code('open_requires_notional'));
  // Quantities per leg may differ (a close sized to the positions held).
  const close = parseIntent({ ...base, action: 'close', legs: [leg('binance', 'SKHYUSDT', 'long', { quantity: '2.4' }), leg('binance', 'SKHYNIXUSDT', 'short', { quantity: '0.25' })] });
  assert.deepEqual(close.legs.map(item => item.quantity), ['2.4', '0.25']);
  // Oil keeps its shape: no notional field on its legs, and notional is refused there.
  const oil = parseIntent({ market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('binance', 'BZUSDT', 'short', { barrels: '1' }), leg('binance', 'CLUSDT', 'long', { barrels: '1' })] });
  assert.equal(Object.hasOwn(oil.legs[0], 'notional'), false);
  assert.throws(() => parseIntent({ market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('binance', 'BZUSDT', 'short', { notional: '1' }), leg('binance', 'CLUSDT', 'long', { notional: '1' })] }), code('unknown_field'));
  // Across venues: one hynix contract named at the top.
  const cross = parseIntent({ market: 'hynix', preset: 'cross-exchange', symbol: 'SKHYUSDT', action: 'open', timeoutMs: 60_000, legs: [{ venue: 'binance', side: 'long', orderType: 'market', notional: '50' }, { venue: 'bybit', side: 'short', orderType: 'market', notional: '50' }] });
  assert.deepEqual(cross.legs.map(item => [item.venue, item.symbol]), [['binance', 'SKHYUSDT'], ['bybit', 'SKHYUSDT']]);
  assert.throws(() => parseIntent({ market: 'hynix', preset: 'cross-exchange', symbol: 'BZUSDT', action: 'open', timeoutMs: 60_000, legs: cross.legs }), code('invalid_value'));
});

test('折算与溢价：名义金额按中间价与合约乘数折成数量并向下取整到步长；溢价率 = ADR × 10 ÷ 正股 − 1', () => {
  assert.equal(midOf('41.20', '41.24'), '41.22');
  assert.equal(quantityForNotional('100', '41.22', { contractSize: '1', quantityStep: '0.01' }), '2.42');
  assert.equal(quantityForNotional('100', '400.2', { contractSize: '1', quantityStep: '0.001' }), '0.249');
  assert.equal(quantityForNotional('100', '400.2', { contractSize: '10', quantityStep: '0.001' }), '0.024');
  assert.equal(quantityForNotional('1', '400.2', { contractSize: '1', quantityStep: '0.01' }), '0');
  assert.equal(premiumPercent('41.2', '400'), '3');
  assert.equal(premiumPercent('39', '400'), '-2.5');
  assert.equal(premiumPercent('41', '0'), null);
});

test('同所开平：等名义金额折成两腿数量，按计划比例对冲后完成；平仓按各腿数量；任务列表按品种分开', () => withHarness(async h => {
  bindAccounts(h.ex);
  const preview = await h.ex.preview(sameIntent(), SESSION);
  // Binance ADR mid 41.22 → 2.42; ordinary mid 400.2 → 0.249 (steps 0.01 and 0.001).
  assert.deepEqual(preview.legs.map(item => [item.symbol, item.side, item.quantity]), [['SKHYUSDT', 'short', '2.42'], ['SKHYNIXUSDT', 'long', '0.249']]);
  assert.equal(preview.barrels, undefined);
  assert.ok(preview.notes.some(note => note.includes('按计划比例')), preview.notes.join('\n'));
  const opened = await settle(h, (await previewAndConfirm(h, sameIntent())).jobId);
  assert.equal(opened.status, 'completed', opened.reason ?? '');
  assert.equal(opened.market, 'hynix');
  assert.deepEqual(opened.legs.map(item => [item.symbol, item.filledQuantity]), [['SKHYUSDT', '2.42'], ['SKHYNIXUSDT', '0.249']]);
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short'), '2.42');
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'SKHYNIXUSDT', 'long'), '0.249');

  const closeIntent = { market: 'hynix', preset: 'same-exchange', action: 'close', timeoutMs: 60_000, legs: [leg('binance', 'SKHYNIXUSDT', 'long', { quantity: '0.249' }), leg('binance', 'SKHYUSDT', 'short', { quantity: '2.42' })] };
  const closed = await settle(h, (await previewAndConfirm(h, closeIntent)).jobId);
  assert.equal(closed.status, 'completed', closed.reason ?? '');
  assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short'), '0'), 0);
  assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'SKHYNIXUSDT', 'long'), '0'), 0);

  const oil = await settle(h, (await previewAndConfirm(h, { market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('binance', 'BZUSDT', 'short', { barrels: '1' }), leg('binance', 'CLUSDT', 'long', { barrels: '1' })] })).jobId);
  assert.equal(oil.status, 'completed', oil.reason ?? '');
  assert.equal(oil.market, 'oil');
  assert.deepEqual(h.ex.recentJobs(20, 'hynix').map(job => job.id), [closed.id, opened.id]);
  assert.deepEqual(h.ex.recentJobs(20, 'oil').map(job => job.id), [oil.id]);
  assert.equal(h.ex.recentJobs(20).length, 3);
}));

test('金额太小、跨所等金额：不足最小数量拒绝；跨所同一合约按各所步长折算后按比例完成', () => withHarness(async h => {
  bindAccounts(h.ex);
  await assert.rejects(h.ex.preview(sameIntent({ notional: '0.3' }), SESSION), code('notional_too_small'));
  const cross = { market: 'hynix', preset: 'cross-exchange', symbol: 'SKHYUSDT', action: 'open', timeoutMs: 60_000, legs: [{ venue: 'bybit', side: 'long', orderType: 'market', notional: '100' }, { venue: 'binance', side: 'short', orderType: 'market', notional: '100' }] };
  const preview = await h.ex.preview(cross, SESSION);
  // Bybit mid 41.24, step 0.1 → 2.4; Binance mid 41.22, step 0.01 → 2.42.
  assert.deepEqual(preview.legs.map(item => [item.venue, item.quantity]), [['bybit', '2.4'], ['binance', '2.42']]);
  const done = await settle(h, (await previewAndConfirm(h, cross)).jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.deepEqual(done.legs.map(item => item.filledQuantity), ['2.4', '2.42']);
}));

test('部分成交按比例对冲后完成并注明；对冲腿被拒转人工并写出应对冲数量', () => withHarness(async h => {
  bindAccounts(h.ex);
  // The lead (ADR, 2.42 planned) fills 1.21: the hedge is 0.249 × 1.21 ÷ 2.42 = 0.1245, floored to 0.124.
  h.binance.inject({ operation: 'place', mode: 'partial', filled: '1.21' });
  const partial = await settle(h, (await previewAndConfirm(h, sameIntent())).jobId);
  assert.equal(partial.status, 'completed', partial.reason ?? '');
  assert.deepEqual(partial.legs.map(item => item.filledQuantity), ['1.21', '0.124']);
  assert.match(partial.reason ?? '', /首腿成交 1\.21，计划 2\.42；对冲腿按比例成交 0\.124/);

  const before = h.binance.position(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short');
  const { jobId } = await previewAndConfirm(h, sameIntent());
  // The lead goes out and fills; the next place (the hedge) is refused.
  await h.ex.tick();
  h.binance.inject({ operation: 'place', mode: 'reject' });
  const refused = await settle(h, jobId);
  assert.equal(refused.status, 'attention');
  assert.ok(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short'), before) > 0);
  assert.match(refused.reason ?? '', /按计划比例对冲腿应为 0\.249/);
}));

test('行情视图：同所溢价（中间价、卖出、买入）与跨所价差；持仓只读海力士合约', async () => {
  const h = createHarness();
  try {
    const market = createHynixMarket({ connectors: [h.binance, h.bybit] as never, accounts: SIM_BINDINGS as never, now: () => h.clock.now });
    await market.refreshQuotes();
    await market.refreshPositions();
    const view = market.view();
    assert.equal(view.books.length, 4);
    const binance = view.sameExchange.find(row => row.venue === 'binance')!;
    // mid: 41.22 × 10 ÷ 400.2 − 1; sell: 41.20 × 10 ÷ 400.40 − 1; buy: 41.24 × 10 ÷ 400.00 − 1.
    assert.equal(Number(binance.premium).toFixed(4), ((41.22 * 10 / 400.2 - 1) * 100).toFixed(4));
    assert.equal(Number(binance.sell).toFixed(4), ((41.2 * 10 / 400.4 - 1) * 100).toFixed(4));
    assert.equal(Number(binance.buy).toFixed(4), '3.1000');
    assert.deepEqual(view.crossExchange.map(row => [row.symbol, row.binanceOverBybit, row.bybitOverBinance]), [['SKHYUSDT', '-0.06', '-0.02'], ['SKHYNIXUSDT', '-0.5', '-0.3']]);
    const positions = market.positionsView();
    assert.deepEqual(Object.keys(positions.accounts[0]!.long ?? {}), ['SKHYUSDT', 'SKHYNIXUSDT']);
  } finally { h.dispose(); }
});

test('飞书：海力士任务写各腿数量、均价与溢价率；未结束任务的配置提示写海力士', () => withHarness(async h => {
  bindAccounts(h.ex);
  const file = join(h.dir, 'notify.sqlite');
  const events = (after: number, limit: number) => h.store.db.prepare('SELECT seq, type, at, json, job_id AS jobId FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as never;
  const latestSeq = () => (h.store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  const notifier = createNotifier({ file, events, latestSeq, pairs: () => [], incidentPair: () => null, job: id => h.ex.jobView(id), feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh', secret: 'sec' }, fetchImpl: async () => { throw new Error('不发送'); }, now: () => h.clock.now, log: () => undefined });
  const texts = () => { const db = new DatabaseSync(file); try { return (db.prepare('SELECT text FROM outbox ORDER BY id').all() as { text: string }[]).map(row => row.text); } finally { db.close(); } };
  try {
    notifier.poll();
    const { jobId } = await previewAndConfirm(h, sameIntent());
    notifier.poll();
    // Still open: a config without Bybit is fine, without oil it is stranded and named as hynix.
    assert.deepEqual(strandedOilJobs(h.ex, undefined).map(line => line.slice(0, 6)), ['海力士任务 ']);
    assert.equal((await settle(h, jobId)).status, 'completed');
    notifier.poll();
    const sent = texts();
    assert.equal(sent.length, 2, sent.join('\n'));
    assert.match(sent[0]!, /【海力士任务已确认】Binance 同所 开仓 做空溢价（空 SKHYUSDT、多 SKHYNIXUSDT），计划 ADR 2\.42 可成交价 41\.2、正股 0\.249 可成交价 400\.4，溢价 2\.90%/);
    assert.match(sent[1]!, /【海力士任务完成】Binance 同所 开仓 做空溢价.*成交 ADR 2\.42 均价 [\d.]+、正股 0\.249 均价 [\d.]+；成交溢价 [\d.-]+%/);
  } finally { notifier.close(); }
}));

test('页面表单：等金额与按数量两种意图、校验、按持仓填平仓数量', async () => {
  const { DEFAULT_HYNIX_FORM, closeQuantities, describeHynixIntent, hynixFormToIntent } = await import('../web/src/hynix-form.ts');
  const open = hynixFormToIntent({ ...DEFAULT_HYNIX_FORM, notional: '1000' });
  assert.ok('intent' in open);
  assert.deepEqual(open.intent.legs.map(item => [item.symbol, item.side, item.notional, item.quantity]), [['SKHYUSDT', 'short', '1000', undefined], ['SKHYNIXUSDT', 'long', '1000', undefined]]);
  assert.equal(describeHynixIntent(open.intent), '开仓 Binance 做空溢价：空 ADR / 多 正股');
  // What the page builds, the executor accepts.
  assert.equal(parseIntent(open.intent).market, 'hynix');
  assert.deepEqual(hynixFormToIntent({ ...DEFAULT_HYNIX_FORM, notional: '0' }), { error: '每腿名义金额须为正数 USDT（最多 8 位小数）' });
  assert.ok('error' in hynixFormToIntent({ ...DEFAULT_HYNIX_FORM, sizing: 'quantity', leadQuantity: '2', hedgeQuantity: '' }));
  assert.ok('error' in hynixFormToIntent({ ...DEFAULT_HYNIX_FORM, notional: '10', leadOrderType: 'chase' }));
  assert.deepEqual(hynixFormToIntent({ ...DEFAULT_HYNIX_FORM, sizing: 'quantity', leadQuantity: '2', hedgeQuantity: '0.2' }), { error: '开仓须按每腿相同的名义金额下单；按各腿数量只用于平仓' });
  const closeForm = { ...DEFAULT_HYNIX_FORM, action: 'close' as const, sizing: 'quantity' as const, leadSymbol: 'SKHYNIXUSDT' as const };
  const accounts = [{ venue: 'binance', long: { SKHYNIXUSDT: '0.249' }, short: { SKHYUSDT: '2.42' } }];
  const held = closeQuantities(closeForm, accounts);
  assert.deepEqual(held, { leadQuantity: '0.249', hedgeQuantity: '2.42' });
  const close = hynixFormToIntent({ ...closeForm, ...held });
  assert.ok('intent' in close);
  assert.deepEqual(parseIntent(close.intent).legs.map(item => [item.symbol, item.side, item.quantity]), [['SKHYNIXUSDT', 'long', '0.249'], ['SKHYUSDT', 'short', '2.42']]);
  assert.deepEqual(closeQuantities(closeForm, [{ venue: 'binance', long: null, short: null }]), { error: 'Binance 正股多头持仓尚未读到，请稍后再填' });
  assert.deepEqual(closeQuantities({ ...closeForm, premium: 'long' }, accounts), { error: 'Binance 正股空头没有持仓，不能按持仓平仓' });
  const cross = hynixFormToIntent({ ...DEFAULT_HYNIX_FORM, preset: 'cross-exchange', venue: 'bybit', leadOrderType: 'chase', notional: '50', symbol: 'SKHYNIXUSDT' });
  assert.ok('intent' in cross);
  assert.deepEqual(parseIntent(cross.intent).legs.map(item => [item.venue, item.symbol, item.side, item.orderType]), [['bybit', 'SKHYNIXUSDT', 'long', 'chase'], ['binance', 'SKHYNIXUSDT', 'short', 'market']]);
});
