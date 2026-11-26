// Pulls Var/Lighter samples from the platform into a local directory (docs/mcp.md 8.3), so an AI on the client machine
// can replay them with the repository's backtest. Uses the read-only token like tools/mcp/readonly.ts and never runs on
// the server. Each platform's directory holds a JSONL file per case-sensitive pair key (format 2, legs a/b, oldest first). `state.json` keeps the
// saved parameters and each pair's asset kind. A file is continued after its last line, so local history may outgrow
// the server's 14-day retention.
//
//   TP_MCP_URL=… TP_MCP_TOKEN_FILE=… node tools/varlighter/pull.ts --enabled
//   TP_MCP_URL=… TP_MCP_TOKEN_FILE=… node tools/varlighter/pull.ts --symbol 'var:AAPL|rh:AAPL' --symbol 'lighter:BTC|entropy:BTC'
import { appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { SAMPLE_FORMAT, upgradeKey } from '../../src/varlighter/model.ts';
import type { SamplesView, StateView } from '../../src/varlighter/views.ts';
import { loadSettings, platformGet, PlatformError, SettingsError, type Get } from '../mcp/readonly.ts';
import { cacheRoot, checkSampleSymbol, hasLocalFiles, LEGACY_NOTICE, readLocalState, sampleFile, sourceCache, STATE_FILE, type LocalState } from './cache.ts';

export { cacheRoot as dataDir, sampleFile, STATE_FILE, type LocalState } from './cache.ts';

const PAGE = 1000, MIN_PAGE = 50, MAX_WAITS = 40;
const LOCK_WAIT_MS = 10 * 60_000;

/**
 * The `t` of the file's last line, reading only its tail; 0 for a missing or empty file. A last line without its newline
 * (a pull killed while appending) is cut off first, so the next pull writes it again whole.
 */
export function lastSampleAt(file: string, symbol?: string): number {
  if (!existsSync(file)) return 0;
  const fd = openSync(file, 'r+');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const length = Math.min(size, 256 * 1024), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let tail = buffer, completeSize = size;
    if (buffer[length - 1] !== 0x0a) {
      const end = buffer.lastIndexOf(0x0a);
      if (end < 0 && length < size) throw new Error(`${file} 的最后一行过长或已损坏：删除最后一行后重试`);
      completeSize = size - length + end + 1;
      tail = buffer.subarray(0, end + 1);
    }
    const last = tail.toString('utf8').split('\n').filter(line => line.trim()).at(-1);
    let t = 0;
    if (last !== undefined) {
      let sample: { symbol?: unknown; t?: unknown } | undefined;
      try { sample = JSON.parse(last); } catch { /* reported below */ }
      if (typeof sample?.t !== 'number' || !Number.isSafeInteger(sample.t)) throw new Error(`${file} 的最后一行不是有效的样本：删除最后一行后重试`);
      if (symbol !== undefined) checkSampleSymbol(sample.symbol, symbol);
      t = sample.t;
    }
    if (completeSize !== size) ftruncateSync(fd, completeSize);
    return t;
  } finally { closeSync(fd); }
}

/** A local SQLite write lock is owned by this connection until close, including while its process is suspended.
 * The carrier file stays in place. Ordinary process exit or a crash releases the OS lock. */
async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = new DatabaseSync(`${file}.lock.sqlite`, { timeout: 0 });
  const deadline = performance.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try { lock.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        const { code, errcode } = error as { code?: string; errcode?: number };
        if (code !== 'ERR_SQLITE_ERROR' || ((errcode ?? 0) & 0xff) !== 5) throw error;
        if (performance.now() >= deadline) throw new Error(`${file} 被另一次拉取占用超过 ${LOCK_WAIT_MS / 60_000} 分钟`);
        // A synchronous busy timeout would also block a holder waiting for a response in this Node process.
        await delay(100);
      }
    }
    return await work();
  } finally { lock.close(); }
}

export interface PullOptions {
  get: Get; dir: string;
  /** Pair keys; with `enabled`, the enabled or held pairs are added. */
  symbols?: readonly string[]; enabled?: boolean;
  log?: (line: string) => void;
  /** Seconds to wait on a 429 (tests pass a no-op). */
  sleep?: (seconds: number) => Promise<void>;
}
/** gap: the server had already dropped the samples after the local file's last one (pulled after its retention), so the file jumps from `from` to `to`. */
export interface PullResult { symbol: string; added: number; last: number | null; file: string; gap: { from: number; to: number } | null }

/** A GET that waits out 429s (the token's 30 a minute) and returns the status for the caller's 413 handling. */
async function patient(get: Get, path: string, sleep: (seconds: number) => Promise<void>): Promise<unknown> {
  for (let waits = 0; ; waits++) {
    try { return await get(path); }
    catch (error) {
      if (!(error instanceof PlatformError) || error.status !== 429 || waits >= MAX_WAITS) throw error;
      await sleep(error.retryAfter ?? 5);
    }
  }
}

export async function pull({ get, dir: root, symbols = [], enabled = false, log = () => {}, sleep = seconds => delay(seconds * 1000) }: PullOptions) {
  const keys = symbols.map(key => upgradeKey(key) ?? (() => { throw new SettingsError(`配对键无效：${key}（应为「场所:代码|场所:代码」，如 var:AAPL|rh:AAPL）`); })());
  const { dir, source } = sourceCache(root, get.source);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stateFile = join(dir, STATE_FILE);
  const { state, cacheNotice } = await locked(stateFile, async () => {
    const cacheNotice = !readLocalState(dir) && hasLocalFiles(root) ? LEGACY_NOTICE : undefined;
    const view = await patient(get, '/api/varlighter/state', sleep) as StateView;
    const state: LocalState = {
      source, savedAt: Date.now(), settings: view.settings,
      pairs: view.rows.map(row => ({ key: row.key, kind: row.kind, name: row.name, enabled: row.enabled, position: row.position !== null, aFeeBps: row.aFeeBps ?? null, bFeeBps: row.bFeeBps ?? null })),
      orphans: view.orphans.map(row => row.key),
    };
    const temp = join(dir, `.${STATE_FILE}.tmp`);
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, stateFile);
    return { state, cacheNotice };
  });
  const wanted = new Set(keys);
  if (enabled) {
    for (const pair of state.pairs) if (pair.enabled || pair.position) wanted.add(pair.key);
    for (const key of state.orphans) wanted.add(key);
  }
  const results: PullResult[] = [];
  for (const symbol of wanted) {
    const file = sampleFile(dir, symbol);
    results.push(await locked(file, async () => {
      let after = lastSampleAt(file, symbol), added = 0, limit = PAGE, gap: PullResult['gap'] = null, checked = false;
      for (;;) {
        let page: SamplesView;
        try { page = await patient(get, `/api/varlighter/samples?symbol=${encodeURIComponent(symbol)}&after=${after}&limit=${limit}`, sleep) as SamplesView; }
        catch (error) {
          if (error instanceof PlatformError && error.status === 413 && limit > MIN_PAGE) { limit = Math.max(MIN_PAGE, Math.floor(limit / 2)); continue; }
          throw error;
        }
        if (page.format !== SAMPLE_FORMAT) throw new Error(`平台的样本格式是 ${page.format ?? 1}，本机是 ${SAMPLE_FORMAT}：平台与本机仓库须同为 v0.88.0 以后或同为以前的版本`);
        checkSampleSymbol(page.symbol, symbol);
        // Only the first page can show it: the server's oldest sample is newer than the local file's last one.
        if (!checked && after > 0 && page.firstAt !== null && page.firstAt > after) gap = { from: after, to: page.firstAt };
        checked = true;
        // Keyed by the server's column names, so a client a version apart keeps every field it knows.
        const lines: string[] = [];
        for (const row of page.rows) {
          const sample = Object.fromEntries(page.columns.map((column, index) => [column, row[index] ?? null])) as { symbol: unknown; t: number };
          checkSampleSymbol(sample.symbol, symbol);
          if (!(sample.t > after)) continue;
          lines.push(JSON.stringify(sample));
          after = sample.t;
        }
        if (lines.length) { appendFileSync(file, `${lines.join('\n')}\n`); added += lines.length; }
        if (page.next === null || !lines.length) break;
      }
      log(`${symbol}：新增 ${added} 条，最新 ${after ? new Date(after).toISOString() : '无'}${gap ? `；服务器已不保留 ${new Date(gap.from).toISOString()} 到 ${new Date(gap.to).toISOString()} 的样本，本机这段为空` : ''}`);
      return { symbol, added, last: after || null, file, gap };
    }));
  }
  return { dir, cacheNotice, state, results };
}

/** `--symbol <key>` (repeatable) and `--enabled`. */
export function parsePullArgs(argv: readonly string[]): { symbols: string[]; enabled: boolean } {
  const symbols: string[] = [];
  let enabled = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--enabled') enabled = true;
    else if (arg === '--symbol' && argv[index + 1] !== undefined) symbols.push(argv[++index]!);
    else throw new SettingsError(`不认识的参数：${arg}（用法：--symbol 'var:AAPL|rh:AAPL' 可多个，或 --enabled）`);
  }
  if (!symbols.length && !enabled) throw new SettingsError('请给出 --symbol <配对键> 或 --enabled');
  return { symbols, enabled };
}

if (import.meta.main) {
  try {
    const args = parsePullArgs(process.argv.slice(2));
    const { dir, state, cacheNotice, results } = await pull({ get: platformGet(loadSettings()), dir: cacheRoot(), ...args, log: line => process.stderr.write(`${line}\n`) });
    process.stdout.write(`${JSON.stringify({ source: state.source, dir, cacheNotice, results }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`拉取失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
