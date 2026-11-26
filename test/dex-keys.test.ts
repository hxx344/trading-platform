// DEX 价差实盘的场所账户（docs/dexspread.md 第 12 节第 1 步）：文件编码与严格解析、启动时从环境取走、文件被删或更换后停用、
// 录入助手、三个场所的账户应答解析、引擎的账户只读与实盘准备页检查项。账户应答都是假的，不连任何外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEX_KEYS_ENV, configuredVenues, decodeDexKeysFile, decodeDexKeysValue, encodeDexKeys, guardedAccounts, parseDexAccounts, takeDexKeys, type DexAccounts, type DexAccountsState } from '../src/dex/keys.ts';
import { parseKeysInput, planKeys, readKeysFile, writeKeysFile } from '../src/dex/keys-setup.ts';
import { fetchAccount, parseEntropyAccount, parseLighterAccount } from '../src/varlighter/accounts.ts';
import { ACCOUNT_STALE_MS, READY_FUNDING_USD, createVarLighterEngine } from '../src/varlighter/engine.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';
import type { SocketLike } from '../src/varlighter/feeds.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ADDRESS = '0x00000000000000000000000000000000000000aB';
const ALL: DexAccounts = { lighter: { accountIndex: 12345 }, rh: { accountIndex: 281474976710654 }, entropy: { address: ADDRESS.toLowerCase() } };

test('场所账户：编码往返、严格解析、地址统一成小写', () => {
  const text = encodeDexKeys({ ...ALL, entropy: { address: ADDRESS } });
  assert.match(text, /^TP_DEX_KEYS=[A-Za-z0-9_-]+\n$/, '一行、不含引号与空白，EnvironmentFile 原样读入');
  assert.deepEqual(decodeDexKeysFile(text), ALL);
  assert.deepEqual(decodeDexKeysValue(text.trim().slice(DEX_KEYS_ENV.length + 1)), ALL);
  assert.deepEqual(configuredVenues({ rh: { accountIndex: 0 } }), ['rh']);
  assert.deepEqual(parseDexAccounts({ version: 1 }), {});
  // 带 privateKey 的被拒是 L211 的闸门：这个文件经环境变量投递，放开未知字段之前必须先换投递方式。
  for (const bad of [null, [], { version: 2 }, { version: 1, extra: 1 }, { version: 1, lighter: { accountIndex: -1 } }, { version: 1, lighter: { accountIndex: 1.5 } },
    { version: 1, lighter: { accountIndex: '7' } }, { version: 1, rh: { accountIndex: 2 ** 48 } }, { version: 1, lighter: { accountIndex: 1, privateKey: 'x' } },
    { version: 1, entropy: { address: '0x12' } }, { version: 1, entropy: { address: 7 } }, { version: 1, entropy: [] }]) assert.throws(() => parseDexAccounts(bad), `${JSON.stringify(bad)}`);
  for (const bad of ['', 'TP_DEX_KEYS=', 'TP_DEX_KEYS="abc"\n', 'OTHER=abc\n', `${text}${text}`, `TP_DEX_KEYS=${'a'.repeat(9000)}\n`, 'TP_DEX_KEYS=bm90LWpzb24\n']) assert.throws(() => decodeDexKeysFile(bad), `${bad.slice(0, 30)}`);
});

test('启动时取走环境里的场所账户并删掉变量；内容无效时不使用', () => {
  const env: NodeJS.ProcessEnv = { [DEX_KEYS_ENV]: encodeDexKeys(ALL).trim().slice(DEX_KEYS_ENV.length + 1), OTHER: '1' };
  assert.deepEqual(takeDexKeys(env), { accounts: ALL, present: true, problem: null, fileSize: Buffer.byteLength(encodeDexKeys(ALL)) });
  assert.deepEqual(env, { OTHER: '1' }, '子进程拿不到');
  assert.deepEqual(takeDexKeys({}), { accounts: {}, present: false, problem: null });
  const bad: NodeJS.ProcessEnv = { [DEX_KEYS_ENV]: 'not base64 json' };
  const taken = takeDexKeys(bad);
  assert.deepEqual([taken.accounts, taken.present, taken.problem !== null, DEX_KEYS_ENV in bad], [{}, true, true, false]);
});

test('文件被删除或更换后不再使用启动时拿到的账户（L207）', () => {
  const taken = { accounts: ALL, present: true, problem: null };
  type Mark = { ino: number; size: number; mtimeMs: number; ctimeMs?: number; file?: boolean } | null;
  let mark: Mark = { ino: 7, size: 100, mtimeMs: 5 };
  const stat = () => { if (!mark) throw new Error('ENOENT'); const now = mark; return { ctimeMs: 5, ...now, isFile: () => now.file !== false }; };
  const source = guardedAccounts(taken, '/etc/x/keys.env', stat);
  assert.deepEqual(source(), { accounts: ALL, problem: null });
  mark = { ino: 7, size: 100, mtimeMs: 6 };
  assert.deepEqual([source().accounts, /已更换/.test(source().problem!)], [{}, true], '内容改过');
  mark = { ino: 8, size: 100, mtimeMs: 5 };
  assert.match(source().problem!, /已更换/, '换了文件');
  mark = { ino: 7, size: 100, mtimeMs: 5, ctimeMs: 6 };
  assert.match(source().problem!, /已更换/, '原地改写后把修改时间改回去：ctime 变了');
  mark = null;
  assert.deepEqual([source().accounts, /已删除/.test(source().problem!)], [{}, true]);
  mark = { ino: 7, size: 100, mtimeMs: 5 };
  assert.deepEqual(source(), { accounts: ALL, problem: null }, '文件原样回来时可用：内容没有离开过内存，身份也没变');
  // 启动时就看不到文件（环境里却有值）、文件不是普通文件、没有给路径：都不用。
  mark = null;
  assert.match(guardedAccounts(taken, '/etc/x/keys.env', stat)().problem!, /启动时看不到/);
  mark = { ino: 7, size: 100, mtimeMs: 5, file: false };
  assert.match(guardedAccounts(taken, '/etc/x/keys.env', stat)().problem!, /启动时看不到/);
  assert.match(guardedAccounts(taken, null, stat)().problem!, /启动时看不到/);
  // 启动时文件的大小与拿到的内容对不上：systemd 读完之后、本进程看文件之前被换过，不把换过的文件当基准。
  mark = { ino: 7, size: 100, mtimeMs: 5 };
  assert.match(guardedAccounts({ ...taken, fileSize: 99 }, '/etc/x/keys.env', stat)().problem!, /已更换/);
  assert.deepEqual(guardedAccounts({ ...taken, fileSize: 100 }, '/etc/x/keys.env', stat)(), { accounts: ALL, problem: null });
  // 环境里没有值而文件在：录入后服务还没重启。
  assert.match(guardedAccounts({ accounts: {}, present: false, problem: null }, '/etc/x/keys.env', stat)().problem!, /已写入，等 DEX 价差服务重启/);
  // 没有配置不算问题；内容无效时报告原因。
  assert.deepEqual(guardedAccounts({ accounts: {}, present: false, problem: null }, null, stat)(), { accounts: {}, problem: null });
  assert.match(guardedAccounts({ accounts: {}, present: true, problem: '场所账户的编码无效' }, '/etc/x/keys.env', stat)().problem!, /场所账户文件无效：场所账户的编码无效/);
});

test('录入助手：空行沿用、- 去掉、格式不对被拒；文件 600，全部去掉时删除文件', t => {
  assert.deepEqual(parseKeysInput('12\n\n-\n'), { lighter: '12', rh: null, entropy: 'none' });
  assert.deepEqual(parseKeysInput(''), { lighter: null, rh: null, entropy: null });
  assert.throws(() => parseKeysInput('1\n2\n3\n4\n'), /须为三行/);
  const first = planKeys({}, { lighter: '12345', rh: null, entropy: ADDRESS });
  assert.deepEqual([first.accounts, first.changed], [{ lighter: { accountIndex: 12345 }, entropy: { address: ADDRESS.toLowerCase() } }, true]);
  assert.equal(first.summary, 'DEX 价差实盘账户：已配置 Lighter、Entropy');
  assert.ok(!first.summary.includes('12345') && !first.summary.toLowerCase().includes(ADDRESS.toLowerCase()), '打印的内容不带账户编号与地址');
  assert.equal(planKeys(first.accounts, { lighter: null, rh: null, entropy: null }).changed, false);
  assert.equal(planKeys(first.accounts, { lighter: '12345', rh: null, entropy: ADDRESS.toUpperCase().replace('0X', '0x') }).changed, false, '同值不算改动');
  const dropped = planKeys(first.accounts, { lighter: 'none', rh: '9', entropy: null });
  assert.deepEqual([dropped.accounts, dropped.changed], [{ rh: { accountIndex: 9 }, entropy: { address: ADDRESS.toLowerCase() } }, true]);
  assert.equal(planKeys(first.accounts, { lighter: 'none', rh: null, entropy: 'none' }).summary, 'DEX 价差实盘账户：没有配置任何场所');
  for (const bad of ['-1', '1.5', '0x10', '01', '1e3', ' 7', '9999999999999999']) assert.throws(() => planKeys({}, { lighter: bad, rh: null, entropy: null }), /账户编号/, bad);
  assert.throws(() => planKeys({}, { lighter: null, rh: null, entropy: '0x1234' }), /Entropy 账户地址/);

  const dir = mkdtempSync(path.join(tmpdir(), 'dex-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'keys.env');
  assert.equal(readKeysFile(file), null);
  writeKeysFile(file, first.accounts);
  assert.deepEqual(readKeysFile(file), first.accounts);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  // 助手写出的真实文件，经环境变量取到同一份内容后，用真实的 stat 核对：必须可用（大小绑定与逐字节的写法对得上）。
  const real = takeDexKeys({ [DEX_KEYS_ENV]: readFileSync(file, 'utf8').trim().slice(DEX_KEYS_ENV.length + 1) });
  assert.deepEqual(guardedAccounts(real, file)(), { accounts: first.accounts, problem: null });
  assert.match(guardedAccounts({ accounts: {}, present: false, problem: null }, file)().problem!, /已写入，等 DEX 价差服务重启/);
  writeKeysFile(file, dropped.accounts);
  assert.deepEqual(readKeysFile(file), dropped.accounts, '覆盖已有文件');
  writeKeysFile(file, {});
  assert.equal(existsSync(file), false);
  writeFileSync(file, 'TP_DEX_KEYS="手写的内容"\n');
  assert.throws(() => readKeysFile(file), /不是本程序写出的格式/);
});

test('录入助手的命令行：三行标准输入，输出不带账户；内容坏了也能去掉', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-keys-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'keys.env');
  const run = (args: string[], input = '') => spawnSync(process.execPath, [path.join(root, 'src/dex/keys-setup.ts'), ...args], { input, encoding: 'utf8' });
  const set = run(['--file', file], `12345\n-\n${ADDRESS}\n`);
  assert.deepEqual([set.status, set.stdout, set.stderr], [0, 'DEX 价差实盘账户：已配置 Lighter、Entropy\n', '']);
  assert.deepEqual(decodeDexKeysFile(readFileSync(file, 'utf8')), { lighter: { accountIndex: 12345 }, entropy: { address: ADDRESS.toLowerCase() } });
  const same = run(['--file', file], '\n\n\n');
  assert.deepEqual([same.status, same.stdout], [0, 'DEX 价差实盘账户：已配置 Lighter、Entropy；与现有配置相同，未改动\n']);
  const before = readFileSync(file, 'utf8');
  const bad = run(['--file', file], 'abc\n\n\n');
  assert.deepEqual([bad.status, bad.stdout, readFileSync(file, 'utf8') === before], [1, '', true], '格式不对时不改文件');
  assert.match(bad.stderr, /Lighter 账户编号须为非负整数/);
  assert.equal(run(['--file', 'relative.env'], '').status, 1);
  writeFileSync(file, '坏了');
  assert.equal(run(['--file', file], '1\n\n\n').status, 1, '读不懂已有文件时不覆盖');
  const off = run(['--file', file, '--off']);
  assert.deepEqual([off.status, off.stdout, existsSync(file)], [0, 'DEX 价差实盘账户已去掉\n', false]);
  assert.equal(run(['--file', file, '--off']).stdout, 'DEX 价差实盘账户本来就没有配置\n');
});

const lighterAnswer = (index: number, extra: Record<string, unknown> = {}) => ({ code: 200, total: 1, accounts: [{ code: 0, account_index: index, index, l1_address: '0x1', available_balance: '250.5', collateral: '300.25',
  positions: [{ market_id: 0, symbol: 'ETH', sign: 1, position: '0.0000', position_value: '-0.000000' }, { market_id: 1, symbol: 'NVDA', sign: -1, position: '2.5', position_value: '-437.5' }], ...extra }] });
const entropyAnswer = (available = '80.0') => ({ marginSummary: { accountValue: '120.5', totalNtlPos: '50.0', totalRawUsd: '0', totalMarginUsed: '10' }, withdrawable: available,
  assetPositions: [{ type: 'oneWay', position: { coin: 'io:NVDA', szi: '-0.3', positionValue: '52.5' } }, { type: 'oneWay', position: { coin: 'io:AAPL', szi: '0.0', positionValue: '0.0' } }], time: 1 });

test('账户应答解析：只留非零持仓，账户身份对不上或缺字段时拒绝', () => {
  assert.deepEqual(parseLighterAccount(lighterAnswer(12345), 12345), { collateral: 300.25, available: 250.5, positions: [{ symbol: 'NVDA', size: -2.5, valueUsd: 437.5 }] });
  assert.throws(() => parseLighterAccount(lighterAnswer(12346), 12345), /与请求的账户不一致/);
  assert.throws(() => parseLighterAccount({ code: 29404, message: 'not found' }, 1), /格式无效/);
  assert.throws(() => parseLighterAccount({ code: 200, accounts: [lighterAnswer(1).accounts[0], lighterAnswer(1).accounts[0]] }, 1), /格式无效/);
  assert.throws(() => parseLighterAccount(lighterAnswer(1, { collateral: undefined }), 1), /缺少保证金/);
  assert.throws(() => parseLighterAccount(lighterAnswer(1, { available_balance: '' }), 1), /缺少可用余额/);
  assert.throws(() => parseLighterAccount(lighterAnswer(1, { positions: null }), 1), /缺少持仓/);
  assert.throws(() => parseLighterAccount(lighterAnswer(1, { positions: [{ symbol: 'X', sign: 0, position: '1', position_value: '1' }] }), 1), /持仓格式无效/);
  assert.deepEqual(parseEntropyAccount(entropyAnswer()), { collateral: 120.5, available: 80, positions: [{ symbol: 'io:NVDA', size: -0.3, valueUsd: 52.5 }] });
  assert.deepEqual(parseLighterAccount(lighterAnswer(1, { positions: [{ symbol: 'X', sign: 0, position: '0', position_value: '0' }] }), 1).positions, [], '空仓条目不看方向');
  assert.throws(() => parseEntropyAccount({ assetPositions: [] }), /格式无效/);
  assert.throws(() => parseEntropyAccount({ ...entropyAnswer(), withdrawable: 'x' }), /缺少可用余额/);
  assert.throws(() => parseEntropyAccount({ ...entropyAnswer(), assetPositions: [{ position: null }] }), /持仓格式无效/);
});

const silent = (): SocketLike => { const s: SocketLike = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() { s.readyState = 3; } }; return s; };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('账户读取：Lighter 两套账户走各自的接口，Entropy 的地址放在请求体里', async () => {
  const seen: { url: string; body: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: typeof init.body === 'string' ? init.body : null });
    return url.includes('hyperliquid') ? json(entropyAnswer()) : json(lighterAnswer(url.includes('api.rh.') ? ALL.rh!.accountIndex : ALL.lighter!.accountIndex));
  }) as unknown as typeof fetch;
  const signal = new AbortController().signal;
  assert.equal((await fetchAccount(fetchImpl, signal, 'lighter', ALL)).available, 250.5);
  assert.equal((await fetchAccount(fetchImpl, signal, 'rh', ALL)).available, 250.5);
  assert.equal((await fetchAccount(fetchImpl, signal, 'entropy', ALL)).available, 80);
  assert.deepEqual(seen, [
    { url: 'https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=12345', body: null },
    { url: 'https://api.rh.lighter.xyz/api/v1/account?by=index&value=281474976710654', body: null },
    { url: 'https://api.hyperliquid.xyz/info', body: JSON.stringify({ type: 'clearinghouseState', user: ADDRESS.toLowerCase(), dex: 'io' }) },
  ]);
  await assert.rejects(fetchAccount(fetchImpl, signal, 'rh', { lighter: ALL.lighter }), /没有配置账户/);
  assert.equal(seen.length, 3, '没有配置的场所不发请求');
});

test('实盘准备页：没有录入时待接入；录入后显示各场所余额，余额不足、读数过期、文件被删都不算就绪', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-accounts-'));
  let clock = Date.parse('2026-11-27T15:00:00Z');
  let state: DexAccountsState = { accounts: {}, problem: null };
  let entropyAvailable = '80.0', failing = false;
  const requests: string[] = [];
  const fetchImpl = (async (url: string) => {
    requests.push(url);
    if (failing) return json({}, 500);
    return url.includes('hyperliquid') ? json(entropyAnswer(entropyAvailable)) : json(lighterAnswer(url.includes('api.rh.') ? ALL.rh!.accountIndex : ALL.lighter!.accountIndex));
  }) as unknown as typeof fetch;
  const engine = createVarLighterEngine({ store: openVarLighterStore(path.join(dir, 'varlighter.sqlite')), fetchImpl, connect: silent, now: () => clock, accounts: () => state });
  t.after(() => { engine.close(); rmSync(dir, { recursive: true, force: true }); });
  const signal = new AbortController().signal;
  const item = (key: string) => engine.views.readiness().items.find(entry => entry.key === key)!;

  await engine.refreshAccounts(() => signal);
  assert.equal(requests.length, 0, '没有配置账户时不发请求');
  assert.equal(item('accounts').status, 'todo');
  assert.match(item('accounts').detail, /--set-dex-keys/);
  assert.equal(item('funding').status, 'todo');
  assert.match(item('funding').detail, /Lighter RH 用 USDG/);
  assert.equal(item('lighter_order').status, 'todo', '下单连接器这一步还没有接入');
  assert.equal(engine.views.readiness().ready, false);

  // 只录入了两个场所：没有两腿都是行情流场所的已启用配对时，按三个场所都要用来核对。
  state = { accounts: { lighter: ALL.lighter, entropy: ALL.entropy }, problem: null };
  assert.deepEqual([item('accounts').status, item('accounts').detail], ['warn', '已录入 Lighter、Entropy；还缺 Lighter RH']);
  assert.equal(item('funding').status, 'warn');
  assert.match(item('funding').detail, /Lighter 还没有读到；Entropy 还没有读到/);
  await engine.refreshAccounts(() => signal);
  assert.equal(requests.length, 2);
  assert.match(item('funding').detail, /^Lighter 可用 250\.50、权益 300\.25 USDC，持仓 1 个；Entropy 可用 80\.00、权益 120\.50 USDC，持仓 1 个；可用余额至少 100 才算就绪，未达到：Lighter RH、Entropy$/);
  const text = JSON.stringify(engine.views.readiness());
  assert.ok(!text.includes('12345') && !text.includes(ADDRESS.toLowerCase().slice(2)), '页面与只读接口不带账户编号和地址');

  // 三个场所都录入、余额都够。
  state = { accounts: ALL, problem: null };
  entropyAvailable = String(READY_FUNDING_USD);
  await engine.refreshAccounts(() => signal);
  assert.deepEqual([item('accounts').status, item('accounts').detail], ['ok', '已录入 Lighter、Lighter RH、Entropy']);
  assert.equal(item('funding').status, 'ok');
  assert.match(item('funding').detail, /Lighter RH 可用 250\.50、权益 300\.25 USDG/);

  // 读取失败：旧读数在时限内仍算数，过了时限不算。
  failing = true;
  clock += ACCOUNT_STALE_MS;
  await engine.refreshAccounts(() => signal);
  assert.equal(item('funding').status, 'ok', '刚好在时限内');
  assert.equal(item('accounts').status, 'ok', '读取失败但还有时限内的读数');
  clock += 1;
  assert.equal(item('funding').status, 'warn');
  assert.match(item('funding').detail, /Lighter 可用 250\.50、权益 300\.25 USDC，持仓 1 个（读取失败：HTTP 500）/);
  assert.deepEqual([item('accounts').status, /读不到 Lighter、Lighter RH、Entropy/.test(item('accounts').detail)], ['warn', true], '录入了但读不到不算就绪');
  failing = false;
  await engine.refreshAccounts(() => signal);
  assert.equal(item('funding').status, 'ok');

  // 一个场所不应答：各场所各用各的时限，另外两个照常读到。
  const hung = createVarLighterEngine({ store: openVarLighterStore(path.join(dir, 'hung.sqlite')), connect: silent, now: () => clock, accounts: () => ({ accounts: ALL, problem: null }),
    fetchImpl: ((url: string, init: RequestInit) => url.includes('mainnet.zklighter') ? new Promise((_, fail) => init.signal!.addEventListener('abort', () => fail(new Error('超时')))) : fetchImpl(url, init)) as unknown as typeof fetch });
  try {
  const signals: AbortController[] = [];
  const reading = hung.refreshAccounts(() => { const one = new AbortController(); signals.push(one); return one.signal; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals.length, 3, '每个场所一个时限');
  signals[0]!.abort();
  await reading;
  const hungItems = hung.views.readiness().items;
  assert.match(hungItems.find(entry => entry.key === 'funding')!.detail, /Lighter 读取失败（超时）；Lighter RH 可用 250\.50.*Entropy 可用 100\.00/);
  assert.match(hungItems.find(entry => entry.key === 'accounts')!.detail, /读不到 Lighter（/);
  } finally { hung.close(); }

  // 文件被删：不再读账户，旧读数也不再显示。
  const before = requests.length;
  state = { accounts: {}, problem: '场所账户文件已删除，已停止使用其中的账户' };
  assert.deepEqual([item('accounts').status, item('accounts').detail], ['warn', '场所账户文件已删除，已停止使用其中的账户']);
  assert.equal(item('funding').status, 'todo');
  await engine.refreshAccounts(() => signal);
  assert.equal(requests.length, before, '吊销后不再发请求');
  state = { accounts: ALL, problem: null };
  assert.match(item('funding').detail, /Lighter 还没有读到/, '吊销期间清掉了旧读数');
});
