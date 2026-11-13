// The oil rules form (web/src/oil-rules-form.ts): what it sends is what the service accepts, and its refusals match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleConfig } from '../src/oil/rules.ts';
import { compareDecimal, emptyRuleForm, ruleConfigOf, ruleFormOf } from '../web/src/oil-rules-form.ts';

test('自动规则表单：填好的表单转成服务端接受的参数，往返不变；阈值先后、桶数与次数在页面先拦', () => {
  const form = { ...emptyRuleForm('bybit'), name: ' 夜盘 ', openThreshold: ' 4.5', closeThreshold: '-0.25', barrels: '2' };
  const checked = ruleConfigOf(form);
  assert.ok('config' in checked);
  assert.deepEqual(parseRuleConfig(checked.config, ['bybit']), checked.config);
  assert.deepEqual(checked.config, { name: '夜盘', venue: 'bybit', direction: 'short', openThreshold: '4.5', closeThreshold: '-0.25', barrels: '2', confirmSamples: 3, maxOpensPerDay: 3 });
  assert.deepEqual(ruleConfigOf(ruleFormOf(checked.config)), checked);
  const refusal = (patch: Partial<typeof form>) => { const result = ruleConfigOf({ ...form, ...patch }); return 'error' in result ? result.error : null; };
  assert.equal(refusal({ closeThreshold: '4.5' }), '做空价差时，平仓阈值须低于开仓阈值。');
  assert.equal(refusal({ direction: 'long' }), '做多价差时，平仓阈值须高于开仓阈值。');
  assert.equal(refusal({ openThreshold: '1e3' }), '开仓与平仓阈值须为十进制数，可为负数。');
  assert.equal(refusal({ barrels: '0.00' }), '请填写大于零的每腿桶数。');
  assert.equal(refusal({ confirmSamples: '31' }), '连续满足次数须为 1 至 30 的整数。');
  assert.equal(refusal({ maxOpensPerDay: '0' }), '每日最多开仓次数须为 1 至 50 的整数。');
  assert.deepEqual([compareDecimal('-0.1', '-0.10'), compareDecimal('-1', '0.5'), compareDecimal('2.000000000000000001', '2')], [0, -1, 1]);
});
