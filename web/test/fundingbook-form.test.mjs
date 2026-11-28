// 资金费组合页不依赖 DOM 的部分（web/src/fundingbook/fundingbook-form.ts）：页签地址、读数格式、参数表单到请求、页面提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, parseSettings, VENUE_SPECS } from '../../src/fundingbook/model.ts';
import {
  FUNDINGBOOK_TABS, SETTING_FIELDS, SETTING_GROUPS, fundingBookHref, multiple, newAccount, notice, parseState, percent, price, quantity, resetConfirmText,
  settingsChanged, settingsForm, settingsRequest, signedUsd, stepText, tone, usd, venueDefaults,
} from '../src/fundingbook/fundingbook-form.ts';
import { parseRoute } from '../src/route-parse.ts';
import { breadcrumbOf, navEntries } from '../src/workspace-nav.ts';

test('页签地址与路由互相对应，不认识的子地址不落在本页', () => {
  for (const tab of FUNDINGBOOK_TABS) assert.deepEqual(parseRoute(fundingBookHref(tab.id)), { page: 'fundingbook', tab: tab.id });
  assert.equal(fundingBookHref('overview'), '#/fundingbook');
  assert.deepEqual(parseRoute('#/fundingbook/nope'), { page: 'overview' });
  assert.equal(navEntries.fundingbook.href, '#/fundingbook');
  assert.deepEqual(breadcrumbOf({ page: 'fundingbook', tab: 'plan' }), { workspace: '策略与风险', page: '资金费组合' });
});

test('读数格式：金额、百分数、倍数、数量；缺数显示破折号', () => {
  assert.equal(usd(41895.4), '$41,895');
  assert.equal(usd(-12.345, 2), '−$12.35');
  assert.equal(signedUsd(3.2), '+$3.20');
  assert.equal(signedUsd(-3.2), '−$3.20');
  assert.equal(signedUsd(0), '$0.00');
  assert.equal(percent(0.0876), '8.76%');
  assert.equal(percent(-0.0144, 1), '−1.4%');
  assert.equal(multiple(7.214), '7.21σ');
  assert.equal(quantity(-0.418945), '−0.41895');
  assert.equal(price(100000.26), '100,000.3');
  assert.equal(price(0.0001234), '0.000123');
  for (const format of [usd, signedUsd, percent, multiple, quantity, price]) { assert.equal(format(null), '—'); assert.equal(format(undefined), '—'); assert.equal(format(Number.NaN), '—'); }
  assert.deepEqual([tone(1), tone(-1), tone(0), tone(null)], ['up', 'down', '', '']);
});

test('步骤说明：划转、加仓、减仓、平仓', () => {
  assert.equal(stepText({ kind: 'transfer', account: 'lighter-1', to: 'bybit-1', notional: 4762.2 }), '从 lighter-1 划转 $4,762.20 到 bybit-1');
  const order = { kind: 'order', account: 'lighter-1', base: 'BTC', symbol: 'BTC', side: 'sell', qty: 0.41895, price: 100000, notional: 41895 };
  assert.equal(stepText(order), 'lighter-1 加仓：卖出 0.41895 BTC（BTC）');
  assert.match(stepText({ ...order, side: 'buy', reduce: true }), /^lighter-1 减仓：买入/);
  assert.match(stepText({ ...order, side: 'buy', reduce: true, close: true }), /^lighter-1 平仓：买入/);
});

test('参数表单：默认值来回转换不变，转出的请求体服务端接受', () => {
  const form = settingsForm(DEFAULT_SETTINGS);
  assert.equal(form.bases, 'BTC, ETH, SOL, BNB');
  assert.equal(settingsChanged(form, DEFAULT_SETTINGS), false);
  const request = settingsRequest(form);
  assert.equal(request.ok, true);
  assert.deepEqual(parseSettings(request.body), DEFAULT_SETTINGS);
  // 每个数值参数都有输入框，分组都有标题。
  const numeric = Object.keys(DEFAULT_SETTINGS).filter(key => typeof DEFAULT_SETTINGS[key] === 'number').sort();
  assert.deepEqual(SETTING_FIELDS.map(field => field.key).sort(), numeric);
  for (const field of SETTING_FIELDS) assert.ok(SETTING_GROUPS.some(group => group.id === field.group));
});

test('参数表单：标的拆分与大写，改动被识别，填错给出第一处的说明', () => {
  const form = { ...settingsForm(DEFAULT_SETTINGS), bases: ' btc，eth 、sol  ', enabled: true, safetySigma: '6' };
  const request = settingsRequest(form);
  assert.deepEqual(request.body.bases, ['BTC', 'ETH', 'SOL']);
  assert.equal(request.body.safetySigma, 6);
  assert.equal(parseSettings(request.body).enabled, true);
  assert.equal(settingsChanged(form, DEFAULT_SETTINGS), true);
  assert.deepEqual(settingsRequest({ ...form, capital: '-5' }), { ok: false, message: '模拟盘本金须为不带符号的数字' });
  assert.deepEqual(settingsRequest({ ...form, capital: '1e4' }), { ok: false, message: '模拟盘本金须为不带符号的数字' });
  const accounts = form.accounts.map((account, index) => index === 1 ? { ...account, takerBps: 'x' } : account);
  assert.deepEqual(settingsRequest({ ...form, accounts }), { ok: false, message: '账户 bybit-1 的吃单费率须为不带符号的数字' });
  assert.deepEqual(settingsRequest({ ...form, accounts: [{ ...form.accounts[0], id: ' ' }] }), { ok: false, message: '第 1 个账户没有名称' });
  assert.equal(settingsChanged({ ...form, capital: 'x' }, DEFAULT_SETTINGS), true);
});

test('添加账户：取还没用过的场所与名称，带上这个场所的默认值', () => {
  const form = settingsForm(DEFAULT_SETTINGS), added = newAccount(form, VENUE_SPECS);
  assert.deepEqual(added, { id: 'hyperliquid-1', venue: 'hyperliquid', mmrPct: '2', maxLeverage: '10', takerBps: '4.5' });
  const full = { ...form, accounts: VENUE_SPECS.map(venue => ({ ...added, id: `${venue.id}-1`, venue: venue.id })) };
  assert.equal(newAccount(full, VENUE_SPECS).id, 'lighter-2');
});

test('页面提示：未启用、行情未运行、规划失败、回补中；正常时没有提示', () => {
  const base = { running: true, settings: { ...DEFAULT_SETTINGS, enabled: true }, collect: { done: 12, total: 12, errors: [] }, roundError: null, round: { id: 1 } };
  assert.equal(notice(base), null);
  assert.equal(notice({ ...base, settings: DEFAULT_SETTINGS }).tone, 'info');
  assert.match(notice({ ...base, running: false }).text, /合约价差监控没有运行/);
  assert.deepEqual(notice({ ...base, roundError: '拿不到价格' }), { tone: 'error', text: '本轮规划不可用。拿不到价格' });
  assert.equal(notice({ ...base, roundError: '参数 JSON 损坏', settings: DEFAULT_SETTINGS, running: false }).tone, 'error');
  assert.match(notice({ ...base, round: null, collect: { done: 3, total: 12, errors: [] } }).text, /3 \/ 12/);
  assert.match(resetConfirmText({ recovery: { book: null, settings: null }, settings: DEFAULT_SETTINGS, rounds: [1, 2] }), /规划记录（最近 2 轮可见）.*\$10,000/);
  assert.match(resetConfirmText({ recovery: { book: 'JSON 损坏', settings: 'JSON 损坏' }, settings: DEFAULT_SETTINGS, rounds: [] }), /删除原始账本.*恢复参数后/);
});

test('应答校验：缺字段时按读取失败处理', () => {
  assert.throws(() => parseState(null), /应答格式不对/);
  assert.throws(() => parseState({ settings: DEFAULT_SETTINGS }), /应答格式不对/);
  const ok = { settings: DEFAULT_SETTINGS, recovery: { settings: null, book: null }, venues: VENUE_SPECS, legs: [], rounds: [], collect: { done: 0, total: 0, errors: [] } };
  assert.equal(parseState(ok), ok);
  assert.throws(() => parseState({ ...ok, venues: undefined }), /应答格式不对/);
  assert.throws(() => parseState({ ...ok, collect: { done: 0, total: 0 } }), /应答格式不对/);
});

test('换场所带出该场所的默认费率、保证金率与杠杆', () => {
  assert.deepEqual(venueDefaults('lighter', VENUE_SPECS), { venue: 'lighter', mmrPct: '2', maxLeverage: '10', takerBps: '0' });
  assert.deepEqual(venueDefaults('nowhere', VENUE_SPECS), { venue: 'nowhere' });
});
