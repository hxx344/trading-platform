import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONDO_MM_DEFAULTS, validateOndoMmConfig } from '../src/vendor/ondo/mm.mjs';
import { observeStartRequest, quoteConfigRequest, quoteStartRequest, quoteStopRequest } from '../web/src/ondo/quote-form.ts';
import { capitalUsd, netAprPct, readObservationCapital } from '../web/src/ondo/observation-form.ts';

test('Ondo 挂单表单与服务使用一致的开仓保护、持仓和退出范围', () => {
  for (const config of [
    ONDO_MM_DEFAULTS,
    { ...ONDO_MM_DEFAULTS, wallUsd: '0.0001', maxHoldSec: 1, maxLossBps: '0.1', exitSlippageBps: '0' },
    { ...ONDO_MM_DEFAULTS, wallUsd: '100000000', maxHoldSec: 86400, maxLossBps: '10000', exitSlippageBps: '1000', exitMode: 'makerThenManual' as const },
  ]) {
    const request = quoteConfigRequest(config);
    assert.ok('body' in request);
    assert.deepEqual(validateOndoMmConfig(request.body.config), config);
  }
  for (const patch of [{ wallEnabled: false }, { wallUsd: '0' }, { wallUsd: '1e4' }, { maxHoldSec: 1.1 }, { maxHoldSec: 86401 },
    { maxLossBps: '0.01' }, { maxLossBps: '20.12345' }, { exitSlippageBps: '-1' }, { exitSlippageBps: '1001' }]) {
    const config = { ...ONDO_MM_DEFAULTS, ...patch };
    assert.ok('error' in quoteConfigRequest(config));
    assert.throws(() => validateOndoMmConfig(config));
  }
});

test('Ondo 实盘仅对本次勾选的设置版本发送账户级撤单确认；观察不携带实盘授权', () => {
  assert.equal(quoteStartRequest('live', 3, null, true), null);
  assert.equal(quoteStartRequest('live', 3, 2, true), null);
  for (const adoptPositions of [true, false]) {
    assert.deepEqual(quoteStartRequest('live', 3, 3, adoptPositions), { revision: 3, confirmLive: true, confirmAccountWide: true, adoptPositions });
    assert.deepEqual(quoteStartRequest('observe', 3, 3, adoptPositions), { revision: 3 });
  }
});

test('Ondo 停止请求绑定所见会话和实盘标记；缺少活动会话就不能停止', () => {
  assert.equal(quoteStopRequest(null), null);
  assert.equal(quoteStopRequest({ phase: 'stopped', sessionId: null, live: false }), null);
  assert.equal(quoteStopRequest({ phase: 'running', sessionId: null, live: true }), null);
  assert.deepEqual(quoteStopRequest({ phase: 'running', sessionId: 'first', live: false }), { sessionId: 'first', live: false });
  assert.deepEqual(quoteStopRequest({ phase: 'stopping', sessionId: 'next', live: true }), { sessionId: 'next', live: true });
});

test('并行观察独立传入勾选市场与版本，实盘模式、空选、重复代码或超过二十个时拒绝', () => {
  const all = Array.from({ length: 20 }, (_, i) => `M${i}-USD.P`);
  assert.deepEqual(observeStartRequest('observe', 4, all), { revision: 4, observeMarkets: all });
  assert.equal(observeStartRequest('live', 4, all), null);
  for (const invalid of [[], [all[0]!, all[0]!], [...all, 'MORE-USD.P'], ['BTC']]) {
    assert.equal(observeStartRequest('observe', 4, invalid), null);
  }
});

test('单市场单档简单年化保留负收益和零值，缺净收益或分母无效时不展示', () => {
  assert.equal(netAprPct(1, 200), 182.5);
  assert.equal(netAprPct(-1, 400), -91.25);
  assert.equal(netAprPct(0, 200), 0);
  assert.equal(netAprPct(null, 200), null);
  assert.equal(netAprPct(1, 0), null);
  assert.equal(netAprPct(Number.NaN, 200), null);
  assert.equal(netAprPct(1, Number.POSITIVE_INFINITY), null);
  assert.equal(capitalUsd('.25'), 0.25);
  for (const text of ['', '0', '-1', 'NaN', 'Infinity', '0x10', '1e3']) assert.equal(capitalUsd(text), null);
});

test('浏览器可为下一次观察记住不同的本金，保留上次会话显示时的分母', () => {
  const last = { startedAt: 100, usd: 200 };
  assert.deepEqual(readObservationCapital(JSON.stringify({ input: '400', session: last })), { input: '400', session: last });
  assert.deepEqual(readObservationCapital(JSON.stringify({ input: '', session: last })), { input: null, session: last });
  assert.deepEqual(readObservationCapital(JSON.stringify({ input: '400', session: { startedAt: 100, usd: 0 } })), { input: '400', session: null });
  assert.deepEqual(readObservationCapital('{'), { input: null, session: null });
});
