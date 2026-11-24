// Replays locally pulled Var/Lighter samples (tools/varlighter/pull.ts) with the repository's current backtest
// (src/varlighter/backtest.ts), so a strategy change can be checked against real samples before it is released
// (docs/mcp.md 8.3). Every run is a fresh process: edit the strategy, run again, compare.
//
//   node tools/varlighter/backtest.ts --symbol rh:AAPL --hours 168 --params '{"entryBps":25}'
//   node tools/varlighter/backtest.ts --symbol rh:AAPL --grid '{"entryBps":[15,20,25,30],"exitBps":[-5,0,5]}'
//   node tools/varlighter/backtest.ts --request '{"symbol":"rh:AAPL","grid":{"entryBps":[20,30]}}'
//
// Missing parameters are filled from the platform's saved ones (state.json), checked like the page's backtest request.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBacktest, type BacktestSummary } from '../../src/varlighter/backtest.ts';
import { PAIR_KEY, SAMPLE_FIELDS, type AssetKind, type Sample } from '../../src/varlighter/model.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL, readGlobalParams, readSymbolParams, type GlobalParams, type SymbolParams } from '../../src/varlighter/strategy.ts';
import { dataDir, sampleFile, STATE_FILE, type LocalState } from './pull.ts';

export const MAX_COMBOS = 200;
const MAX_HOURS = 24 * 365;
const KINDS: readonly AssetKind[] = ['equity', 'etf', 'crypto', 'metal', 'commodity', 'private', 'other'];

export class RequestError extends Error {}

export interface BacktestRequest {
  symbol: string;
  /** Hours replayed up to the last local sample; omitted: everything after the first baseline window. */
  hours?: number;
  params?: Record<string, unknown>; global?: Record<string, unknown>;
  /** Candidate values per parameter (symbol or global field names); every combination is run. */
  grid?: Record<string, unknown[]>;
  /** Trades listed for a single run: a count (default 50) or 'all'. */
  trades?: number | 'all';
  /** Needed only for a pair no longer listed in state.json. */
  kind?: AssetKind;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function readRequest(raw: unknown): BacktestRequest {
  if (!isObject(raw)) throw new RequestError('回测请求须为对象');
  const unknown = Object.keys(raw).find(key => !['symbol', 'hours', 'params', 'global', 'grid', 'trades', 'kind'].includes(key));
  if (unknown) throw new RequestError(`回测请求包含未知字段 ${unknown}`);
  if (typeof raw.symbol !== 'string' || !PAIR_KEY.test(raw.symbol)) throw new RequestError('symbol 须为配对键（如 rh:AAPL）');
  if (raw.hours !== undefined && (typeof raw.hours !== 'number' || !Number.isInteger(raw.hours) || raw.hours < 1 || raw.hours > MAX_HOURS)) throw new RequestError(`hours 须为 1–${MAX_HOURS} 的整数`);
  for (const name of ['params', 'global'] as const) if (raw[name] !== undefined && !isObject(raw[name])) throw new RequestError(`${name} 须为对象`);
  if (raw.grid !== undefined) {
    if (!isObject(raw.grid) || !Object.keys(raw.grid).length) throw new RequestError('grid 须为非空对象，每个字段给出候选值数组');
    for (const [name, values] of Object.entries(raw.grid)) {
      if (!(name in DEFAULT_SYMBOL) && !(name in DEFAULT_GLOBAL)) throw new RequestError(`grid 里的 ${name} 不是标的参数或全局参数`);
      if (name === 'enabled' || name === 'paused') throw new RequestError(`grid 不能扫 ${name}`);
      if (!Array.isArray(values) || !values.length) throw new RequestError(`grid.${name} 须为非空数组`);
    }
    const combos = Object.values(raw.grid as Record<string, unknown[]>).reduce((product, values) => product * values.length, 1);
    if (combos > MAX_COMBOS) throw new RequestError(`grid 组合 ${combos} 个，超过上限 ${MAX_COMBOS}`);
  }
  if (raw.trades !== undefined && raw.trades !== 'all' && (typeof raw.trades !== 'number' || !Number.isInteger(raw.trades) || raw.trades < 0 || raw.trades > 10_000)) throw new RequestError('trades 须为 0–10000 的整数或 all');
  if (raw.kind !== undefined && !KINDS.includes(raw.kind as AssetKind)) throw new RequestError(`kind 须为 ${KINDS.join('、')} 之一`);
  return raw as unknown as BacktestRequest;
}

/** One pair's local samples, oldest first; fields a newer server added are dropped, missing ones become null. */
export function loadSamples(file: string): Sample[] {
  if (!existsSync(file)) throw new RequestError(`本机没有这个配对的样本（${file}）：先运行 tools/varlighter/pull.ts`);
  const samples: Sample[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line) as Record<string, unknown>;
    samples.push(Object.fromEntries(SAMPLE_FIELDS.map(field => [field, raw[field] ?? null])) as unknown as Sample);
  }
  return samples;
}

/** Every combination of the grid's values, in the order given. */
export function combinations(grid: Record<string, unknown[]>): Record<string, unknown>[] {
  return Object.entries(grid).reduce<Record<string, unknown>[]>((list, [name, values]) => list.flatMap(combo => values.map(value => ({ ...combo, [name]: value }))), [{}]);
}

const split = (values: Record<string, unknown>) => {
  const symbol: Record<string, unknown> = {}, global: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) (name in DEFAULT_SYMBOL ? symbol : global)[name] = value;
  return { symbol, global };
};

export function runLocal(request: BacktestRequest, dir: string): unknown {
  const statePath = join(dir, STATE_FILE);
  if (!existsSync(statePath)) throw new RequestError(`没有 ${statePath}：先运行 tools/varlighter/pull.ts`);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as LocalState;
  const kind = request.kind ?? state.pairs.find(pair => pair.key === request.symbol)?.kind;
  if (!kind) throw new RequestError(`state.json 里没有 ${request.symbol} 的类别（配对已失联）：请在请求里给出 kind`);
  const samples = loadSamples(sampleFile(dir, request.symbol));
  if (!samples.length) throw new RequestError('本机样本为空');
  const savedSymbol = state.settings.symbols[request.symbol] ?? DEFAULT_SYMBOL;
  const savedGlobal = readGlobalParams({}, { ...DEFAULT_GLOBAL, ...state.settings.global });
  const to = samples.at(-1)!.t;
  const resolve = (overrides: Record<string, unknown>) => {
    const extra = split(overrides);
    const params: SymbolParams = readSymbolParams({ ...request.params, ...extra.symbol, enabled: true }, { ...DEFAULT_SYMBOL, ...savedSymbol });
    const global: GlobalParams = readGlobalParams({ ...request.global, ...extra.global }, savedGlobal);
    const from = request.hours !== undefined ? to - request.hours * 3_600_000 : samples[0]!.t + global.windowHours * 3_600_000;
    return { params, global, from };
  };
  const span = { firstSample: samples[0]!.t, lastSample: to, localSamples: samples.length };
  if (!request.grid) {
    const { params, global, from } = resolve({});
    const result = runBacktest(request.symbol, kind, samples, from, to, params, global);
    const shown = request.trades === 'all' ? result.trades : result.trades.slice(-(request.trades ?? 50));
    return { symbol: request.symbol, kind, ...span, from, to, samples: result.samples, params, global, summary: result.summary, open: result.open, tradesShown: shown.length, trades: shown };
  }
  // Without hours, from follows each combination's baseline window, so it is listed per run.
  const runs: { values: Record<string, unknown>; from: number; summary: BacktestSummary }[] = [];
  for (const values of combinations(request.grid)) {
    const resolved = resolve(values);
    runs.push({ values, from: resolved.from, summary: runBacktest(request.symbol, kind, samples, resolved.from, to, resolved.params, resolved.global).summary });
  }
  runs.sort((a, b) => b.summary.netUsd - a.summary.netUsd);
  const base = resolve({});
  return { symbol: request.symbol, kind, ...span, to, base: { params: base.params, global: base.global }, combos: runs.length, runs };
}

/** `--request <json>`, or the flags --symbol, --hours, --params, --global, --grid, --trades, --kind. */
export function parseArgs(argv: readonly string[]): BacktestRequest {
  const raw: Record<string, unknown> = {};
  const json = (name: string, text: string) => { try { return JSON.parse(text) as unknown; } catch { throw new RequestError(`${name} 不是有效的 JSON`); } };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!, value = argv[index + 1];
    if (value === undefined) throw new RequestError(`${flag} 缺少取值`);
    index++;
    if (flag === '--request') Object.assign(raw, json(flag, value));
    else if (flag === '--symbol' || flag === '--kind') raw[flag.slice(2)] = value;
    else if (flag === '--hours') raw.hours = Number(value);
    else if (flag === '--trades') raw.trades = value === 'all' ? 'all' : Number(value);
    else if (flag === '--params' || flag === '--global' || flag === '--grid') raw[flag.slice(2)] = json(flag, value);
    else throw new RequestError(`不认识的参数：${flag}`);
  }
  return readRequest(raw);
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(runLocal(parseArgs(process.argv.slice(2)), dataDir()))}\n`);
  } catch (error) {
    process.stderr.write(`回测失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
