// Pulls Var/Lighter samples from the platform into a local directory (docs/mcp.md 8.3), so an AI on the client machine
// can replay them with the repository's backtest. Uses the read-only token like tools/mcp/readonly.ts and never runs on
// the server. Each pair is one `<encoded pair key>.jsonl` (one Sample object per line, oldest first; sample format 2, two
// legs a/b; files from before v0.88.0 were named `<venue>_<code>.jsonl` with Var/Lighter fields and are left alone); `state.json` keeps the
// saved parameters and each pair's asset kind. A file is continued after its last line, so local history may outgrow
// the server's 14-day retention.
//
//   TP_MCP_URL=… TP_MCP_TOKEN_FILE=… node tools/varlighter/pull.ts --enabled
//   TP_MCP_URL=… TP_MCP_TOKEN_FILE=… node tools/varlighter/pull.ts --symbol 'var:AAPL|rh:AAPL' --symbol 'lighter:BTC|entropy:BTC'
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SAMPLE_FORMAT, upgradeKey } from '../../src/varlighter/model.ts';
import type { SamplesView, StateView } from '../../src/varlighter/views.ts';
import { loadSettings, platformGet, PlatformError, SettingsError, type Get } from '../mcp/readonly.ts';

export const STATE_FILE = 'state.json';
const PAGE = 1000, MIN_PAGE = 50, MAX_WAITS = 40;
/** A lock older than this is taken as left by a killed pull; waiting for a live one gives up after LOCK_WAIT_MS. */
const LOCK_STALE_MS = 5 * 60_000, LOCK_WAIT_MS = 10 * 60_000;

/** The local sample directory: TP_VARLIGHTER_DIR, else ~/.cache/trading-platform/varlighter. */
export const dataDir = (env: NodeJS.ProcessEnv = process.env): string => env.TP_VARLIGHTER_DIR || join(homedir(), '.cache', 'trading-platform', 'varlighter');
/** A pair key as a file name: percent-encoded, so `:` `|` `@` are safe on Windows and two keys never share a file. */
export const sampleFile = (dir: string, key: string): string => join(dir, `${encodeURIComponent(key)}.jsonl`);

/** What the local backtest needs from the platform's state: the saved parameters and each pair's asset kind. */
export interface LocalState {
  savedAt: number;
  settings: StateView['settings'];
  pairs: { key: string; kind: StateView['rows'][number]['kind']; name: string; enabled: boolean; position: boolean;
    /** Each leg's taker fee in bps as the platform applies it (manual value or catalog); null: unknown, the backtest opens nothing. */
    aFeeBps: number | null; bFeeBps: number | null }[];
  /** Enabled or held keys no longer paired (no kind known). */
  orphans: string[];
}

/**
 * The `t` of the file's last line, reading only its tail; 0 for a missing or empty file. A last line without its newline
 * (a pull killed while appending) is cut off first, so the next pull writes it again whole.
 */
export function lastSampleAt(file: string): number {
  if (!existsSync(file)) return 0;
  const fd = openSync(file, 'r+');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const length = Math.min(size, 256 * 1024), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let tail = buffer;
    if (buffer[length - 1] !== 0x0a) {
      const end = buffer.lastIndexOf(0x0a);
      if (end < 0 && length < size) throw new Error(`${file} 的最后一行过长或已损坏：删除最后一行后重试`);
      ftruncateSync(fd, size - length + end + 1);
      tail = buffer.subarray(0, end + 1);
    }
    const last = tail.toString('utf8').split('\n').filter(line => line.trim()).at(-1);
    if (last === undefined) return 0;
    let t: unknown;
    try { t = (JSON.parse(last) as { t?: unknown }).t; } catch { t = undefined; }
    if (typeof t !== 'number' || !Number.isSafeInteger(t)) throw new Error(`${file} 的最后一行不是有效的样本：删除最后一行后重试`);
    return t;
  } finally { closeSync(fd); }
}

/**
 * Holds `<file>.lock` while `work` runs, so two pulls of one pair (parallel MCP calls, or the command line beside the
 * MCP server) never append the same page twice. The lock holds an owner tag; the holder refreshes its time through
 * `keep` (each page and each 429 wait), and only a lock untouched for LOCK_STALE_MS is taken over, by renaming it away
 * first so a waiter never removes a lock another waiter has just made. A lock is removed only by its owner.
 */
async function locked<T>(file: string, work: (keep: () => void) => Promise<T>): Promise<T> {
  const lock = `${file}.lock`, tag = `${process.pid}-${randomBytes(6).toString('hex')}`, started = Date.now();
  const content = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  for (;;) {
    try { writeFileSync(lock, tag, { flag: 'wx' }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age = 0;
      const seen = content(lock);
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS && seen !== null) {
        const aside = `${lock}.${tag}.stale`;
        try { renameSync(lock, aside); } catch { continue; }
        // Another waiter may have taken over and locked between our read and the rename: put its lock back.
        if (content(aside) !== seen) { try { linkSync(aside, lock); } catch { /* someone locked again meanwhile */ } }
        rmSync(aside, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`${lock} 被另一次拉取占用超过 ${LOCK_WAIT_MS / 60_000} 分钟`);
      // Not the injected 429 sleep: a test's no-op there would spin here without letting the holder's request finish.
      await delay(200);
    }
  }
  const keep = () => { try { if (content(lock) === tag) { const now = new Date(); utimesSync(lock, now, now); } } catch { /* refreshed next time */ } };
  try { return await work(keep); } finally { if (content(lock) === tag) rmSync(lock, { force: true }); }
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
async function patient(get: Get, path: string, sleep: (seconds: number) => Promise<void>, keep = () => {}): Promise<unknown> {
  for (let waits = 0; ; waits++) {
    try { return await get(path); }
    catch (error) {
      if (!(error instanceof PlatformError) || error.status !== 429 || waits >= MAX_WAITS) throw error;
      keep();
      await sleep(error.retryAfter ?? 5);
      keep();
    }
  }
}

export async function pull({ get, dir, symbols = [], enabled = false, log = () => {}, sleep = seconds => delay(seconds * 1000) }: PullOptions): Promise<{ state: LocalState; results: PullResult[] }> {
  const keys = symbols.map(key => upgradeKey(key) ?? (() => { throw new SettingsError(`配对键无效：${key}（应为「场所:代码|场所:代码」，如 var:AAPL|rh:AAPL）`); })());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const view = await patient(get, '/api/varlighter/state', sleep) as StateView;
  const state: LocalState = {
    savedAt: Date.now(), settings: view.settings,
    pairs: view.rows.map(row => ({ key: row.key, kind: row.kind, name: row.name, enabled: row.enabled, position: row.position !== null, aFeeBps: row.aFeeBps ?? null, bFeeBps: row.bFeeBps ?? null })),
    orphans: view.orphans.map(row => row.key),
  };
  const temp = join(dir, `.${STATE_FILE}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, join(dir, STATE_FILE));
  const wanted = new Set(keys);
  if (enabled) {
    for (const pair of state.pairs) if (pair.enabled || pair.position) wanted.add(pair.key);
    for (const key of state.orphans) wanted.add(key);
  }
  const results: PullResult[] = [];
  for (const symbol of wanted) {
    const file = sampleFile(dir, symbol);
    results.push(await locked(file, async keep => {
      let after = lastSampleAt(file), added = 0, limit = PAGE, gap: PullResult['gap'] = null, checked = false;
      for (;;) {
        let page: SamplesView;
        try { page = await patient(get, `/api/varlighter/samples?symbol=${encodeURIComponent(symbol)}&after=${after}&limit=${limit}`, sleep, keep) as SamplesView; }
        catch (error) {
          if (error instanceof PlatformError && error.status === 413 && limit > MIN_PAGE) { limit = Math.max(MIN_PAGE, Math.floor(limit / 2)); continue; }
          throw error;
        }
        if (page.format !== SAMPLE_FORMAT) throw new Error(`平台的样本格式是 ${page.format ?? 1}，本机是 ${SAMPLE_FORMAT}：平台与本机仓库须同为 v0.88.0 以后或同为以前的版本`);
        // Only the first page can show it: the server's oldest sample is newer than the local file's last one.
        if (!checked && after > 0 && page.firstAt !== null && page.firstAt > after) gap = { from: after, to: page.firstAt };
        checked = true;
        keep();
        // Read again before writing: should the lock ever be lost (a holder stalled past LOCK_STALE_MS), a page another
        // pull already wrote is still not written twice.
        after = Math.max(after, lastSampleAt(file));
        // Keyed by the server's column names, so a client a version apart keeps every field it knows.
        const lines: string[] = [];
        for (const row of page.rows) {
          const sample = Object.fromEntries(page.columns.map((column, index) => [column, row[index] ?? null])) as { t: number };
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
  return { state, results };
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
    const dir = dataDir();
    const { results } = await pull({ get: platformGet(loadSettings()), dir, ...args, log: line => process.stderr.write(`${line}\n`) });
    process.stdout.write(`${JSON.stringify({ dir, results }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`拉取失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
