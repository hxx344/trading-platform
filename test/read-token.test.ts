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
import { READ_SCOPES, READ_TOKEN_FILE, READ_TOKEN_MAX, READ_TOKEN_ROUTES, READ_TOKEN_TTL_MS, createReadTokens, readTokenAllows, readTokenScope, readTokenSystemStatus, type ReadScope } from '../src/read-token.ts';
import { createRedactor, identifierField } from '../src/read-redact.ts';
import { createOndoModule } from '../src/service/ondo.ts';
import type { UpdateView } from '../src/service/update-types.ts';
import { ONDO_MM_DEFAULTS } from '../src/vendor/ondo/mm.mjs';
import type { OndoClient } from '../src/vendor/ondo/client.mjs';
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
    status: () => ({ feishu: { configured: true, recent: [{ text: '账户 ***9a7b 已暂停' }] }, streams: [{ account: '***9a7b' }], wallet: ADDRESS, nested: { subAccountId: 123456, signer: ADDRESS_UPPER, note: `tx ${HASH}` }, [ADDRESS]: { balance: '1.5' },
      health: { startedAt: 1, loops: [{ name: 'jobs', lastOkAt: 2, failures: 1, lastError: 'LOOP-ERROR-TEXT 持仓 3 手', lastErrorAt: 3 }] },
      dependencies: { level: 'ok', incidents: [] },
      monitor: { available: true, error: null, oil: { summary: 'MONITOR-SUMMARY-TEXT' }, perpetual: { summary: 'PERP-SUMMARY-TEXT' } } }),
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
    ...(tokens ? { readTokens: tokens } : {}), tokenThrottle: () => new LoginThrottle(now) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const sessionPost = (path: string, body: unknown = {}) => fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) });
  const generate = async (scopes: readonly ReadScope[] = READ_SCOPES, name = 'test') => {
    const response = await sessionPost('/api/read-token/generate', { name, scopes });
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
const ALL = { name: 'MCP', scopes: [...READ_SCOPES] };

test('只读令牌：没有令牌文件、令牌错误一律 401；连续错误后锁定为 429；未配置令牌功能时同样 401', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    assert.equal((await s.read(`tpr_${'A'.repeat(43)}`, '/api/status')).status, 401, '尚未生成');
    const token = await s.generate();
    assert.equal((await s.read(token, '/api/status')).status, 200);
    await new Promise(resolve => setTimeout(resolve, 20));
    const used = s.tokens!.view().tokens[0]!;
    clock.now += 1_000;
    assert.equal((await s.read(`${token}x`, '/api/status')).status, 401);
    const mixed = await s.read(token, '/api/status', { headers: { cookie: s.cookie } });
    assert.equal(mixed.status, 403);
    assert.equal((await fetch(`${s.base}/api/status`, { headers: { authorization: token } })).status, 401, '缺少 Bearer');
    let locked = false;
    for (let i = 0; i < 12 && !locked; i += 1) locked = (await s.read(`tpr_${'B'.repeat(43)}`, '/api/status')).status === 429;
    assert.ok(locked, '连续错误后锁定');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual([s.tokens!.view().tokens[0]!.lastUsedAt, s.tokens!.view().tokens[0]!.requests24h], [used.lastUsedAt, used.requests24h], '被拒的请求不算使用');
    const logged = s.lines.length;
    for (let i = 0; i < 5; i += 1) assert.equal((await s.read(`tpr_${'B'.repeat(43)}`, '/api/status')).status, 429);
    assert.equal(s.lines.length, logged, '锁定期间的请求不写日志');
    assert.equal((await s.read(token, '/api/status')).status, 429, '同一来源锁定期间正确令牌也要等');
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
      '/api/asset/positions', '/api/asset/fills', '/api/observe', '/api/import', '/api/read-token', '/', '/assets/index.js', '/login', '/api/ready', '/api/unknown',
      '/api/varlighter/backtest', '/api/varlighter/settings', '/api/varlighter/paper', '/api/varlighter/live/close', '/api/monitor/perpetual/quote', '/api/monitor/oil/alerts/x', '/api/monitor/variational/quote'];
    assert.ok(literals.length > 30, `路由里的路径字面量：${literals.length}`);
    for (const path of [...literals, ...dynamic]) {
      if (path === '/api/read-token/self') continue;   // the token's own route, below
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
    // Gold-oil as hynix: its state (accounts, positions, jobs) is readable, its books are not.
    assert.equal(readTokenAllows(new URL('/api/goldoil/state', 'http://x')), true);
    assert.equal(readTokenAllows(new URL('/api/goldoil/market', 'http://x')), false);
    assert.equal((await s.read(token, '/api/goldoil/market')).status, 403);
  } finally { await s.close(); }
});

test('只读令牌：应答按值与按字段打码，原值不出现；同一原值在不同接口别名一致；会话访问不打码', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    const token = await s.generate();
    const status = await (await s.read(token, '/api/status')).text();
    const unmasked = await fetch(s.base + '/api/logs', { headers: { cookie: s.cookie, 'x-pa-read-cache': '1' } });
    const pageVersion = unmasked.headers.get('x-pa-read-version');
    assert.ok(pageVersion);
    const maskedLogs = await s.read(token, '/api/logs', { headers: { 'x-pa-read-cache': pageVersion } });
    assert.equal(maskedLogs.status, 200);
    assert.equal(maskedLogs.headers.get('x-pa-read-version'), null);
    const logs = await maskedLogs.text();
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
    // A second token: the first keeps working and both read the same aliases (one key, docs/mcp.md 8.4).
    const second = await s.generate(READ_SCOPES, '第二个');
    assert.equal((await s.read(token, '/api/status')).status, 200, '多个令牌并存');
    assert.ok((await (await s.read(second, '/api/status')).text()).includes(addr), '各令牌别名一致');
    // All revoked: the aliases and the key go, the next token reads new aliases.
    assert.equal((await s.sessionPost('/api/read-token/revoke', { all: true })).status, 200);
    assert.equal((await s.read(token, '/api/status')).status, 401);
    assert.equal((await (await s.sessionPost('/api/read-token/lookup', { alias: addr })).json() as { original: unknown }).original, null);
    const next = await s.generate();
    assert.ok(!(await (await s.read(next, '/api/status')).text()).includes(addr), '全部吊销后再生成，别名改变');
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
    assert.equal(s.tokens!.view().tokens[0]!.requests24h, 32);
  } finally { await s.close(); }
});

test('只读令牌：每个令牌同时最多 2 个请求在处理，全部令牌合计最多 4 个；每分钟 30 次按令牌分别计', () => {
  const tokens = createReadTokens({ dir: mkdtempSync(join(tmpdir(), 'tp-read-token-')), now: () => 0, log: () => {} });
  const first = tokens.admit('a'), second = tokens.admit('a');
  assert.ok(first && second);
  assert.equal(tokens.admit('a'), null);
  first();
  first();
  const third = tokens.admit('a');
  assert.ok(third, '释放后可再进，重复释放不多算');
  const b1 = tokens.admit('b'), b2 = tokens.admit('b');
  assert.ok(b1 && b2, '另一个令牌有自己的额度');
  assert.equal(tokens.admit('c'), null, '合计 4 个在处理');
  b1();
  const c1 = tokens.admit('c');
  assert.ok(c1);
  second(); third(); b2(); c1();
  for (let i = 0; i < 27; i += 1) tokens.admit('a')!();   // 3 admitted above, refusals do not count
  assert.equal(tokens.admit('a'), null, '令牌 a 这一分钟已用满 30 次');
  assert.ok(tokens.admit('d'), '令牌 d 不受影响');
});

test('只读令牌：文件只存摘要且为 600；吊销后立即 401；到期后 401；到期前 7 天与 1 天各提醒一次，重启不重复', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    const token = await s.generate();
    const file = join(s.dir, READ_TOKEN_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(file, 'utf8').includes(token.slice(4)), '文件里没有令牌明文');
    const view = (await (await fetch(`${s.base}/api/read-token`, { headers: { cookie: s.cookie } })).json() as { tokens: { state: string; expiresAt: number; warn: boolean }[] }).tokens[0]!;
    assert.equal(view.state, 'active');
    assert.equal(view.expiresAt, clock.now + READ_TOKEN_TTL_MS);
    assert.equal(view.warn, false);
    assert.deepEqual(s.tokens!.dueReminders(), []);
    clock.now = view.expiresAt - 7 * 86_400_000 + 1000;
    assert.equal(s.tokens!.view().tokens[0]!.warn, true);
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
    assert.equal((await s.sessionPost('/api/read-token/revoke', { all: true })).status, 200);
    assert.equal((await s.read(fresh, '/api/status')).status, 401, '吊销立即生效');
    assert.throws(() => statSync(file), /ENOENT/);
  } finally { await s.close(); }
});

test('只读令牌：到期提醒交给通知后才标记已发，通知抛错时下次仍提醒（#71 同类路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-read-token-'));
  const at = { now: Date.UTC(2026, 10, 19) };
  const open = () => createReadTokens({ dir, now: () => at.now, log: () => {} });
  try {
    open().generate(ALL);
    at.now += READ_TOKEN_TTL_MS - 7 * 86_400_000 + 1000;
    assert.throws(() => open().dueReminders(() => { throw new Error('database is locked'); }), /database is locked/);
    const sent: string[] = [];
    assert.equal(open().dueReminders(text => sent.push(text)).length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /7 天内到期/);
    assert.deepEqual(open().dueReminders(text => sent.push(text)), []);
    assert.equal(sent.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  const article = 'https://eqn.news/main/1234';
  const details = redact({ text: '失败 https://example.test/private 来自 192.0.2.7、2001:db8::8 vr-token=example', link: article });
  assert.deepEqual(details, { text: '失败 [URL] 来自 [IP]、[IP] vr-token=[隐藏]', link: article });
  const words = redact({ text: '子账户 50000 USDT 已划转；UID 88776655 已暂停；账户 1234567 的余额 12.5%', users: 3, user: 123456 }) as Record<string, unknown>;
  assert.match(String(words.text), /^子账户 50000 USDT 已划转；UID acct-[0-9a-f]{8} 已暂停；账户 acct-[0-9a-f]{8} 的余额/, '数字后跟单位是金额，不打码');
  assert.equal(words.users, 3, '计数字段的数字不打码');
  for (const text of ['UID 88776655, not configured', 'account 12345678.', 'uid=12345678.', 'Binance account 12345678 USDT-M', 'UID 1234567 U本位', '子账户 12345678 个人', 'account 12345678 BTCUSDT', 'UID 12345678 次日'])
    assert.ok(!(redact({ text }) as { text: string }).text.includes(/\d{5,}/.exec(text)![0]), text);
  assert.equal((redact({ text: '账户 12345678.5 USDT，UID 1,234,567 元' }) as { text: string }).text, '账户 12345678.5 USDT，UID 1,234,567 元', '小数与千分位是金额');
  assert.match(String(words.user), /^acct-/);
  assert.equal(seen.get(String(out.wallet)), ADDRESS);
  assert.ok(identifierField('walletAddress') && identifierField('sub-account-id') && !identifierField('pairId'));
});

// Identifier-named fields known to hold a count, not an id; any other number under an identifier field counts as an original.
const COUNT_FIELDS = new Set(['users', 'signers', 'addresses']);
/** Every original a masked answer must not carry: values under identifier fields and 0x runs, from the session's answer. */
function originals(value: unknown, field = '', out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const run of value.match(/0x[0-9a-fA-F]{40,}/g) ?? []) out.add(run);
    if (identifierField(field) && value.length >= 4) out.add(value);
  } else if (typeof value === 'number' && identifierField(field) && !COUNT_FIELDS.has(field) && String(value).length >= 4) out.add(String(value));
  else if (Array.isArray(value)) for (const item of value) originals(item, field, out);
  else if (value !== null && typeof value === 'object') for (const [name, item] of Object.entries(value)) { originals(name, '', out); originals(item, name, out); }
  return out;
}

const UPDATE: UpdateView = {
  current: { version: '0.69.0', commit: 'abc1234', packaged: true },
  latest: { version: '0.69.1', name: 'v0.69.1', notes: '更新说明：发布说明正文', publishedAt: '2026-11-19T00:00:00Z', url: 'https://github.com/example/releases/v0.69.1' },
  checkedAt: 1, checking: false, error: null, retryAt: null, manualAt: 0, available: true, enabled: true,
  pending: { id: 'req-1', version: '0.69.1', at: 2, stale: false },
  job: { id: 'job-1', version: '0.69.1', from: '0.69.0', startedAt: 3, at: 4, phase: 'running', step: 'install', message: '正在安装 /home/svc-trader', output: ['/home/svc-trader/trading-platform/data 已备份'] },
};

test('只读令牌：执行器状态、划转、ADL 与 Ondo 用真实视图读取，应答里没有会话应答中的任何标识原值，读取不调用交易所客户端；在线更新只给投影', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-read-token-ondo-'));
  const clientCalls: string[] = [];
  const client = {
    async markets() { clientCalls.push('markets'); return new Map([['NVDA-USD.P', { tick: '0.01', step: '0.01', trading: true, makerFee: null }]]); },
    async depth(name: string) { clientCalls.push(`depth ${name}`); return { market: name, time: Date.now(), bids: [['100.00', '3']], asks: [['100.02', '4']] }; },
    close() {},
  } as unknown as OndoClient;
  const ondo = await createOndoModule({ initial: { ...structuredClone(ONDO_MM_DEFAULTS), mode: 'observe', markets: ['NVDA-USD.P'], orderUsd: '250', maxPositionUsd: '250' } as never }, undefined, dataDir, { log: () => {}, rewardsClient: () => client, mmIntervalMs: 0 });
  const s = await start({ extra: { ondo: ondo.views, update: { status: () => structuredClone(UPDATE), check: async () => ({}), apply: () => ({}) } } });
  const realFetch = globalThis.fetch;
  try {
    const token = await s.generate();
    const before = clientCalls.length;
    // The executor's own state (accounts, jobs, transfers, ADL) and the modules wired here, through the real views.
    const checked = new Set<string>();
    for (const path of ['/api/state', '/api/status', '/api/logs', '/api/oil/state', '/api/ondo/state', '/api/transfer-pairs/xau/history', '/api/adl/pairs/xau/incidents']) {
      const session = await realFetch(s.base + path, { headers: { cookie: s.cookie } });
      const masked = await s.read(token, path);
      assert.equal(masked.status, session.status, path);
      const plain = await session.text(), text = await masked.text();
      if (session.headers.get('content-type')?.includes('json')) for (const original of originals(JSON.parse(plain))) { checked.add(`${path} ${original}`); assert.ok(!text.includes(original), `${path} 含原值 ${original}`); }
      assert.doesNotMatch(text, HEX_RUN, path);
    }
    assert.deepEqual(clientCalls.slice(before), [], '令牌读取 Ondo 状态不调用交易所客户端');
    assert.ok([...checked].some(item => item.startsWith('/api/state ')), `执行器状态里的账户标识也核对过：${[...checked].join('；')}`);
    // The update status: versions, state and times only; no install output, message, notes or links.
    const update = await (await s.read(token, '/api/update')).json() as Record<string, unknown>;
    assert.deepEqual(update, {
      current: { version: '0.69.0', commit: 'abc1234', packaged: true }, latest: { version: '0.69.1', publishedAt: '2026-11-19T00:00:00Z' },
      checkedAt: 1, checking: false, checkFailed: false, available: true, enabled: true, pending: { version: '0.69.1', at: 2, stale: false },
      job: { version: '0.69.1', from: '0.69.0', startedAt: 3, at: 4, phase: 'running', step: 'install', installed: null, stale: false },
    });
    assert.match(await (await realFetch(`${s.base}/api/update`, { headers: { cookie: s.cookie } })).text(), /svc-trader/, '会话仍看到完整内容');
  } finally {
    await s.close(); await ondo.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});


test('只读令牌范围：范围外的接口 403 token_scope 并写明范围；/api/read-token/self 只答令牌本身，会话 404', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    const system = await s.generate(['system'], '只看系统');
    assert.equal((await s.read(system, '/api/status')).status, 200);
    for (const [path, scope] of [['/api/state', 'portfolio'], ['/api/news', 'public'], ['/api/oil/state', 'portfolio']] as const) {
      const refused = await s.read(system, path);
      assert.equal(refused.status, 403, path);
      const body = await refused.json() as { code: string; scope: string; message: string };
      assert.deepEqual([body.code, body.scope], ['token_scope', scope], path);
      assert.match(body.message, new RegExp(scope));
      assert.equal(readTokenScope(new URL(path, 'http://x')), scope);
    }
    const asset = await s.read(system, '/api/asset/state');
    assert.equal(asset.status, 403, '资产账本不在任何范围');
    assert.equal((await asset.json() as { code: string }).code, 'read_only');
    const self = await s.read(system, '/api/read-token/self');
    assert.equal(self.status, 200);
    const body = await self.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'id', 'name', 'scopes']);
    assert.deepEqual([body.name, body.scopes, body.expiresAt], ['只看系统', ['system'], clock.now + READ_TOKEN_TTL_MS]);
    assert.equal((await s.read(system, '/api/read-token/self?x=1')).status, 403, '带查询参数不放行');
    assert.equal((await fetch(`${s.base}/api/read-token/self`, { headers: { cookie: s.cookie } })).status, 404, '会话没有这个接口');
    assert.equal((await fetch(`${s.base}/api/read-token/self`)).status, 401);
    assert.equal((await s.read(`tpr_${'Q'.repeat(43)}`, '/api/read-token/self')).status, 401);
    assert.equal(readTokenScope(new URL('/api/asset/state', 'http://x')), null);
    assert.ok(READ_TOKEN_ROUTES.every(route => READ_SCOPES.includes(route.scope)));
  } finally { await s.close(); }
});

test('只读令牌：最多 8 个，第 9 个 409；名称与范围逐项校验 400；吊销单个只影响它，未知编号 404', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    assert.equal((await s.sessionPost('/api/read-token/generate', {})).status, 400);
    for (const body of [{ name: '', scopes: ['public'] }, { name: 'x'.repeat(41), scopes: ['public'] }, { name: 'a\nb', scopes: ['public'] }, { name: 'a', scopes: [] }, { name: 'a', scopes: ['asset'] }, { name: 'a', scopes: 'public' }]) {
      const response = await s.sessionPost('/api/read-token/generate', body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json() as { code: string }).code, 'token_input');
    }
    const tokens: string[] = [];
    for (let i = 0; i < READ_TOKEN_MAX; i += 1) tokens.push(await s.generate(['public'], `客户端 ${i}`));
    const ninth = await s.sessionPost('/api/read-token/generate', { name: '第九个', scopes: ['public'] });
    assert.equal(ninth.status, 409);
    assert.equal((await ninth.json() as { code: string }).code, 'token_limit');
    const listed = s.tokens!.view().tokens;
    assert.equal(listed.length, READ_TOKEN_MAX);
    assert.equal(new Set(listed.map(token => token.id)).size, READ_TOKEN_MAX);
    assert.equal((await s.sessionPost('/api/read-token/revoke', { id: listed[2]!.id })).status, 200);
    assert.equal((await s.read(tokens[2]!, '/api/read-token/self')).status, 401, '吊销的立即失效');
    assert.equal((await s.read(tokens[3]!, '/api/read-token/self')).status, 200, '其余不受影响');
    assert.equal(s.tokens!.view().tokens.length, READ_TOKEN_MAX - 1);
    assert.equal((await s.sessionPost('/api/read-token/revoke', { id: listed[2]!.id })).status, 404);
    assert.equal((await s.sessionPost('/api/read-token/revoke', { id: '../x' })).status, 400);
    assert.equal((await s.sessionPost('/api/read-token/generate', { name: '补上', scopes: ['public'] })).status, 200, '吊销一个后可再生成');
    assert.ok(s.lines.some(line => line.includes(`编号 ${listed[2]!.id}（客户端 2）`)));
  } finally { await s.close(); }
});

test('只读令牌：版本 1 的文件读作一个名为 MCP、三个范围都有的令牌，编号、日期、密钥与别名不变，下次写入改为版本 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-read-token-'));
  const at = { now: Date.UTC(2026, 10, 19) };
  const open = () => createReadTokens({ dir, now: () => at.now, log: () => {} });
  try {
    const { token } = open().generate({ name: '临时', scopes: ['public'] });
    const file = join(dir, READ_TOKEN_FILE);
    const v2 = JSON.parse(readFileSync(file, 'utf8')) as { redactKey: string; tokens: Record<string, unknown>[] };
    const { name: _name, scopes: _scopes, ...single } = v2.tokens[0]!;
    writeFileSync(file, JSON.stringify({ version: 1, redactKey: v2.redactKey, aliases: [['addr-00000001', ADDRESS]], ...single }), { mode: 0o600 });
    const tokens = open();
    assert.deepEqual(tokens.check(token), { ok: true, id: single.id, name: 'MCP', scopes: [...READ_SCOPES] });
    assert.equal(tokens.lookup('addr-00000001'), ADDRESS);
    assert.deepEqual(tokens.view().tokens.map(item => [item.id, item.createdAt, item.expiresAt]), [[single.id, single.createdAt, single.expiresAt]]);
    tokens.generate({ name: '第二个', scopes: ['system'] });
    const written = JSON.parse(readFileSync(file, 'utf8')) as { version: number; redactKey: string; tokens: { name: string }[] };
    assert.equal(written.version, 2);
    assert.equal(written.redactKey, v2.redactKey, '密钥不变，别名一致');
    assert.deepEqual(written.tokens.map(item => item.name), ['MCP', '第二个']);
    writeFileSync(file, JSON.stringify({ version: 3, redactKey: v2.redactKey, aliases: [], tokens: [] }), { mode: 0o600 });
    assert.match(open().view().error ?? '', /格式无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('只读令牌：全部吊销后别名与密钥一起换掉；令牌文件被外部删除后下一次请求就 401，统计不写回文件', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    const file = join(s.dir, READ_TOKEN_FILE);
    const keyOf = () => (JSON.parse(readFileSync(file, 'utf8')) as { redactKey: string }).redactKey;
    const first = await s.generate(['system'], '甲');
    const key = keyOf();
    await s.generate(['public'], '乙');
    assert.equal(keyOf(), key, '再生成不换密钥');
    assert.equal((await s.sessionPost('/api/read-token/revoke', { all: true })).status, 200);
    assert.deepEqual(s.tokens!.view().tokens, []);
    const third = await s.generate(['system'], '丙');
    assert.notEqual(keyOf(), key, '全部吊销后再生成换密钥');
    assert.equal((await s.read(first, '/api/status')).status, 401);
    assert.equal((await s.read(third, '/api/status')).status, 200);
    rmSync(file);
    assert.equal((await s.read(third, '/api/status')).status, 401, '删除文件即全部吊销');
    s.tokens!.flush();
    assert.throws(() => statSync(file), /ENOENT/, '不写回');
    assert.deepEqual(s.tokens!.view().tokens, []);
    assert.ok(s.lines.some(line => line.includes('文件已被删除')));
  } finally { await s.close(); }
});

test('只读令牌：到期提醒按令牌分别发，文字写明名称与编号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-read-token-'));
  const start0 = Date.UTC(2026, 10, 19);
  const at = { now: start0 };
  const open = () => createReadTokens({ dir, now: () => at.now, log: () => {} });
  try {
    const a = open().generate({ name: '甲', scopes: ['public'] });
    at.now += 10 * 86_400_000;
    const b = open().generate({ name: '乙', scopes: ['system'] });
    at.now = start0 + READ_TOKEN_TTL_MS - 7 * 86_400_000 + 1000;
    const firstRound = open().dueReminders();
    assert.equal(firstRound.length, 1);
    assert.match(firstRound[0]!, new RegExp(`「甲」（编号 ${a.id}）将在 7 天内到期`));
    at.now += 10 * 86_400_000;
    const second = open().dueReminders();
    assert.equal(second.length, 1, '甲已到期不再提醒，乙到了 7 天');
    assert.match(second[0]!, new RegExp(`「乙」（编号 ${b.id}）`));
    assert.deepEqual(open().dueReminders(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('只读令牌：文件被外部删除后，不经令牌请求直接生成、逐个吊销或看列表，都不把旧令牌写回；到期提醒不再发', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-read-token-'));
  const at = { now: Date.UTC(2026, 10, 19) };
  const lines: string[] = [];
  const tokens = createReadTokens({ dir, now: () => at.now, log: line => lines.push(line) });
  try {
    const file = join(dir, READ_TOKEN_FILE);
    const old = tokens.generate({ name: '旧', scopes: ['system'] });
    const oldKey = (JSON.parse(readFileSync(file, 'utf8')) as { redactKey: string }).redactKey;
    rmSync(file);
    assert.deepEqual(tokens.view().tokens, [], '列表随之清空');
    const fresh = tokens.generate({ name: '新', scopes: ['system'] });
    const written = JSON.parse(readFileSync(file, 'utf8')) as { redactKey: string; tokens: { id: string }[] };
    assert.deepEqual(written.tokens.map(token => token.id), [fresh.id], '文件里只有新令牌');
    assert.notEqual(written.redactKey, oldKey, '新密钥');
    assert.deepEqual(tokens.check(old.token), { ok: false, reason: 'invalid' });
    assert.equal(tokens.check(fresh.token).ok, true);
    rmSync(file);
    assert.throws(() => tokens.revoke(fresh.id), /没有编号/, '删除后逐个吊销不写回');
    assert.throws(() => statSync(file), /ENOENT/);
    const again = createReadTokens({ dir, now: () => at.now, log: () => {} });
    again.generate({ name: '甲', scopes: ['public'] });
    rmSync(file);
    at.now += READ_TOKEN_TTL_MS - 86_400_000 + 1000;
    assert.deepEqual(again.dueReminders(() => assert.fail('已吊销的令牌不提醒')), []);
    assert.throws(() => statSync(file), /ENOENT/);
    assert.ok(lines.some(line => line.includes('文件已被删除')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('只读令牌：没有 portfolio 的令牌读 /api/status 只得到运行状态，不含飞书消息原文与账户行情流；日志属于 portfolio', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    const system = await s.generate(['system'], '运维');
    const full = await s.generate(READ_SCOPES, '分析');
    const narrow = await (await s.read(system, '/api/status')).json() as Record<string, unknown>;
    const wide = await (await s.read(full, '/api/status')).text();
    assert.match(wide, /已暂停/, '有 portfolio 时照旧');
    const text = JSON.stringify(narrow);
    assert.doesNotMatch(text, /已暂停|streams|wallet|nested|recent|LOOP-ERROR-TEXT|MONITOR-SUMMARY-TEXT|PERP-SUMMARY-TEXT/);
    for (const marker of ['LOOP-ERROR-TEXT', 'MONITOR-SUMMARY-TEXT', 'PERP-SUMMARY-TEXT']) assert.match(wide, new RegExp(marker));
    assert.deepEqual(Object.keys(narrow).sort(), ['dependencies', 'feishu', 'health', 'monitor', 'omitted', 'samples']);
    assert.deepEqual(narrow.health, { startedAt: 1, loops: [{ name: 'jobs', lastOkAt: 2, failures: 1, lastErrorAt: 3 }] });
    assert.deepEqual(narrow.dependencies, { level: 'ok', incidents: [] });
    assert.deepEqual(narrow.monitor, { available: true, error: null });
    assert.deepEqual(narrow.feishu, { configured: true });
    for (const path of ['/api/logs', '/api/logs/problems']) {
      const refused = await s.read(system, path);
      assert.equal(refused.status, 403, path);
      assert.equal((await refused.json() as { scope: string }).scope, 'portfolio');
      assert.equal((await s.read(full, path)).status, 200, path);
    }
  } finally { await s.close(); }
});

test('只读令牌：/api/read-token/self 同样受每分钟 30 次限额；吊销全部要显式 all，空的请求体 400', async () => {
  clock.now = Date.UTC(2026, 10, 19);
  const s = await start();
  try {
    const token = await s.generate(['public'], '甲');
    for (let i = 0; i < 30; i += 1) assert.equal((await s.read(token, '/api/read-token/self')).status, 200);
    assert.equal((await s.read(token, '/api/read-token/self')).status, 429);
    for (const body of [{}, { all: false }, { all: true, id: s.tokens!.view().tokens[0]!.id }, { all: 'yes' }]) {
      assert.equal((await s.sessionPost('/api/read-token/revoke', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(s.tokens!.view().tokens.length, 1, '都没有吊销');
    assert.equal((await s.sessionPost('/api/read-token/revoke', { all: true })).status, 200);
    assert.deepEqual(s.tokens!.view().tokens, []);
  } finally { await s.close(); }
});

test('只读令牌：system 状态投影对各种 health 形状都不带出循环报错原文，不认识的顶层字段不给', () => {
  for (const health of [undefined, null, 'x', { loops: { jobs: { lastError: 'SECRET' } } }, { loops: [null, 1, { name: 'jobs', lastError: 'SECRET', failures: 2 }] }]) {
    const view = readTokenSystemStatus({ health, extra: 'SECRET', feishu: { configured: true, recent: [{ text: 'SECRET' }] } });
    assert.doesNotMatch(JSON.stringify(view), /SECRET/, JSON.stringify(health));
  }
  assert.deepEqual(readTokenSystemStatus({ health: { loops: [null, 1, { name: 'jobs', lastError: 'x', failures: 2 }] } }).health, { loops: [null, 1, { name: 'jobs', failures: 2 }] });
  assert.equal(readTokenSystemStatus({}).health, null);
});
