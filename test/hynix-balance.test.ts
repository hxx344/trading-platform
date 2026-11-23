// SK hynix leg balance (docs/hynix.md section 7): the notional gap of the two legs, its level against the settings and
// the one order that levels it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../src/contracts.ts';
import { DEFAULT_BALANCE_SETTINGS, balanceLevel, pairBalance, parseBalanceSettings, rebalanceOrder, rebalanceStillFits, type HeldContract, type PairBalance } from '../src/hynix/balance.ts';

const adr = (long: string, short: string, price = '125.74'): HeldContract => ({ symbol: 'SKHYUSDT', long, short, price, contractSize: '1' });
const ordinary = (long: string, short: string, price = '843.6'): HeldContract => ({ symbol: 'SKHYNIXUSDT', long, short, price, contractSize: '1' });
const RULES = { SKHYUSDT: { contractSize: '1', quantityStep: '0.01', minQuantity: '0.01' }, SKHYNIXUSDT: { contractSize: '1', quantityStep: '0.001', minQuantity: '0.001' } };
const paired = (value: PairBalance) => { assert.equal(value.status, 'paired'); return value as Extract<PairBalance, { status: 'paired' }>; };

test('两腿名义：差额按较大一腿计百分比；空头较大时净空，减仓减空头腿、加仓加多头腿，数量向下取整不越过平衡点', () => {
  // Long 61.5 ordinary at 843.6 = 51881.4; short 430.28 ADR at 125.74 = 54103.4072.
  const balance = paired(pairBalance(adr('0', '430.28'), ordinary('61.5', '0')));
  assert.equal(balance.long.notional, '51881.4');
  assert.equal(balance.short.notional, '54103.4072');
  assert.equal(balance.gap, '2222.0072');
  assert.equal(balance.netSide, 'short');
  assert.equal(balance.percent.slice(0, 6), '4.1069');
  assert.equal(balanceLevel(balance, DEFAULT_BALANCE_SETTINGS), 'rebalance');
  assert.equal(balanceLevel(balance, { ...DEFAULT_BALANCE_SETTINGS, hardPercent: '4' }), 'hard');
  assert.equal(balanceLevel(balance, { ...DEFAULT_BALANCE_SETTINGS, rebalancePercent: '4.2' }), 'ok');
  assert.equal(balanceLevel(balance, { ...DEFAULT_BALANCE_SETTINGS, minGapUsdt: '3000' }), 'ok');
  // 2222.0072 ÷ 125.74 = 17.671…: 17.67 ADR closes of the short; ÷ 843.6 = 2.6339…: 2.633 ordinary more of the long.
  assert.deepEqual(rebalanceOrder(balance, 'reduce', RULES), { symbol: 'SKHYUSDT', side: 'short', action: 'close', quantity: '17.67' });
  assert.deepEqual(rebalanceOrder(balance, 'add', RULES), { symbol: 'SKHYNIXUSDT', side: 'long', action: 'open', quantity: '2.633' });
  // Neither order crosses the balance point at these prices.
  assert.ok(17.67 * 125.74 <= 2222.0072 && 2.633 * 843.6 <= 2222.0072);
});

test('两腿名义：多头较大时净多；合约乘数计入名义；相等时无需调平；差额不足最小下单量时说明原因', () => {
  const balance = paired(pairBalance(adr('100', '0', '40'), { ...ordinary('0', '0.9', '400'), contractSize: '10' }));
  assert.deepEqual([balance.long.notional, balance.short.notional, balance.gap, balance.netSide, balance.percent], ['4000', '3600', '400', 'long', '10']);
  assert.deepEqual(rebalanceOrder(balance, 'reduce', RULES), { symbol: 'SKHYUSDT', side: 'long', action: 'close', quantity: '10' });
  assert.deepEqual(rebalanceOrder(balance, 'add', { ...RULES, SKHYNIXUSDT: { contractSize: '10', quantityStep: '0.001', minQuantity: '0.001' } }), { symbol: 'SKHYNIXUSDT', side: 'short', action: 'open', quantity: '0.1' });
  const level = paired(pairBalance(adr('10', '0', '40'), ordinary('0', '1', '400')));
  assert.deepEqual([level.gap, level.netSide, level.percent], ['0', null, '0']);
  assert.deepEqual(rebalanceOrder(level, 'reduce', RULES), { error: '两腿名义金额已相等，无需调平' });
  const small = paired(pairBalance(adr('10', '0', '40'), ordinary('0', '1', '399.9')));
  assert.match((rebalanceOrder(small, 'reduce', { ...RULES, SKHYUSDT: { contractSize: '1', quantityStep: '0.01', minQuantity: '1' } }) as { error: string }).error, /不足 SKHYUSDT 最小下单量 1/);
  assert.equal(balanceLevel(small, DEFAULT_BALANCE_SETTINGS), 'ok');
});

test('两腿名义：没有持仓、单腿、同向、同一合约双向都不算成对；不成对按硬上限处理', () => {
  assert.deepEqual(pairBalance(adr('0', '0'), ordinary('0', '0')), { status: 'none' });
  assert.equal(balanceLevel({ status: 'none' }, DEFAULT_BALANCE_SETTINGS), 'ok');
  const single = pairBalance(adr('0', '430.28'), ordinary('0', '0'));
  assert.equal(single.status, 'unpaired');
  assert.match((single as { reason: string }).reason, /只有单腿/);
  assert.equal(balanceLevel(single, DEFAULT_BALANCE_SETTINGS), 'hard');
  assert.match((pairBalance(adr('0', '430.28'), ordinary('0', '61.5')) as { reason: string }).reason, /方向相同/);
  assert.match((pairBalance(adr('1', '430.28'), ordinary('61.5', '0')) as { reason: string }).reason, /同时持有多头与空头/);
});

test('平衡设置：调平线 0.1 起且低于硬上限，硬上限不超过 50，最小差额 0–100000，最多两位小数，不收多余字段', () => {
  assert.deepEqual(parseBalanceSettings({ rebalancePercent: '2.0', hardPercent: '5', minGapUsdt: '50.50' }), { rebalancePercent: '2', hardPercent: '5', minGapUsdt: '50.5' });
  const refused = (value: unknown) => assert.throws(() => parseBalanceSettings(value), (error: unknown) => error instanceof ContractError);
  refused({ rebalancePercent: '0.05', hardPercent: '5', minGapUsdt: '50' });
  refused({ rebalancePercent: '5', hardPercent: '5', minGapUsdt: '50' });
  refused({ rebalancePercent: '2', hardPercent: '50.01', minGapUsdt: '50' });
  refused({ rebalancePercent: '2', hardPercent: '5', minGapUsdt: '100000.01' });
  refused({ rebalancePercent: '2.001', hardPercent: '5', minGapUsdt: '50' });
  refused({ rebalancePercent: 2, hardPercent: '5', minGapUsdt: '50' });
  refused({ rebalancePercent: '2', hardPercent: '5', minGapUsdt: '-1' });
  refused({ rebalancePercent: '2', hardPercent: '5', minGapUsdt: '50', extra: 1 });
  refused({ rebalancePercent: '2', hardPercent: '5' });
});

test('发送前复核：确认张数的名义不超过当前差额 1.5 倍且合约、方向仍对得上时才算相容', () => {
  // 4000 against 3600: gap 400, so 600 of notional is the limit on either leg.
  for (const [net, other] of [['short', 'long'], ['long', 'short']] as const) {
    const balance = pairBalance(net === 'short' ? adr('0', '100', '40') : adr('100', '0', '40'), net === 'short' ? ordinary('9', '0', '400') : ordinary('0', '9', '400'));
    const fits = (method: 'reduce' | 'add', symbol: string, side: 'long' | 'short', quantity: string) => rebalanceStillFits(balance, method, { symbol, side, quantity }, '1');
    assert.deepEqual([fits('reduce', 'SKHYUSDT', net, '10'), fits('reduce', 'SKHYUSDT', net, '15'), fits('reduce', 'SKHYUSDT', net, '15.01')], [true, true, false], net);
    assert.deepEqual([fits('add', 'SKHYNIXUSDT', other, '1'), fits('add', 'SKHYNIXUSDT', other, '1.5'), fits('add', 'SKHYNIXUSDT', other, '1.501')], [true, true, false], net);
    // The method now points at the other contract or the other side: the net direction changed since the preview.
    assert.deepEqual([fits('reduce', 'SKHYNIXUSDT', other, '0.1'), fits('add', 'SKHYUSDT', net, '1'), fits('reduce', 'SKHYUSDT', other, '1'), fits('add', 'SKHYNIXUSDT', net, '0.1')], [false, false, false, false], net);
  }
  // The contract size counts: 0.15 × 10 × 400 = 600.
  const sized = pairBalance(adr('100', '0', '40'), { ...ordinary('0', '0.9', '400'), contractSize: '10' });
  assert.deepEqual(['0.15', '0.151'].map(quantity => rebalanceStillFits(sized, 'add', { symbol: 'SKHYNIXUSDT', side: 'short', quantity }, '10')), [true, false]);
  const order = { symbol: 'SKHYUSDT', side: 'long', quantity: '0.01' } as const;
  assert.equal(rebalanceStillFits(pairBalance(adr('10', '0', '40'), ordinary('0', '1', '400')), 'reduce', order, '1'), false);
  assert.equal(rebalanceStillFits(pairBalance(adr('0', '0'), ordinary('0', '0')), 'reduce', order, '1'), false);
  assert.equal(rebalanceStillFits(pairBalance(adr('10', '0', '40'), ordinary('0', '0')), 'reduce', order, '1'), false);
});
