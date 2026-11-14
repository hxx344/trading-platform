// The oil page's form → intent conversion and job action rules (web/src/oil-form.ts): every intent it builds passes the
// executor's own parseIntent with the legs the form meant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../src/contracts.ts';
import { DEFAULT_FORM, describeIntent, formToIntent, jobActions, type OilForm } from '../web/src/oil-form.ts';

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
  const parsed = parseIntent(long);
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
  const cross = build({ preset: 'cross-exchange', venue: 'bybit', symbol: 'CLUSDT', leadSide: 'short', barrels: '2.5' });
  assert.deepEqual(cross, { market: 'oil', preset: 'cross-exchange', symbol: 'CLUSDT', action: 'open', timeoutMs: 60_000, legs: [
    { venue: 'bybit', side: 'short', orderType: 'market', barrels: '2.5' },
    { venue: 'binance', side: 'long', orderType: 'market', barrels: '2.5' },
  ] });
  assert.equal(describeIntent(cross), '开仓 跨所 CLUSDT：Bybit 空 CL / Binance 多 CL');
  assert.equal(parseIntent(cross).symbol, 'CLUSDT');
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
  const parsed = parseIntent(chase);
  assert.deepEqual([parsed.legs[0].orderType, parsed.legs[0].limitPrice, parsed.batches], ['local-chase', '70.5', { count: 3, intervalMs: 10_000 }]);
  // No bound typed: the preview's price protection bound; one batch sends no batches field.
  const plain = build({ leadOrderType: 'local-chase' });
  assert.equal('limitPrice' in plain.legs[0], false);
  assert.equal('batches' in plain, false);
  assert.equal(parseIntent(plain).legs[0].orderType, 'local-chase');
  assert.equal('limitPrice' in build({ leadOrderType: 'market', chaseLimit: '70' }).legs[0], false, '只有本地追价带界限');
  assert.deepEqual(build({ batchCount: '2', batchIntervalSeconds: '' }).batches, { count: 2, intervalMs: 0 });

  const error = (patch: Partial<OilForm>) => { const result = formToIntent({ ...DEFAULT_FORM, barrels: '10', ...patch }); return 'error' in result ? result.error : null; };
  assert.match(error({ leadOrderType: 'local-chase', venue: 'bybit' }) ?? '', /只用于 Binance/);
  assert.match(error({ leadOrderType: 'local-chase', chaseLimit: '-1' }) ?? '', /追价界限/);
  for (const batchCount of ['0', '21', '1.5', '']) assert.match(error({ batchCount }) ?? '', /1–20/, batchCount);
  assert.match(error({ batchCount: '2', batchIntervalSeconds: '601' }) ?? '', /0–600/);
  assert.match(error({ venue: 'bybit', leadOrderType: 'chase', batchCount: '2' }) ?? '', /分批只用于/);
  assert.match(error({ batchCount: '3', batchIntervalSeconds: '30' }) ?? '', /短于最长执行时间/);
  assert.equal(error({ batchCount: '3', batchIntervalSeconds: '29' }), null);
});
