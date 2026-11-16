// The H2 balance panel's pure logic (web/src/hynix-balance.ts, docs/hynix.md section 7): formatting, reading the state's
// balance defensively, suggestion and confirm wording, the threshold form and the rebalance preview body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed2, followsServer, netText, percent2, readBalance, rebalanceConfirmText, rebalanceIntent, settingsFormError, suggestionText, suggestionUsable, usdt2 } from '../web/src/hynix-balance.ts';

test('金额与占比：两位小数，按十进制字符串四舍五入，不丢大数精度；空值与非数字显示破折号', () => {
  assert.equal(fixed2('52.02'), '52.02');
  assert.equal(fixed2('412.2'), '412.20');
  assert.equal(fixed2('12.620087336244541484'), '12.62');
  assert.equal(fixed2('0.125'), '0.13');
  assert.equal(fixed2('0.124999'), '0.12');
  assert.equal(fixed2('99.995'), '100.00');
  assert.equal(fixed2('5'), '5.00');
  assert.equal(fixed2('0'), '0.00');
  assert.equal(fixed2('-3.456'), '-3.46');
  assert.equal(fixed2('-0.001'), '0.00');
  assert.equal(fixed2('123456789012345678901.235'), '123456789012345678901.24');
  assert.equal(fixed2(1.5), '1.50');
  for (const bad of [null, undefined, '', 'abc', '1e5', '1.2.3', Number.NaN, Infinity]) assert.equal(fixed2(bad as never), '—');
  assert.equal(percent2('12.620087'), '12.62%');
  assert.equal(percent2(null), '—');
  assert.equal(usdt2('360.18'), '360.18 USDT');
  assert.equal(usdt2('x'), '—');
});

test('净敞口与建议文案：净多 / 净空 / 两腿相等；减仓平较大一腿、加仓加较小一腿；不提供时写原因', () => {
  assert.equal(netText('52.02', 'short'), '52.02 USDT · 净空');
  assert.equal(netText('1', 'long'), '1.00 USDT · 净多');
  assert.equal(netText('0', null), '0.00 USDT · 两腿相等');
  const reduce = { symbol: 'SKHYUSDT', side: 'short' as const, action: 'close' as const, quantity: '1.26' };
  const add = { symbol: 'SKHYNIXUSDT', side: 'long' as const, action: 'open' as const, quantity: '0.129' };
  assert.equal(suggestionText('reduce', reduce), '减仓调平：平 1.26 份 ADR 空头');
  assert.equal(suggestionText('add', add), '加仓调平：加 0.129 股正股多头');
  assert.equal(suggestionText('add', { error: '不足最小下单量' }), '加仓调平：不提供（不足最小下单量）');
  assert.equal(suggestionText('reduce', undefined), '减仓调平：不提供');
  assert.equal(suggestionUsable(reduce), true);
  assert.equal(suggestionUsable({ error: 'x' }), false);
  assert.equal(suggestionUsable(undefined), false);
});

test('读取 balance：旧服务没有时为 null；各状态按约定读出；形状不对的行显示为不可用，不抛错', () => {
  assert.equal(readBalance(undefined), null);
  assert.equal(readBalance({ settings: {} }), null);
  assert.equal(readBalance('x'), null);
  const view = readBalance({
    settings: { rebalancePercent: '2', hardPercent: '5', minGapUsdt: '50' }, settingsAvailable: true, settingsError: null,
    venues: [
      { venue: 'binance', positionsAt: 1, quotesAt: 2, status: 'paired', level: 'hard', gap: '52.02', netSide: 'short', percent: '12.6',
        long: { symbol: 'SKHYNIXUSDT', side: 'long', quantity: '0.9', price: '400.2', notional: '360.18' },
        short: { symbol: 'SKHYUSDT', side: 'short', quantity: '10', price: '41.22', notional: '412.2' },
        suggest: { reduce: { symbol: 'SKHYUSDT', side: 'short', action: 'close', quantity: '1.26' }, add: { error: '太小' } } },
      { venue: 'bybit', positionsAt: 1, quotesAt: 1, status: 'unpaired', reason: '只有单腿持仓，另一腿为空', legs: [{ symbol: 'SKHYUSDT', side: 'long', quantity: '1', price: '41.24', notional: '41.24' }], level: 'hard' },
      { venue: 'bybit', positionsAt: null, quotesAt: null, status: 'unavailable', reason: 'SKHYNIXUSDT 盘口已过期' },
      { venue: 'bybit', positionsAt: 1, quotesAt: 1, status: 'none', level: 'ok' },
      { venue: 'binance', status: 'paired', level: 'ok' },
      { venue: 'binance', status: 'mystery' },
      null,
    ],
  });
  assert.ok(view);
  assert.deepEqual(view.settings, { rebalancePercent: '2', hardPercent: '5', minGapUsdt: '50' });
  assert.equal(view.settingsAvailable, true);
  assert.deepEqual(view.venues.map(row => row.status), ['paired', 'unpaired', 'unavailable', 'none', 'unavailable', 'unavailable']);
  const paired = view.venues[0]!;
  assert.equal(paired.status, 'paired');
  if (paired.status === 'paired') {
    assert.equal(paired.netSide, 'short');
    assert.deepEqual(paired.suggest?.add, { error: '太小' });
    assert.equal(paired.suggest?.reduce && 'quantity' in paired.suggest.reduce ? paired.suggest.reduce.quantity : null, '1.26');
  }
  const unpaired = view.venues[1]!;
  assert.equal(unpaired.status === 'unpaired' && unpaired.legs.length, 1);
  assert.equal(view.venues[4]!.status === 'unavailable' && view.venues[4]!.reason, '读数不完整');
  const broken = readBalance({ settings: { rebalancePercent: '2', hardPercent: '5', minGapUsdt: '50' }, settingsAvailable: false, settingsError: '设置库打不开', venues: [] });
  assert.deepEqual([broken?.settingsAvailable, broken?.settingsError], [false, '设置库打不开']);
});

test('阈值表单：同服务的规则，给出中文原因；通过时去掉首尾空白', () => {
  assert.deepEqual(settingsFormError({ rebalancePercent: ' 3 ', hardPercent: '8.5', minGapUsdt: '100' }), { settings: { rebalancePercent: '3', hardPercent: '8.5', minGapUsdt: '100' } });
  assert.deepEqual(settingsFormError({ rebalancePercent: '0.1', hardPercent: '50', minGapUsdt: '0' }), { settings: { rebalancePercent: '0.1', hardPercent: '50', minGapUsdt: '0' } });
  const error = (rebalancePercent: string, hardPercent: string, minGapUsdt: string) => { const result = settingsFormError({ rebalancePercent, hardPercent, minGapUsdt }); return 'error' in result ? result.error : null; };
  assert.equal(error('0.05', '5', '50'), '调平线不能低于 0.1%');
  assert.equal(error('0.123', '5', '50'), '调平线须为 0.1–50 之间的数，最多两位小数');
  assert.equal(error('0', '5', '50'), '调平线不能低于 0.1%');
  assert.equal(error('2', '60', '50'), '硬上限不能高于 50%');
  assert.equal(error('2', '50.5', '50'), '硬上限不能高于 50%');
  assert.equal(error('5', '5', '50'), '调平线须低于硬上限');
  assert.equal(error('6', '5', '50'), '调平线须低于硬上限');
  assert.equal(error('2', '5', '100000.01'), '最小差额不能高于 100000 USDT');
  assert.equal(error('2', '5', '1000000'), '最小差额须为 0–100000 USDT，最多两位小数');
  assert.equal(error('2', 'abc', '50'), '硬上限须为 0.1–50 之间的数，最多两位小数');
  assert.equal(error('2', '5', '-1'), '最小差额须为 0–100000 USDT，最多两位小数');
  assert.equal(error('02', '5', '50'), '调平线须为 0.1–50 之间的数，最多两位小数');
});

test('表单跟随服务端：有未保存修改时不跟随；保存后只认保存之后取得的读数（L089）', () => {
  assert.equal(followsServer(false, null, 100), true);
  assert.equal(followsServer(true, null, 100), false);
  assert.equal(followsServer(false, 200, 150), false);
  assert.equal(followsServer(false, 200, 200), false);
  assert.equal(followsServer(false, 200, 201), true);
  assert.equal(followsServer(false, 200, null), false);
});

test('调平预览请求不带合约、方向与数量，执行参数固定；确认文案写清合约、方向、数量、价格保护界限与金额，缺字段不抛错', () => {
  assert.deepEqual(rebalanceIntent('binance', 'reduce'), { market: 'hynix', preset: 'rebalance', venue: 'binance', method: 'reduce', timeoutMs: 60_000 });
  const preview = {
    intent: { market: 'hynix' as const, preset: 'rebalance' as const, venue: 'binance', method: 'reduce' as const, timeoutMs: 60_000 },
    legs: [{ index: 0, venue: 'binance', symbol: 'SKHYUSDT', side: 'short', orderSide: 'buy', quantity: '1.26', orderType: 'market', reduceOnly: true, accountId: 'BN1001', accountMode: 'standard', priceBound: '41.44', instrument: { contractSize: '1', quantityStep: '0.01' }, quote: { bid: '41.2', ask: '41.24', receivedAt: 0 } }],
    notional: '52.07',
  };
  assert.equal(rebalanceConfirmText(preview), '实盘减仓调平：平 Binance ADR 空头 1.26（只减仓），以价格保护界限 41.44 为 IOC 限价、未成交部分撤销，名义金额约 52.07 USDT，60 秒内完成。确定发送到交易所？');
  assert.equal(rebalanceConfirmText({ ...preview, intent: { ...preview.intent, method: 'add' }, legs: [{ ...preview.legs[0]!, symbol: 'SKHYNIXUSDT', side: 'long', quantity: '0.129', reduceOnly: false }] }),
    '实盘加仓调平：加 Binance 正股 多头 0.129，以价格保护界限 41.44 为 IOC 限价、未成交部分撤销，名义金额约 52.07 USDT，60 秒内完成。确定发送到交易所？');
  assert.equal(rebalanceConfirmText({ intent: undefined, legs: [], notional: undefined } as never), '实盘减仓调平：调平委托，名义金额约 — USDT，60 秒内完成。确定发送到交易所？');
});
