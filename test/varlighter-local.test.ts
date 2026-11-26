// DEX spread (formerly Var/Lighter) on the client machine (docs/mcp.md 8.3): tools/varlighter/pull.ts pulls the samples with the read-only
// token, tools/varlighter/backtest.ts replays them with the repository's backtest, and the MCP tool chains both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { createReadTokens } from '../src/read-token.ts';
import { localDexForward, openVarLighter, varLighterViews } from '../src/dex/host.ts';
import { runBacktest, type BacktestResult } from '../src/varlighter/backtest.ts';
import { SAMPLE_FIELDS, type Sample } from '../src/varlighter/model.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL, type GlobalParams, type SymbolParams } from '../src/varlighter/strategy.ts';
import type { StateView } from '../src/varlighter/views.ts';
import { PlatformError, handle, platformGet, type Get } from '../tools/mcp/readonly.ts';
import { checkRequest, combinations, GAP_MS, loadSamples, parseArgs, readRequest, runLocal, type BacktestRequest } from '../tools/varlighter/backtest.ts';
import { readLocalState, sampleFile, sourceCache, STATE_FILE } from '../tools/varlighter/cache.ts';
import { lastSampleAt, parsePullArgs, pull } from '../tools/varlighter/pull.ts';
import { bindAccounts, createHarness } from './harness.ts';

const T0 = Date.parse('2026-11-23T15:00:00Z');
const KEY = 'var:BTC|rh:BTC';
const OLD = 'var:OLD|lighter:OLD';
const FEES = { aFeeBps: 0, bFeeBps: 0 };
const PARAMS: SymbolParams = { ...DEFAULT_SYMBOL, enabled: true, entryBps: 15, exitBps: 2, cooldownMinutes: 0, regimes: ['all'] };
const GLOBAL: GlobalParams = { ...DEFAULT_GLOBAL, windowHours: 2, minSamples: 30 };

function sample(t: number, varMid: number, rhMid = 100): Sample {
  return {
    symbol: KEY, t, receivedAt: t + 1_000, regime: 'all', ratio: 1,
    aAt: t, aMark: varMid, aIndex: null, aFunding: 0.1,
    aBid0: varMid - 0.01, aAsk0: varMid + 0.01, aBid1k: varMid - 0.02, aAsk1k: varMid + 0.02, aBid100k: varMid - 0.05, aAsk100k: varMid + 0.05,
    aBidRx: null, aAskRx: null, aBidTk: null, aAskTk: null, aTkAt: null,
    bAt: t - 500, bMark: rhMid, bIndex: rhMid, bFunding: 0.0001,
    bBid0: rhMid - 0.01, bAsk0: rhMid + 0.01, bBid1k: rhMid - 0.02, bAsk1k: rhMid + 0.02, bBid100k: null, bAsk100k: null,
    bBidRx: rhMid - 0.01, bAskRx: rhMid + 0.01, bBidTk: null, bAskTk: null, bTkAt: null,
    captureKind: 'decision', decisionAt: t + 1_000, aRxAt: null, bRxAt: t + 1_000, aTkQty: null, bTkQty: null, aTkReceivedAt: null, bTkReceivedAt: null,
  };
}
/** Var spikes 45 bp over Lighter every 30 minutes and sits 20 bp over otherwise: a trade per spike. */
const oscillating = (from: number, count: number): Sample[] => Array.from({ length: count }, (_, index) => sample(T0 + (from + index) * 60_000, 100 * (1 + ((from + index) % 30 === 15 ? 45 : 20) / 1e4)));

async function platform(params = PARAMS, fees = FEES) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-vl-local-'));
  const root = mkdtempSync(join(tmpdir(), 'tp-vl-cache-'));
  const h = createHarness();
  bindAccounts(h.ex);
  const holder = openVarLighter(dir, { fetchImpl: async () => Response.json({}), connect: () => { throw new Error('不连行情'); } }, () => {});
  const writer = openVarLighterStore(join(dir, 'varlighter.sqlite'));
  // The state is written by hand (the real one needs the venues' catalogs); the samples come from the real engine.
  const state = { rows: [{ key: KEY, kind: 'crypto', name: 'Bitcoin', enabled: true, position: null, ...fees }], orphans: [{ key: OLD }],
    settings: { revision: 3, global: GLOBAL, symbols: { [KEY]: params }, confirmed: [KEY], combos: ['var|rh'], pairs: [] } } as unknown as StateView;
  const server = createExecutorServer({ executor: h.ex, accessToken: 'vl-local-access-01', session: 'vl-local-session-01', readTokens: createReadTokens({ dir, log: () => {} }), log: () => {},
    views: { varlighter: localDexForward({ ...varLighterViews(holder), state: () => state }) } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = ((await fetch(`${base}/login?token=vl-local-access-01`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
  const tokenFile = join(dir, 'client-token');
  const newReader = async () => {
    const { token } = await (await fetch(`${base}/api/read-token/generate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: '{"name":"test","scopes":["public","system","portfolio"]}' })).json() as { token: string };
    writeFileSync(tokenFile, token, { mode: 0o600 });
    return platformGet({ base: new URL(base), token });
  };
  return {
    root, local: sourceCache(root, base).dir, base, tokenFile, writer, get: await newReader(), newReader,
    async close() { writer.close(); await new Promise(resolve => server.close(resolve)); h.dispose(); holder.engine?.close(); rmSync(dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); },
  };
}

type Replay = Pick<BacktestResult, 'summary' | 'trades'> & { source: string; tradesShown: number; params: SymbolParams; global: GlobalParams };
const cli = (request: BacktestRequest, root: string, source?: string): Replay => {
  const env: NodeJS.ProcessEnv = { ...process.env, TP_VARLIGHTER_DIR: root, TP_MCP_TOKEN_FILE: join(root, 'missing-token') };
  if (source === undefined) delete env.TP_MCP_URL; else env.TP_MCP_URL = source;
  return JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../tools/varlighter/backtest.ts', import.meta.url)), '--request', JSON.stringify(request)], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
};

async function mcpText(get: Get, args: Record<string, unknown>): Promise<string> {
  const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'varlighter_backtest', arguments: args } }, get) as { result: { content: { text: string }[]; isError?: boolean } };
  if (answer.result.isError) throw new Error(answer.result.content[0]!.text);
  return answer.result.content[0]!.text;
}

async function mcp(get: Get, args: Record<string, unknown>) {
  return JSON.parse(await mcpText(get, args)) as { cacheNotice?: string; pulled: { added: number; file: string }; result: Replay };
}

function assertTradeDetails(replay: Replay, reference: BacktestResult, limit: number | 'all') {
  assert.deepEqual(replay.summary, reference.summary);
  const expected = limit === 0 ? [] : limit === 'all' ? reference.trades : reference.trades.slice(-limit);
  assert.equal(replay.tradesShown, expected.length);
  assert.deepEqual(replay.trades, expected);
}

test('本机拉样本：按页增量续拉，重拉不重复；--enabled 含已启用与失联配对；本机回测与服务器同一套回测结果一致；grid 按净盈亏排序', async () => {
  const p = await platform();
  try {
    const samples = oscillating(0, 2_500);
    p.writer.addSamples(samples);
    const first = await pull({ get: p.get, dir: p.root, enabled: true });
    assert.deepEqual(first.results.map(result => [result.symbol, result.added]), [[KEY, 2_500], [OLD, 0]], '三页拉完；失联配对一并尝试');
    assert.equal(lastSampleAt(sampleFile(p.local, KEY)), samples.at(-1)!.t);
    assert.equal((await pull({ get: p.get, dir: p.root, symbols: [KEY] })).results[0]!.added, 0, '没有新样本');
    const more = oscillating(2_500, 10);
    p.writer.addSamples(more);
    assert.equal((await pull({ get: p.get, dir: p.root, symbols: [KEY] })).results[0]!.added, 10, '只拉新增的');
    const lines = readFileSync(sampleFile(p.local, KEY), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Sample);
    assert.deepEqual(lines, [...samples, ...more], '本机文件与服务器样本逐条一致');

    // The server gives its backtest one baseline window before `from` (engine.ts), and so does the local one.
    const all = [...samples, ...more], to = all.at(-1)!.t, from = to - 24 * 3_600_000;
    const window = all.filter(item => item.t >= from - GLOBAL.windowHours * 3_600_000);
    const server = runBacktest(KEY, 'crypto', window, from, to, PARAMS, GLOBAL, FEES);
    assert.ok(server.trades.length >= 20, `应有成交，实际 ${server.trades.length}`);
    const single = runLocal({ symbol: KEY, hours: 24, trades: 5 }, p.root) as { summary: unknown; trades: unknown[]; tradesShown: number; params: SymbolParams; global: GlobalParams };
    assert.deepEqual(single.summary, server.summary);
    assert.deepEqual(single.trades, server.trades.slice(-5));
    assert.deepEqual([single.params.entryBps, single.global.windowHours], [15, 2], '缺的参数用平台保存的');
    const full = runBacktest(KEY, 'crypto', all, to - 72 * 3_600_000, to, PARAMS, GLOBAL, FEES);
    assert.ok(full.trades.length > 50 && full.trades.length < 200);
    for (const trades of [0, 1, undefined, 200, 'all'] as const) {
      const request = { symbol: KEY, hours: 72, trades };
      assertTradeDetails(runLocal(request, p.root) as Replay, full, trades ?? 50);
      assertTradeDetails(cli(request, p.root), full, trades ?? 50);
    }
    assert.throws(() => cli({ symbol: KEY, trades: -1 }, p.root), /trades 须为/);
    assert.throws(() => runLocal({ symbol: KEY, trades: -1 }, p.root), /trades 须为/);
    const changed = runLocal({ symbol: KEY, hours: 24, params: { entryBps: 30 } }, p.root) as { summary: unknown };
    assert.deepEqual(changed.summary, runBacktest(KEY, 'crypto', window, from, to, { ...PARAMS, entryBps: 30 }, GLOBAL, FEES).summary);
    const grid = runLocal({ symbol: KEY, hours: 24, grid: { entryBps: [15, 30], minNetBps: [3, 7] } }, p.root) as { combos: number; runs: { values: Record<string, number>; summary: { netUsd: number } }[] };
    assert.equal(grid.combos, 4);
    assert.ok(grid.runs.every((run, index) => index === 0 || grid.runs[index - 1]!.summary.netUsd >= run.summary.netUsd), '按净盈亏从高到低');
    const best = grid.runs[0]!;
    assert.deepEqual(best.summary, runBacktest(KEY, 'crypto', window, from, to, { ...PARAMS, entryBps: best.values.entryBps! }, { ...GLOBAL, minNetBps: best.values.minNetBps! }, FEES).summary);
    assert.throws(() => runLocal({ symbol: OLD }, p.root), /请在请求里给出 kind/);
    assert.throws(() => runLocal({ symbol: 'var:NONE|rh:NONE', kind: 'crypto' }, p.root), /先运行 tools\/varlighter\/pull\.ts/);
    // 旧键（v0.87.0 以前的 rh:BTC）按 var:BTC|rh:BTC 读同一份本机样本；手续费按平台当时用的值，请求里可覆盖。
    assert.deepEqual((runLocal(readRequest({ symbol: 'rh:BTC', hours: 24, trades: 5 }), p.root) as { summary: unknown }).summary, server.summary);
    const fee = runLocal({ symbol: KEY, hours: 24, global: { rhFeeBps: 5 } }, p.root) as { summary: unknown };
    assert.deepEqual(fee.summary, runBacktest(KEY, 'crypto', window, from, to, PARAMS, { ...GLOBAL, rhFeeBps: 5 }, { aFeeBps: 0, bFeeBps: 5 }).summary);
    assert.throws(() => runLocal({ symbol: KEY, params: { entryBps: -1 } }, p.root));
  } finally { await p.close(); }
});

test('本机拉样本：429 按 Retry-After 等待后继续，413 把每页减半，其他错误直接抛出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-vl-retry-'));
  try {
    const waits: number[] = [], limits: string[] = [];
    let refusals = 2;
    const get: Get = async path => {
      if (path === '/api/varlighter/state') return { rows: [], orphans: [], settings: { revision: 1, global: GLOBAL, symbols: {}, confirmed: [], combos: ['var|rh'], pairs: [] } };
      if (refusals-- > 0) throw new PlatformError('429', 429, 7);
      const limit = new URL(path, 'http://x').searchParams.get('limit')!;
      limits.push(limit);
      if (Number(limit) > 250) throw new PlatformError('413', 413);
      return { symbol: KEY, format: 2, columns: ['symbol', 't'], rows: [[KEY, T0]], next: null, firstAt: T0, retentionDays: 14 };
    };
    const bind = (reader: Get) => Object.assign(reader, { source: 'https://test.invalid' });
    const { results } = await pull({ get: bind(get), dir, symbols: [KEY], sleep: async seconds => { waits.push(seconds); } });
    assert.deepEqual(waits, [7, 7]);
    assert.deepEqual(limits, ['1000', '500', '250']);
    assert.equal(results[0]!.added, 1);
    await assert.rejects(pull({ get: bind(async () => { throw new PlatformError('401', 401); }), dir, symbols: [KEY] }), /401/);
    await assert.rejects(pull({ get, dir, symbols: ['BTC'] }), /配对键无效/);
    // 平台还是 v0.87.0 以前（样本没有 format 或为 1）：字段不同，拒绝而不是写出错的本机文件。
    const old: Get = async path => path === '/api/varlighter/state' ? await get(path)
      : { symbol: KEY, columns: ['symbol', 't'], rows: [[KEY, T0]], next: null, firstAt: T0, retentionDays: 14 };
    await assert.rejects(pull({ get: bind(old), dir, symbols: ['var:ETH|rh:ETH'] }), /样本格式是 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 审查补充（docs/reviews/2026-11-25-varlighter-ai-readonly.md）----

test('本机拉样本：同一配对并发拉取不重复；中断留下的半行先截掉再续拉', async () => {
  const p = await platform();
  try {
    const samples = oscillating(0, 1_500);
    p.writer.addSamples(samples);
    const file = sampleFile(p.local, KEY);
    const pulls = await Promise.all([1, 2, 3].map(() => pull({ get: p.get, dir: p.root, symbols: [KEY] })));
    assert.equal(pulls.reduce((sum, done) => sum + done.results[0]!.added, 0), 1_500, '三次并发合计只写一遍');
    const read = () => readFileSync(file, 'utf8').trim().split('\n').map(line => (JSON.parse(line) as Sample).t);
    assert.deepEqual(read(), samples.map(item => item.t));

    appendFileSync(file, '{"symbol":"var:BTC|rh:BTC","t":');
    assert.equal(lastSampleAt(file), samples.at(-1)!.t, '半行被截掉');
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
    const more = oscillating(1_500, 5);
    p.writer.addSamples(more);
    appendFileSync(file, '{"t":');
    assert.equal((await pull({ get: p.get, dir: p.root, symbols: [KEY] })).results[0]!.added, 5);
    assert.deepEqual(read(), [...samples, ...more].map(item => item.t));
    appendFileSync(file, 'garbage\n');
    assert.throws(() => lastSampleAt(file), /删除最后一行后重试/);
  } finally { await p.close(); }
});

test('本机样本：服务器已过保留期时报告空档；载入时跳过不递增的行并列出超过 30 分钟的空档', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-vl-gap-'));
  try {
    const later = T0 + 3 * 3_600_000;
    let time = T0;
    const get = Object.assign(async (path: string) => path === '/api/varlighter/state'
      ? { rows: [], orphans: [], settings: { revision: 1, global: GLOBAL, symbols: {}, confirmed: [], combos: ['var|rh'], pairs: [] } }
      : { symbol: KEY, format: 2, columns: ['symbol', 't'], rows: [[KEY, time]], next: null, firstAt: time, retentionDays: 14 }, { source: 'https://test.invalid' });
    const first = await pull({ get, dir, symbols: [KEY] });
    const file = first.results[0]!.file;
    const early = loadSamples(file).samples[0]!;
    assert.deepEqual([early.decisionAt, early.captureKind], [null, null], '早期格式 2 缺少的证据保持未知');
    time = later;
    const { results } = await pull({ get, dir, symbols: [KEY] });
    assert.deepEqual(results[0]!.gap, { from: T0, to: later });
    assert.equal(results[0]!.added, 1);

    const rows = [sample(T0, 100), sample(T0, 100), sample(T0 + 60_000, 100), sample(T0 - 60_000, 100), sample(T0 + 60_000 + GAP_MS + 1, 100)];
    writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}
`);
    const loaded = loadSamples(file);
    assert.deepEqual(loaded.samples.map(item => item.t), [T0, T0 + 60_000, T0 + 60_000 + GAP_MS + 1]);
    assert.equal(loaded.skipped, 2);
    assert.deepEqual(loaded.gaps, [{ from: T0 + 60_000, to: T0 + 60_000 + GAP_MS + 1 }]);
    appendFileSync(file, '{"symbol":"var:BTC|rh:BTC","t":');
    assert.equal(loadSamples(file).samples.length, 3, '正在追加的半行不读');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('本机回测参数：命令行与 JSON 请求同一套校验；grid 展开全部组合', () => {
  assert.deepEqual(parseArgs(['--symbol', KEY, '--hours', '48', '--params', '{"entryBps":20}', '--trades', 'all']), { symbol: KEY, hours: 48, params: { entryBps: 20 }, trades: 'all' });
  assert.deepEqual(parseArgs(['--request', '{"symbol":"lighter:ETH|entropy:ETH","grid":{"exitBps":[0,1]}}']), { symbol: 'lighter:ETH|entropy:ETH', grid: { exitBps: [0, 1] } });
  assert.equal(readRequest({ symbol: 'rh:AAPL' }).symbol, 'var:AAPL|rh:AAPL', '旧键升级');
  assert.equal(readRequest({ symbol: 'rh:ETH|lighter:ETH@0.5' }).symbol, 'rh:ETH|lighter:ETH@0.5');
  assert.throws(() => readRequest({ symbol: 'var:AAPL|var:AAPL' }));
  assert.throws(() => parseArgs(['--symbol', KEY, '--params', '{x']), /不是有效的 JSON/);
  assert.throws(() => parseArgs(['--hours']), /缺少取值/);
  assert.throws(() => readRequest({ symbol: KEY, extra: 1 }), /未知字段 extra/);
  assert.throws(() => readRequest({ symbol: KEY, kind: 'stock' }), /kind/);
  assert.deepEqual(combinations({ a: [1, 2], b: ['x', 'y'] }), [{ a: 1, b: 'x' }, { a: 1, b: 'y' }, { a: 2, b: 'x' }, { a: 2, b: 'y' }]);
  assert.deepEqual(parsePullArgs(['--symbol', KEY, '--enabled']), { symbols: [KEY], enabled: true });
  assert.throws(() => parsePullArgs([]), /--symbol/);
  // --check 只按参数规则核对，不读样本：没有 state.json 时用默认参数。
  const empty = mkdtempSync(join(tmpdir(), 'tp-vl-check-'));
  try {
    assert.deepEqual(checkRequest({ symbol: KEY, grid: { entryBps: [10, 20], windowHours: [2, 4] } }, empty), { ok: true, combos: 4 });
    assert.throws(() => checkRequest({ symbol: KEY, params: { entryBps: -1 } }, empty));
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('MCP varlighter_backtest：先增量拉取，再在新进程里用仓库代码回测，结果与本机回测一致', async () => {
  const p = await platform();
  const saved = process.env.TP_VARLIGHTER_DIR;
  process.env.TP_VARLIGHTER_DIR = p.root;
  try {
    const samples = oscillating(0, 1000), to = samples.at(-1)!.t;
    p.writer.addSamples(samples);
    const reference = runBacktest(KEY, 'crypto', samples, to - 24 * 3_600_000, to, PARAMS, GLOBAL, FEES);
    assert.ok(reference.trades.length > 20 && reference.trades.length < 200);
    for (const trades of [0, 1, undefined, 200] as const) {
      const request = { symbol: KEY, hours: 24, trades };
      const { pulled, result } = await mcp(p.get, request);
      assert.equal(pulled.added, trades === 0 ? samples.length : 0);
      assertTradeDetails(result, reference, trades ?? 20);
      assert.deepEqual(result, JSON.parse(JSON.stringify(runLocal({ ...request, trades: trades ?? 20 }, p.root))));
    }
    for (const trades of [-1, 201, 'all']) await assert.rejects(mcp(p.get, { symbol: KEY, trades }), /trades 须为 0–200/);
    await assert.rejects(mcp(p.get, { symbol: OLD }), /给出 kind/);
    // A request the strategy rules reject is refused in the child before anything is pulled.
    const paths: string[] = [];
    const watched = Object.assign((path: string) => { paths.push(path); return p.get(path); }, { source: p.base });
    await assert.rejects(mcp(watched, { symbol: 'var:ETH|rh:ETH', params: { entryBps: -1 } }), /entryBps|入场/);
    assert.deepEqual(paths, [], '不合法的请求不拉取');
    assert.equal(existsSync(sampleFile(p.local, 'var:ETH|rh:ETH')), false);
    p.writer.addSamples(Array.from({ length: 1000 }, (_, i) => sample(T0 + (1000 + i) * 60_000, i % 3 === 1 ? 100.8 : 100.2)));
    const large = await mcpText(p.get, { symbol: KEY, hours: 48, trades: 200 });
    assert.match(large, /已截断.*100 KiB.*减小 trades/);
    const compact = await mcp(p.get, { symbol: KEY, hours: 48, trades: 0 });
    assert.ok(compact.result.summary.trades > 200);
    assert.deepEqual(compact.result.trades, []);
  } finally {
    if (saved === undefined) delete process.env.TP_VARLIGHTER_DIR; else process.env.TP_VARLIGHTER_DIR = saved;
    await p.close();
  }
});

test('两个平台共用缓存根：命令行、并发 MCP、切回原平台与令牌轮换都只读取该来源的样本和费率', async t => {
  const bParams = { ...PARAMS, entryBps: 18 }, bFees = { aFeeBps: 1, bFeeBps: 2 };
  const a = await platform(), b = await platform(bParams, bFees);
  t.after(async () => { await Promise.all([a.close(), b.close()]); });
  const previous = process.env.TP_VARLIGHTER_DIR;
  process.env.TP_VARLIGHTER_DIR = a.root;
  t.after(() => { if (previous === undefined) delete process.env.TP_VARLIGHTER_DIR; else process.env.TP_VARLIGHTER_DIR = previous; });

  const legacyState = '{"settings":{}}', legacySample = '{"t":9999999999999}\n';
  const legacyFile = join(a.root, `${encodeURIComponent(KEY)}.jsonl`);
  writeFileSync(join(a.root, STATE_FILE), legacyState);
  writeFileSync(legacyFile, legacySample);
  const request = { symbol: KEY, hours: 24, trades: 200 };
  assert.throws(() => cli(request, a.root), /旧缓存缺少平台来源/);
  const aSamples = oscillating(120, 300), bSamples = Array.from({ length: 600 }, (_, i) => sample(T0 + i * 60_000, i % 20 === 10 ? 100.8 : 100.1));
  a.writer.addSamples(aSamples.slice(0, 180));
  b.writer.addSamples(bSamples);
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../tools/varlighter/pull.ts', import.meta.url)), '--symbol', KEY], {
    env: { ...process.env, TP_MCP_URL: a.base, TP_MCP_TOKEN_FILE: a.tokenFile }, windowsHide: true,
  });
  const first = JSON.parse(stdout);
  assert.deepEqual([first.source, first.dir, first.results[0].added], [a.base, a.local, 180]);
  assert.match(first.cacheNotice, /旧缓存/);
  a.writer.addSamples(aSamples.slice(180));

  const [aRun, bRun] = await Promise.all([mcp(a.get, request), mcp(b.get, request)]);
  assert.deepEqual([aRun.pulled.added, bRun.pulled.added], [120, 600]);
  assert.notEqual(aRun.pulled.file, bRun.pulled.file);
  assert.match(bRun.cacheNotice!, /旧缓存/);
  assert.throws(() => cli(request, a.root), /多个平台.*TP_MCP_URL/);
  for (const [run, connection, samples, params, fees] of [[aRun, a, aSamples, PARAMS, FEES], [bRun, b, bSamples, bParams, bFees]] as const) {
    const to = samples.at(-1)!.t;
    assert.deepEqual(loadSamples(run.pulled.file).samples, samples);
    assert.equal(run.result.source, connection.base);
    assert.deepEqual(run.result.params, params);
    const state = readLocalState(sourceCache(a.root, connection.base).dir)!;
    assert.deepEqual([state.source, state.pairs[0]!.aFeeBps, state.pairs[0]!.bFeeBps], [connection.base, fees.aFeeBps, fees.bFeeBps]);
    const reference = runBacktest(KEY, 'crypto', samples, to - 24 * 3_600_000, to, params, GLOBAL, fees);
    assert.ok(reference.trades.length > 0);
    assertTradeDetails(run.result, reference, 200);
    assert.deepEqual(cli(request, a.root, connection.base), run.result);
    assert.doesNotMatch(JSON.stringify(run) + readFileSync(join(sourceCache(a.root, connection.base).dir, STATE_FILE), 'utf8'), /tpr_/);
  }
  const again = await mcp(await a.newReader(), request);
  assert.equal(again.pulled.added, 0);
  assert.deepEqual(again.result, aRun.result);
  assert.equal(readFileSync(join(a.root, STATE_FILE), 'utf8'), legacyState);
  assert.equal(readFileSync(legacyFile, 'utf8'), legacySample);
});

test('同来源跨进程刷新先取得状态锁再发 GET，旧请求拉样本期间新请求可以发布自己的快照', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-vl-state-lock-'));
  const latch = () => {
    let open!: () => void;
    const wait = new Promise<void>(resolve => { open = resolve; });
    return { open, wait };
  };
  const oldRead = latch(), sendOldState = latch(), oldSampling = latch(), sendPage = latch(), newRead = latch();
  const snapshot = (revision: number) => ({
    rows: [{ key: KEY, kind: 'crypto', name: KEY, enabled: true, position: null, aFeeBps: revision, bFeeBps: 0 }], orphans: [],
    settings: { revision, global: GLOBAL, symbols: { [KEY]: { ...PARAMS, entryBps: 20 + revision } }, confirmed: [KEY], combos: ['var|rh'], pairs: [] },
  });
  const server = createServer(async (request, response) => {
    if (request.url === '/api/varlighter/state') {
      oldRead.open(); await sendOldState.wait;
      response.end(JSON.stringify(snapshot(1)));
    } else {
      oldSampling.open(); await sendPage.wait;
      response.end(JSON.stringify({ symbol: KEY, format: 2, columns: ['symbol', 't'], rows: [], firstAt: null, next: null }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tokenFile = join(root, 'token');
  writeFileSync(tokenFile, `tpr_${'A'.repeat(43)}`, { mode: 0o600 });
  const child = promisify(execFile)(process.execPath, [fileURLToPath(new URL('../tools/varlighter/pull.ts', import.meta.url)), '--symbol', KEY], {
    env: { ...process.env, TP_MCP_TOKEN_FILE: tokenFile, TP_MCP_URL: source, TP_VARLIGHTER_DIR: root }, windowsHide: true, timeout: 15_000,
  });
  const childStopped = child.then(() => { throw new Error('旧请求提前结束'); });
  let newer: Promise<unknown> | undefined;
  try {
    await Promise.race([oldRead.wait, childStopped]);
    newer = pull({ dir: root, get: Object.assign(async () => { newRead.open(); return snapshot(2); }, { source }) });
    const overlapped = await Promise.race([newRead.wait.then(() => true), delay(150, false, { ref: false })]);
    sendOldState.open();
    await Promise.race([oldSampling.wait, childStopped]);
    const published = await Promise.race([newer.then(() => true), delay(3_000, false, { ref: false })]);
    sendPage.open();
    await Promise.all([child, newer]);
    assert.equal(overlapped, false, '旧状态仍在读取时不能发起新的状态请求');
    assert.equal(published, true, '状态锁在请求样本前释放');
    const saved = readLocalState(sourceCache(root, source).dir)!;
    assert.deepEqual([saved.settings.revision, saved.settings.symbols[KEY]!.entryBps, saved.pairs[0]!.aFeeBps], [2, 22, 2]);
  } finally {
    sendOldState.open(); sendPage.open();
    await Promise.allSettled([child, childStopped, newer]);
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('配对键大小写进入文件、锁和每条样本校验，错误配对不能续写或回放', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-vl-pair-case-'));
  try {
    const lower = 'var:btc|rh:btc', source = 'https://test.invalid', dir = sourceCache(root, source).dir;
    const upperFile = sampleFile(dir, KEY), lowerFile = sampleFile(dir, lower);
    assert.notEqual(upperFile.toLowerCase(), lowerFile.toLowerCase());
    const byKey: Record<string, Sample[]> = { [KEY]: oscillating(0, 3), [lower]: oscillating(1, 4).map(row => ({ ...row, symbol: lower, aMark: 99 })) };
    let fault: 'page' | 'row' | undefined;
    const get = Object.assign(async (path: string) => {
      if (path === '/api/varlighter/state') return { rows: [KEY, lower].map(key => ({ key, kind: 'crypto', name: key, position: null })),
        orphans: [], settings: { global: GLOBAL, symbols: {} } };
      const params = new URL(path, source).searchParams, key = params.get('symbol')!, after = Number(params.get('after'));
      const rows = byKey[key]!.filter(s => s.t > after);
      if (fault === 'row') rows.push({ ...sample(after + 60_000, 101), symbol: lower });
      return { symbol: fault === 'page' ? lower : key, format: 2, columns: SAMPLE_FIELDS, rows: rows.map(s => SAMPLE_FIELDS.map(field => s[field])), firstAt: byKey[key]![0]!.t, next: null };
    }, { source });
    const [up, down] = await Promise.all([KEY, lower].map(symbol => pull({ get, dir: root, symbols: [symbol] })));
    assert.deepEqual([up.results[0]!.added, down.results[0]!.added], [3, 4]);
    assert.deepEqual(loadSamples(upperFile, KEY).samples, byKey[KEY]);
    assert.deepEqual(loadSamples(lowerFile, lower).samples, byKey[lower]);
    const original = readFileSync(upperFile, 'utf8');
    byKey[KEY]!.push(sample(T0 + 5 * 60_000, 101));
    for (fault of ['page', 'row'] as const) {
      await assert.rejects(pull({ get, dir: root, symbols: [KEY] }), /样本配对与请求/);
      assert.equal(readFileSync(upperFile, 'utf8'), original);
    }
    const foreignTail = original + JSON.stringify(byKey[lower]![0]) + '\n{"t":';
    writeFileSync(upperFile, foreignTail);
    assert.throws(() => runLocal({ symbol: KEY }, root, source), /样本配对与请求/);
    await assert.rejects(pull({ get, dir: root, symbols: [KEY] }), /样本配对与请求/);
    assert.equal(readFileSync(upperFile, 'utf8'), foreignTail, '发现异配对后保留文件，包括最后的半行');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('缓存按规范化地址分区，无法确认来源的快照或孤立样本在写入前报错', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-vl-source-'));
  try {
    const cache = sourceCache(root, 'HTTPS://EXAMPLE.TEST:443/');
    assert.deepEqual(cache, sourceCache(root, 'https://example.test'));
    assert.equal(cache.source, 'https://example.test');
    assert.notEqual(cache.dir, sourceCache(root, 'http://example.test').dir);
    assert.notEqual(cache.dir, sourceCache(root, 'https://example.test:8443').dir);
    for (const raw of ['https://user:secret@example.test', 'https://example.test/?token=secret']) {
      assert.throws(() => sourceCache(root, raw), error => error instanceof Error && !error.message.includes('secret'));
    }
    mkdirSync(cache.dir, { recursive: true });
    const file = sampleFile(cache.dir, KEY), snapshot = join(cache.dir, STATE_FILE);
    writeFileSync(file, 'old data');
    const get = Object.assign(async () => assert.fail('来源不明时不能拉取'), { source: cache.source });
    await assert.rejects(pull({ get, dir: root, symbols: [KEY] }), /样本缺少平台来源/);
    assert.equal(existsSync(snapshot), false);
    for (const state of [{}, { source: 'https://other.test' }]) {
      const raw = JSON.stringify(state);
      writeFileSync(snapshot, raw);
      await assert.rejects(pull({ get, dir: root, symbols: [KEY] }), /缓存来源与平台目录不符/);
      assert.throws(() => runLocal({ symbol: KEY }, root, cache.source), /缓存来源与平台目录不符/);
      assert.equal(readFileSync(snapshot, 'utf8'), raw);
    }
    assert.equal(readFileSync(file, 'utf8'), 'old data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
