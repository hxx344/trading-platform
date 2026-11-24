// Pulls Var/Lighter samples from the platform into a local directory (docs/mcp.md 8.3), so an AI on the client machine
// can replay them with the repository's backtest. Uses the read-only token like tools/mcp/readonly.ts and never runs on
// the server. Each pair is one `<venue>_<code>.jsonl` (one Sample object per line, oldest first); `state.json` keeps the
// saved parameters and each pair's asset kind. A file is continued after its last line, so local history may outgrow
// the server's 14-day retention.
//
//   TP_MCP_URL=… TP_MCP_TOKEN_FILE=… node tools/varlighter/pull.ts --enabled
//   TP_MCP_URL=… TP_MCP_TOKEN_FILE=… node tools/varlighter/pull.ts --symbol rh:AAPL --symbol lighter:BTC
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PAIR_KEY } from '../../src/varlighter/model.ts';
import type { SamplesView, StateView } from '../../src/varlighter/views.ts';
import { loadSettings, platformGet, PlatformError, SettingsError, type Get } from '../mcp/readonly.ts';

export const STATE_FILE = 'state.json';
const PAGE = 1000, MIN_PAGE = 50, MAX_WAITS = 40;

/** The local sample directory: TP_VARLIGHTER_DIR, else ~/.cache/trading-platform/varlighter. */
export const dataDir = (env: NodeJS.ProcessEnv = process.env): string => env.TP_VARLIGHTER_DIR || join(homedir(), '.cache', 'trading-platform', 'varlighter');
export const sampleFile = (dir: string, key: string): string => join(dir, `${key.replace(':', '_')}.jsonl`);

/** What the local backtest needs from the platform's state: the saved parameters and each pair's asset kind. */
export interface LocalState {
  savedAt: number;
  settings: StateView['settings'];
  pairs: { key: string; kind: StateView['rows'][number]['kind']; name: string; enabled: boolean; position: boolean }[];
  /** Enabled or held keys no longer paired (no kind known). */
  orphans: string[];
}

/** The `t` of the file's last line, reading only its tail; 0 for a missing or empty file. */
export function lastSampleAt(file: string): number {
  if (!existsSync(file)) return 0;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const length = Math.min(size, 64 * 1024), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').filter(line => line.trim());
    const last = lines.at(-1);
    const t = last ? (JSON.parse(last) as { t?: unknown }).t : 0;
    if (typeof t !== 'number' || !Number.isSafeInteger(t)) throw new Error(`${file} 的最后一行没有有效的 t`);
    return t;
  } finally { closeSync(fd); }
}

export interface PullOptions {
  get: Get; dir: string;
  /** Pair keys; with `enabled`, the enabled or held pairs are added. */
  symbols?: readonly string[]; enabled?: boolean;
  log?: (line: string) => void;
  /** Seconds to wait on a 429 (tests pass a no-op). */
  sleep?: (seconds: number) => Promise<void>;
}
export interface PullResult { symbol: string; added: number; last: number | null; file: string }

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

export async function pull({ get, dir, symbols = [], enabled = false, log = () => {}, sleep = seconds => delay(seconds * 1000) }: PullOptions): Promise<{ state: LocalState; results: PullResult[] }> {
  for (const key of symbols) if (!PAIR_KEY.test(key)) throw new SettingsError(`配对键无效：${key}（应为「场所:代码」，如 rh:AAPL）`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const view = await patient(get, '/api/varlighter/state', sleep) as StateView;
  const state: LocalState = {
    savedAt: Date.now(), settings: view.settings,
    pairs: view.rows.map(row => ({ key: row.key, kind: row.kind, name: row.name, enabled: row.enabled, position: row.position !== null })),
    orphans: view.orphans.map(row => row.key),
  };
  const temp = join(dir, `.${STATE_FILE}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, join(dir, STATE_FILE));
  const wanted = new Set(symbols);
  if (enabled) {
    for (const pair of state.pairs) if (pair.enabled || pair.position) wanted.add(pair.key);
    for (const key of state.orphans) wanted.add(key);
  }
  const results: PullResult[] = [];
  for (const symbol of wanted) {
    const file = sampleFile(dir, symbol);
    let after = lastSampleAt(file), added = 0, limit = PAGE;
    for (;;) {
      let page: SamplesView;
      try { page = await patient(get, `/api/varlighter/samples?symbol=${encodeURIComponent(symbol)}&after=${after}&limit=${limit}`, sleep) as SamplesView; }
      catch (error) {
        if (error instanceof PlatformError && error.status === 413 && limit > MIN_PAGE) { limit = Math.max(MIN_PAGE, Math.floor(limit / 2)); continue; }
        throw error;
      }
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
    log(`${symbol}：新增 ${added} 条，最新 ${after ? new Date(after).toISOString() : '无'}`);
    results.push({ symbol, added, last: after || null, file });
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
    else throw new SettingsError(`不认识的参数：${arg}（用法：--symbol rh:AAPL 可多个，或 --enabled）`);
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
