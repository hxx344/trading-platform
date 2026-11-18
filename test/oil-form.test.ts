// The oil page's form → intent conversion and job action rules (web/src/oil-form.ts): every intent it builds passes the
// executor's own parseIntent with the legs the form meant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, parsePairIntent } from '../src/contracts.ts';
import { DEFAULT_FORM, describeIntent, formToIntent, hedgeVenueFor, jobActions, type OilForm } from '../web/src/oil-form.ts';

const build = (patch: Partial<OilForm>) => {
  const result = formToIntent({ ...DEFAULT_FORM, barrels: '10', ...patch });
  if ('error' in result) throw new Error(result.error);
  return result.intent;
};

test('原油下单表单：同所做多价差 = 多 BZ / 空 CL，首腿按所选合约，对冲腿市价；做空与平仓同样换算，通过执行器校验', () => {
  const long = build({});
  assert.deepEqual(long, { market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [
    { venue: 'binance', symbol: 'CLUSDT', side: 'short', orderType: 'market', barrels: '10' },
    { venue: 'binance', symbol: 'BZUSDT', side: 'long', orderType: 'market', barrels: '10' },
  ] });
  assert.equal(describeIntent(long), '开仓 Binance 做多价差：空 CL / 多 BZ');
  const parsed = parsePairIntent(long);
  assert.deepEqual(parsed.legs.map(leg => [leg.symbol, leg.side, leg.barrels]), [['CLUSDT', 'short', '10'], ['BZUSDT', 'long', '10']]);

  const short = build({ spread: 'short', leadSymbol: 'BZUSDT', action: 'close', venue: 'bybit', leadOrderType: 'chase', timeoutSeconds: '120', slippageBps: '25' });
  assert.deepEqual(short.legs, [
    { venue: 'bybit', symbol: 'BZUSDT', side: 'short', orderType: 'chase', barrels: '10' },
    { venue: 'bybit', symbol: 'CLUSDT', side: 'long', orderType: 'market', barrels: '10' },
  ]);
  assert.deepEqual([short.action, short.timeoutMs, short.maxSlippageBps], ['close', 120_000, 25]);
  assert.equal(describeIntent(short), '平仓 Bybit 做空价差：空 BZ / 多 CL');
  assert.equal(parseIntent(short).maxSlippageBps, 25);
});

test('原油下单表单：跨所同一合约，首腿交易所与方向由表单定，对冲腿去另一个交易所反向市价，通过执行器校验', () => {
  const cross = build({ preset: 'cross-exchange', venue: 'bybit', hedgeVenue: 'binance', symbol: 'CLUSDT', leadSide: 'short', barrels: '2.5' });
  assert.deepEqual(cross, { market: 'oil', preset: 'cross-exchange', symbol: 'CLUSDT', action: 'open', timeoutMs: 60_000, legs: [
    { venue: 'bybit', side: 'short', orderType: 'market', barrels: '2.5' },
    { venue: 'binance', side: 'long', orderType: 'market', barrels: '2.5' },
  ] });
  assert.equal(describeIntent(cross), '开仓 跨所 CLUSDT：Bybit 空 CL / Binance 多 CL');
  assert.equal(parsePairIntent(cross).symbol, 'CLUSDT');
});

test('原油下单表单（OKX）：同所两腿与跨所任选两所，OKX 首腿可本地追价、不可追价策略；对冲腿须在另一所', () => {
  const same = build({ venue: 'okx', leadOrderType: 'local-chase', chaseLimit: '70.1' });
  assert.deepEqual(same.legs.map(leg => [leg.venue, leg.symbol, leg.orderType]), [['okx', 'CLUSDT', 'local-chase'], ['okx', 'BZUSDT', 'market']]);
  assert.equal((parseIntent(same) as { legs: { venue: string }[] }).legs[0]!.venue, 'okx');
  const cross = build({ preset: 'cross-exchange', venue: 'okx', hedgeVenue: 'bybit', symbol: 'BZUSDT', leadSide: 'long' });
  assert.deepEqual(cross.legs.map(leg => [leg.venue, leg.side]), [['okx', 'long'], ['bybit', 'short']]);
  assert.equal(describeIntent(cross), '开仓 跨所 BZUSDT：OKX 多 BZ / Bybit 空 BZ');
  assert.equal(parsePairIntent(cross).legs[1]!.venue, 'bybit');
  const error = (patch: Partial<OilForm>) => { const result = formToIntent({ ...DEFAULT_FORM, barrels: '10', ...patch }); return 'error' in result ? result.error : null; };
  assert.match(error({ venue: 'okx', leadOrderType: 'chase' }) ?? '', /只有 Bybit 支持；OKX 首腿/);
  assert.match(error({ preset: 'cross-exchange', venue: 'okx', hedgeVenue: 'okx' }) ?? '', /对冲腿须在另一个交易所/);
  assert.equal(hedgeVenueFor(['binance', 'bybit', 'okx'], 'okx', 'bybit'), 'bybit');
  assert.equal(hedgeVenueFor(['binance', 'bybit', 'okx'], 'bybit', 'bybit'), 'binance');
  assert.equal(hedgeVenueFor(['binance', 'okx'], 'binance', 'bybit'), 'okx');
  assert.equal(hedgeVenueFor(['okx'], 'okx', 'bybit'), null);
});

test('原油下单表单：桶数、执行时间、价格保护与 Binance 追价先在页面拒绝并说明', () => {
  const error = (patch: Partial<OilForm>) => { const result = formToIntent({ ...DEFAULT_FORM, barrels: '10', ...patch }); return 'error' in result ? result.error : null; };
  for (const barrels of ['', '0', '-1', '1e3', 'abc', '01', '1.123456789']) assert.match(error({ barrels }) ?? '', /桶数/, barrels);
  for (const timeoutSeconds of ['29', '3601', '60.5', '']) assert.match(error({ timeoutSeconds }) ?? '', /30–3600/, timeoutSeconds);
  for (const slippageBps of ['0', '1001', '2.5']) assert.match(error({ slippageBps }) ?? '', /1–1000/, slippageBps);
  assert.match(error({ leadOrderType: 'chase', venue: 'binance' }) ?? '', /只有 Bybit/);
  assert.equal(error({ slippageBps: '' }), null);
  assert.equal(error({ barrels: '0.1' }), null);
});

test('原油任务操作：运行中可停止；追价创建结果未知时给认领、确认未创建与强制释放；其余需人工处理且锁未释放时给释放合约', () => {
  const flags = { status: 'running', stopRequested: false, locked: true, strategyPending: false };
  assert.deepEqual(jobActions(flags), { stop: true, strategy: false, acknowledge: false });
  assert.deepEqual(jobActions({ ...flags, stopRequested: true }), { stop: false, strategy: false, acknowledge: false });
  assert.deepEqual(jobActions({ ...flags, status: 'accepted' }).stop, true);
  assert.deepEqual(jobActions({ ...flags, status: 'attention', strategyPending: true }), { stop: false, strategy: true, acknowledge: false });
  assert.deepEqual(jobActions({ ...flags, status: 'attention' }), { stop: false, strategy: false, acknowledge: true });
  assert.deepEqual(jobActions({ ...flags, status: 'attention', locked: false }), { stop: false, strategy: false, acknowledge: false });
  for (const status of ['completed', 'failed', 'stopped']) assert.deepEqual(jobActions({ ...flags, status }), { stop: false, strategy: false, acknowledge: false });
});

test('原油下单表单：本地追价只给 Binance 首腿，可填追价界限；分批只用于市价与本地追价，通过执行器校验', () => {
  const chase = build({ preset: 'cross-exchange', venue: 'binance', symbol: 'CLUSDT', leadOrderType: 'local-chase', chaseLimit: ' 70.5 ', batchCount: '3', batchIntervalSeconds: '10' });
  assert.deepEqual(chase.legs[0], { venue: 'binance', side: 'long', orderType: 'local-chase', barrels: '10', limitPrice: '70.5' });
  assert.deepEqual(chase.batches, { count: 3, intervalMs: 10_000 });
  const parsed = parsePairIntent(chase);
  assert.deepEqual([parsed.legs[0].orderType, parsed.legs[0].limitPrice, parsed.batches], ['local-chase', '70.5', { count: 3, intervalMs: 10_000 }]);
  // No bound typed: the preview's price protection bound; one batch sends no batches field.
  const plain = build({ leadOrderType: 'local-chase' });
  assert.equal('limitPrice' in plain.legs[0], false);
  assert.equal('batches' in plain, false);
  assert.equal(parsePairIntent(plain).legs[0].orderType, 'local-chase');
  assert.equal('limitPrice' in build({ leadOrderType: 'market', chaseLimit: '70' }).legs[0], false, '只有本地追价带界限');
  assert.deepEqual(build({ batchCount: '2', batchIntervalSeconds: '' }).batches, { count: 2, intervalMs: 0 });

  const error = (patch: Partial<OilForm>) => { const result = formToIntent({ ...DEFAULT_FORM, barrels: '10', ...patch }); return 'error' in result ? result.error : null; };
  assert.match(error({ leadOrderType: 'local-chase', venue: 'bybit' }) ?? '', /只用于 Binance 或 OKX/);
  assert.match(error({ leadOrderType: 'local-chase', chaseLimit: '-1' }) ?? '', /追价界限/);
  for (const batchCount of ['0', '21', '1.5', '']) assert.match(error({ batchCount }) ?? '', /1–20/, batchCount);
  assert.match(error({ batchCount: '2', batchIntervalSeconds: '601' }) ?? '', /0–600/);
  assert.match(error({ venue: 'bybit', leadOrderType: 'chase', batchCount: '2' }) ?? '', /分批只用于/);
  assert.match(error({ batchCount: '3', batchIntervalSeconds: '30' }) ?? '', /短于最长执行时间/);
  assert.equal(error({ batchCount: '3', batchIntervalSeconds: '29' }), null);
});

test('原油下单表单：对冲腿本地追价（Binance、OKX）带追价时限，通过执行器校验；Bybit 对冲腿、时限越界报错；四腿对冲腿仍为市价', async () => {
  const same = build({ hedgeOrderType: 'local-chase', hedgeChaseSeconds: '15' });
  assert.deepEqual(same.legs[1], { venue: 'binance', symbol: 'BZUSDT', side: 'long', orderType: 'local-chase', chaseTimeoutMs: 15_000, barrels: '10' });
  assert.equal(parsePairIntent(same).legs[1].chaseTimeoutMs, 15_000);
  const cross = build({ preset: 'cross-exchange', venue: 'bybit', hedgeVenue: 'okx', hedgeOrderType: 'local-chase' });
  assert.deepEqual(cross.legs[1], { venue: 'okx', side: 'short', orderType: 'local-chase', chaseTimeoutMs: 10_000, barrels: '10' });
  assert.equal(parsePairIntent(cross).legs[1].orderType, 'local-chase');
  const error = (patch: Partial<OilForm>) => { const result = formToIntent({ ...DEFAULT_FORM, barrels: '10', ...patch }); return 'error' in result ? result.error : null; };
  assert.match(error({ preset: 'cross-exchange', venue: 'binance', hedgeVenue: 'bybit', hedgeOrderType: 'local-chase' }) ?? '', /只用于 Binance 或 OKX/);
  assert.match(error({ hedgeOrderType: 'local-chase', hedgeChaseSeconds: '0' }) ?? '', /1–600 秒/);
  assert.match(error({ hedgeOrderType: 'local-chase', hedgeChaseSeconds: '601' }) ?? '', /1–600 秒/);
  assert.equal(error({ hedgeOrderType: 'market', hedgeChaseSeconds: '' }), null, '市价对冲不看时限字段');
  const { fourLegFormToIntent } = await import('../web/src/oil-form.ts');
  const four = fourLegFormToIntent({ ...DEFAULT_FORM, barrels: '10', preset: 'four-leg', venue: 'binance', hedgeVenue: 'okx', fourSpread: 'long', hedgeOrderType: 'local-chase' });
  assert.ok('intent' in four);
  assert.deepEqual(four.intent.legs.map(leg => leg.orderType), ['market', 'market', 'market', 'market']);
});
