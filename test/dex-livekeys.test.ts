// DEX 价差实盘的交易凭据文件（src/varlighter/livekeys.ts，docs/dexspread.md 第 13 节）：严格解析、文件权限、往返、
// 文件损坏时不改动、任何输出都不带私钥。私钥都是固定的假值，不对应任何真实账户；只读写临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addressOf } from '../src/aster/eip712.ts';
import { LIVE_KEYS_FILE, LiveKeysError, createLiveKeysStore, parseLiveKeys } from '../src/varlighter/livekeys.ts';
import { VarLighterError, createVarLighterEngine } from '../src/varlighter/engine.ts';
import type { LivePosition } from '../src/varlighter/live.ts';
import type { SocketLike } from '../src/varlighter/feeds.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';

// 假值：Lighter 的 API 私钥 40 字节，Entropy 的 API 钱包私钥 32 字节。
const LIGHTER_KEY = 'ab'.repeat(40), RH_KEY = 'cd'.repeat(40), ENTROPY_KEY = '11'.repeat(32);
const ADDRESS = '0x00000000000000000000000000000000000000aB';
const ACCOUNT = 987654, RH_ACCOUNT = 876543;
const SECRETS = [LIGHTER_KEY, RH_KEY, ENTROPY_KEY];
const lighter = (extra: Record<string, unknown> = {}) => ({ accountIndex: ACCOUNT, apiKeyIndex: 5, privateKey: LIGHTER_KEY, ...extra });
const entropy = (extra: Record<string, unknown> = {}) => ({ address: ADDRESS, privateKey: ENTROPY_KEY, ...extra });

function temp(t: test.TestContext, name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** 执行应当被拒的操作，返回报错文本；报错必须是 LiveKeysError 且不带任何私钥片段。 */
function refusal(work: () => unknown, label: string): string {
  try { work(); } catch (error) {
    assert.ok(error instanceof LiveKeysError, `${label}：报错类型应为 LiveKeysError，实际 ${String(error)}`);
    noSecret(error.message, label);
    return error.message;
  }
  return assert.fail(`${label}：应当被拒`);
}
function noSecret(text: string, label: string, extra: string[] = []): void {
  const lower = text.toLowerCase();
  // 整串与任意 16 位的片段都不能出现（片段取开头，假值是重复的两位十六进制）。
  for (const secret of [...SECRETS, ...extra]) assert.ok(!lower.includes(secret.toLowerCase().slice(0, 16)), `${label}：输出里带了私钥`);
}

test('实盘凭据：Lighter 字段严格解析，API 密钥编号与账户编号的保留值被拒', t => {
  const store = createLiveKeysStore(temp(t, 'dex-livekeys-a-'));
  const bad: [string, unknown, RegExp][] = [
    ['不是对象', null, /格式无效/], ['数组', [lighter()], /格式无效/], ['字符串', LIGHTER_KEY, /格式无效/],
    ['未知字段', lighter({ note: 'x' }), /不认识的字段/], ['带场所字段', lighter({ venue: 'lighter' }), /不认识的字段/],
    ['账户编号 0', lighter({ accountIndex: 0 }), /须大于 0/], ['账户编号 "0"', lighter({ accountIndex: '0' }), /须大于 0/],
    ['账户编号为负', lighter({ accountIndex: -1 }), /账户编号/], ['账户编号为小数', lighter({ accountIndex: 1.5 }), /账户编号/],
    ['账户编号缺失', { apiKeyIndex: 5, privateKey: LIGHTER_KEY }, /账户编号/], ['账户编号十六进制', lighter({ accountIndex: '0x10' }), /账户编号/],
    ['账户编号超范围', lighter({ accountIndex: 2 ** 48 }), /账户编号/], ['账户编号前导零', lighter({ accountIndex: '0123' }), /账户编号/],
    ...[0, 1, 2, 3, 255, 256, -1, 4.5, '3', '255', 'x', '', null, undefined, true].map((index): [string, unknown, RegExp] => [`API 密钥编号 ${JSON.stringify(index)}`, lighter({ apiKeyIndex: index }), /API 密钥编号须为 4 到 254/]),
    ['私钥太短', lighter({ privateKey: LIGHTER_KEY.slice(2) }), /80 位十六进制/], ['私钥太长', lighter({ privateKey: LIGHTER_KEY + 'ab' }), /80 位十六进制/],
    ['私钥非十六进制', lighter({ privateKey: 'zz' + LIGHTER_KEY.slice(2) }), /80 位十六进制/], ['私钥是 64 位（钱包私钥）', lighter({ privateKey: ENTROPY_KEY }), /不是钱包私钥/],
    ['私钥不是字符串', lighter({ privateKey: 12345 }), /80 位十六进制/], ['私钥缺失', { accountIndex: ACCOUNT, apiKeyIndex: 5 }, /80 位十六进制/],
    ['私钥中间有空格', lighter({ privateKey: `${LIGHTER_KEY.slice(0, 40)} ${LIGHTER_KEY.slice(40)}` }), /80 位十六进制/],
  ];
  for (const [label, value, pattern] of bad) for (const venue of ['lighter', 'rh'] as const) assert.match(refusal(() => store.set(venue, value), `${venue} ${label}`), pattern, `${venue} ${label}`);
  // RH 上 157 保留，主网上可以用。
  assert.match(refusal(() => store.set('rh', lighter({ apiKeyIndex: 157 })), 'RH 157'), /Lighter RH 上 157 保留/);
  assert.match(refusal(() => store.set('rh', lighter({ apiKeyIndex: '157' })), 'RH "157"'), /157 保留/);
  assert.deepEqual(store.view(), { lighter: false, rh: false, entropy: false }, '被拒的都没有写入');
  store.set('lighter', lighter({ apiKeyIndex: 157 }));
  assert.equal(store.read().keys.lighter!.apiKeyIndex, 157);
  // 边界值与宽松写法：编号可以是数字文本，私钥可带 0x、大写、首尾空白，存下来统一成小写不带 0x。
  for (const index of [4, 254, '4', ' 254 ']) { store.set('rh', lighter({ apiKeyIndex: index })); assert.equal(store.read().keys.rh!.apiKeyIndex, Number(String(index).trim())); }
  store.set('rh', { accountIndex: ` ${RH_ACCOUNT} `, apiKeyIndex: 6, privateKey: ` 0X${RH_KEY.toUpperCase()} ` });
  assert.deepEqual(store.read().keys.rh, { accountIndex: RH_ACCOUNT, apiKeyIndex: 6, privateKey: RH_KEY });
});

test('实盘凭据：Entropy 字段严格解析，填主钱包私钥时拒绝', t => {
  const store = createLiveKeysStore(temp(t, 'dex-livekeys-b-'));
  const owner = addressOf('0x' + ENTROPY_KEY);
  const bad: [string, unknown, RegExp][] = [
    ['不是对象', 'x', /格式无效/], ['数组', [], /格式无效/], ['未知字段', entropy({ accountIndex: 1 }), /不认识的字段/],
    ['地址太短', entropy({ address: '0x1234' }), /Entropy 账户地址/], ['地址不带 0x', entropy({ address: ADDRESS.slice(2) }), /Entropy 账户地址/],
    ['地址缺失', { privateKey: ENTROPY_KEY }, /Entropy 账户地址/], ['地址非十六进制', entropy({ address: '0x' + 'g'.repeat(40) }), /Entropy 账户地址/],
    ['私钥太短', entropy({ privateKey: ENTROPY_KEY.slice(2) }), /64 位十六进制/], ['私钥太长', entropy({ privateKey: ENTROPY_KEY + '11' }), /64 位十六进制/],
    ['私钥非十六进制', entropy({ privateKey: 'zz' + ENTROPY_KEY.slice(2) }), /64 位十六进制/], ['私钥是 80 位（Lighter 的）', entropy({ privateKey: LIGHTER_KEY }), /64 位十六进制/],
    ['私钥不是字符串', entropy({ privateKey: 7 }), /64 位十六进制/], ['私钥缺失', { address: ADDRESS }, /64 位十六进制/],
    ['私钥为 0（不是有效的 secp256k1 私钥）', entropy({ privateKey: '00'.repeat(32) }), /私钥无效/],
    // 主钱包私钥能提币：私钥对应的地址就是填的主账户地址时拒绝，地址大小写与私钥写法不影响判断。
    ['主钱包私钥', entropy({ address: owner }), /就是主账户的钱包私钥/], ['主钱包私钥（地址大写）', entropy({ address: '0x' + owner.slice(2).toUpperCase() }), /就是主账户的钱包私钥/],
    ['主钱包私钥（私钥带 0x 大写）', entropy({ address: owner.toLowerCase(), privateKey: '0X' + ENTROPY_KEY.toUpperCase() }), /就是主账户的钱包私钥/],
  ];
  for (const [label, value, pattern] of bad) assert.match(refusal(() => store.set('entropy', value), label), pattern, label);
  assert.deepEqual(store.view(), { lighter: false, rh: false, entropy: false });
  store.set('entropy', { address: ` ${ADDRESS} `, privateKey: ` ${ENTROPY_KEY.toUpperCase()} ` });
  assert.deepEqual(store.read().keys.entropy, { address: ADDRESS.toLowerCase(), privateKey: '0x' + ENTROPY_KEY }, '地址统一小写，私钥统一成 0x 加小写');
  store.set('entropy', entropy({ privateKey: '0x' + ENTROPY_KEY }));
  assert.equal(store.read().keys.entropy!.privateKey, '0x' + ENTROPY_KEY);
});

test('实盘凭据文件：整体解析拒绝未知版本、未知场所与坏掉的场所', () => {
  assert.deepEqual(parseLiveKeys({ version: 1 }), {});
  assert.deepEqual(parseLiveKeys({ version: 1, lighter: lighter(), rh: lighter({ accountIndex: RH_ACCOUNT, privateKey: RH_KEY }), entropy: entropy() }),
    { lighter: { accountIndex: ACCOUNT, apiKeyIndex: 5, privateKey: LIGHTER_KEY }, rh: { accountIndex: RH_ACCOUNT, apiKeyIndex: 5, privateKey: RH_KEY }, entropy: { address: ADDRESS.toLowerCase(), privateKey: '0x' + ENTROPY_KEY } });
  for (const bad of [null, [], 'x', {}, { version: 2 }, { version: '1' }, { version: 1, var: lighter() }, { version: 1, extra: 1 }, { version: 1, lighter: null }, { version: 1, lighter: entropy() },
    { version: 1, entropy: lighter() }, { version: 1, rh: lighter({ apiKeyIndex: 157 }) }, { version: 1, lighter: lighter(), entropy: entropy({ privateKey: 'x' }) }]) refusal(() => parseLiveKeys(bad), JSON.stringify(bad)?.slice(0, 30) ?? 'null');
});

test('实盘凭据：录入与移除往返，文件 600，页面只看到布尔值，账户标识里没有私钥', t => {
  const dir = temp(t, 'dex-livekeys-c-'), file = path.join(dir, LIVE_KEYS_FILE);
  const store = createLiveKeysStore(dir);
  assert.deepEqual([store.read(), store.view(), store.accounts(), existsSync(file)], [{ keys: {}, problem: null }, { lighter: false, rh: false, entropy: false }, {}, false]);
  store.remove('lighter');
  assert.equal(existsSync(file), false, '本来就没有时移除不建文件');

  store.set('lighter', lighter());
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), [LIVE_KEYS_FILE], '不留临时文件');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, lighter: { accountIndex: ACCOUNT, apiKeyIndex: 5, privateKey: LIGHTER_KEY } });
  store.set('entropy', entropy());
  store.set('rh', lighter({ accountIndex: RH_ACCOUNT, apiKeyIndex: 9, privateKey: RH_KEY }));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, '覆盖后仍是 600');
  assert.deepEqual(readdirSync(dir), [LIVE_KEYS_FILE]);
  assert.deepEqual(store.view(), { lighter: true, rh: true, entropy: true });
  assert.ok(Object.values(store.view()).every(value => typeof value === 'boolean'), '页面只看到布尔值');
  assert.deepEqual(store.accounts(), { lighter: { accountIndex: ACCOUNT }, rh: { accountIndex: RH_ACCOUNT }, entropy: { address: ADDRESS.toLowerCase() } });
  noSecret(JSON.stringify(store.view()), 'view');
  noSecret(JSON.stringify(store.accounts()), 'accounts');
  assert.ok(!JSON.stringify(store.view()).includes(String(ACCOUNT)) && !JSON.stringify(store.view()).includes(ADDRESS.toLowerCase().slice(2)), 'view 不带账户编号与地址');
  assert.deepEqual(store.read().keys, { lighter: { accountIndex: ACCOUNT, apiKeyIndex: 5, privateKey: LIGHTER_KEY }, rh: { accountIndex: RH_ACCOUNT, apiKeyIndex: 9, privateKey: RH_KEY }, entropy: { address: ADDRESS.toLowerCase(), privateKey: '0x' + ENTROPY_KEY } });

  // 另一个实例（进程重启）读到同样的内容。
  assert.deepEqual(createLiveKeysStore(dir).read(), store.read());
  // 替换一个场所不动其余的；被拒的替换不改文件。
  store.set('lighter', lighter({ apiKeyIndex: 7 }));
  assert.deepEqual([store.read().keys.lighter!.apiKeyIndex, store.read().keys.rh!.apiKeyIndex, !!store.read().keys.entropy], [7, 9, true]);
  const before = readFileSync(file, 'utf8');
  refusal(() => store.set('lighter', lighter({ apiKeyIndex: 2 })), '替换被拒');
  assert.equal(readFileSync(file, 'utf8'), before);

  store.remove('rh');
  assert.deepEqual(store.view(), { lighter: true, rh: false, entropy: true });
  assert.ok(!readFileSync(file, 'utf8').includes(RH_KEY), '移除后文件里不再有这把私钥');
  store.remove('rh');
  assert.deepEqual(store.view(), { lighter: true, rh: false, entropy: true }, '重复移除无害');
  store.remove('lighter');
  store.remove('entropy');
  assert.deepEqual([existsSync(file), readdirSync(dir), store.read()], [false, [], { keys: {}, problem: null }], '全部移除时删除文件');
});

test('实盘凭据：文件被删除或在服务器上被换掉后，下一次取用就按新的现状（L207）', t => {
  const dir = temp(t, 'dex-livekeys-d-'), file = path.join(dir, LIVE_KEYS_FILE);
  const store = createLiveKeysStore(dir);
  store.set('lighter', lighter());
  store.set('entropy', entropy());
  assert.equal(store.read().keys.lighter!.privateKey, LIGHTER_KEY);
  rmSync(file);
  assert.deepEqual([store.read(), store.view(), store.accounts()], [{ keys: {}, problem: null }, { lighter: false, rh: false, entropy: false }, {}], '删除文件即吊销，不用缓存');
  // 换成只有 RH 的文件（内容长度不同）：读到新的，不沿用旧缓存。
  writeFileSync(file, JSON.stringify({ version: 1, rh: lighter({ accountIndex: RH_ACCOUNT, privateKey: RH_KEY }) }) + '\n');
  assert.deepEqual([store.view(), store.read().keys.rh?.privateKey, store.read().keys.lighter], [{ lighter: false, rh: true, entropy: false }, RH_KEY, undefined]);
});

test('实盘凭据：文件读不懂时不使用、说明原因，录入与移除都拒绝且不动文件；报错不带私钥', t => {
  const dir = temp(t, 'dex-livekeys-e-'), file = path.join(dir, LIVE_KEYS_FILE);
  const store = createLiveKeysStore(dir);
  store.set('lighter', lighter());
  const good = readFileSync(file, 'utf8');
  const broken: [string, string, RegExp][] = [
    ['不是 JSON', '坏了', /不是有效的 JSON/],
    // 截断的文件里仍有私钥片段：原因里不能把 JSON 解析器引用的原文带出来。
    ['截断', good.slice(0, good.length - 20), /不是有效的 JSON/],
    ['空文件', '', /不是有效的 JSON/],
    ['版本不认识', JSON.stringify({ version: 2, lighter: lighter() }), /格式无效/],
    ['未知字段', JSON.stringify({ version: 1, lighter: lighter(), other: RH_KEY }), /不认识的字段/],
    ['其中一个场所坏了', JSON.stringify({ version: 1, lighter: lighter(), entropy: entropy({ privateKey: ENTROPY_KEY.slice(4) }) }), /64 位十六进制/],
    ['保留的 API 密钥编号', JSON.stringify({ version: 1, lighter: lighter({ apiKeyIndex: 3 }) }), /API 密钥编号/],
  ];
  for (const [label, content, pattern] of broken) {
    writeFileSync(file, content);
    const read = store.read();
    assert.deepEqual(read.keys, {}, `${label}：整份不用，不挑能读的场所`);
    assert.match(read.problem!, /^实盘凭据文件读不懂，未使用：/, label);
    assert.match(read.problem!, pattern, label);
    noSecret(read.problem!, `${label} 的原因`);
    assert.deepEqual([store.view(), store.accounts()], [{ lighter: false, rh: false, entropy: false }, {}], label);
    assert.match(refusal(() => store.set('rh', lighter({ privateKey: RH_KEY })), `${label} 时录入`), /请先在服务器上删除 live-keys\.json 再重新录入/);
    assert.match(refusal(() => store.remove('lighter'), `${label} 时移除`), /请先在服务器上删除 live-keys\.json/);
    assert.equal(readFileSync(file, 'utf8'), content, `${label}：被拒的改动不动文件`);
    assert.deepEqual(readdirSync(dir), [LIVE_KEYS_FILE], `${label}：不留临时文件`);
  }
  // 删掉坏文件后可以重新录入。
  rmSync(file);
  assert.deepEqual(store.read(), { keys: {}, problem: null });
  store.set('rh', lighter({ privateKey: RH_KEY }));
  assert.deepEqual(store.view(), { lighter: false, rh: true, entropy: false });
  // 路径是目录（不是普通文件）时当作没有。
  rmSync(file);
  const odd = temp(t, 'dex-livekeys-f-');
  writeFileSync(path.join(odd, 'x'), '');
  assert.deepEqual(createLiveKeysStore(path.join(odd, 'x')).read(), { keys: {}, problem: null }, '数据目录不可用时读不到凭据，不抛错');
});

test('实盘接口：场所有实盘持仓时只能给同一个账户换密钥，换账户与移除都 409 且不改文件；只读令牌能读的视图不含实盘事件', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-livekeys-e-'));
  const keys = createLiveKeysStore(dir), store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  keys.set('lighter', lighter());
  keys.set('entropy', entropy());
  // 库里已有一笔 Lighter 对 Entropy 的实盘持仓。
  const leg = (venue: 'lighter' | 'entropy', side: 'buy' | 'sell') => ({ venue, symbol: venue === 'entropy' ? 'io:NVDA' : 'NVDA', side, qty: 1, entryQuote: 100, exitQty: 0, exitQuote: 0, feesUsd: 0, estimated: false });
  const held: LivePosition = { id: 'l-1', symbol: 'lighter:NVDA|entropy:NVDA', direction: 'a_rich', ratio: 1, state: 'open', step: 'settle', openedAt: 1, updatedAt: 1, closedAt: null,
    a: leg('lighter', 'sell'), b: leg('entropy', 'buy'), plan: { qty: 1, limit: 100 }, pending: null, tries: 0, retryAt: 0, closeReason: null, singleLeg: false, netUsd: null, note: '' };
  store.saveLive(held);
  store.event(1, 'live', null, '实盘开仓：测试');
  const silent = (): SocketLike => { const s: SocketLike = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() { s.readyState = 3; } }; return s; };
  const engine = createVarLighterEngine({ store, connect: silent, now: () => 10_000, liveKeys: keys, signerProblem: () => null,
    fetchImpl: async () => new Response('{}', { status: 500 }), traders: () => { throw new Error('不该下单'); } });
  const status = (work: () => unknown): number | null => { try { work(); } catch (error) { assert.ok(error instanceof VarLighterError, String(error)); noSecret(error.message, 'error'); return error.status; } return null; };
  const file = path.join(dir, LIVE_KEYS_FILE), before = readFileSync(file, 'utf8');
  assert.equal(status(() => engine.views.liveKeys({ venue: 'lighter', ...lighter({ accountIndex: ACCOUNT + 1, apiKeyIndex: 8 }) })), 409, '换成别的账户');
  assert.equal(status(() => engine.views.liveKeys({ venue: 'entropy', ...entropy({ address: '0x00000000000000000000000000000000000000cd' }) })), 409, '换成别的地址');
  assert.equal(status(() => engine.views.liveKeysRemove({ venue: 'lighter' })), 409, '有持仓时移除');
  assert.equal(readFileSync(file, 'utf8'), before, '被拒时文件不动');
  // 同一个账户换一把新的 API 密钥：允许（地址大小写不同也算同一个）。
  assert.equal(status(() => engine.views.liveKeys({ venue: 'lighter', ...lighter({ apiKeyIndex: 9 }) })), null);
  assert.equal(status(() => engine.views.liveKeys({ venue: 'entropy', ...entropy({ address: ADDRESS.toUpperCase().replace('0X', '0x') }) })), null);
  assert.equal(keys.read().keys.lighter!.apiKeyIndex, 9);
  // 没有持仓的场所随便换。
  assert.equal(status(() => engine.views.liveKeys({ venue: 'rh', ...lighter({ accountIndex: RH_ACCOUNT, privateKey: RH_KEY }) })), null);
  assert.equal(status(() => engine.views.liveKeys({ venue: 'rh', ...lighter({ accountIndex: RH_ACCOUNT + 1, privateKey: RH_KEY }) })), null);
  // 只读令牌能读的总览里有持仓摘要、没有实盘事件；实盘视图里有。
  const overview = JSON.stringify(engine.views.state());
  assert.ok(!overview.includes('实盘开仓：测试'), '总览不带实盘事件');
  assert.equal(engine.views.state().trading.open, 1);
  assert.ok(engine.views.live().events.some(item => item.message === '实盘开仓：测试'));
  noSecret(JSON.stringify(engine.views.live()), 'live view');
});
