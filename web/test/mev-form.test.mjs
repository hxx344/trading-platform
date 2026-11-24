// MEV 套利页不依赖 DOM 的部分（web/src/mev/mev-form.ts）：页签地址、读数格式、风控参数表单到请求、开始实盘的确认文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, parseSettings } from '../../src/mev/risk.ts';
import {
  MEV_TABS, SETTING_FIELDS, SETTING_GROUPS, TX_STATUS_LABELS, age, bps, compactUsd, eth, feePercent, mevHref, outcomeTone, settingsChanged, settingsForm, settingsRequest, shortAddress, startBlocker, startConfirmText, tokenAmount, txTone, usd,
} from '../src/mev/mev-form.ts';
import { parseRoute } from '../src/route-parse.ts';

const OPERATOR = '0x00000000000000000000000000000000000000a1', EXECUTOR = '0x00000000000000000000000000000000004d4556', OWNER = '0x000000000000000000000000000000000000b0b0';
const view = (patch = {}) => ({
  operator: OPERATOR, executor: EXECUTOR, owner: OWNER, verification: { ok: true, reason: null, checkedAt: 1 }, head: { number: 10, ageSec: 1, baseFeeGwei: 0.01 }, lagging: false,
  wallet: { eth: 0.05, nonce: 3 }, settings: DEFAULT_SETTINGS, fault: null, haltReason: null, ...patch,
});

test('每个页签的地址都能解析回这个页签，不认识的子地址不落在本页', () => {
  for (const { id } of MEV_TABS) assert.deepEqual(parseRoute(mevHref(id)), { page: 'mev', tab: id });
  assert.equal(mevHref('overview'), '#/mev');
  assert.notEqual(parseRoute('#/mev/other').page, 'mev');
  assert.notEqual(parseRoute('#/mevx').page, 'mev');
});

test('参数表单覆盖全部参数，默认值往返不变，服务端接受页面生成的请求', () => {
  assert.deepEqual(SETTING_FIELDS.map(field => field.key).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  for (const field of SETTING_FIELDS) assert.ok(SETTING_GROUPS.some(group => group.id === field.group), field.key);
  const form = settingsForm(DEFAULT_SETTINGS);
  for (const text of Object.values(form)) assert.match(text, /^\d+(\.\d+)?$/);
  assert.equal(form.tipShare, String(Number((DEFAULT_SETTINGS.tipShare * 100).toPrecision(12))), '比例按百分数显示');
  const request = settingsRequest(form);
  assert.ok(request.ok);
  assert.deepEqual(request.body.settings, DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings(request.body.settings), DEFAULT_SETTINGS);
  assert.equal(settingsChanged(form, DEFAULT_SETTINGS), false);
  assert.equal(settingsChanged({ ...form, minNetUsd: ` ${form.minNetUsd} ` }, DEFAULT_SETTINGS), false, '首尾空白不算改动');
  assert.equal(settingsChanged({ ...form, minNetUsd: '9' }, DEFAULT_SETTINGS), true);
  const changed = settingsRequest({ ...form, tipShare: '33.3', minNetUsd: '0.75' });
  assert.ok(changed.ok);
  assert.equal(changed.body.settings.tipShare, 0.333);
  assert.equal(changed.body.settings.minNetUsd, 0.75);
});

test('参数表单拒绝空、负数、科学计数与非数字，报出是哪一项', () => {
  const form = settingsForm(DEFAULT_SETTINGS);
  for (const bad of ['', '-1', '1e3', 'abc', '1.', '.5', '+2', '1,000']) assert.deepEqual(settingsRequest({ ...form, minNetUsd: bad }), { ok: false, message: '最低净利须为不带符号的数字' }, bad);
  assert.deepEqual(settingsRequest({ ...form, maxGasLimit: 'x', minNetUsd: 'y' }), { ok: false, message: '最低净利须为不带符号的数字' }, '报第一处');
});

test('开始实盘：核对未过、未读到链上状态、区块落后、余额不足时给出原因', () => {
  assert.equal(startBlocker(view()), null);
  assert.equal(startBlocker(view({ verification: { ok: false, reason: '执行合约的链上代码与本仓库的产物不一致', checkedAt: 1 } })), '执行合约的链上代码与本仓库的产物不一致');
  assert.equal(startBlocker(view({ verification: { ok: false, reason: null, checkedAt: 1 } })), '合约核对未通过');
  assert.equal(startBlocker(view({ head: null })), '还没有读到链上状态');
  assert.equal(startBlocker(view({ wallet: null })), '还没有读到链上状态');
  assert.equal(startBlocker(view({ lagging: true })), '节点的最新区块落后');
  assert.match(startBlocker(view({ wallet: { eth: DEFAULT_SETTINGS.minWalletEth / 2, nonce: 0 } })), /^热钱包余额 .* ETH 低于下限 /);
});

test('确认文案带热钱包、合约、收款地址与额度；有故障记录或停止原因时一并给出', () => {
  const text = startConfirmText(view());
  for (const part of [OPERATOR, EXECUTOR, OWNER, '0.050000 ETH', `每日 gas 预算 ${DEFAULT_SETTINGS.dailyGasBudgetEth} ETH`, '花费真实的 gas']) assert.ok(text.includes(part), part);
  assert.ok(text.endsWith('确认开始？'));
  assert.ok(!text.includes('故障') && !text.includes('上次'));
  assert.ok(startConfirmText(view({ fault: 'nonce 被外部交易占用', haltReason: '连续回滚' })).includes('上次的故障记录将被清除：nonce 被外部交易占用'));
  assert.ok(startConfirmText(view({ haltReason: '连续 3 笔上链回滚' })).includes('上次停止的原因：连续 3 笔上链回滚'));
});

test('读数格式', () => {
  assert.equal(usd(1234.5), '$1,234.50');
  assert.equal(usd(-0.126), '-$0.13');
  assert.equal(usd(null), '—');
  assert.equal(usd(Number.NaN), '—');
  assert.deepEqual([compactUsd(950), compactUsd(12_340), compactUsd(4_500_000), compactUsd(2.5e9), compactUsd(undefined)], ['$950', '$12.3k', '$4.50M', '$2.50B', '—']);
  assert.equal(eth(0.0123456789), '0.012346 ETH');
  assert.equal(eth(null), '—');
  assert.equal(bps(12.345), '12.35');
  assert.equal(bps(Number.POSITIVE_INFINITY), '—');
  assert.deepEqual([feePercent(500), feePercent(3000), feePercent(85)], ['0.05%', '0.30%', '0.0085%']);
  assert.equal(tokenAmount('1.230000000000000000', 'WETH'), '1.23 WETH');
  assert.equal(tokenAmount('12.000000', 'USDC'), '12 USDC');
  assert.equal(tokenAmount('0.123456789123', ''), '0.12345678');
  assert.equal(tokenAmount(null, 'WETH'), '—');
  assert.equal(shortAddress(EXECUTOR), '0x0000…4556');
  assert.equal(shortAddress('0x12'), '0x12');
  const now = 1_800_000_000_000;
  assert.deepEqual([age(null, now), age(now - 30_000, now), age(now + 5_000, now), age(now - 600_000, now), age(now - 7_200_000, now), age(now - 3 * 86_400_000, now)], ['—', '30 秒前', '0 秒前', '10 分钟前', '2 小时前', '3 天前']);
});

test('每种交易状态都有文案与色调', () => {
  for (const status of ['recorded', 'sent', 'unknown', 'expired', 'success', 'reverted', 'replaced', 'lost']) assert.ok(TX_STATUS_LABELS[status], status);
  assert.deepEqual(['success', 'reverted', 'lost', 'unknown', 'expired', 'replaced', 'sent', 'recorded'].map(status => txTone(status)), ['ok', 'bad', 'bad', 'warn', 'warn', '', 'info', 'info']);
  assert.deepEqual(['sent', 'blocked', 'observed', 'thin'].map(outcome => outcomeTone(outcome)), ['ok', 'warn', 'info', '']);
});
