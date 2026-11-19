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
import { OUTPUT_MAX_BYTES, TOOLS, handle, loadSettings, platformGet, serve, toolText, type Get } from '../tools/mcp/readonly.ts';
import { bindAccounts, createHarness } from './harness.ts';

const ADDRESS = `0x${'cd34'.repeat(10)}`;

async function platform() {
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
  const { token } = await (await fetch(`${base}/api/read-token/generate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: '{}' })).json() as { token: string };
  return { dir, base, token, cookie, async close() { await new Promise(resolve => server.close(resolve)); h.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
const call = async (get: Get, name: string, args: unknown = {}) => {
  const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, get) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { code: number } };
  return answer;
};

test('MCP：七个工具经令牌读取白名单接口，应答已打码；未配置的模块写明不可用而不报错', async () => {
  const p = await platform();
  try {
    const get = platformGet({ base: new URL(p.base), token: p.token });
    assert.deepEqual(TOOLS.map(tool => tool.name), ['platform_status', 'logs', 'aster_pair', 'oil_hynix', 'monitor', 'module_state', 'update_status']);
    const runs: [string, unknown][] = [['platform_status', {}], ['logs', { filter: 'problems', limit: 5, before: '100' }], ['aster_pair', { pairId: 'xau' }], ['oil_hynix', {}], ['oil_hynix', { view: 'pnl', range: '30d', page: 2 }],
      ['monitor', {}], ['module_state', { module: 'crossex' }], ['module_state', { module: 'options', view: 'performance' }], ['update_status', {}]];
    for (const [name, args] of runs) {
      const answer = await call(get, name, args);
      assert.equal(answer.result?.isError, undefined, `${name}：${answer.result?.content[0]?.text}`);
      assert.doesNotMatch(answer.result!.content[0]!.text, /0x[0-9a-fA-F]{40}|\*\*\*1234/, name);
    }
    assert.match((await call(get, 'logs', { filter: 'problems', limit: 5, before: '100' })).result!.content[0]!.text, /签名者 addr-[0-9a-f]{8} before=100 limit=5/);
    assert.match((await call(get, 'oil_hynix', { view: 'pnl', range: '30d', page: 2 })).result!.content[0]!.text, /"range":"30d","page":2/);
    assert.match((await call(get, 'monitor')).result!.content[0]!.text, /unavailable/);
    // The session still sees the original, so the masking happened on the server.
    assert.match(await (await fetch(`${p.base}/api/status`, { headers: { cookie: p.cookie } })).text(), new RegExp(ADDRESS));
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
  assert.equal(tools.length, 7);
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
