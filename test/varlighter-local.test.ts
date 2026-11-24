// Var/Lighter on the client machine (docs/mcp.md 8.3): tools/varlighter/pull.ts pulls the samples with the read-only
// token, tools/varlighter/backtest.ts replays them with the repository's backtest, and the MCP tool chains both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { createReadTokens } from '../src/read-token.ts';
import { openVarLighter, varLighterViews } from '../src/service/varlighter.ts';
import { runBacktest } from '../src/varlighter/backtest.ts';
import type { Sample } from '../src/varlighter/model.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL, type GlobalParams, type SymbolParams } from '../src/varlighter/strategy.ts';
import type { StateView } from '../src/varlighter/views.ts';
import { PlatformError, handle, platformGet, type Get } from '../tools/mcp/readonly.ts';
import { combinations, parseArgs, readRequest, runLocal } from '../tools/varlighter/backtest.ts';
import { lastSampleAt, parsePullArgs, pull, sampleFile } from '../tools/varlighter/pull.ts';
import { bindAccounts, createHarness } from './harness.ts';

const T0 = Date.parse('2026-11-23T15:00:00Z');
const KEY = 'rh:BTC';
const PARAMS: SymbolParams = { ...DEFAULT_SYMBOL, enabled: true, entryBps: 15, exitBps: 2, cooldownMinutes: 0, regimes: ['all'] };
const GLOBAL: GlobalParams = { ...DEFAULT_GLOBAL, windowHours: 2, minSamples: 30 };

function sample(t: number, varMid: number, rhMid = 100): Sample {
  return {
    symbol: KEY, t, receivedAt: t + 1_000, regime: 'all', varMark: varMid,
    varBid0: varMid - 0.01, varAsk0: varMid + 0.01, varBid1k: varMid - 0.02, varAsk1k: varMid + 0.02, varBid100k: varMid - 0.05, varAsk100k: varMid + 0.05, varFunding: 0.1,
    rhAt: t - 500, rhBid0: rhMid - 0.01, rhAsk0: rhMid + 0.01, rhMark: rhMid, rhIndex: rhMid, rhFunding: 0.0001,
    rhBid1k: rhMid - 0.02, rhAsk1k: rhMid + 0.02, rhBid100k: null, rhAsk100k: null, rhBidRx: rhMid - 0.01, rhAskRx: rhMid + 0.01, varBidTk: null, varAskTk: null, varTkAt: null,
  };
}
/** Var spikes 45 bp over Lighter every 30 minutes and sits 20 bp over otherwise: a trade per spike. */
const oscillating = (from: number, count: number): Sample[] => Array.from({ length: count }, (_, index) => sample(T0 + (from + index) * 60_000, 100 * (1 + ((from + index) % 30 === 15 ? 45 : 20) / 1e4)));

async function platform() {
  const dir = mkdtempSync(join(tmpdir(), 'tp-vl-local-'));
  const local = mkdtempSync(join(tmpdir(), 'tp-vl-cache-'));
  const h = createHarness();
  bindAccounts(h.ex);
  const holder = openVarLighter(dir, { fetchImpl: async () => Response.json({}), connect: () => { throw new Error('不连行情'); } }, () => {});
  const writer = openVarLighterStore(join(dir, 'varlighter.sqlite'));
  // The state is written by hand (the real one needs the venues' catalogs); the samples come from the real engine.
  const state = { rows: [{ key: KEY, kind: 'crypto', name: 'Bitcoin', enabled: true, position: null }], orphans: [{ key: 'lighter:OLD' }],
    settings: { revision: 3, global: GLOBAL, symbols: { [KEY]: PARAMS }, confirmed: [KEY], venues: ['rh'] } } as unknown as StateView;
  const server = createExecutorServer({ executor: h.ex, accessToken: 'vl-local-access-01', session: 'vl-local-session-01', readTokens: createReadTokens({ dir, log: () => {} }), log: () => {},
    views: { varlighter: { ...varLighterViews(holder), state: () => state } } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = ((await fetch(`${base}/login?token=vl-local-access-01`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
  const { token } = await (await fetch(`${base}/api/read-token/generate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: '{}' })).json() as { token: string };
  return {
    local, writer, get: platformGet({ base: new URL(base), token }),
    async close() { writer.close(); await new Promise(resolve => server.close(resolve)); h.dispose(); holder.engine?.close(); rmSync(dir, { recursive: true, force: true }); rmSync(local, { recursive: true, force: true }); },
  };
}

test('本机拉样本：按页增量续拉，重拉不重复；--enabled 含已启用与失联配对；本机回测与服务器同一套回测结果一致；grid 按净盈亏排序', async () => {
  const p = await platform();
  try {
    const samples = oscillating(0, 2_500);
    p.writer.addSamples(samples);
    const first = await pull({ get: p.get, dir: p.local, enabled: true });
    assert.deepEqual(first.results.map(result => [result.symbol, result.added]), [[KEY, 2_500], ['lighter:OLD', 0]], '三页拉完；失联配对一并尝试');
    assert.equal(lastSampleAt(sampleFile(p.local, KEY)), samples.at(-1)!.t);
    assert.equal((await pull({ get: p.get, dir: p.local, symbols: [KEY] })).results[0]!.added, 0, '没有新样本');
    const more = oscillating(2_500, 10);
    p.writer.addSamples(more);
    assert.equal((await pull({ get: p.get, dir: p.local, symbols: [KEY] })).results[0]!.added, 10, '只拉新增的');
    const lines = readFileSync(sampleFile(p.local, KEY), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Sample);
    assert.deepEqual(lines, [...samples, ...more], '本机文件与服务器样本逐条一致');

    const all = [...samples, ...more], to = all.at(-1)!.t, from = to - 24 * 3_600_000;
    const server = runBacktest(KEY, 'crypto', all, from, to, PARAMS, GLOBAL);
    assert.ok(server.trades.length >= 20, `应有成交，实际 ${server.trades.length}`);
    const single = runLocal({ symbol: KEY, hours: 24, trades: 5 }, p.local) as { summary: unknown; trades: unknown[]; tradesShown: number; params: SymbolParams; global: GlobalParams };
    assert.deepEqual(single.summary, server.summary);
    assert.deepEqual(single.trades, server.trades.slice(-5));
    assert.deepEqual([single.params.entryBps, single.global.windowHours], [15, 2], '缺的参数用平台保存的');
    const changed = runLocal({ symbol: KEY, hours: 24, params: { entryBps: 30 } }, p.local) as { summary: unknown };
    assert.deepEqual(changed.summary, runBacktest(KEY, 'crypto', all, from, to, { ...PARAMS, entryBps: 30 }, GLOBAL).summary);
    const grid = runLocal({ symbol: KEY, hours: 24, grid: { entryBps: [15, 30], minNetBps: [3, 7] } }, p.local) as { combos: number; runs: { values: Record<string, number>; summary: { netUsd: number } }[] };
    assert.equal(grid.combos, 4);
    assert.ok(grid.runs.every((run, index) => index === 0 || grid.runs[index - 1]!.summary.netUsd >= run.summary.netUsd), '按净盈亏从高到低');
    const best = grid.runs[0]!;
    assert.deepEqual(best.summary, runBacktest(KEY, 'crypto', all, from, to, { ...PARAMS, entryBps: best.values.entryBps! }, { ...GLOBAL, minNetBps: best.values.minNetBps! }).summary);
    assert.throws(() => runLocal({ symbol: 'lighter:OLD' }, p.local), /请在请求里给出 kind/);
    assert.throws(() => runLocal({ symbol: 'rh:NONE', kind: 'crypto' }, p.local), /先运行 tools\/varlighter\/pull\.ts/);
    assert.throws(() => runLocal({ symbol: KEY, params: { entryBps: -1 } }, p.local));
  } finally { await p.close(); }
});

test('本机拉样本：429 按 Retry-After 等待后继续，413 把每页减半，其他错误直接抛出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-vl-retry-'));
  try {
    const waits: number[] = [], limits: string[] = [];
    let refusals = 2;
    const get: Get = async path => {
      if (path === '/api/varlighter/state') return { rows: [], orphans: [], settings: { revision: 1, global: GLOBAL, symbols: {}, confirmed: [], venues: ['rh'] } };
      if (refusals-- > 0) throw new PlatformError('429', 429, 7);
      const limit = new URL(path, 'http://x').searchParams.get('limit')!;
      limits.push(limit);
      if (Number(limit) > 250) throw new PlatformError('413', 413);
      return { symbol: KEY, columns: ['symbol', 't'], rows: [[KEY, T0]], next: null, firstAt: T0, retentionDays: 14 };
    };
    const { results } = await pull({ get, dir, symbols: [KEY], sleep: async seconds => { waits.push(seconds); } });
    assert.deepEqual(waits, [7, 7]);
    assert.deepEqual(limits, ['1000', '500', '250']);
    assert.equal(results[0]!.added, 1);
    await assert.rejects(pull({ get: async () => { throw new PlatformError('401', 401); }, dir, symbols: [KEY] }), /401/);
    await assert.rejects(pull({ get, dir, symbols: ['BTC'] }), /配对键无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('本机回测参数：命令行与 JSON 请求同一套校验；grid 展开全部组合', () => {
  assert.deepEqual(parseArgs(['--symbol', KEY, '--hours', '48', '--params', '{"entryBps":20}', '--trades', 'all']), { symbol: KEY, hours: 48, params: { entryBps: 20 }, trades: 'all' });
  assert.deepEqual(parseArgs(['--request', '{"symbol":"lighter:ETH","grid":{"exitBps":[0,1]}}']), { symbol: 'lighter:ETH', grid: { exitBps: [0, 1] } });
  assert.throws(() => parseArgs(['--symbol', KEY, '--params', '{x']), /不是有效的 JSON/);
  assert.throws(() => parseArgs(['--hours']), /缺少取值/);
  assert.throws(() => readRequest({ symbol: KEY, extra: 1 }), /未知字段 extra/);
  assert.throws(() => readRequest({ symbol: KEY, kind: 'stock' }), /kind/);
  assert.deepEqual(combinations({ a: [1, 2], b: ['x', 'y'] }), [{ a: 1, b: 'x' }, { a: 1, b: 'y' }, { a: 2, b: 'x' }, { a: 2, b: 'y' }]);
  assert.deepEqual(parsePullArgs(['--symbol', KEY, '--enabled']), { symbols: [KEY], enabled: true });
  assert.throws(() => parsePullArgs([]), /--symbol/);
});

test('MCP varlighter_backtest：先增量拉取，再在新进程里用仓库代码回测，结果与本机回测一致', async () => {
  const p = await platform();
  const saved = process.env.TP_VARLIGHTER_DIR;
  process.env.TP_VARLIGHTER_DIR = p.local;
  try {
    p.writer.addSamples(oscillating(0, 600));
    const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'varlighter_backtest', arguments: { symbol: KEY, hours: 8, trades: 3 } } }, p.get) as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(answer.result.isError, undefined, answer.result.content[0]!.text);
    const body = JSON.parse(answer.result.content[0]!.text) as { pulled: { added: number }; result: { summary: unknown; trades: unknown[] } };
    assert.equal(body.pulled.added, 600);
    const direct = runLocal({ symbol: KEY, hours: 8, trades: 3 }, p.local) as { summary: unknown; trades: unknown[] };
    assert.deepEqual(body.result, JSON.parse(JSON.stringify(direct)));
    const missing = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'varlighter_backtest', arguments: { symbol: 'lighter:OLD' } } }, p.get) as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0]!.text, /给出 kind/);
  } finally {
    if (saved === undefined) delete process.env.TP_VARLIGHTER_DIR; else process.env.TP_VARLIGHTER_DIR = saved;
    await p.close();
  }
});
