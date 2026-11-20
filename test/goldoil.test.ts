// Gold-oil two-leg trading (docs/goldoil.md): the intent, sizing by notional, settling in the planned proportion, the
// market of a job from all its legs (a gold-oil job may lead with CLUSDT), the ratio view, Feishu and the page form.
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ContractError, marketOfSymbols, parseFourLegIntent, parseIntent, parsePairIntent } from '../src/contracts.ts';
import { add, cmp } from '../src/decimal.ts';
import { SIM_ACCOUNTS, SIM_BINDINGS } from '../src/simulation.ts';
import { createGoldOilMarket } from '../src/goldoil/market.ts';
import { createOilMarket } from '../src/oil/market.ts';
import { createHynixMarket } from '../src/hynix/market.ts';
import { goldOilRatio } from '../src/goldoil/ratio.ts';
import { createNotifier } from '../src/service/feishu.ts';
import { goldoilViews, oilLoops, strandedOilJobs, type OilRuntime } from '../src/service/oil.ts';
import { SESSION, bindAccounts, createHarness, previewAndConfirm, settle, type Harness } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
const leg = (venue: string, symbol: string, side: 'long' | 'short', amount: { quantity?: string; notional?: string; barrels?: string }) => ({ venue, symbol, side, orderType: 'market', ...amount });
/** Long the ratio on one venue: buy gold, sell oil, equal notional; `lead` is the contract sent first. */
const sameIntent = ({ venue = 'binance', notional = '1000', action = 'open', oil = 'CLUSDT', lead = 'XAUUSDT' }: { venue?: string; notional?: string; action?: 'open' | 'close'; oil?: string; lead?: string } = {}) => {
  const gold = leg(venue, 'XAUUSDT', 'long', { notional }), oilLeg = leg(venue, oil, 'short', { notional });
  return { market: 'goldoil', preset: 'same-exchange', action, timeoutMs: 60_000, legs: lead === 'XAUUSDT' ? [gold, oilLeg] : [oilLeg, gold] };
};
async function withHarness(run: (h: Harness) => Promise<void>) {
  const h = createHarness();
  try { await run(h); } finally { h.dispose(); }
}

test('意图：金油同所须一腿 XAU 一腿 CL 或 BZ；跨所只做 XAU；按名义金额规则同海力士；原油与海力士不收 XAU；不做四腿与调平', () => {
  const same = parsePairIntent(sameIntent());
  assert.equal(same.market, 'goldoil');
  assert.deepEqual(same.legs.map(item => [item.symbol, item.notional, item.barrels]), [['XAUUSDT', '1000', null], ['CLUSDT', '1000', null]]);
  assert.deepEqual(parsePairIntent(sameIntent({ oil: 'BZUSDT', lead: 'BZUSDT' })).legs.map(item => item.symbol), ['BZUSDT', 'XAUUSDT']);
  // Two oil legs, two gold legs: not a gold-oil pair.
  assert.throws(() => parsePairIntent({ ...sameIntent(), legs: [leg('binance', 'BZUSDT', 'long', { notional: '1000' }), leg('binance', 'CLUSDT', 'short', { notional: '1000' })] }), code('same_symbol'));
  assert.throws(() => parsePairIntent({ ...sameIntent(), legs: [leg('binance', 'XAUUSDT', 'long', { notional: '1000' }), leg('binance', 'XAUUSDT', 'short', { notional: '1000' })] }), code('same_symbol'));
  assert.throws(() => parsePairIntent({ ...sameIntent(), legs: [leg('binance', 'XAUUSDT', 'long', { notional: '1000' }), leg('binance', 'SKHYUSDT', 'short', { notional: '1000' })] }), code('invalid_value'));
  // Across venues: gold only; oil across venues is the oil market's.
  const cross = (symbol: string) => ({ market: 'goldoil', preset: 'cross-exchange', symbol, action: 'open', timeoutMs: 60_000, legs: [{ venue: 'binance', side: 'long', orderType: 'market', notional: '500' }, { venue: 'bybit', side: 'short', orderType: 'market', notional: '500' }] });
  assert.equal(parsePairIntent(cross('XAUUSDT')).symbol, 'XAUUSDT');
  assert.throws(() => parsePairIntent(cross('CLUSDT')), (error: unknown) => error instanceof ContractError && error.code === 'invalid_value' && error.message.includes('金油跨所合约'));
  // Sizing as hynix: notional or quantity, alike on both legs; equal notional; open only by notional; no barrels.
  assert.throws(() => parsePairIntent({ ...sameIntent(), legs: [leg('binance', 'XAUUSDT', 'long', { notional: '1000' }), leg('binance', 'CLUSDT', 'short', { notional: '900' })] }), code('unbalanced'));
  assert.throws(() => parsePairIntent({ ...sameIntent(), legs: [leg('binance', 'XAUUSDT', 'long', { notional: '1000' }), leg('binance', 'CLUSDT', 'short', { quantity: '14' })] }), code('quantity_mode'));
  assert.throws(() => parsePairIntent({ ...sameIntent(), legs: [leg('binance', 'XAUUSDT', 'long', { quantity: '0.4' }), leg('binance', 'CLUSDT', 'short', { quantity: '14' })] }), (error: unknown) => error instanceof ContractError && error.code === 'open_requires_notional' && error.message.startsWith('金油开仓'));
  assert.equal(parsePairIntent({ ...sameIntent({ action: 'close' }), legs: [leg('binance', 'XAUUSDT', 'long', { quantity: '0.4' }), leg('binance', 'CLUSDT', 'short', { quantity: '14' })] }).action, 'close');
  assert.throws(() => parsePairIntent({ ...sameIntent(), legs: [leg('binance', 'XAUUSDT', 'long', { barrels: '1' }), leg('binance', 'CLUSDT', 'short', { barrels: '1' })] }), code('unknown_field'));
  assert.equal(parsePairIntent({ ...sameIntent(), batches: { count: 2, intervalMs: 0 } }).batches?.count, 2);
  // Oil and hynix keep their own contracts.
  assert.throws(() => parsePairIntent({ market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('binance', 'XAUUSDT', 'long', { barrels: '1' }), leg('binance', 'CLUSDT', 'short', { barrels: '1' })] }), code('invalid_value'));
  assert.throws(() => parsePairIntent({ market: 'oil', preset: 'cross-exchange', symbol: 'XAUUSDT', action: 'open', timeoutMs: 60_000, legs: [{ venue: 'binance', side: 'long', orderType: 'market', barrels: '1' }, { venue: 'bybit', side: 'short', orderType: 'market', barrels: '1' }] }), code('invalid_value'));
  assert.throws(() => parsePairIntent({ market: 'hynix', preset: 'cross-exchange', symbol: 'XAUUSDT', action: 'open', timeoutMs: 60_000, legs: [{ venue: 'binance', side: 'long', orderType: 'market', notional: '1' }, { venue: 'bybit', side: 'short', orderType: 'market', notional: '1' }] }), code('invalid_value'));
  const four = { market: 'goldoil', preset: 'four-leg', action: 'open', timeoutMs: 60_000, legs: [...sameIntent().legs, ...sameIntent({ venue: 'bybit' }).legs.map(item => ({ ...item, side: item.side === 'long' ? 'short' : 'long' }))] };
  assert.throws(() => parseFourLegIntent(four), code('four_leg_market'));
  assert.throws(() => parseIntent({ market: 'goldoil', preset: 'rebalance', venue: 'binance', method: 'reduce', timeoutMs: 60_000 }), code('rebalance_market'));
});

test('品种判断：按全部腿，任一腿 XAU 为金油，任一腿海力士合约为海力士，其余为原油', () => {
  assert.equal(marketOfSymbols(['CLUSDT', 'XAUUSDT']), 'goldoil');
  assert.equal(marketOfSymbols(['XAUUSDT', 'BZUSDT']), 'goldoil');
  assert.equal(marketOfSymbols(['XAUUSDT']), 'goldoil');
  assert.equal(marketOfSymbols(['SKHYNIXUSDT', 'SKHYUSDT']), 'hynix');
  assert.equal(marketOfSymbols(['SKHYUSDT']), 'hynix');
  assert.equal(marketOfSymbols(['CLUSDT', 'BZUSDT']), 'oil');
});

test('同所开平：等名义金额按中间价折算，首腿 CL 的金油任务按比例完成、不进原油列表；平仓按各腿数量；三个品种的列表各自分开', () => withHarness(async h => {
  bindAccounts(h.ex);
  const preview = await h.ex.preview(sameIntent(), SESSION);
  // Binance XAU mid 2650.30 → 1000 ÷ 2650.30 = 0.3773… → 0.377 (step 0.001); CL mid 70.01 → 14.2836… → 14.28 (step 0.01).
  assert.deepEqual(preview.legs.map(item => [item.symbol, item.side, item.quantity]), [['XAUUSDT', 'long', '0.377'], ['CLUSDT', 'short', '14.28']]);
  assert.equal(preview.barrels, undefined, '金油不做等桶核对');
  assert.ok(preview.notes.some(note => note.includes('按计划比例')), preview.notes.join('\n'));

  // The oil leg first: a job read by its first leg would be oil, settle by barrels (14.28 against 0.377) and go to attention.
  const opened = await settle(h, (await previewAndConfirm(h, sameIntent({ lead: 'CLUSDT' }))).jobId);
  assert.equal(opened.status, 'completed', opened.reason ?? '');
  assert.equal(opened.market, 'goldoil');
  assert.deepEqual(opened.legs.map(item => [item.symbol, item.filledQuantity]), [['CLUSDT', '14.28'], ['XAUUSDT', '0.377']]);
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'XAUUSDT', 'long'), '0.377');
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'short'), '14.28');

  const closeIntent = { market: 'goldoil', preset: 'same-exchange', action: 'close', timeoutMs: 60_000, legs: [leg('binance', 'XAUUSDT', 'long', { quantity: '0.377' }), leg('binance', 'CLUSDT', 'short', { quantity: '14.28' })] };
  const closed = await settle(h, (await previewAndConfirm(h, closeIntent)).jobId);
  assert.equal(closed.status, 'completed', closed.reason ?? '');
  assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'XAUUSDT', 'long'), '0'), 0);
  assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'short'), '0'), 0);

  const oil = await settle(h, (await previewAndConfirm(h, { market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('binance', 'CLUSDT', 'short', { barrels: '1' }), leg('binance', 'BZUSDT', 'long', { barrels: '1' })] })).jobId);
  assert.equal(oil.status, 'completed', oil.reason ?? '');
  assert.equal(oil.market, 'oil');
  const hynix = await settle(h, (await previewAndConfirm(h, { market: 'hynix', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('binance', 'SKHYUSDT', 'short', { notional: '100' }), leg('binance', 'SKHYNIXUSDT', 'long', { notional: '100' })] })).jobId);
  assert.equal(hynix.market, 'hynix');
  assert.deepEqual(h.ex.recentJobs(20, 'goldoil').map(job => job.id), [closed.id, opened.id]);
  assert.deepEqual(h.ex.recentJobs(20, 'oil').map(job => job.id), [oil.id], '原油列表不含首腿 CL 的金油任务');
  assert.deepEqual(h.ex.recentJobs(20, 'hynix').map(job => job.id), [hynix.id]);
  assert.equal(h.ex.recentJobs(20).length, 4);
}));

test('分批与跨所：首腿按步长均分、对冲按比例；跨所 XAU 按各所步长折算后按比例完成；金额太小拒绝', () => withHarness(async h => {
  bindAccounts(h.ex);
  const batched = { ...sameIntent(), batches: { count: 2, intervalMs: 0 } };
  const preview = await h.ex.preview(batched, SESSION);
  assert.equal(preview.batches?.length, 2);
  assert.equal(add(...preview.batches!), '0.377');
  const done = await settle(h, (await previewAndConfirm(h, batched)).jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.deepEqual(done.legs.map(item => item.filledQuantity), ['0.377', '14.28']);

  await assert.rejects(h.ex.preview(sameIntent({ notional: '1' }), SESSION), code('notional_too_small'));
  const cross = { market: 'goldoil', preset: 'cross-exchange', symbol: 'XAUUSDT', action: 'open', timeoutMs: 60_000, legs: [{ venue: 'bybit', side: 'short', orderType: 'market', notional: '1000' }, { venue: 'binance', side: 'long', orderType: 'market', notional: '1000' }] };
  // Binance holds the batched long (one-way): the cross pair adds to it rather than reducing it (implicit_reduce).
  // Bybit mid 2650.50, step 0.01 → 0.37; Binance mid 2650.30, step 0.001 → 0.377.
  assert.deepEqual((await h.ex.preview(cross, SESSION)).legs.map(item => [item.venue, item.quantity]), [['bybit', '0.37'], ['binance', '0.377']]);
  const crossed = await settle(h, (await previewAndConfirm(h, cross)).jobId);
  assert.equal(crossed.status, 'completed', crossed.reason ?? '');
  assert.equal(crossed.market, 'goldoil');
  assert.deepEqual(crossed.legs.map(item => item.filledQuantity), ['0.37', '0.377']);
}));

test('部分成交按比例对冲后完成并注明；对冲腿被拒转人工并写出应对冲数量', () => withHarness(async h => {
  bindAccounts(h.ex);
  // The lead (CL, 14.28 planned) fills 7.14: the hedge is 0.377 × 7.14 ÷ 14.28 = 0.1885, floored to 0.188.
  h.binance.inject({ operation: 'place', mode: 'partial', filled: '7.14' });
  const partial = await settle(h, (await previewAndConfirm(h, sameIntent({ lead: 'CLUSDT' }))).jobId);
  assert.equal(partial.status, 'completed', partial.reason ?? '');
  assert.deepEqual(partial.legs.map(item => item.filledQuantity), ['7.14', '0.188']);
  assert.match(partial.reason ?? '', /首腿成交 7\.14，计划 14\.28；对冲腿按比例成交 0\.188/);

  const { jobId } = await previewAndConfirm(h, sameIntent({ lead: 'CLUSDT' }));
  await h.ex.tick();
  h.binance.inject({ operation: 'place', mode: 'reject' });
  const refused = await settle(h, jobId);
  assert.equal(refused.status, 'attention');
  assert.match(refused.reason ?? '', /按计划比例对冲腿应为 0\.377/);
  assert.doesNotMatch(refused.reason ?? '', /桶/);
}));

test('行情视图：每所每个油品一行的金油比（中间价、卖出、买入），跨所只列 XAU；持仓读三个合约', async () => {
  assert.equal(goldOilRatio('2650', '0'), null);
  assert.equal(goldOilRatio('100', '8'), '12.5');
  const h = createHarness();
  try {
    const market = createGoldOilMarket({ connectors: [h.binance, h.bybit] as never, accounts: SIM_BINDINGS as never, now: () => h.clock.now });
    await market.refreshQuotes();
    await market.refreshPositions();
    const view = market.view();
    assert.equal(view.books.length, 6);
    assert.deepEqual(view.sameExchange.map(row => [row.venue, row.oilSymbol]), [['binance', 'CLUSDT'], ['binance', 'BZUSDT'], ['bybit', 'CLUSDT'], ['bybit', 'BZUSDT']]);
    const cl = view.sameExchange[0]!;
    // mid: 2650.30 ÷ 70.01; sell: XAU bid 2650.00 ÷ CL ask 70.02; buy: XAU ask 2650.60 ÷ CL bid 70.00.
    assert.equal(Number(cl.ratio).toFixed(6), (2650.3 / 70.01).toFixed(6));
    assert.equal(Number(cl.sell).toFixed(6), (2650 / 70.02).toFixed(6));
    assert.equal(cl.buy, '37.865714285714285714');
    assert.ok(cl.receivedAt !== null);
    assert.deepEqual(view.crossExchange.map(row => [row.symbol, row.first, row.second, row.firstOverSecond, row.secondOverFirst]), [['XAUUSDT', 'binance', 'bybit', '-0.8', '-0.4']]);
    assert.deepEqual(Object.keys(market.positionsView().accounts[0]!.long ?? {}), ['XAUUSDT', 'CLUSDT', 'BZUSDT']);
  } finally { h.dispose(); }
});

test('飞书：金油任务写方向、各腿数量、均价与金油比；未结束任务的配置提示写金油', () => withHarness(async h => {
  bindAccounts(h.ex);
  const file = join(h.dir, 'notify.sqlite');
  const events = (after: number, limit: number) => h.store.db.prepare('SELECT seq, type, at, json, job_id AS jobId FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as never;
  const latestSeq = () => (h.store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  const notifier = createNotifier({ file, events, latestSeq, pairs: () => [], incidentPair: () => null, job: id => h.ex.jobView(id), feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh', secret: 'sec' }, fetchImpl: async () => { throw new Error('不发送'); }, now: () => h.clock.now, log: () => undefined });
  const texts = () => { const db = new DatabaseSync(file); try { return (db.prepare('SELECT text FROM outbox ORDER BY id').all() as { text: string }[]).map(row => row.text); } finally { db.close(); } };
  try {
    notifier.poll();
    // The oil leg first: still named gold-oil.
    const { jobId } = await previewAndConfirm(h, sameIntent({ lead: 'CLUSDT' }));
    notifier.poll();
    assert.deepEqual(strandedOilJobs(h.ex, undefined).map(line => line.slice(0, 5)), ['金油任务 ']);
    assert.equal((await settle(h, jobId)).status, 'completed');
    notifier.poll();
    const sent = texts();
    assert.equal(sent.length, 2, sent.join('\n'));
    // Long gold buys at the ask 2650.60, short CL sells at the bid 70.00: 37.866.
    assert.match(sent[0]!, /【金油任务已确认】Binance 同所 开仓 做多金油比（多 XAUUSDT、空 CLUSDT），计划 CLUSDT 14\.28 可成交价 70(\.0+)?、XAUUSDT 0\.377 可成交价 2650\.6，金油比 37\.866/);
    assert.match(sent[1]!, /【金油任务完成】Binance 同所 开仓 做多金油比.*成交 CLUSDT 14\.28 均价 [\d.]+、XAUUSDT 0\.377 均价 [\d.]+；成交金油比 \d+\.\d{3}/);
    assert.doesNotMatch(sent.join('\n'), /桶/);
  } finally { notifier.close(); }
}));

test('页面表单：同所金油比两个方向与首腿、跨所 XAU、按数量平仓与按持仓填入；页面给出的意图执行器都接受', async () => {
  const { DEFAULT_GOLDOIL_FORM, closeQuantities, describeGoldOilIntent, goldOilFormToIntent } = await import('../web/src/goldoil-form.ts');
  const open = goldOilFormToIntent({ ...DEFAULT_GOLDOIL_FORM, notional: '1000' });
  assert.ok('intent' in open);
  assert.deepEqual(open.intent.legs.map(item => [item.symbol, item.side, item.notional]), [['XAUUSDT', 'long', '1000'], ['CLUSDT', 'short', '1000']]);
  assert.equal(describeGoldOilIntent(open.intent), '开仓 Binance 做多金油比：多 XAU / 空 CL');
  assert.equal(parseIntent(open.intent).market, 'goldoil');
  const short = goldOilFormToIntent({ ...DEFAULT_GOLDOIL_FORM, notional: '500', ratio: 'short', oilSymbol: 'BZUSDT', lead: 'oil' });
  assert.ok('intent' in short);
  assert.deepEqual(short.intent.legs.map(item => [item.symbol, item.side]), [['BZUSDT', 'long'], ['XAUUSDT', 'short']]);
  assert.equal(describeGoldOilIntent(short.intent), '开仓 Binance 做空金油比：多 BZ / 空 XAU');
  assert.equal(parsePairIntent(short.intent).market, 'goldoil');
  assert.deepEqual(goldOilFormToIntent({ ...DEFAULT_GOLDOIL_FORM, notional: '0' }), { error: '每腿名义金额须为正数 USDT（最多 8 位小数）' });
  assert.deepEqual(goldOilFormToIntent({ ...DEFAULT_GOLDOIL_FORM, sizing: 'quantity', leadQuantity: '0.3', hedgeQuantity: '14' }), { error: '开仓须按每腿相同的名义金额下单；按各腿数量只用于平仓' });
  assert.deepEqual(goldOilFormToIntent({ ...DEFAULT_GOLDOIL_FORM, notional: '10', leadOrderType: 'chase' }), { error: '追价策略只有 Bybit 支持；Binance 首腿请选市价或本地追价' });

  const closeForm = { ...DEFAULT_GOLDOIL_FORM, action: 'close' as const, sizing: 'quantity' as const, lead: 'oil' as const };
  const accounts = [{ venue: 'binance', long: { XAUUSDT: '0.377' }, short: { CLUSDT: '14.28' } }];
  const mine = [{ venue: 'binance', long: { XAUUSDT: '0.377' }, short: { CLUSDT: '14.28' }, uncertain: { long: [], short: [] } }];
  const held = closeQuantities(closeForm, accounts, mine);
  assert.deepEqual(held, { leadQuantity: '14.28', hedgeQuantity: '0.377', left: [] });
  if ('error' in held) return;
  const close = goldOilFormToIntent({ ...closeForm, leadQuantity: held.leadQuantity, hedgeQuantity: held.hedgeQuantity });
  assert.ok('intent' in close);
  assert.deepEqual(parsePairIntent(close.intent).legs.map(item => [item.symbol, item.side, item.quantity]), [['CLUSDT', 'short', '14.28'], ['XAUUSDT', 'long', '0.377']]);
  assert.deepEqual(closeQuantities(closeForm, [{ venue: 'binance', long: null, short: null }], mine), { error: 'Binance CL空头持仓尚未读到，请稍后再填' });
  assert.deepEqual(closeQuantities({ ...closeForm, ratio: 'short' }, accounts, mine), { error: 'Binance CL多头没有持仓，不能按持仓平仓' });
  // The account holds more than gold-oil jobs do (an oil-page short on CL, gold bought outside): only gold-oil's part is filled.
  const more = [{ venue: 'binance', long: { XAUUSDT: '0.5' }, short: { CLUSDT: '20.28' } }];
  assert.deepEqual(closeQuantities(closeForm, more, mine), { leadQuantity: '14.28', hedgeQuantity: '0.377', left: ['Binance CL空头账户另有 6 不属于金油任务，未填入', 'Binance XAU多头账户另有 0.123 不属于金油任务，未填入'] });
  // Less on the account than the jobs' net (reduced outside): the account's amount.
  assert.deepEqual(closeQuantities(closeForm, [{ venue: 'binance', long: { XAUUSDT: '0.3' }, short: { CLUSDT: '14.28' } }], mine), { leadQuantity: '14.28', hedgeQuantity: '0.3', left: [] });
  // Only the oil page's CL short: nothing of gold-oil's to close.
  assert.deepEqual(closeQuantities(closeForm, more, [{ venue: 'binance', long: { XAUUSDT: '0.377' }, short: {}, uncertain: { long: [], short: [] } }]), { error: 'Binance CL空头没有金油任务的持仓（账户持仓 20.28 不属于金油任务），不能按持仓平仓' });
  // A gold-oil job's CL fills are unverified: that leg is left to be typed from the venue, the other is filled as usual.
  const unsure = [{ ...mine[0]!, uncertain: { long: [], short: ['CLUSDT'] } }];
  assert.deepEqual(closeQuantities(closeForm, more, unsure), { leadQuantity: '', hedgeQuantity: '0.377', left: ['Binance CL空头有金油任务成交未核实，请按交易所持仓手动填写', 'Binance XAU多头账户另有 0.123 不属于金油任务，未填入'] });
  assert.deepEqual(closeQuantities(closeForm, more, [{ ...mine[0]!, uncertain: { long: ['XAUUSDT'], short: ['CLUSDT'] } }]), { error: '两腿都有金油任务成交未核实，请按交易所持仓手动填写' });

  const cross = goldOilFormToIntent({ ...DEFAULT_GOLDOIL_FORM, preset: 'cross-exchange', venue: 'bybit', hedgeVenue: 'binance', leadOrderType: 'chase', notional: '50', leadSide: 'short' });
  assert.ok('intent' in cross);
  assert.equal(cross.intent.symbol, 'XAUUSDT');
  assert.equal(describeGoldOilIntent(cross.intent), '开仓 跨所 XAU：Bybit 空 XAU / Binance 多 XAU');
  assert.deepEqual(parsePairIntent(cross.intent).legs.map(item => [item.venue, item.symbol, item.side, item.orderType]), [['bybit', 'XAUUSDT', 'short', 'chase'], ['binance', 'XAUUSDT', 'long', 'market']]);
  const batched = goldOilFormToIntent({ ...DEFAULT_GOLDOIL_FORM, notional: '1000', batchCount: '3', batchIntervalSeconds: '5' });
  assert.ok('intent' in batched);
  assert.deepEqual(parsePairIntent(batched.intent).batches, { count: 3, intervalMs: 5000 });
  assert.deepEqual(goldOilFormToIntent({ ...DEFAULT_GOLDOIL_FORM, preset: 'cross-exchange', venue: 'okx', hedgeVenue: 'okx', notional: '50' }), { error: '跨所组合的对冲腿须在另一个交易所' });
});

test('金油累计净持有：对全部金油任务按账户、方向、合约净额（开仓加、平仓减），不含原油任务，不受列表条数限制；页面状态按交易所给出', () => withHarness(async h => {
  bindAccounts(h.ex);
  assert.deepEqual(h.ex.goldoilHeld(), {});
  assert.equal((await settle(h, (await previewAndConfirm(h, sameIntent({ lead: 'CLUSDT' }))).jobId)).status, 'completed');
  // An oil job on the same account and contract: the account's CL short grows, gold-oil's does not.
  assert.equal((await settle(h, (await previewAndConfirm(h, { market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('binance', 'CLUSDT', 'short', { barrels: '1' }), leg('binance', 'BZUSDT', 'long', { barrels: '1' })] })).jobId)).status, 'completed');
  const close = { market: 'goldoil', preset: 'same-exchange', action: 'close', timeoutMs: 60_000, legs: [leg('binance', 'CLUSDT', 'short', { quantity: '7.14' }), leg('binance', 'XAUUSDT', 'long', { quantity: '0.188' })] };
  assert.equal((await settle(h, (await previewAndConfirm(h, close)).jobId)).status, 'completed');
  const key = `binance:simulated:${SIM_ACCOUNTS.binance}`;
  assert.deepEqual(h.ex.goldoilHeld(), { [key]: { long: { XAUUSDT: '0.189' }, short: { CLUSDT: '7.14' }, uncertain: { long: [], short: [] } } });
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'short'), '8.14', '账户合计含原油任务的 1 桶');
  const oil = { config: { accounts: SIM_BINDINGS }, goldoil: { view: () => ({}), positionsView: () => ({ readAt: null, accounts: [] }) } } as unknown as OilRuntime;
  assert.deepEqual((goldoilViews(oil, h.ex).state() as { goldoilHeld: unknown }).goldoilHeld, [
    { venue: 'binance', long: { XAUUSDT: '0.189' }, short: { CLUSDT: '7.14' }, uncertain: { long: [], short: [] } }, { venue: 'bybit', long: {}, short: {}, uncertain: { long: [], short: [] } },
  ]);
  // Beyond the page's 20 latest jobs the net still counts every gold-oil job.
  for (let i = 0; i < 21; i++) assert.equal((await settle(h, (await previewAndConfirm(h, sameIntent({ notional: '100' }))).jobId)).status, 'completed');
  assert.equal(h.ex.recentJobs(20, 'goldoil').length, 20);
  const net = h.ex.goldoilHeld()[key]!;
  assert.equal(net.long.XAUUSDT, h.binance.position(SIM_ACCOUNTS.binance, 'XAUUSDT', 'long'));
  assert.equal(cmp(net.short.CLUSDT!, h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'short')), -1);
}));

test('金油累计净持有逐任务计算：新成交后更新、部分成交与转人工按实际成交、跨所 XAU、超量平仓每步截 0、结果未核实标记', () => withHarness(async h => {
  bindAccounts(h.ex);
  const bn = `binance:simulated:${SIM_ACCOUNTS.binance}`, by = `bybit:simulated:${SIM_ACCOUNTS.bybit}`, none = { long: [], short: [] };
  // A running job is read, then its hedge fills: the kept result follows the job's new version.
  const { jobId } = await previewAndConfirm(h, sameIntent({ lead: 'CLUSDT' }));
  await h.ex.tick();
  const early = h.ex.goldoilHeld()[bn];
  assert.notEqual(early?.long.XAUUSDT, '0.377');
  assert.equal((await settle(h, jobId)).status, 'completed');
  assert.deepEqual(h.ex.goldoilHeld()[bn], { long: { XAUUSDT: '0.377' }, short: { CLUSDT: '14.28' }, uncertain: none });
  // Partial fill: 7.14 CL and 0.188 XAU more.
  h.binance.inject({ operation: 'place', mode: 'partial', filled: '7.14' });
  assert.equal((await settle(h, (await previewAndConfirm(h, sameIntent({ lead: 'CLUSDT' }))).jobId)).status, 'completed');
  // Hedge refused, job to attention: the CL lead's 14.28 counts, the XAU leg filled nothing.
  const refused = await previewAndConfirm(h, sameIntent({ lead: 'CLUSDT' }));
  await h.ex.tick();
  h.binance.inject({ operation: 'place', mode: 'reject' });
  assert.equal((await settle(h, refused.jobId)).status, 'attention');
  assert.deepEqual(h.ex.goldoilHeld()[bn], { long: { XAUUSDT: '0.565' }, short: { CLUSDT: '35.7' }, uncertain: none });
  h.ex.acknowledge(refused.jobId, randomUUID(), SESSION);
  // An oil job adds 1 CL short; a gold-oil close of 36.7 takes gold-oil's CL to 0 (not -1), so the next open counts in full.
  assert.equal((await settle(h, (await previewAndConfirm(h, { market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('binance', 'CLUSDT', 'short', { barrels: '1' }), leg('binance', 'BZUSDT', 'long', { barrels: '1' })] })).jobId)).status, 'completed');
  const over = { market: 'goldoil', preset: 'same-exchange', action: 'close', timeoutMs: 60_000, legs: [leg('binance', 'CLUSDT', 'short', { quantity: '36.7' }), leg('binance', 'XAUUSDT', 'long', { quantity: '0.565' })] };
  assert.equal((await settle(h, (await previewAndConfirm(h, over)).jobId)).status, 'completed');
  assert.deepEqual(h.ex.goldoilHeld()[bn], { long: { XAUUSDT: '0' }, short: { CLUSDT: '0' }, uncertain: none });
  assert.equal((await settle(h, (await previewAndConfirm(h, sameIntent())).jobId)).status, 'completed');
  assert.deepEqual(h.ex.goldoilHeld()[bn], { long: { XAUUSDT: '0.377' }, short: { CLUSDT: '14.28' }, uncertain: none });
  // Across venues: XAU on each venue's own account.
  const cross = { market: 'goldoil', preset: 'cross-exchange', symbol: 'XAUUSDT', action: 'open', timeoutMs: 60_000, legs: [{ venue: 'binance', side: 'long', orderType: 'market', notional: '1000' }, { venue: 'bybit', side: 'short', orderType: 'market', notional: '1000' }] };
  const crossed = await settle(h, (await previewAndConfirm(h, cross)).jobId);
  assert.equal(crossed.status, 'completed', crossed.reason ?? '');
  const held = h.ex.goldoilHeld();
  assert.equal(held[bn]!.long.XAUUSDT, add('0.377', crossed.legs[0]!.filledQuantity));
  assert.deepEqual(held[by], { long: {}, short: { XAUUSDT: crossed.legs[1]!.filledQuantity }, uncertain: none });
  // A lead order whose outcome stays unknown until the job goes to a person: its contract is marked, not guessed.
  h.binance.inject({ operation: 'place', mode: 'lost-request' });
  const lost = await previewAndConfirm(h, sameIntent({ lead: 'CLUSDT' }));
  await h.ex.tick();
  h.binance.setPosition(SIM_ACCOUNTS.binance, 'CLUSDT', 'short', '99');
  for (let i = 0; i < 20 && h.ex.jobView(lost.jobId).status === 'running'; i++) { h.advance(10_000); await h.ex.tick(); }
  const view = h.ex.jobView(lost.jobId);
  assert.equal(view.status, 'attention');
  assert.equal(view.legs[0]!.operation?.state, 'unknown');
  assert.deepEqual(h.ex.goldoilHeld()[bn]!.uncertain, { long: [], short: ['CLUSDT'] });
}));

test('XAU 读不到不拖累原油与海力士：合约规则、盘口、持仓读取都抛错时，两者视图与循环照常，原油预览成功', () => withHarness(async h => {
  bindAccounts(h.ex);
  const broken = () => Promise.reject(new Error('XAU 不可读'));
  for (const venue of [h.binance, h.bybit]) {
    const { instrument, quote, account } = venue;
    venue.instrument = (symbol, options) => symbol === 'XAUUSDT' ? broken() : instrument.call(venue, symbol, options);
    venue.quote = (symbol, options) => symbol === 'XAUUSDT' ? broken() : quote.call(venue, symbol, options);
    venue.account = (binding, symbols, options) => symbols.includes('XAUUSDT') ? broken() : account.call(venue, binding, symbols, options);
  }
  const options = { connectors: [h.binance, h.bybit] as never, accounts: SIM_BINDINGS as never, now: () => h.clock.now };
  const oil = { config: { accounts: SIM_BINDINGS }, market: createOilMarket(options), hynix: createHynixMarket(options), goldoil: createGoldOilMarket(options) } as unknown as OilRuntime;
  const logs: string[] = [];
  let rounds = 0;
  await Promise.all(oilLoops(oil, { stopped: () => rounds >= 12, pause: async () => { rounds++; } }, line => logs.push(line)));
  const books = (view: unknown) => (view as { books: { symbol: string; bid: string | null; error: string | null }[] }).books;
  assert.ok(books(oil.market.view()).every(row => row.bid !== null && row.error === null), JSON.stringify(books(oil.market.view())));
  assert.ok(books(oil.hynix.view()).every(row => row.bid !== null && row.error === null));
  const gold = books(oil.goldoil.view()).filter(row => row.symbol === 'XAUUSDT');
  assert.ok(gold.length === 2 && gold.every(row => row.bid === null && /XAU 不可读/.test(row.error ?? '')), JSON.stringify(gold));
  const positions = (view: { accounts: { long: Record<string, string> | null }[] }) => view.accounts.map(account => account.long !== null);
  assert.deepEqual(positions(oil.market.positionsView() as never), [true, true]);
  assert.deepEqual(positions(oil.hynix.positionsView() as never), [true, true]);
  assert.deepEqual(positions(oil.goldoil.positionsView() as never), [false, false]);
  const preview = await h.ex.preview({ market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('binance', 'BZUSDT', 'short', { barrels: '1' }), leg('binance', 'CLUSDT', 'long', { barrels: '1' })] }, SESSION);
  assert.equal(preview.barrels, '1');
  await assert.rejects(h.ex.preview(sameIntent(), SESSION), /XAU 不可读/);
}));

test('分批对冲腿取整：油腿在前、XAU 对冲，某批 XAU 按比例取整为 0 时拒绝 batch_size', () => withHarness(async h => {
  bindAccounts(h.ex);
  // Bybit, 100 USDT a leg: CL 1.4 (step 0.1), XAU 0.03 (step 0.01). Five batches of CL 0.3 / 0.3 / 0.3 / 0.3 / 0.2: the first
  // batch's XAU is 0.03 × 0.3 ÷ 1.4 = 0.0064, floored to 0.
  const intent = (count: number) => ({ ...sameIntent({ venue: 'bybit', notional: '100', lead: 'CLUSDT' }), batches: { count, intervalMs: 0 } });
  const two = await h.ex.preview(intent(2), SESSION);
  assert.deepEqual(two.legs.map(item => [item.symbol, item.quantity]), [['CLUSDT', '1.4'], ['XAUUSDT', '0.03']]);
  await assert.rejects(h.ex.preview(intent(5), SESSION), (error: unknown) => error instanceof ContractError && error.code === 'batch_size' && error.message.includes('第 1 批'));
}));

test('重启接管首腿为 CLUSDT 的未完成金油任务：新执行器仍按金油、按计划比例对冲并结算', () => withHarness(async h => {
  bindAccounts(h.ex);
  // The CL lead fills half; the executor stops before the hedge goes out.
  h.binance.inject({ operation: 'place', mode: 'partial', filled: '7.14' });
  const { jobId } = await previewAndConfirm(h, { ...sameIntent({ lead: 'CLUSDT' }), timeoutMs: 600_000 });
  await h.ex.tick();
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'short'), '7.14');
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'XAUUSDT', 'long'), '0');
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const done = await settle(h, jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.equal(done.market, 'goldoil');
  assert.deepEqual(done.legs.map(item => [item.symbol, item.filledQuantity]), [['CLUSDT', '7.14'], ['XAUUSDT', '0.188']]);
  assert.match(done.reason ?? '', /对冲腿按比例成交 0\.188/);
  assert.doesNotMatch(done.reason ?? '', /桶/);
  assert.deepEqual(h.ex.recentJobs(20, 'oil'), []);
}));
