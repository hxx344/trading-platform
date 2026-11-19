// The read-only API token (docs/mcp.md): the token branch in front of the routes, the masking of its answers, the
// limits, expiry and its reminders, and the page-only management.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExecutorServer, type ServiceViews } from '../src/http.ts';
import { LoginThrottle } from '../src/login-password.ts';
import { READ_TOKEN_FILE, READ_TOKEN_ROUTES, READ_TOKEN_TTL_MS, createReadTokens, readTokenAllows } from '../src/read-token.ts';
import { createRedactor, identifierField } from '../src/read-redact.ts';
import { bindAccounts, createHarness } from './harness.ts';

const TOKEN = 'read-token-access-0001';
const SESSION = 'read-token-session-0001';
const ADDRESS = `0x${'ab12'.repeat(10)}`;
const ADDRESS_UPPER = `0x${'AB12'.repeat(10)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const SIGNATURE = `0x${'cd'.repeat(65)}`;
const HEX_RUN = /0x[0-9a-fA-F]{40,}/;

/** Views carrying identifiers in every way the masking must catch: by value, by field name, as a key, inside log text. */
function views(overrides: Partial<ServiceViews> = {}): ServiceViews {
  return {
    status: () => ({ feishu: { configured: true, recent: [{ text: '账户 ***9a7b 已暂停' }] }, streams: [{ account: '***9a7b' }], wallet: ADDRESS, nested: { subAccountId: 123456, signer: ADDRESS_UPPER, note: `tx ${HASH}` }, [ADDRESS]: { balance: '1.5' } }),
    logs: (_filter, _before, limit) => ({ items: [{ id: '1', at: 1, level: 'info', text: `划转完成 ${HASH} 签名 ${SIGNATURE} 账户 ${ADDRESS}` }, { id: '2', at: 2, level: 'problem', text: 'Binance 密钥属于 UID 88776655，与配置的账户 ***6655 不一致' }].slice(0, limit), next: null }),
    oil: { market: () => ({}), state: () => ({ accounts: [{ label: 'oil-a', accountId: 'gate-998877', uid: 4455, user: ADDRESS }] }), pnl: () => ({ rows: [] }) },
    update: { status: () => ({ current: 'v0.69.0' }), check: async () => ({}), apply: () => ({}) },
    ...overrides,
  };
}

async function start({ now = () => clock.now, extra = {} as Partial<ServiceViews>, readTokens = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-read-token-'));
  const h = createHarness();
  bindAccounts(h.ex);
  const lines: string[] = [];
  const tokens = readTokens ? createReadTokens({ dir, now, log: line => lines.push(line) }) : undefined;
  const server = createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, views: views(extra), log: line => lines.push(line),
    ...(tokens ? { readTokens: tokens } : {}), tokenThrottle: new LoginThrottle(now) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const sessionPost = (path: string, body: unknown = {}) => fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) });
  const generate = async () => {
    const response = await sessionPost('/api/read-token/generate');
    assert.equal(response.status, 200);
    return (await response.json() as { token: string }).token;
  };
  const read = (token: string, path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers as Record<string, string> } });
  return {
    dir, base, cookie, lines, tokens, sessionPost, generate, read,
    async close() { await new Promise(resolve => server.close(resolve)); h.dispose(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const clock = { now: Date.UTC(2026, 10, 19) };

test('只读令牌：没有令牌文件、令牌错误一律 401；连续错误后锁定为 429；未配置令牌功能时同样 401', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    assert.equal((await s.read(`tpr_${'A'.repeat(43)}`, '/api/status')).status, 401, '尚未生成');
    const token = await s.generate();
    assert.equal((await s.read(token, '/api/status')).status, 200);
    assert.equal((await s.read(`${token}x`, '/api/status')).status, 401);
    assert.equal((await fetch(`${s.base}/api/status`, { headers: { authorization: token } })).status, 401, '缺少 Bearer');
    let locked = false;
    for (let i = 0; i < 12 && !locked; i += 1) locked = (await s.read(`tpr_${'B'.repeat(43)}`, '/api/status')).status === 429;
    assert.ok(locked, '连续错误后锁定');
    assert.equal((await s.read(token, '/api/status')).status, 429, '锁定期间正确令牌也要等');
    clock.now += 10 * 60_000;
    assert.equal((await s.read(token, '/api/status')).status, 200, '锁定结束后恢复');
    assert.ok(s.lines.every(line => !line.includes(token) && !line.includes('B'.repeat(43))), '日志不含令牌');
  } finally { await s.close(); }
  const without = await start({ readTokens: false });
  try { assert.equal((await without.read(`tpr_${'A'.repeat(43)}`, '/api/status')).status, 401); }
  finally { await without.close(); }
});

test('只读令牌：白名单外的 GET、所有 POST、页面、静态资源、登录与令牌管理一律 403；多余查询参数 403；同时带 cookie 403', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    const token = await s.generate();
    // Every /api path literal the routes know, and the dynamic ones by example: each is either on the list or refused.
    const source = readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8');
    const literals = [...new Set([...source.matchAll(/'(\/api\/[a-z0-9/_-]+)'/g)].map(match => match[1]!))];
    const dynamic = ['/api/transfer-pairs/xau/balances', '/api/jobs/00000000-0000-4000-8000-000000000000', '/api/monitor/oil/exchanges/gate', '/api/monitor/oil/exchanges/gate/funding-history',
      '/api/monitor/oil/funding', '/api/monitor/perpetual/quote', '/api/monitor/perpetual/summary', '/api/monitor/perpetual/stream', '/api/monitor/perpetual/depth', '/api/crossex/instruments', '/api/crossex/market',
      '/api/crossex/bootstrap', '/api/crossex/requests/x', '/api/ondo/rewards', '/api/ondo/rewards/book', '/api/options/market', '/api/options/preview', '/api/options/rfq', '/api/asset/state', '/api/asset/ledger',
      '/api/asset/positions', '/api/asset/fills', '/api/observe', '/api/import', '/api/read-token', '/', '/assets/index.js', '/login', '/api/ready', '/api/unknown'];
    assert.ok(literals.length > 30, `路由里的路径字面量：${literals.length}`);
    for (const path of [...literals, ...dynamic]) {
      const allowed = readTokenAllows(new URL(path, 'http://x'));
      const response = await s.read(token, path);
      if (allowed) assert.notEqual(response.status, 403, path);
      else {
        assert.equal(response.status, 403, path);
        assert.equal((await response.json() as { code: string }).code, 'read_only', path);
      }
    }
    for (const path of ['/api/status', '/api/read-token/generate', '/api/read-token/revoke', '/api/read-token/lookup', '/api/summary/send', '/api/confirm', '/api/update/check']) {
      const response = await s.read(token, path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pa-executor': '1' }, body: '{}' });
      assert.equal(response.status, 403, path);
    }
    assert.equal((await s.read(token, '/api/status', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-pa-executor': '1' }, body: '{}' })).status, 403);
    assert.equal((await s.read(token, '/api/logs?limit=5&filter=all')).status, 403, '不在表里的查询参数');
    assert.equal((await s.read(token, '/api/logs?limit=5')).status, 200);
    const both = await s.read(token, '/api/status', { headers: { cookie: s.cookie } });
    assert.equal(both.status, 403);
    assert.equal((await both.json() as { code: string }).code, 'token_cookie');
    const page = await s.read(token, '/');
    assert.equal(page.headers.get('set-cookie'), null, '令牌换不到 cookie');
    // The list itself: only GET reads, none of them an asset, import, exchange or stream route.
    for (const { path } of READ_TOKEN_ROUTES) assert.doesNotMatch(String(path), /asset|import|observe|exchanges|stream|balances|rewards|market|preview|rfq|bootstrap|instruments|session|read-token|check|apply/);
  } finally { await s.close(); }
});

test('只读令牌：应答按值与按字段打码，原值不出现；同一原值在不同接口别名一致；会话访问不打码', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    const token = await s.generate();
    const status = await (await s.read(token, '/api/status')).text();
    const logs = await (await s.read(token, '/api/logs')).text();
    const oil = await (await s.read(token, '/api/oil/state')).text();
    for (const body of [status, logs, oil]) {
      assert.doesNotMatch(body, HEX_RUN, body);
      assert.doesNotMatch(body, /:123456\b|gate-998877|"uid":4455|\*\*\*|UID 8877665/, body);
    }
    const addr = /addr-[0-9a-f]{8}/.exec(status)![0];
    const masked = JSON.parse(status) as { streams: { account: string }[]; feishu: { recent: { text: string }[] } };
    assert.equal(masked.feishu.recent[0]!.text, `账户 ${masked.streams[0]!.account} 已暂停`, '***后四位按值打码，与字段里的同一别名');
    assert.match(logs, /UID acct-[0-9a-f]{8}，与配置的账户 acct-[0-9a-f]{8} 不一致/);
    assert.ok(logs.includes(addr) && oil.includes(addr), '同一地址在三个接口里别名相同');
    assert.equal(status.split(addr).length - 1, 3, '值、大小写不同的同一地址和对象键都打码为同一别名');
    assert.match(logs, /tx-[0-9a-f]{8}.*tx-[0-9a-f]{8}/, '哈希与签名');
    const parsed = JSON.parse(oil) as { accounts: { label: string; accountId: string; uid: string }[] };
    assert.equal(parsed.accounts[0]!.label, 'oil-a', '标签不打码');
    assert.match(parsed.accounts[0]!.accountId, /^acct-[0-9a-f]{8}$/);
    assert.match(parsed.accounts[0]!.uid, /^acct-[0-9a-f]{8}$/);
    const plain = await (await fetch(`${s.base}/api/status`, { headers: { cookie: s.cookie } })).text();
    assert.ok(plain.includes(ADDRESS), '会话应答不变');
    // The page's lookup, session only; a new token gives new aliases and forgets the old ones.
    const lookup = await s.sessionPost('/api/read-token/lookup', { alias: addr });
    assert.deepEqual(await lookup.json(), { alias: addr, original: ADDRESS });
    const acct = parsed.accounts[0]!.accountId;
    assert.equal((await (await s.sessionPost('/api/read-token/lookup', { alias: acct })).json() as { original: string }).original, 'gate-998877');
    assert.equal((await s.sessionPost('/api/read-token/lookup', { alias: 'nope' })).status, 400);
    assert.equal((await s.read(token, '/api/read-token/lookup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify({ alias: addr }) })).status, 403);
    const next = await s.generate();
    assert.equal((await s.read(token, '/api/status')).status, 401, '重新生成后旧令牌立即失效');
    const renamed = await (await s.read(next, '/api/status')).text();
    assert.ok(!renamed.includes(addr), '换令牌后别名改变');
    assert.equal((await (await s.sessionPost('/api/read-token/lookup', { alias: addr })).json() as { original: unknown }).original, null);
  } finally { await s.close(); }
});

test('只读令牌：每分钟 30 次之后 429，下一分钟恢复；应答超过 512 KiB 返回 413 不截断', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const big = 'x'.repeat(600 * 1024);
  const s = await start({ extra: { oil: { market: () => ({}), state: () => ({ big }), pnl: () => ({}) } } });
  try {
    const token = await s.generate();
    const large = await s.read(token, '/api/oil/state');
    assert.equal(large.status, 413);
    assert.equal((await large.json() as { code: string }).code, 'too_large');
    for (let i = 1; i < 30; i += 1) assert.equal((await s.read(token, '/api/status')).status, 200, String(i));
    const limited = await s.read(token, '/api/status');
    assert.equal(limited.status, 429);
    assert.equal((await limited.json() as { code: string }).code, 'token_rate');
    clock.now += 60_000;
    assert.equal((await s.read(token, '/api/status')).status, 200);
    // One audit line per request, without the token; the page's count includes the refused ones.
    const audit = s.lines.filter(line => line.startsWith('只读令牌 '));
    assert.equal(audit.length, 32);
    assert.ok(audit.every(line => !line.includes(token)));
    assert.match(audit[0]!, /GET \/api\/oil\/state → 413/);
    assert.equal(s.tokens!.view().requests24h, 32);
  } finally { await s.close(); }
});

test('只读令牌：同时最多 2 个请求在处理', () => {
  const tokens = createReadTokens({ dir: mkdtempSync(join(tmpdir(), 'tp-read-token-')), now: () => 0, log: () => {} });
  const first = tokens.admit(), second = tokens.admit();
  assert.ok(first && second);
  assert.equal(tokens.admit(), null);
  first();
  first();
  assert.ok(tokens.admit(), '释放后可再进，重复释放不多算');
});

test('只读令牌：文件只存摘要且为 600；吊销后立即 401；到期后 401；到期前 7 天与 1 天各提醒一次，重启不重复', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    const token = await s.generate();
    const file = join(s.dir, READ_TOKEN_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(file, 'utf8').includes(token.slice(4)), '文件里没有令牌明文');
    const view = await (await fetch(`${s.base}/api/read-token`, { headers: { cookie: s.cookie } })).json() as { state: string; expiresAt: number; warn: boolean };
    assert.equal(view.state, 'active');
    assert.equal(view.expiresAt, clock.now + READ_TOKEN_TTL_MS);
    assert.equal(view.warn, false);
    assert.deepEqual(s.tokens!.dueReminders(), []);
    clock.now = view.expiresAt - 7 * 86_400_000 + 1000;
    assert.equal(s.tokens!.view().warn, true);
    assert.equal(s.tokens!.dueReminders().length, 1);
    assert.deepEqual(s.tokens!.dueReminders(), []);
    // A restart reads the reminders already sent from the file.
    const restarted = createReadTokens({ dir: s.dir, now: () => clock.now, log: () => {} });
    assert.deepEqual(restarted.dueReminders(), []);
    clock.now = view.expiresAt - 86_400_000 + 1000;
    const last = restarted.dueReminders();
    assert.equal(last.length, 1);
    assert.match(last[0]!, /1 天内到期/);
    assert.deepEqual(createReadTokens({ dir: s.dir, now: () => clock.now, log: () => {} }).dueReminders(), []);
    clock.now = view.expiresAt;
    const expired = await s.read(token, '/api/status');
    assert.equal(expired.status, 401);
    assert.match((await expired.json() as { message: string }).message, /到期/);
    clock.now = Date.UTC(2026, 10, 19);
    const fresh = await s.generate();
    assert.equal((await s.read(fresh, '/api/status')).status, 200);
    assert.equal((await s.sessionPost('/api/read-token/revoke')).status, 200);
    assert.equal((await s.read(fresh, '/api/status')).status, 401, '吊销立即生效');
    assert.throws(() => statSync(file), /ENOENT/);
  } finally { await s.close(); }
});

test('只读令牌：生成与吊销只接受会话与请求标记；令牌文件损坏时不接受任何令牌并在页面说明', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    assert.equal((await fetch(`${s.base}/api/read-token/generate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pa-executor': '1' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${s.base}/api/read-token/generate`, { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    const token = await s.generate();
    writeFileSync(join(s.dir, READ_TOKEN_FILE), '{"version":1}');
    const broken = createReadTokens({ dir: s.dir, now: () => clock.now, log: () => {} });
    assert.deepEqual(broken.check(token), { ok: false, reason: 'none' });
    assert.match(broken.view().error ?? '', /格式无效/);
  } finally { await s.close(); }
});

test('打码：字段名不分大小写与下划线；地址类字段里的地址与别处同一别名；数组逐项处理，对象按普通对象处理', () => {
  const seen = new Map<string, string>();
  const redact = createRedactor(Buffer.alloc(32, 7), (alias, original) => seen.set(alias, original));
  const out = redact({ Sub_Account_ID: 7, wallet: ADDRESS, addresses: [ADDRESS, 'abc'], text: `see ${ADDRESS}`, signers: { a: 1 }, at: new Date(0), price: '1.25', label: 'xau' }) as Record<string, unknown>;
  assert.match(String(out.Sub_Account_ID), /^acct-/);
  assert.equal(out.wallet, (out.addresses as string[])[0]);
  assert.equal(out.text, `see ${out.wallet}`);
  assert.match((out.addresses as string[])[1]!, /^acct-/);
  assert.equal((out.signers as Record<string, unknown>).a, 1, '标识字段下的对象按普通对象处理（CrossEx live.account 是余额对象）');
  assert.equal(out.at, '1970-01-01T00:00:00.000Z');
  assert.equal(out.price, '1.25');
  assert.equal(out.label, 'xau');
  assert.equal(seen.get(String(out.wallet)), ADDRESS);
  assert.ok(identifierField('walletAddress') && identifierField('sub-account-id') && !identifierField('pairId'));
});
