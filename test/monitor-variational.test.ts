// Monitor M-3d: the Variational row of the oil comparison and the saved session token. The vendored parsers
// (src/vendor/variational-market.mjs), the token file (src/monitor/variational-session.ts), the Python transport
// (src/monitor/variational-transport.ts with scripts/variational-request.py), the reader's choice between authenticated and
// public marks, and the endpoints. Every venue is the stand-in in monitor-fake.ts; nothing reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { calculateExchangeSpread, validateExchangeQuote } from '../src/vendor/exchange-comparison.mjs';
import { createBinanceGate } from '../src/vendor/anthropic-market.mjs';
import {
  parseVariationalFunding, parseVariationalMark, parseVariationalOilQuote, readVariationalAuthenticatedMarks, requestVariational, variationalTokenExpiry,
} from '../src/vendor/variational-market.mjs';
import { createExchangeReader } from '../src/monitor/exchanges.ts';
import { createMonitorStore } from '../src/monitor/store.ts';
import { VARIATIONAL_SESSION_FILE, createVariationalSession, type VariationalSession } from '../src/monitor/variational-session.ts';
import { VARIATIONAL_HELPER, createVariationalFetch, type SpawnImpl } from '../src/monitor/variational-transport.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { monitorViews, openMonitor, stopMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';
import { VARIATIONAL_AUTH_SHIFT, fakeAnthropicVenues, fakeVariationalToken, venuePrice } from './monitor-fake.ts';

const T0 = Date.UTC(2026, 10, 14, 9, 0, 7), DAY = 86_400_000;
const close = (actual: number, expected: number, label = '') => assert.ok(Math.abs(actual - expected) < 1e-12, `${label} ${actual} ≈ ${expected}`);
const temp = () => mkdtempSync(join(tmpdir(), 'tp-variational-'));

function setup({ session = true }: { session?: boolean } = {}) {
  let t = T0;
  const now = () => t, logs: string[] = [];
  const venues = fakeAnthropicVenues({ now });
  const dir = temp();
  const variational = session ? createVariationalSession({ dir, fetcher: venues.variationalFetch, now, log: line => logs.push(line) }) : undefined;
  const reader = createExchangeReader({
    gate: createBinanceGate(), now, log: line => logs.push(line), fetchImpl: venues.fetch, WebSocketImpl: venues.WebSocket,
    oilQuote: () => null, hynixQuote: () => null, variationalFetch: venues.variationalFetch, ...(variational ? { variationalSession: variational } : {}),
  });
  return { venues, dir, logs, reader, variational: variational!, now, advance: (ms: number) => { t += ms; }, dispose: () => { reader.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('解析：预测资金费按 年化 × 周期 ÷ 一年秒数 折成每期；标记价只认 qty 1 与原合约，30 秒以上为过期；公开目录缺合约或重复时报错', () => {
  const next = new Date(T0 + 3 * 3_600_000).toISOString();
  // 0.1095 × 28 800 ÷ 31 536 000 = 0.0001 per 8 h.
  const funding = parseVariationalFunding({ predicted_funding_rate: '0.1095', funding_interval_s: 28_800, next_funding_time: next }, T0);
  close(funding.fundingRate, 0.0001);
  assert.deepEqual([funding.fundingIntervalHours, funding.nextFundingAt], [8, next]);
  assert.throws(() => parseVariationalFunding({ predicted_funding_rate: '0.1', funding_interval_s: 5_400, next_funding_time: next }, T0), /资金费周期/);
  assert.throws(() => parseVariationalFunding({ predicted_funding_rate: '0.1', funding_interval_s: 28_800, next_funding_time: new Date(T0 - 1).toISOString() }, T0), /下次结算/);
  const instrument = (underlying: string) => ({ underlying, instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: 'commodity' });
  const mark = (extra: Record<string, unknown> = {}) => ({ instrument: instrument('BZ'), qty: '1', mark_price: '74.5', bid: '74.4', ask: '74.6', timestamp: new Date(T0 - 1000).toISOString(), ...extra });
  assert.deepEqual(parseVariationalMark(mark(), 'BZ', T0), { price: 74.5, sourceTime: T0 - 1000 });
  assert.throws(() => parseVariationalMark(mark(), 'CL', T0), /合约或报价数量不匹配/);
  assert.throws(() => parseVariationalMark(mark({ qty: '2' }), 'BZ', T0), /合约或报价数量不匹配/);
  assert.throws(() => parseVariationalMark(mark({ timestamp: new Date(T0 - 31_000).toISOString() }), 'BZ', T0), /已过期/);
  assert.throws(() => parseVariationalMark(mark({ ask: '74.3' }), 'BZ', T0), /报价无效/);
  const row = (ticker: string, price = '70') => ({ ticker, mark_price: price, funding_interval_s: 28_800 });
  const quote = parseVariationalOilQuote({ listings: [row('BZ', '74'), row('CL', '70')] }, T0);
  assert.deepEqual([quote.left.price, quote.right.price, quote.left.fundingIntervalHours, quote.left.fundingRate, quote.timestampBasis], [74, 70, 8, null, 'received']);
  assert.throws(() => parseVariationalOilQuote({ listings: [row('BZ'), row('BZ'), row('CL')] }, T0), /Var 原油合约 BZ 缺失或重复/);
  assert.throws(() => parseVariationalOilQuote({ listings: [row('BZ', '0'), row('CL')] }, T0), /Var BZ 标记价格不可用/);
});

test('token：只认单个 vr-token 值并读出声明的到期时间；整段 Cookie、两段式与无 exp 都拒绝', () => {
  const token = fakeVariationalToken(T0 + DAY);
  assert.equal(variationalTokenExpiry(token), Math.floor((T0 + DAY) / 1000) * 1000);
  for (const bad of [`vr-token=${token}`, 'abc.def', `${token.split('.')[0]}.${Buffer.from('{}').toString('base64url')}.sig`, '', null, 'a'.repeat(9000)]) {
    assert.throws(() => variationalTokenExpiry(bad), /Var token 格式无效/, String(bad).slice(0, 40));
  }
});

test('认证请求：只有 401 且 x-omni-auth: r 才算 token 被拒；Cloudflare 拦截、403 与网络失败不算；公开接口不能带 token、认证接口不能不带', async () => {
  const token = fakeVariationalToken(T0 + DAY);
  const answer = (status: number, headers: Record<string, string> = {}) => async () => new Response('{}', { status, headers: { 'content-type': 'application/json', ...headers } });
  const reason = async (fetcher: () => Promise<Response>) => {
    try { await requestVariational('/me', token, { fetcher }); return null; } catch (error) { return error as { message: string; rejected: boolean; blocked: boolean }; }
  };
  assert.deepEqual(await reason(answer(401, { 'x-omni-auth': 'r' })).then(e => [e?.rejected, e?.message]), [true, 'Variational 未通过会话认证，请更新 token。']);
  assert.deepEqual(await reason(answer(401)).then(e => [e?.rejected, e?.blocked]), [false, false]);
  assert.deepEqual(await reason(answer(403, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' })).then(e => [e?.rejected, e?.blocked, e?.message]), [false, true, '服务器访问 Variational 被拦截，请稍后重试；这不代表 token 已过期。']);
  assert.deepEqual(await reason(async () => { throw Object.assign(new Error('x'), { code: 'VARIATIONAL_PYTHON_MISSING' }); }).then(e => e?.message), 'Variational 请求需要 Python 3，请重新运行一键部署或安装 Python 3。');
  assert.deepEqual(await reason(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }).then(e => e?.message), 'Variational 请求超时，请稍后重试。');
  await assert.rejects(requestVariational('/me', null, { fetcher: answer(200) }), /需要有效会话/);
  await assert.rejects(requestVariational('/portfolio' as never, token, { fetcher: answer(200) }), /不支持的 Variational 数据接口/);
  // A leg's own reason survives the pair (the workbench folds it into one text).
  const venues = fakeAnthropicVenues({ now: () => T0 });
  venues.variationalMode = 'challenge';
  await assert.rejects(readVariationalAuthenticatedMarks(token, { fetcher: venues.variationalFetch, clock: () => T0 }), /被拦截/);
});

test('读取器：没有 token 时用公开标记价与公开预测资金费，年化按手算一致；公开资金费请求不带 token', async () => {
  const s = setup({ session: false });
  try {
    const quote = await s.reader.quote('oil', 'variational');
    const left = venuePrice('variational', 'BZ', T0), right = venuePrice('variational', 'CL', T0);
    assert.deepEqual([quote.left.price, quote.right.price, quote.timestampBasis, quote.fundingError], [left, right, 'received', '']);
    close(quote.left.fundingRate!, 0.0001); close(quote.right.fundingRate!, -0.00004);
    // Both legs settle every 8 h: (L × 0.0001 − R × −0.00004) ÷ 8 ÷ (L + R) × 8760.
    close(calculateExchangeSpread(quote).shortAnnualized!, (left * 0.0001 + right * 0.00004) / 8 / (left + right) * 8760);
    assert.deepEqual(validateExchangeQuote(JSON.parse(JSON.stringify(quote)), 'variational', 'oil'), quote);
    assert.deepEqual([s.venues.requests.get('variational:indicative'), s.venues.variationalTokens], [undefined, []]);
    s.venues.variationalFundingDown = true; s.advance(6_000);
    const missing = await s.reader.quote('oil', 'variational');
    assert.deepEqual([missing.left.fundingRate, missing.fundingError, calculateExchangeSpread(missing).shortAnnualized], [null, 'Var 公开资金费暂不可用（Variational 暂不可用），后台将自动重试；无需更新 token。', null]);
    s.venues.exchangeDown.add('variational'); s.advance(6_000);
    await assert.rejects(s.reader.quote('oil', 'variational'), /接口返回 HTTP 500/);
  } finally { s.dispose(); }
});

test('读取器：保存了有效 token 时用认证标记价并标“已配置”；被拒后退回公开价格、不再带 token；被拦截只标暂不可用', async () => {
  const s = setup();
  try {
    const token = fakeVariationalToken(T0 + DAY);
    await s.variational.update({ token, revision: 0 });
    const quote = await s.reader.quote('oil', 'variational');
    close(quote.left.price, Math.round((venuePrice('variational', 'BZ', T0) + VARIATIONAL_AUTH_SHIFT) * 1000) / 1000, 'auth left');
    assert.deepEqual([quote.timestampBasis, quote.fetchedAt, s.variational.view().status], ['source', new Date(T0 - 1000).toISOString(), 'ready']);
    assert.ok(quote.left.fundingRate !== null, '公开资金费照样接上');

    s.venues.variationalMode = 'challenge'; s.advance(6_000);
    const blocked = await s.reader.quote('oil', 'variational').catch(error => error as Error);
    // Challenged: the funding is blocked too, the public marks still answer; the token is not called invalid.
    assert.ok(!(blocked instanceof Error), String(blocked));
    assert.deepEqual([blocked.left.price, s.variational.view().status], [venuePrice('variational', 'BZ', T0 + 6_000), 'unavailable']);
    assert.match(s.variational.view().error, /认证行情暂不可用/);

    s.venues.variationalMode = 'reject'; s.advance(6_000);
    const rejected = await s.reader.quote('oil', 'variational');
    assert.deepEqual([rejected.left.price, s.variational.view().status, s.variational.current().token], [venuePrice('variational', 'BZ', T0 + 12_000), 'rejected', null]);
    const sent = s.venues.variationalTokens.length;
    s.advance(6_000);
    await s.reader.quote('oil', 'variational');
    assert.equal(s.venues.variationalTokens.length, sent, '被拒的 token 不再发出');
    assert.ok(!s.logs.some(line => line.includes(token)), '日志不带 token');
  } finally { s.dispose(); }
});

test('读取器：本机没有 python3 时公开价格照常，资金费与认证行情的空缺都带原因，日志按原因只记一次、恢复记一次', async () => {
  let t = T0;
  const venues = fakeAnthropicVenues({ now: () => t }), dir = temp(), logs: string[] = [];
  let missing = true;
  const fetcher = async (url: string, init: RequestInit) => {
    if (missing) throw Object.assign(new Error('x'), { code: 'VARIATIONAL_PYTHON_MISSING' });
    return venues.variationalFetch(url, init);
  };
  const session = createVariationalSession({ dir, fetcher: venues.variationalFetch, now: () => t, log: () => undefined });
  const reader = createExchangeReader({ gate: createBinanceGate(), now: () => t, log: line => logs.push(line), fetchImpl: venues.fetch, oilQuote: () => null, hynixQuote: () => null, variationalSession: session, variationalFetch: fetcher });
  try {
    await session.update({ token: fakeVariationalToken(T0 + DAY), revision: 0 });
    const quote = await reader.quote('oil', 'variational');
    assert.deepEqual([quote.timestampBasis, quote.left.fundingRate], ['received', null]);
    assert.equal(quote.fundingError, 'Var 公开资金费暂不可用（Variational 请求需要 Python 3，请重新运行一键部署或安装 Python 3），后台将自动重试；无需更新 token。');
    assert.deepEqual([session.view().status, session.view().error], ['unavailable', '认证行情暂不可用（Variational 请求需要 Python 3，请重新运行一键部署或安装 Python 3），后台将自动重试；公开行情不受影响。']);
    t += 6_000; await reader.quote('oil', 'variational');
    assert.equal(logs.filter(line => line.includes('读取失败')).length, 2, '认证与资金费各记一次');
    missing = false; t += 6_000;
    const back = await reader.quote('oil', 'variational');
    assert.deepEqual([back.timestampBasis, back.fundingError, session.view().status, session.view().error], ['source', '', 'ready', '']);
    assert.equal(logs.filter(line => line.endsWith('已恢复')).length, 2);
  } finally { reader.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('读取器：认证读取途中 token 被换掉时丢弃旧结果重读，旧 token 的拒绝不会落到新 token 上', async () => {
  const venues = fakeAnthropicVenues({ now: () => T0 });
  const tokens = [fakeVariationalToken(T0 + DAY, 'old'), fakeVariationalToken(T0 + DAY, 'new')];
  let revision = 1;
  const reports: [number, string][] = [];
  const session = {
    current: () => ({ token: tokens[revision - 1]!, revision, status: 'ready' as const }),
    report: (rev: number, next: string) => { reports.push([rev, next]); },
  } as unknown as VariationalSession;
  // The old token is rejected, and while its answer is on the way the page saves the new one.
  const fetcher = async (url: string, init: RequestInit) => {
    const carried = new Headers(init.headers).get('cookie') ?? '';
    if (carried.includes(tokens[0]!)) { revision = 2; return new Response('{}', { status: 401, headers: { 'x-omni-auth': 'r' } }); }
    return venues.variationalFetch(url, init);
  };
  const store = createMonitorStore({ file: ':memory:', now: () => T0 });
  const reader = createExchangeReader({ gate: createBinanceGate(), quoteStore: store, now: () => T0, log: () => undefined, fetchImpl: venues.fetch, oilQuote: () => null, hynixQuote: () => null, variationalSession: session, variationalFetch: fetcher });
  try {
    const quote = await reader.quote('oil', 'variational');
    assert.equal(quote.timestampBasis, 'source', '用新 token 的认证价格');
    assert.deepEqual(reports, [[2, 'ready']]);
    assert.equal(store.readState('comparison.v1.oil.variational'), null);
  } finally { reader.stop(); store.close(); }
});

test('token 文件：保存前先经 /me 确认，写成 600；版本冲突 409、过期 400、3 秒内重复 429、/me 被拒或被拦截时原配置不变', async () => {
  const s = setup();
  try {
    const file = join(s.dir, VARIATIONAL_SESSION_FILE);
    assert.deepEqual(s.variational.view(), { available: true, configured: false, revision: 0, expiresAt: null, updatedAt: null, status: 'missing', error: '' });
    const code = (operation: Promise<unknown>) => operation.then(() => 'ok', (error: { status: number; code: string }) => `${error.status} ${error.code}`);
    const token = fakeVariationalToken(T0 + DAY);
    assert.equal(await code(s.variational.update({ token, revision: 0, extra: 1 })), '400 invalid_session');
    assert.equal(await code(s.variational.update({ token: `vr-token=${token}`, revision: 0 })), '400 invalid_session');
    assert.equal(await code(s.variational.update({ token: fakeVariationalToken(T0 + 20_000), revision: 0 })), '400 invalid_session');
    assert.equal(await code(s.variational.update({ token, revision: 3 })), '409 session_conflict');
    s.venues.variationalMode = 'reject';
    assert.equal(await code(s.variational.update({ token, revision: 0 })), '400 session_rejected');
    assert.equal(await code(s.variational.update({ token, revision: 0 })), '429 session_rate_limited');
    s.advance(3_000); s.venues.variationalMode = 'challenge';
    const blocked = await s.variational.update({ token, revision: 0 }).catch(error => error as Error & { status: number });
    assert.deepEqual([(blocked as { status: number }).status, (blocked as Error).message], [502, '服务器访问 Variational 被拦截，请稍后重试；这不代表 token 已过期。 原配置未修改。']);
    assert.throws(() => statSync(file), /ENOENT/);

    s.advance(3_000); s.venues.variationalMode = 'accept';
    const saved = await s.variational.update({ token: `  ${token}\n`, revision: 0 });
    assert.deepEqual([saved.configured, saved.revision, saved.status, saved.expiresAt, saved.updatedAt], [true, 1, 'ready', new Date(variationalTokenExpiry(token)).toISOString(), new Date(T0 + 6_000).toISOString()]);
    assert.ok(!JSON.stringify(saved).includes(token), '状态不带 token');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, revision: 1, token, updatedAt: new Date(T0 + 6_000).toISOString() });
    assert.equal(s.logs.at(-1), `行情监控：已更新 Var token（版本 1，声明到期 ${new Date(variationalTokenExpiry(token)).toISOString()}）`);
    // Restarted: the saved token is used again; once its expiry is near it is not.
    const again = createVariationalSession({ dir: s.dir, fetcher: s.venues.variationalFetch, now: s.now, log: () => undefined });
    assert.deepEqual([again.view().revision, again.current().token], [1, token]);
    s.advance(DAY - 6_000 - 25_000);
    assert.deepEqual([again.view().status, again.current().token], ['expired', null]);
  } finally { s.dispose(); }
});

test('token 文件：写入失败 503 原配置保留；文件权限不是 600 或内容坏了时忽略并说明，页面保存一次即覆盖', async () => {
  const dir = temp();
  try {
    const venues = fakeAnthropicVenues({ now: () => T0 });
    const missing = createVariationalSession({ dir: join(dir, 'gone'), fetcher: venues.variationalFetch, now: () => T0, log: () => undefined });
    await assert.rejects(missing.update({ token: fakeVariationalToken(T0 + DAY), revision: 0 }), (error: { status: number; code: string }) => error.status === 503 && error.code === 'session_unsaved');
    assert.equal(missing.view().configured, false);

    const file = join(dir, VARIATIONAL_SESSION_FILE), token = fakeVariationalToken(T0 + DAY);
    writeFileSync(file, JSON.stringify({ version: 1, revision: 4, token, updatedAt: new Date(T0).toISOString() }), { mode: 0o644 });
    chmodSync(file, 0o644);
    const logs: string[] = [];
    const loose = createVariationalSession({ dir, fetcher: venues.variationalFetch, now: () => T0, log: line => logs.push(line) });
    assert.deepEqual([loose.view().configured, loose.view().status, loose.view().error, loose.current().token], [false, 'missing', '保存的 Var token 文件权限不是 600，已忽略；请重新保存 token。', null]);
    assert.ok(logs.length === 1 && !logs[0]!.includes(token));
    const saved = await loose.update({ token, revision: 0 });
    assert.deepEqual([saved.revision, saved.error, statSync(file).mode & 0o777], [1, '', 0o600]);

    writeFileSync(file, '{not json', { mode: 0o600 });
    const broken = createVariationalSession({ dir, fetcher: venues.variationalFetch, now: () => T0, log: () => undefined });
    assert.equal(broken.view().error, '保存的 Var token 文件无法读取或内容无效，已忽略；请重新保存 token。');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A child process stand-in: records what reached stdin, answers as told. */
function fakeSpawn(behave: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }, input: string) => void) {
  const calls: { command: string; args: string[]; input: string; env: NodeJS.ProcessEnv | undefined }[] = [];
  const spawnImpl = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; setImmediate(() => child.emit('close', null)); return true; } });
    const call = { command, args, input: '', env: options.env };
    calls.push(call);
    child.stdin.on('data', chunk => { call.input += String(chunk); });
    child.stdin.on('finish', () => behave(child, call.input));
    return child;
  }) as unknown as SpawnImpl;
  return { calls, spawnImpl };
}

test('传输：白名单外的地址、请求头与请求体不启动子进程；token 只经标准输入传入；退出码非 0、超时、中止与缺 Python 都给固定原因', async () => {
  const token = fakeVariationalToken(T0 + DAY);
  const answer = (body: unknown, status = 200) => JSON.stringify({ status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)).toString('base64') });
  const ok = fakeSpawn((child, input) => { child.stdout.end(answer({ echo: JSON.parse(input).url })); child.emit('close', 0); });
  const fetcher = createVariationalFetch({ spawnImpl: ok.spawnImpl, helper: '/helper.py' });
  const me = { method: 'GET', headers: { Accept: 'application/json', Cookie: `vr-token=${token}` }, redirect: 'error' as const };
  const response = await fetcher('https://omni.variational.io/api/me', me);
  assert.deepEqual(await response.json(), { echo: 'https://omni.variational.io/api/me' });
  assert.deepEqual([ok.calls[0]!.command, ok.calls[0]!.args], ['python3', ['-I', '-B', '/helper.py']]);
  assert.deepEqual(Object.keys(ok.calls[0]!.env ?? {}), process.env.PATH ? ['PATH'] : [], '子进程只拿到 PATH');
  assert.ok(ok.calls[0]!.input.includes(token) && !ok.calls[0]!.args.join(' ').includes(token), 'token 只在标准输入');
  const invalid = [
    ['https://omni.variational.io/api/portfolio', me],
    ['https://evil.example/api/me', me],
    ['https://omni.variational.io/api/me', { ...me, headers: { ...me.headers, 'X-Extra': '1' } }],
    ['https://omni.variational.io/api/me', { ...me, redirect: 'follow' as const }],
    ['https://omni.variational.io/api/me', { method: 'GET', headers: {} }],
    ['https://omni.variational.io/api/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future', me],
    ['https://omni.variational.io/api/quotes/indicative', { method: 'POST', headers: me.headers, body: JSON.stringify({ instrument: { underlying: 'BTC', instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: 'commodity' }, qty: '1' }) }],
  ] as const;
  for (const [url, init] of invalid) await assert.rejects(fetcher(url, init as RequestInit), /不支持的 Variational 数据请求/, url);
  assert.equal(ok.calls.length, 1, '无效请求不启动子进程');

  const exit = createVariationalFetch({ spawnImpl: fakeSpawn(child => { child.stderr.end(`Traceback ${token}`); child.emit('close', 2); }).spawnImpl });
  await assert.rejects(exit('https://omni.variational.io/api/me', me), (error: Error) => error.message === 'Variational 标准行情传输暂不可用，请稍后重试。');
  const silent = fakeSpawn(() => undefined);
  await assert.rejects(createVariationalFetch({ spawnImpl: silent.spawnImpl, timeoutMs: 20 })('https://omni.variational.io/api/me', me), /超时/);
  const aborted = new AbortController();
  const pending = createVariationalFetch({ spawnImpl: fakeSpawn(() => undefined).spawnImpl })('https://omni.variational.io/api/me', { ...me, signal: aborted.signal });
  aborted.abort();
  await assert.rejects(pending, /已取消/);
  const noPython = (() => { const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); setImmediate(() => child.emit('error', Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }))); return child; }) as unknown as SpawnImpl;
  await assert.rejects(createVariationalFetch({ spawnImpl: noPython })('https://omni.variational.io/api/me', me), /需要 Python 3/);
});

const testPython = process.platform === 'win32' ? 'python' : 'python3';
test('传输脚本：真实子进程把直接和 urllib 包装的套接字超时映射为专用退出码，普通故障仍保留原分类', {
  skip: spawnSync(testPython, ['--version']).status !== 0 && '本机没有 Python 3',
}, async () => {
  // The shipped helper validates stdin and sets its own exit status; an idle local socket pair produces the actual timeout.
  const fixture = `
import runpy, socket, sys, urllib.error, urllib.request
mode = sys.argv[2]
def opened(self, request, timeout):
    if mode == "refused":
        raise urllib.error.URLError(ConnectionRefusedError("private upstream detail"))
    left, right = socket.socketpair()
    with left, right:
        left.settimeout(0.01)
        try:
            left.recv(1)
        except socket.timeout as error:
            if mode == "wrapped":
                raise urllib.error.URLError(error) from None
            raise
urllib.request.OpenerDirector.open = opened
runpy.run_path(sys.argv[1], run_name="__main__")
`;
  for (const [mode, expectedExit, name, expectedCode] of [['direct', 3, 'TimeoutError', 'VARIATIONAL_TIMEOUT'], ['wrapped', 3, 'TimeoutError', 'VARIATIONAL_TIMEOUT'], ['refused', 2, 'Error', 'VARIATIONAL_TRANSPORT_FAILURE']] as const) {
    const output: Buffer[] = [];
    let exit: number | null = null;
    const fetcher = createVariationalFetch({ spawnImpl: (_command, args, options) => {
      const child = spawn(testPython, [...args.slice(0, -1), '-c', fixture, args.at(-1)!, mode], { ...options, stdio: 'pipe' });
      child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
      child.once('exit', code => { exit = code; });
      return child;
    } });
    const publicUrl = 'https://omni.variational.io/api/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future';
    await assert.rejects(fetcher(publicUrl, {}), (error: Error & { code?: string }) => {
      assert.equal(error.name, name); assert.equal(error.code, expectedCode); assert.ok(!error.message.includes('private upstream detail')); return true;
    });
    assert.deepEqual([exit, Buffer.concat(output).length], [expectedExit, 0], mode);
  }
});

test('传输脚本：真实 python3 收到白名单外或格式不对的输入时只以退出码 2 结束，不打印输入', { skip: spawnSync('python3', ['--version']).status !== 0 && '本机没有 python3' }, () => {
  const token = fakeVariationalToken(T0 + DAY);
  for (const input of ['not json', JSON.stringify({ url: 'https://evil.example/api/me', method: 'GET', headers: { Cookie: `vr-token=${token}` }, body: null }), JSON.stringify({ url: 'https://omni.variational.io/api/me', method: 'GET', headers: { Cookie: `vr-token=${token}` }, body: null, extra: 1 })]) {
    const run = spawnSync('python3', ['-I', '-B', VARIATIONAL_HELPER], { input, encoding: 'utf8', timeout: 10_000 });
    assert.deepEqual([run.status, run.stdout, run.stderr], [2, '', ''], input.slice(0, 40));
  }
});

test('接口：状态与保存在登录之后，保存须带页面请求标记；状态不带 token；原油关闭时 423；只有海力士时 404；Var 没有结算历史', async () => {
  const dir = temp();
  const t = T0;
  const venues = fakeAnthropicVenues({ now: () => t });
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { oil: {}, hynix: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { fetchImpl: venues.fetch, WebSocketImpl: venues.WebSocket, variationalFetch: venues.variationalFetch, now: () => t, log: () => undefined });
  const h = createHarness();
  const views = { monitor: monitorViews(runtime) };
  const server = createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0011', views });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${url}/login?token=monitor-token-0011`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const call = async (path: string, body?: unknown, headers: Record<string, string> = { 'x-pa-executor': '1', 'content-type': 'application/json' }) => {
      const response = await fetch(url + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, ...headers }, body: JSON.stringify(body) });
      return { status: response.status, text: await response.text() };
    };
    const path = '/api/monitor/oil/exchanges/variational/session', token = fakeVariationalToken(T0 + DAY);
    assert.equal((await fetch(url + path)).status, 401);
    assert.equal((await fetch(url + path, { method: 'POST', headers: { 'x-pa-executor': '1', 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await call(path, { token, revision: 0 }, { 'content-type': 'application/json' })).status, 403);
    assert.deepEqual(JSON.parse((await call(path)).text).status, 'missing');
    const saved = await call(path, { token, revision: 0 });
    assert.equal(saved.status, 200);
    assert.ok(!saved.text.includes(token) && !(await call(path)).text.includes(token), '应答不带 token');
    assert.equal(JSON.parse((await call(path, { token, revision: 0 })).text).code, 'session_conflict');
    const row = await call('/api/monitor/oil/exchanges/variational');
    assert.equal(row.status, 200);
    assert.equal(validateExchangeQuote(JSON.parse(row.text), 'variational', 'oil').timestampBasis, 'source');
    assert.equal((await call('/api/monitor/oil/exchanges/variational/funding-history')).status, 404);
    assert.equal((await call('/api/monitor/hynix/exchanges/variational')).status, 404);
    await call('/api/monitor/oil/control', { enabled: false, revision: 0 });
    assert.deepEqual([(await call(path)).status, (await call(path, { token, revision: 1 })).status, (await call('/api/monitor/oil/exchanges/variational')).status], [423, 423, 423]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose(); stopMonitor(runtime); runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const hynixOnly = temp();
  const other = openMonitor(parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } }).monitor!, hynixOnly, { fetchImpl: venues.fetch, log: () => undefined });
  const server2 = createExecutorServer({ executor: createHarness().ex, accessToken: 'monitor-token-0012', views: { monitor: monitorViews(other) } });
  try {
    assert.equal(other.variational, null);
    await new Promise<void>(resolve => server2.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${url}/login?token=monitor-token-0012`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.equal((await fetch(`${url}/api/monitor/oil/exchanges/variational/session`, { headers: { cookie } })).status, 404);
  } finally {
    await new Promise(resolve => server2.close(resolve));
    stopMonitor(other); other.store.close();
    rmSync(hynixOnly, { recursive: true, force: true });
  }

});

test('页面：Var token 表单只认完整的状态应答；到期时间已过的“已配置”显示为已过期；409 要求先刷新，无应答时结果未知', async () => {
  const { parseSessionView, shownStatus, saveFailure } = await import('../web/src/monitor-variational.ts');
  const { ApiError } = await import('../web/src/api.ts');
  const view = { available: true, configured: true, revision: 2, expiresAt: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString(), status: 'ready', error: '' };
  assert.deepEqual(parseSessionView(view), view);
  for (const bad of [null, [], { ...view, status: 'ok' }, { ...view, revision: -1 }, { ...view, expiresAt: 'soon' }, { ...view, error: undefined }]) {
    assert.throws(() => parseSessionView(bad), /配置返回格式不正确/);
  }
  const parsed = parseSessionView(view);
  assert.deepEqual([shownStatus(parsed, T0), shownStatus(parsed, T0 + 60_000), shownStatus({ ...parsed, status: 'rejected' }, T0 + 60_000)], ['ready', 'expired', 'rejected']);
  assert.deepEqual(saveFailure(new ApiError('x', 409, 'session_conflict')), { message: '配置已被其他页面更新，请先刷新配置，再确认后保存。', reload: true });
  assert.deepEqual(saveFailure(new ApiError('Variational 未通过会话认证，请更新 token。 原配置未修改。', 400, 'session_rejected')), { message: 'Variational 未通过会话认证，请更新 token。 原配置未修改。', reload: false });
  assert.deepEqual(saveFailure(new ApiError('请求失败（HTTP 502）', 502)), { message: '保存结果未确认，请刷新配置后再重试。', reload: true });
  assert.deepEqual(saveFailure(new DOMException('请求超时', 'TimeoutError')), { message: '保存结果未确认，请刷新配置后再重试。', reload: true });
});
