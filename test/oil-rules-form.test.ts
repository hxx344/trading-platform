// The oil rules form (web/src/oil-rules-form.ts): what it sends is what the service accepts, and its refusals match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleConfig } from '../src/oil/rules.ts';
import { compareDecimal, conditionText, emptyRuleForm, heldText, ruleConfigOf, ruleFormOf } from '../web/src/oil-rules-form.ts';

test('自动规则表单：填好的表单转成服务端接受的参数，往返不变；阈值先后、桶数与次数在页面先拦', () => {
  const form = { ...emptyRuleForm('bybit'), name: ' 夜盘 ', openThreshold: ' 4.5', closeThreshold: '-0.25', size: '2' };
  const checked = ruleConfigOf(form);
  assert.ok('config' in checked);
  assert.deepEqual(parseRuleConfig(checked.config, ['bybit']), checked.config);
  assert.deepEqual(checked.config, { market: 'oil', name: '夜盘', venue: 'bybit', direction: 'short', openThreshold: '4.5', closeThreshold: '-0.25', barrels: '2', confirmSamples: 3, maxOpensPerDay: 3 });
  assert.deepEqual(ruleConfigOf(ruleFormOf(checked.config)), checked);
  const refusal = (patch: Partial<typeof form>) => { const result = ruleConfigOf({ ...form, ...patch }); return 'error' in result ? result.error : null; };
  assert.equal(refusal({ closeThreshold: '4.5' }), '做空价差时，平仓阈值须低于开仓阈值。');
  assert.equal(refusal({ direction: 'long' }), '做多价差时，平仓阈值须高于开仓阈值。');
  assert.equal(refusal({ openThreshold: '1e3' }), '开仓与平仓阈值须为十进制数，可为负数。');
  assert.equal(refusal({ size: '0.00' }), '请填写大于零的每腿桶数。');
  assert.equal(refusal({ confirmSamples: '31' }), '连续满足次数须为 1 至 30 的整数。');
  assert.equal(refusal({ maxOpensPerDay: '0' }), '每日最多开仓次数须为 1 至 50 的整数。');
  assert.equal(refusal({ openThreshold: '1000.01' }), '开仓与平仓阈值须在 -1000 至 1000 USDT/桶之间。');
  assert.equal(refusal({ size: '10000.5' }), '每腿桶数最多 10000 桶。');
  assert.equal(refusal({ name: 'a'.repeat(41) }), '规则名称最多 40 个字符，不能含控制字符。');
  assert.equal(refusal({ name: 'a\tb' }), '规则名称最多 40 个字符，不能含控制字符。');
  // At the bounds the page and the service agree.
  const edge = ruleConfigOf({ ...form, name: 'n'.repeat(40), openThreshold: '1000', closeThreshold: '-1000', size: '10000' });
  assert.ok('config' in edge);
  assert.deepEqual(parseRuleConfig(edge.config, ['bybit']), edge.config);
  assert.deepEqual([compareDecimal('-0.1', '-0.10'), compareDecimal('-1', '0.5'), compareDecimal('2.000000000000000001', '2')], [0, -1, 1]);
});

test('自动规则表单：海力士按 % 与每腿 USDT，分批 1–20 批与间隔，与服务端一致', () => {
  const form = { ...emptyRuleForm('binance', 'hynix'), openThreshold: '3', closeThreshold: '0.5', size: '1000', batchCount: '4', batchIntervalSeconds: '30' };
  const checked = ruleConfigOf(form);
  assert.ok('config' in checked, JSON.stringify(checked));
  assert.deepEqual(checked.config, { market: 'hynix', name: '', venue: 'binance', direction: 'short', openThreshold: '3', closeThreshold: '0.5', notional: '1000', confirmSamples: 3, maxOpensPerDay: 3, batches: { count: 4, intervalMs: 30_000 } });
  assert.deepEqual(parseRuleConfig(checked.config, ['binance']), checked.config);
  assert.deepEqual(ruleConfigOf(ruleFormOf(checked.config)), checked);
  assert.equal(conditionText(checked.config), '开仓：溢价 ≥ 3 % · 平仓：溢价 ≤ 0.5 %');
  const refusal = (patch: Partial<typeof form>) => { const result = ruleConfigOf({ ...form, ...patch }); return 'error' in result ? result.error : null; };
  assert.equal(refusal({ closeThreshold: '-99.5' }), '开仓与平仓阈值须在 -99 至 1000 %之间。');
  assert.equal(refusal({ closeThreshold: '3' }), '做空溢价时，平仓阈值须低于开仓阈值。');
  assert.equal(refusal({ size: '1000000.01' }), '每腿名义金额最多 1000000 USDT。');
  assert.equal(refusal({ batchCount: '21' }), '批次数须为 1 至 20 的整数。');
  assert.equal(refusal({ batchIntervalSeconds: '601' }), '批次间隔须为 0 至 600 秒的整数。');
  // 60 s plus 19 intervals of 600 s is over the hour: the page refuses what the service would.
  assert.match(refusal({ batchCount: '20', batchIntervalSeconds: '600' })!, /不能超过 3600 秒/);
  assert.throws(() => parseRuleConfig({ ...checked.config, batches: { count: 20, intervalMs: 600_000 } }, ['binance']), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'batch_timeout');
  // One batch sends none (the stored rule reads as before); the interval is ignored then.
  const single = ruleConfigOf({ ...form, batchCount: '1', batchIntervalSeconds: '' });
  assert.ok('config' in single && !('batches' in single.config));
  assert.equal(heldText([{ symbol: 'SKHYUSDT', side: 'short', quantity: '2.42', barrels: '2.42' }, { symbol: 'SKHYNIXUSDT', side: 'long', quantity: '0.249', barrels: '0.249' }], 'hynix'), 'ADR 空 2.42 · 正股 多 0.249');
});
