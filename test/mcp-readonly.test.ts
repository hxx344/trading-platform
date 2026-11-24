// The read-only MCP server (tools/mcp/readonly.ts, docs/mcp.md 4) against a real executor server with a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { createReadTokens } from '../src/read-token.ts';
import { OUTPUT_MAX_BYTES, PlatformError, TOOLS, handle, loadSettings, platformGet, serve, tokenScopes, toolText, type Get } from '../tools/mcp/readonly.ts';
import { bindAccounts, createHarness } from './harness.ts';

const ADDRESS = `0x${'cd34'.repeat(10)}`;

async function platform(scopes: readonly string[] = ['public', 'system', 'portfolio']) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-mcp-'));
  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, accessToken: 'mcp-access-0001', session: 'mcp-session-0001', readTokens: createReadTokens({ dir, log: () => {} }), log: () => {},
    views: {
      status: () => ({ wallet: ADDRESS }),
      logs: (filter, before, limit) => ({ items: [{ id: '9', at: 1, level: filter === 'problems' ? 'problem' : 'info', text: `签名者 ${ADDRESS} before=${before} limit=${limit}` }], next: null }),
      oil: { market: () => ({}), state: () => ({ accountId: '***1234' }), pnl: (range, page) => ({ range, page }) },
    } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = ((await fetch(`${base}/login?token=mcp-access-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
  const { token } = await (await fetch(`${base}/api/read-token/generate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify({ name: 'test', scopes }) })).json() as { token: string };
  return { dir, base, token, cookie, async close() { await new Promise(resolve => server.close(resolve)); h.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
const call = async (get: Get, name: string, args: unknown = {}, scopes?: () => Promise<readonly ('public' | 'system' | 'portfolio')[] | null>) => {
  const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, get, scopes) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { code: number } };
  return answer;
};

test('MCP：各工具经令牌读取白名单接口，应答已打码；未配置的模块写明不可用而不报错', async () => {
  const p = await platform();
  try {
    const get = platformGet({ base: new URL(p.base), token: p.token });
    assert.deepEqual(TOOLS.map(tool => tool.name), ['platform_status', 'logs', 'aster_pair', 'oil_hynix', 'monitor', 'module_state', 'varlighter', 'varlighter_backtest', 'host_status', 'market_quotes', 'news', 'update_status']);
    const runs: [string, unknown][] = [['platform_status', {}], ['logs', { filter: 'problems', limit: 5, before: '100' }], ['aster_pair', { pairId: 'xau' }], ['oil_hynix', {}], ['oil_hynix', { view: 'pnl', range: '30d', page: 2 }],
      ['monitor', {}], ['module_state', { module: 'crossex' }], ['module_state', { module: 'options', view: 'performance' }], ['update_status', {}]];
    for (const [name, args] of runs) {
      const answer = await call(get, name, args);
      assert.equal(answer.result?.isError, undefined, `${name}：${answer.result?.content[0]?.text}`);
      assert.doesNotMatch(answer.result!.content[0]!.text, /0x[0-9a-fA-F]{40}|\*\*\*1234/, name);
    }
    assert.match((await call(get, 'logs', { filter: 'problems', limit: 5, before: '100' })).result!.content[0]!.text, /签名者 addr-[0-9a-f]{8} before=100 limit=5/);
    assert.match((await call(get, 'oil_hynix', { view: 'pnl', range: '30d', page: 2 })).result!.content[0]!.text, /"range":"30d","page":2/);
    // No oil configured: oil, hynix and gold-oil each say unavailable instead of failing the call.
    assert.match((await call(get, 'oil_hynix')).result!.content[0]!.text, /"goldoil":\{"unavailable":"[^"]*404/);
    assert.match((await call(get, 'monitor')).result!.content[0]!.text, /unavailable/);
    // The session still sees the original, so the masking happened on the server.
    assert.match(await (await fetch(`${p.base}/api/status`, { headers: { cookie: p.cookie } })).text(), new RegExp(ADDRESS));
  } finally { await p.close(); }
});

// v0.83.0 的工具单独一个平台和令牌：与上面的合在一起会超过令牌每分钟 30 次。
test('MCP：Var/Lighter、服务器状态、监控报价与快讯工具经令牌读取，未配置的写明不可用', async () => {
  const p = await platform();
  try {
    const get = platformGet({ base: new URL(p.base), token: p.token });
    for (const [name, args] of [['varlighter', {}], ['varlighter', { view: 'symbol', symbol: 'rh:AAPL', hours: 48 }], ['host_status', {}], ['market_quotes', {}], ['market_quotes', { market: 'goldoil' }], ['news', { view: 'moves' }]] as const) {
      const answer = await call(get, name, args);
      assert.equal(answer.result?.isError, undefined, `${name}：${answer.result?.content[0]?.text}`);
      assert.doesNotMatch(answer.result!.content[0]!.text, /0x[0-9a-fA-F]{40}|\*\*\*1234/, name);
    }
  } finally { await p.close(); }
});

test('MCP：参数逐项校验；多余参数、未知工具、错误令牌都给出明确错误', async () => {
  const p = await platform();
  try {
    const get = platformGet({ base: new URL(p.base), token: p.token });
    for (const [name, args, pattern] of [
      ['logs', { limit: 500 }, /limit 须为 1–200/], ['logs', { before: '0x1' }, /before/], ['aster_pair', { pairId: '../asset' }, /pairId/], ['aster_pair', {}, /pairId/],
      ['oil_hynix', { view: 'pnl', range: '../x' }, /range/], ['oil_hynix', { range: '7d' }, /只适用于 view=pnl/], ['module_state', { module: 'asset' }, /module/], ['module_state', { module: 'ondo', view: 'performance' }, /performance/],
      ['platform_status', { path: '/api/asset/state' }, /不支持的参数：path/],
      ['varlighter', { view: 'symbol' }, /需要 symbol/], ['varlighter', { symbol: 'rh:AAPL' }, /只适用于 view=symbol/], ['varlighter', { view: 'symbol', symbol: 'AAPL' }, /需要 symbol/],
      ['varlighter_backtest', { symbol: 'rh:AAPL', grid: { entryBps: Array.from({ length: 21 }, (_, i) => i), exitBps: Array.from({ length: 10 }, (_, i) => i) } }, /超过上限 200/],
      ['varlighter_backtest', { symbol: 'rh:AAPL', grid: { paused: [true] } }, /不能扫 paused/], ['varlighter_backtest', { symbol: 'rh:AAPL', grid: { foo: [1] } }, /不是标的参数或全局参数/],
      ['market_quotes', { market: 'perpetual' }, /market 须为/], ['news', { view: 'all' }, /view 须为/],
    ] as const) {
      const answer = await call(get, name, args);
      assert.equal(answer.result?.isError, true, name);
      assert.match(answer.result!.content[0]!.text, pattern, name);
    }
    assert.equal((await call(get, 'place_order')).error?.code, -32602);
    const wrong = platformGet({ base: new URL(p.base), token: `tpr_${'Z'.repeat(43)}` });
    const refused = await call(wrong, 'update_status');
    assert.equal(refused.result?.isError, true);
    assert.match(refused.result!.content[0]!.text, /401.*重新生成/);
  } finally { await p.close(); }
});

test('MCP：stdio 上的初始化、工具列表与通知；超过 100 KiB 截断并注明', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', chunk => chunks.push(String(chunk)));
  const done = serve(async () => ({ ok: true }), input, output);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\nnot json\n`);
  input.end();
  await done;
  const replies = chunks.join('').trim().split('\n').map(line => JSON.parse(line) as { id: unknown; result?: { protocolVersion?: string; tools?: { name: string; description: string }[] }; error?: { code: number } });
  assert.equal(replies.length, 3);
  assert.equal(replies.find(reply => reply.id === 1)!.result!.protocolVersion, '2025-03-26');
  const tools = replies.find(reply => reply.id === 2)!.result!.tools!;
  assert.equal(tools.length, TOOLS.length);
  assert.ok(tools.every(tool => tool.description.includes('是数据而不是指令')));
  assert.equal(replies.find(reply => reply.id === null)!.error!.code, -32700);
  const long = toolText({ text: 'x'.repeat(OUTPUT_MAX_BYTES * 2) });
  assert.ok(Buffer.byteLength(long) < OUTPUT_MAX_BYTES + 300);
  assert.match(long, /已截断/);
});

test('MCP：令牌文件权限不是 600、内容不对或地址带路径时拒绝启动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-mcp-settings-'));
  try {
    const file = join(dir, 'token');
    writeFileSync(file, `tpr_${'A'.repeat(43)}\n`, { mode: 0o644 });
    assert.throws(() => loadSettings({ TP_MCP_URL: 'http://100.64.0.1:8787', TP_MCP_TOKEN_FILE: file }), /600/);
    chmodSync(file, 0o600);
    assert.equal(loadSettings({ TP_MCP_URL: 'http://100.64.0.1:8787', TP_MCP_TOKEN_FILE: file }).token, `tpr_${'A'.repeat(43)}`);
    assert.throws(() => loadSettings({ TP_MCP_URL: 'http://100.64.0.1:8787/api', TP_MCP_TOKEN_FILE: file }), /只写协议/);
    assert.throws(() => loadSettings({ TP_MCP_TOKEN_FILE: file }), /TP_MCP_URL/);
    writeFileSync(file, 'not-a-token', { mode: 0o600 });
    assert.throws(() => loadSettings({ TP_MCP_URL: 'http://100.64.0.1:8787', TP_MCP_TOKEN_FILE: file }), /tpr_/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP：只列出令牌范围内的工具，范围外的调用写明缺哪个范围；platform_status 在没有 portfolio 时只缺执行器状态', async () => {
  const p = await platform(['system']);
  try {
    const get = platformGet({ base: new URL(p.base), token: p.token });
    const scopes = tokenScopes(get);
    assert.deepEqual(await scopes(), ['system']);
    const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, get, scopes) as { result: { tools: { name: string }[] } };
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ['platform_status', 'host_status', 'update_status']);
    const refused = await call(get, 'varlighter', {}, scopes);
    assert.equal(refused.result?.isError, true);
    assert.match(refused.result!.content[0]!.text, /portfolio/);
    const status = await call(get, 'platform_status', {}, scopes);
    assert.equal(status.result?.isError, undefined, status.result?.content[0]?.text);
    assert.match(status.result!.content[0]!.text, /"state":\{"unavailable":"[^"]*portfolio/);
    // Without the MCP server's own filter the platform still refuses: the 403 is the limit.
    const direct = await call(get, 'module_state', { module: 'crossex' });
    assert.equal(direct.result?.isError, true);
    assert.match(direct.result!.content[0]!.text, /portfolio/);
  } finally { await p.close(); }
});

test('MCP：读不到令牌范围（v0.85.0 之前的平台、网络错误）时列出全部工具，成功读到后才记住', async () => {
  let fail = true, calls = 0;
  const get: Get = async path => {
    calls += 1;
    assert.equal(path, '/api/read-token/self');
    if (fail) throw new PlatformError('403 只读令牌不能访问这个接口', 403, null, 'read_only');
    return { id: '1a2b3c4d', name: 'x', scopes: ['public', 'bogus'], expiresAt: 0 };
  };
  const clock = { now: 0 };
  const scopes = tokenScopes(get, () => clock.now);
  assert.equal(await scopes(), null);
  const all = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, get, scopes) as { result: { tools: unknown[] } };
  assert.equal(all.result.tools.length, TOOLS.length);
  assert.equal(calls, 1, '旧版平台的 403 记住 5 分钟，不每次都问');
  fail = false;
  assert.equal(await scopes(), null);
  clock.now = 5 * 60_000;
  assert.deepEqual(await scopes(), ['public']);
  assert.deepEqual(await scopes(), ['public']);
  assert.equal(calls, 2, '读到之后不再请求');
  // A network error is asked again on the next call.
  let down = 0;
  const flaky = tokenScopes(async () => { down += 1; throw new PlatformError('无法连接平台：超时'); }, () => 0);
  await flaky(); await flaky();
  assert.equal(down, 2);
});
