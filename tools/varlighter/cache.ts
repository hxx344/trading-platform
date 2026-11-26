import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { StateView } from '../../src/varlighter/views.ts';
import { platformBase, SettingsError } from '../mcp/readonly.ts';

export const STATE_FILE = 'state.json';
export const LEGACY_NOTICE = '旧缓存缺少平台来源，文件保留在根目录。各平台的样本从头拉取并单独保存。';
export const cacheRoot = (env: NodeJS.ProcessEnv = process.env): string => env.TP_VARLIGHTER_DIR || join(homedir(), '.cache', 'trading-platform', 'varlighter');
/** Bounded length and safe on Windows, including IPv6 origins. The readable origin is in state.json and the output. */
const sourceKey = (source: string): string => createHash('sha256').update(source).digest('hex');

export function sourceCache(root: string, url: string | undefined): { source: string; dir: string } {
  const source = platformBase(url).origin;
  return { source, dir: join(root, 'sources', sourceKey(source)) };
}

/** A pair key as a file name: percent-encoded, so `:` `|` `@` are safe on Windows. */
export const sampleFile = (dir: string, key: string): string => join(dir, `${encodeURIComponent(key)}.jsonl`);

export const hasLocalFiles = (dir: string): boolean => existsSync(dir) && readdirSync(dir).some(name => name === STATE_FILE || name.endsWith('.jsonl'));

/** An offline CLI can infer the source only when exactly one platform has a snapshot. */
export function replayDir(root: string, url?: string): string | null {
  if (url !== undefined) return sourceCache(root, url).dir;
  const parent = join(root, 'sources');
  const entries = existsSync(parent) ? readdirSync(parent, { withFileTypes: true }) : [];
  const dirs = entries.filter(entry => entry.isDirectory() && existsSync(join(parent, entry.name, STATE_FILE)));
  if (dirs.length > 1) throw new SettingsError('本机有多个平台的缓存，请用 TP_MCP_URL 选择回测来源');
  if (dirs.length === 1) return join(parent, dirs[0]!.name);
  if (hasLocalFiles(root)) throw new SettingsError(`${LEGACY_NOTICE} 请先运行 tools/varlighter/pull.ts。`);
  return null;
}

export interface LocalState {
  source: string;
  savedAt: number;
  settings: StateView['settings'];
  pairs: { key: string; kind: StateView['rows'][number]['kind']; name: string; enabled: boolean; position: boolean;
    /** Each leg's taker fee in bps as the platform applies it (manual value or catalog); null: unknown. */
    aFeeBps: number | null; bFeeBps: number | null }[];
  /** Enabled or held keys no longer paired (no kind known). */
  orphans: string[];
}

/** Check the binding before using saved settings, continuing a sample cursor or replacing the snapshot. */
export function readLocalState(dir: string): LocalState | null {
  const file = join(dir, STATE_FILE);
  if (!existsSync(file)) {
    if (!hasLocalFiles(dir)) return null;
    // A concurrent first pull may have committed its snapshot and samples after the first check.
    if (!existsSync(file)) throw new SettingsError('样本缺少平台来源快照，请保留该目录并换一个 TP_VARLIGHTER_DIR 重新拉取');
  }
  const state = JSON.parse(readFileSync(file, 'utf8')) as LocalState;
  if (typeof state?.source !== 'string' || sourceKey(state.source) !== basename(dir) || platformBase(state.source).origin !== state.source) {
    throw new SettingsError('缓存来源与平台目录不符，请保留该目录并换一个 TP_VARLIGHTER_DIR 重新拉取');
  }
  return state;
}
