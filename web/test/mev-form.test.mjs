// MEV 套利页不依赖 DOM 的部分（web/src/mev/mev-form.ts）：页签地址、读数格式、风控参数表单到请求、开始实盘的确认文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, parseSettings } from '../../src/mev/risk.ts';
import {
  MEV_TABS, SETTING_FIELDS, SETTING_GROUPS, TX_STATUS_LABELS, age, bps, compactUsd, commitSettingsSave, editSettingsSync, eth, feePercent, initSettingsSync, mevHref, outcomeTone,
  receiveServerSettings, revertSettingsSync, settingsChanged, settingsForm, settingsRequest, shortAddress, startBlocker, startConfirmText, tokenAmount, txTone, usd,
  REDEPLOY_AFTER_MS, deployBlocker, deployConfirmText, insecurePage, resetConfirmText, setupRequest,
} from '../src/mev/mev-form.ts';
import { REDEPLOY_AFTER_MS as SERVER_REDEPLOY_AFTER_MS } from '../../src/mev/setup.ts';
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

test('启用表单：私钥可不带 0x，助记词与短私钥拒绝且报错不带私钥；收款地址与节点地址查格式；节点可不填', () => {
  const key = 'ab'.repeat(32);
  assert.deepEqual(setupRequest({ privateKey: ` ${key} `, owner: ` ${OWNER} `, rpcUrl: '' }), { ok: true, body: { privateKey: `0x${key}`, owner: OWNER } });
  assert.deepEqual(setupRequest({ privateKey: `0x${key}`, owner: OWNER, rpcUrl: ' https://node.example/v2/k ' }), { ok: true, body: { privateKey: `0x${key}`, owner: OWNER, rpcUrl: 'https://node.example/v2/k' } });
  for (const privateKey of ['', key.slice(2), 'word '.repeat(12).trim(), `0x${key}zz`]) {
    const result = setupRequest({ privateKey, owner: OWNER, rpcUrl: '' });
    assert.equal(result.ok, false);
    assert.ok(/私钥/.test(result.message) && !result.message.includes('abab'), result.message);
  }
  assert.match(setupRequest({ privateKey: key, owner: '0x12', rpcUrl: '' }).message, /收款地址/);
  assert.match(setupRequest({ privateKey: key, owner: OWNER, rpcUrl: 'node.example' }).message, /节点地址/);
});

test('明文 http 且不是本机时提醒；部署前要有余额；确认文案带热钱包与收款地址；重发间隔与服务端一致', () => {
  assert.equal(insecurePage({ protocol: 'http:', hostname: '203.0.113.7' }), true);
  for (const location of [{ protocol: 'https:', hostname: 'tp.example' }, { protocol: 'http:', hostname: 'localhost' }, { protocol: 'http:', hostname: '127.0.0.1' }, { protocol: 'http:', hostname: '[::1]' }]) assert.equal(insecurePage(location), false);
  const setup = (patch = {}) => ({ stage: 'wallet', managed: false, operator: OPERATOR, owner: OWNER, rpcHost: 'mainnet.base.org', defaultRpc: true, wallet: { eth: 0.012, nonce: 0, checkedAt: 1 }, rpcError: null, deploy: null, error: null, checkedAt: 2, ...patch });
  assert.equal(deployBlocker(setup()), null);
  assert.match(deployBlocker(setup({ wallet: { eth: 0, nonce: 0, checkedAt: 1 } })), /先转入 gas/);
  assert.match(deployBlocker(setup({ wallet: null })), /正在读取/);
  assert.match(deployBlocker(setup({ wallet: null, rpcError: '超时' })), /读不到/);
  const text = deployConfirmText(setup());
  assert.ok(text.includes(OPERATOR) && text.includes(OWNER) && text.includes('0.012000 ETH') && text.includes('不可更改'), text);
  assert.match(deployConfirmText(setup({ deploy: { hash: '0x1', nonce: 0, at: 1, address: EXECUTOR } })), /加价重发/);
  assert.ok(resetConfirmText(setup()).includes(OPERATOR) && /私钥另有备份/.test(resetConfirmText(setup())));
  assert.ok(!/仍可能上链/.test(resetConfirmText(setup())));
  assert.match(resetConfirmText(setup({ deploy: { hash: '0x1', nonce: 0, at: 1, address: EXECUTOR } })), /仍可能上链/);
  assert.equal(REDEPLOY_AFTER_MS, SERVER_REDEPLOY_AFTER_MS);
});

test('设置同步状态机：编辑中服务端变更、保存后刷新在途/失败与撤销均不回滚到陈旧值', () => {
  const s0 = DEFAULT_SETTINGS;
  const s1 = { ...s0, minNetUsd: 2.5 };
  const s2 = { ...s0, minNetUsd: 5 };
  const s3 = { ...s0, minNetUsd: 8 };

  // 1. 编辑期间服务端推来 S1，保存提交 S2 后即使收到 S1 也不覆盖，等 S2 到来才清除 pending。
  let state = initSettingsSync(s0);
  state = editSettingsSync(state, 'minNetUsd', '5');
  state = receiveServerSettings(state, s1);
  assert.equal(state.form.minNetUsd, '5');
  state = commitSettingsSave(state, s2);
  assert.equal(state.form.minNetUsd, '5');
  assert.equal(settingsChanged(state.form, state.baseline), false);
  state = receiveServerSettings(state, s1);
  assert.equal(state.form.minNetUsd, '5', '已提交的 S2 不被陈旧 S1 盖回');
  state = receiveServerSettings(state, s2);
  assert.equal(state.pendingSavedJson, null);
  assert.equal(state.baseline.minNetUsd, 5);

  // 2. 保存 S2 后刷新失败（view.settings 停在 S0），dirty=false；再改 S4 后撤销回到 S2 而非 S0。
  let offline = commitSettingsSave(editSettingsSync(initSettingsSync(s0), 'minNetUsd', '5'), s2);
  assert.equal(settingsChanged(offline.form, offline.baseline), false);
  offline = editSettingsSync(offline, 'minNetUsd', '7');
  assert.equal(settingsChanged(offline.form, offline.baseline), true);
  offline = revertSettingsSync(offline, s0);
  assert.equal(offline.form.minNetUsd, '5');
  assert.equal(offline.touched, false);
  assert.equal(settingsChanged(offline.form, offline.baseline), false);

  // 3. 保存后刷新在途继续编辑，服务端追平到 S2 时保留用户新输入但更新基线；无未追平保存时撤销回到最新服务端值。
  let overlapping = commitSettingsSave(editSettingsSync(initSettingsSync(s0), 'minNetUsd', '5'), s2);
  overlapping = editSettingsSync(overlapping, 'minNetUsd', '6');
  overlapping = receiveServerSettings(overlapping, s2);
  assert.equal(overlapping.form.minNetUsd, '6');
  assert.equal(overlapping.baseline.minNetUsd, 5);
  assert.equal(overlapping.pendingSavedJson, null);
  const reverted = revertSettingsSync(overlapping, s3);
  assert.equal(reverted.form.minNetUsd, '8');
  assert.equal(reverted.baseline.minNetUsd, 8);

  // 4. 空闲未修改时跟随服务端更新。
  const idle = receiveServerSettings(initSettingsSync(s0), s1);
  assert.equal(idle.form.minNetUsd, '2.5');
  assert.equal(settingsChanged(idle.form, idle.baseline), false);

  // 5. 模拟 settingsRequest() (SETTING_FIELDS 键序) 与 parseSettings() (RANGES 键序) 键序差异，及 '30' 改 '30.0' 同值保存。
  const reqS0 = settingsRequest(settingsForm(s0));
  assert.ok(reqS0.ok);
  const parsedS0 = parseSettings(reqS0.body.settings);
  assert.notEqual(JSON.stringify(reqS0.body.settings), JSON.stringify(parsedS0), '验证前后端对象键序确实不同');
  let reordered = initSettingsSync(parsedS0);
  reordered = editSettingsSync(reordered, 'tipShare', '30.0');
  reordered = commitSettingsSave(reordered, reqS0.body.settings);
  assert.equal(reordered.pendingSavedJson, null, '键序不同但数值未变时不应残留 pendingSavedJson');
  reordered = editSettingsSync(reordered, 'minNetUsd', '5');
  const reqS2 = settingsRequest(reordered.form);
  assert.ok(reqS2.ok);
  reordered = commitSettingsSave(reordered, reqS2.body.settings);
  reordered = editSettingsSync(reordered, 'minNetUsd', '6');
  reordered = receiveServerSettings(reordered, parseSettings(reqS2.body.settings));
  assert.equal(reordered.pendingSavedJson, null, '后端返回 RANGES 键序也能清零 pendingSavedJson');
  assert.equal(reordered.baseline.minNetUsd, 5);
  assert.equal(reordered.form.minNetUsd, '6');

  // 6. 手动把输入改回 baseline 后 touched 解除，期间到达的服务端更新立即同步而不锁死旧值。
  let manual = initSettingsSync(s0);
  manual = editSettingsSync(manual, 'minNetUsd', '5');
  assert.equal(manual.touched, true);
  manual = receiveServerSettings(manual, { ...s0, gasMultiple: 4 });
  assert.equal(manual.form.gasMultiple, String(s0.gasMultiple));
  manual = editSettingsSync(manual, 'minNetUsd', String(s0.minNetUsd));
  assert.equal(manual.touched, false);
  manual = receiveServerSettings(manual, { ...s0, gasMultiple: 4 });
  assert.equal(manual.form.gasMultiple, '4');
  assert.equal(manual.baseline.gasMultiple, 4);
});
