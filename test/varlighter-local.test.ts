// DEX spread (formerly Var/Lighter) on the client machine (docs/mcp.md 8.3): tools/varlighter/pull.ts pulls the samples with the read-only
// token, tools/varlighter/backtest.ts replays them with the repository's backtest, and the MCP tool chains both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { createReadTokens } from '../src/read-token.ts';
import { localDexForward, openVarLighter, varLighterViews } from '../src/dex/host.ts';
import { runBacktest } from '../src/varlighter/backtest.ts';
import type { Sample } from '../src/varlighter/model.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL, type GlobalParams, type SymbolParams } from '../src/varlighter/strategy.ts';
import type { StateView } from '../src/varlighter/views.ts';
import { PlatformError, handle, platformGet, type Get } from '../tools/mcp/readonly.ts';
import { checkRequest, combinations, GAP_MS, loadSamples, parseArgs, readRequest, runLocal } from '../tools/varlighter/backtest.ts';
import { lastSampleAt, parsePullArgs, pull, sampleFile } from '../tools/varlighter/pull.ts';
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
  const state = { rows: [{ key: KEY, kind: 'crypto', name: 'Bitcoin', enabled: true, position: null, aFeeBps: 0, bFeeBps: 0 }], orphans: [{ key: OLD }],
    settings: { revision: 3, global: GLOBAL, symbols: { [KEY]: PARAMS }, confirmed: [KEY], combos: ['var|rh'], pairs: [] } } as unknown as StateView;
  const server = createExecutorServer({ executor: h.ex, accessToken: 'vl-local-access-01', session: 'vl-local-session-01', readTokens: createReadTokens({ dir, log: () => {} }), log: () => {},
    views: { varlighter: localDexForward({ ...varLighterViews(holder), state: () => state }) } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = ((await fetch(`${base}/login?token=vl-local-access-01`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
  const { token } = await (await fetch(`${base}/api/read-token/generate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: '{"name":"test","scopes":["public","system","portfolio"]}' })).json() as { token: string };
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
    assert.deepEqual(first.results.map(result => [result.symbol, result.added]), [[KEY, 2_500], [OLD, 0]], '三页拉完；失联配对一并尝试');
    assert.equal(lastSampleAt(sampleFile(p.local, KEY)), samples.at(-1)!.t);
    assert.equal((await pull({ get: p.get, dir: p.local, symbols: [KEY] })).results[0]!.added, 0, '没有新样本');
    const more = oscillating(2_500, 10);
    p.writer.addSamples(more);
    assert.equal((await pull({ get: p.get, dir: p.local, symbols: [KEY] })).results[0]!.added, 10, '只拉新增的');
    const lines = readFileSync(sampleFile(p.local, KEY), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Sample);
    assert.deepEqual(lines, [...samples, ...more], '本机文件与服务器样本逐条一致');

    // The server gives its backtest one baseline window before `from` (engine.ts), and so does the local one.
    const all = [...samples, ...more], to = all.at(-1)!.t, from = to - 24 * 3_600_000;
    const window = all.filter(item => item.t >= from - GLOBAL.windowHours * 3_600_000);
    const server = runBacktest(KEY, 'crypto', window, from, to, PARAMS, GLOBAL, FEES);
    assert.ok(server.trades.length >= 20, `应有成交，实际 ${server.trades.length}`);
    const single = runLocal({ symbol: KEY, hours: 24, trades: 5 }, p.local) as { summary: unknown; trades: unknown[]; tradesShown: number; params: SymbolParams; global: GlobalParams };
    assert.deepEqual(single.summary, server.summary);
    assert.deepEqual(single.trades, server.trades.slice(-5));
    assert.deepEqual([single.params.entryBps, single.global.windowHours], [15, 2], '缺的参数用平台保存的');
    const changed = runLocal({ symbol: KEY, hours: 24, params: { entryBps: 30 } }, p.local) as { summary: unknown };
    assert.deepEqual(changed.summary, runBacktest(KEY, 'crypto', window, from, to, { ...PARAMS, entryBps: 30 }, GLOBAL, FEES).summary);
    const grid = runLocal({ symbol: KEY, hours: 24, grid: { entryBps: [15, 30], minNetBps: [3, 7] } }, p.local) as { combos: number; runs: { values: Record<string, number>; summary: { netUsd: number } }[] };
    assert.equal(grid.combos, 4);
    assert.ok(grid.runs.every((run, index) => index === 0 || grid.runs[index - 1]!.summary.netUsd >= run.summary.netUsd), '按净盈亏从高到低');
    const best = grid.runs[0]!;
    assert.deepEqual(best.summary, runBacktest(KEY, 'crypto', window, from, to, { ...PARAMS, entryBps: best.values.entryBps! }, { ...GLOBAL, minNetBps: best.values.minNetBps! }, FEES).summary);
    assert.throws(() => runLocal({ symbol: OLD }, p.local), /请在请求里给出 kind/);
    assert.throws(() => runLocal({ symbol: 'var:NONE|rh:NONE', kind: 'crypto' }, p.local), /先运行 tools\/varlighter\/pull\.ts/);
    // 旧键（v0.87.0 以前的 rh:BTC）按 var:BTC|rh:BTC 读同一份本机样本；手续费按平台当时用的值，请求里可覆盖。
    assert.deepEqual((runLocal(readRequest({ symbol: 'rh:BTC', hours: 24, trades: 5 }), p.local) as { summary: unknown }).summary, server.summary);
    const fee = runLocal({ symbol: KEY, hours: 24, global: { rhFeeBps: 5 } }, p.local) as { summary: unknown };
    assert.deepEqual(fee.summary, runBacktest(KEY, 'crypto', window, from, to, PARAMS, { ...GLOBAL, rhFeeBps: 5 }, { aFeeBps: 0, bFeeBps: 5 }).summary);
    assert.throws(() => runLocal({ symbol: KEY, params: { entryBps: -1 } }, p.local));
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
    const { results } = await pull({ get, dir, symbols: [KEY], sleep: async seconds => { waits.push(seconds); } });
    assert.deepEqual(waits, [7, 7]);
    assert.deepEqual(limits, ['1000', '500', '250']);
    assert.equal(results[0]!.added, 1);
    await assert.rejects(pull({ get: async () => { throw new PlatformError('401', 401); }, dir, symbols: [KEY] }), /401/);
    await assert.rejects(pull({ get, dir, symbols: ['BTC'] }), /配对键无效/);
    // 平台还是 v0.87.0 以前（样本没有 format 或为 1）：字段不同，拒绝而不是写出错的本机文件。
    const old: Get = async path => path === '/api/varlighter/state' ? await get(path)
      : { symbol: KEY, columns: ['symbol', 't'], rows: [[KEY, T0]], next: null, firstAt: T0, retentionDays: 14 };
    await assert.rejects(pull({ get: old, dir, symbols: ['var:ETH|rh:ETH'] }), /样本格式是 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 审查补充（docs/reviews/2026-11-25-varlighter-ai-readonly.md）----

test('本机拉样本：同一配对并发拉取不重复；中断留下的半行先截掉再续拉', async () => {
  const p = await platform();
  try {
    const samples = oscillating(0, 1_500);
    p.writer.addSamples(samples);
    const file = sampleFile(p.local, KEY);
    const pulls = await Promise.all([1, 2, 3].map(() => pull({ get: p.get, dir: p.local, symbols: [KEY] })));
    assert.equal(pulls.reduce((sum, done) => sum + done.results[0]!.added, 0), 1_500, '三次并发合计只写一遍');
    const read = () => readFileSync(file, 'utf8').trim().split('\n').map(line => (JSON.parse(line) as Sample).t);
    assert.deepEqual(read(), samples.map(item => item.t));
    assert.equal(existsSync(`${file}.lock`), false, '锁已释放');

    appendFileSync(file, '{"symbol":"var:BTC|rh:BTC","t":');
    assert.equal(lastSampleAt(file), samples.at(-1)!.t, '半行被截掉');
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
    const more = oscillating(1_500, 5);
    p.writer.addSamples(more);
    appendFileSync(file, '{"t":');
    assert.equal((await pull({ get: p.get, dir: p.local, symbols: [KEY] })).results[0]!.added, 5);
    assert.deepEqual(read(), [...samples, ...more].map(item => item.t));
    appendFileSync(file, 'garbage\n');
    assert.throws(() => lastSampleAt(file), /删除最后一行后重试/);
  } finally { await p.close(); }
});

test('本机样本：服务器已过保留期时报告空档；载入时跳过不递增的行并列出超过 30 分钟的空档', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-vl-gap-'));
  try {
    const file = sampleFile(dir, KEY);
    writeFileSync(file, `${JSON.stringify(sample(T0, 100))}\n`);
    const later = T0 + 3 * 3_600_000;
    const get: Get = async path => path === '/api/varlighter/state'
      ? { rows: [], orphans: [], settings: { revision: 1, global: GLOBAL, symbols: {}, confirmed: [], combos: ['var|rh'], pairs: [] } }
      : { symbol: KEY, format: 2, columns: ['symbol', 't'], rows: [[KEY, later]], next: null, firstAt: later, retentionDays: 14 };
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
  // 本机样本文件名把配对键整体编码（含 | 与 @），旧文件 rh:BTC.jsonl 不动。
  assert.ok(sampleFile('d', 'rh:ETH|lighter:ETH@0.5').endsWith(`${encodeURIComponent('rh:ETH|lighter:ETH@0.5')}.jsonl`));
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
  process.env.TP_VARLIGHTER_DIR = p.local;
  try {
    p.writer.addSamples(oscillating(0, 600));
    const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'varlighter_backtest', arguments: { symbol: KEY, hours: 8, trades: 3 } } }, p.get) as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(answer.result.isError, undefined, answer.result.content[0]!.text);
    const body = JSON.parse(answer.result.content[0]!.text) as { pulled: { added: number }; result: { summary: unknown; trades: unknown[] } };
    assert.equal(body.pulled.added, 600);
    const direct = runLocal({ symbol: KEY, hours: 8, trades: 3 }, p.local) as { summary: unknown; trades: unknown[] };
    assert.deepEqual(body.result, JSON.parse(JSON.stringify(direct)));
    const missing = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'varlighter_backtest', arguments: { symbol: OLD } } }, p.get) as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0]!.text, /给出 kind/);
    // A request the strategy rules reject is refused in the child before anything is pulled.
    const paths: string[] = [];
    const watched: Get = path => { paths.push(path); return p.get(path); };
    const bad = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'varlighter_backtest', arguments: { symbol: 'var:ETH|rh:ETH', params: { entryBps: -1 } } } }, watched) as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(bad.result.isError, true);
    assert.deepEqual(paths, [], '不合法的请求不拉取');
    assert.equal(existsSync(sampleFile(p.local, 'var:ETH|rh:ETH')), false);
  } finally {
    if (saved === undefined) delete process.env.TP_VARLIGHTER_DIR; else process.env.TP_VARLIGHTER_DIR = saved;
    await p.close();
  }
});
