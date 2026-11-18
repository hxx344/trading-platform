// The root side of the page's online update (docs/update.md), started by trading-platform-update.path when the service
// leaves update-request.json in the update hand-off directory. It takes the request (a version only), checks it is a
// vX.Y.Z newer than the installed release, downloads that release's SHA256SUMS and install.sh, checks install.sh against
// the sums and runs `bash install.sh --version <version>`: the same download, config check, restart, health check and
// rollback as the one-line install. Its progress and the installer's last lines go to update-result.json for the page.
//
//   node update-helper.ts --dir /var/lib/trading-platform-update --app-dir /opt/trading-platform
//                         --data-dir /var/lib/trading-platform --request-uid <control UID> --request-gid <control GID> [--recover]
//
// --recover (the unit's ExecStopPost) marks a result the helper left running as interrupted.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fchownSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { takeHandoff } from './take-handoff.ts';
import {
  RELEASE_REPO, UPDATE_REQUEST_FILE, UPDATE_REQUEST_STALE_MS, UPDATE_RESULT_FILE, compareVersions, parseUpdateRequest, readInstalledVersion,
  readUpdateResult, writeHandoff, type UpdateRequest, type UpdateResult,
} from './update.ts';

const MAX_REQUEST_BYTES = 1024;
const OUTPUT_LINES = 40;
const LINE_CHARS = 300;
const WRITE_EVERY_MS = 2_000;
const HEARTBEAT_MS = 20_000;
export const RELEASE_BASE = `https://github.com/${RELEASE_REPO}/releases`;

export interface Owner { uid: number; gid: number }

export interface UpdateHelperOptions {
  /** The root-owned update hand-off directory, writable by the requesting account's private group. */
  dir: string;
  /** install.sh's APP_DIR: `current` there is the installed release. */
  appDir: string;
  /** The service's data directory: its owner is the service account. */
  dataDir: string;
  /** UID/GID rendered into the root-owned update unit. Older single-process units use the owner of dataDir. */
  requestOwner?: Owner;
  releaseBase?: string;
  /** Fetches `url` to `target`; throws with the reason. curl by default. */
  download?: (url: string, target: string) => void;
  /** Runs the checked install.sh for `version`, handing over each line it prints; resolves its exit code. */
  runInstaller?: (script: string, version: string, onLine: (line: string) => void) => Promise<number>;
  now?: () => number;
  log?: (line: string) => void;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The hand-off directory must be root's and not writable by others, under a parent only root may change. */
function checkDir(dir: string): void {
  if (process.getuid?.() !== 0) return;
  for (const [path, groupWritable] of [[dir, true], [dirname(dir), false]] as const) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o002) !== 0 || (!groupWritable && (stat.mode & 0o020) !== 0)) {
      throw new Error(`${path} 须为 root 所有、其他人不可写的目录${groupWritable ? '' : '（且组不可写）'}`);
    }
  }
}

function writeResult(dir: string, result: UpdateResult, owner: Owner): void {
  writeHandoff(dir, UPDATE_RESULT_FILE, JSON.stringify(result), fd => { if (process.getuid?.() === 0) fchownSync(fd, owner.uid, owner.gid); });
}

/**
 * Takes the pending request as root: only a plain file of the service account with one link, small enough, is read.
 * It is removed either way, so a bad one is answered once and not taken again.
 */
export function takeUpdateRequest(dir: string, owner: { uid: number }): UpdateRequest | { invalid: string } | null {
  const path = join(dir, UPDATE_REQUEST_FILE);
  let text: string | null;
  try { text = takeHandoff(path, MAX_REQUEST_BYTES, owner.uid); }
  catch (error) { return { invalid: message(error) }; }
  if (text === null) return null;
  try { return parseUpdateRequest(JSON.parse(text)); }
  catch (error) { return { invalid: error instanceof SyntaxError ? '请求不是有效 JSON' : message(error) }; }
}

/** The SHA-256 SHA256SUMS gives for `name`; null when it lists none. */
export function checksumOf(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1]!;
  }
  return null;
}

function curl(url: string, target: string): void {
  const run = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--tlsv1.2', '--connect-timeout', '15', '--max-time', '120',
    '--retry', '3', '--retry-delay', '2', url, '-o', target], { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'ignore', 'pipe'] });
  if (run.error) throw new Error(`无法运行 curl：${run.error.message}`);
  if (run.status !== 0) throw new Error(`下载失败：${url}（${(run.stderr || `curl 退出代码 ${run.status}`).trim().slice(0, 200)}）`);
}

function bash(script: string, version: string, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, '--version', version], { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine);
    child.on('error', reject);
    child.on('close', code => { resolve(code ?? 1); });
  });
}

// Colour codes and other control characters are dropped; the page shows plain lines.
const clean = (line: string): string => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd().slice(0, LINE_CHARS);

/** The installed release's version, or null when `current` has none (never installed by install.sh). */
function installedVersion(appDir: string): string | null {
  try { const found = readInstalledVersion(join(appDir, 'current')); return found.packaged ? found.version : null; } catch { return null; }
}

/** Marks a result left running (the helper was stopped or timed out) as interrupted; returns whether it did. */
export function recoverUpdate(dir: string, appDir: string, owner: Owner, now = Date.now()): boolean {
  let latest: UpdateResult | null;
  try { latest = readUpdateResult(dir); } catch { return false; }
  if (!latest || latest.phase !== 'running') return false;
  const installed = installedVersion(appDir);
  writeResult(dir, {
    ...latest, at: now, phase: 'failed', ...(installed ? { installed } : {}),
    message: `更新助手被中断（超时或被停止）${installed ? `，当前版本 ${installed}` : ''}；请在服务器上查看 journalctl -u trading-platform-update 后重新执行一键部署命令`,
  }, owner);
  return true;
}

/** Handles the pending request, if any; returns whether one was answered. */
export async function runUpdateHelper(options: UpdateHelperOptions): Promise<boolean> {
  const { dir, appDir, dataDir, releaseBase = RELEASE_BASE, download = curl, runInstaller = bash, now = Date.now, log = line => process.stderr.write(`${line}\n`) } = options;
  if (![dir, appDir, dataDir].every(isAbsolute)) throw new Error('目录须为绝对路径');
  checkDir(dir);
  const owner = options.requestOwner ?? statSync(dataDir);
  if (recoverUpdate(dir, appDir, owner, now())) log('上一次更新没有正常结束，已标为中断');
  const request = takeUpdateRequest(dir, owner);
  if (!request) return false;
  const startedAt = now();
  const answer = (fields: Partial<UpdateResult> & Pick<UpdateResult, 'phase' | 'message'>): UpdateResult => {
    const result: UpdateResult = { id: 'id' in request ? request.id : null, version: 'version' in request ? request.version : null, from: null, startedAt, at: now(), output: [], ...fields };
    writeResult(dir, result, owner);
    return result;
  };
  if ('invalid' in request) { log(`更新请求无效：${request.invalid}`); answer({ phase: 'failed', message: `更新请求无效：${request.invalid}` }); return true; }
  const from = installedVersion(appDir);
  if (startedAt - request.at > UPDATE_REQUEST_STALE_MS) { answer({ phase: 'failed', from, message: '更新请求已过期（超过 2 分钟没被处理），请重新确认' }); return true; }
  if (!from) { answer({ phase: 'failed', from, message: `${appDir}/current 不是 install.sh 安装的版本，无法在线更新` }); return true; }
  if (compareVersions(request.version, from) <= 0) { answer({ phase: 'failed', from, installed: from, message: `目标版本 ${request.version} 不比已装版本 ${from} 新，未更新` }); return true; }

  log(`在线更新：${from} → ${request.version}`);
  const output: string[] = [];
  let step: UpdateResult['step'] = 'download', status = `下载 ${request.version} 的安装脚本`;
  const progress = () => answer({ phase: 'running', from, step, message: status, output: [...output] });
  progress();
  const work = mkdtempSync(join(tmpdir(), 'tp-update-'));
  try {
    const script = join(work, 'install.sh');
    try {
      download(`${releaseBase}/download/${request.version}/SHA256SUMS`, join(work, 'SHA256SUMS'));
      download(`${releaseBase}/download/${request.version}/install.sh`, script);
      const expected = checksumOf(readFileSync(join(work, 'SHA256SUMS'), 'utf8'), 'install.sh');
      if (!expected) throw new Error(`${request.version} 的 SHA256SUMS 里没有 install.sh`);
      if (createHash('sha256').update(readFileSync(script)).digest('hex') !== expected) throw new Error(`${request.version} 的 install.sh 与 SHA256SUMS 不一致`);
    } catch (error) {
      answer({ phase: 'failed', from, step, installed: from, message: message(error), output });
      log(`在线更新失败：${message(error)}`);
      return true;
    }
    step = 'install'; status = `正在执行 ${request.version} 的 install.sh`;
    progress();
    let dirty = false, wroteAt = now();
    const timer = setInterval(() => {
      if (!dirty && now() - wroteAt < HEARTBEAT_MS) return;
      dirty = false; wroteAt = now();
      try { progress(); } catch (error) { log(`无法写入更新进度：${message(error)}`); }
    }, WRITE_EVERY_MS);
    let code: number;
    try {
      code = await runInstaller(script, request.version, raw => {
        const line = clean(raw);
        if (!line) return;
        output.push(line);
        if (output.length > OUTPUT_LINES) output.splice(0, output.length - OUTPUT_LINES);
        status = line; dirty = true;
        log(`install.sh: ${line}`);
      });
    } catch (error) { code = -1; output.push(`无法运行 install.sh：${message(error)}`); }
    finally { clearInterval(timer); }
    const installed = installedVersion(appDir);
    if (code === 0 && installed === request.version) {
      answer({ phase: 'done', from, step, installed, message: `已更新到 ${request.version}`, output });
      log(`在线更新完成：${request.version}`);
    } else {
      const last = [...output].reverse().find(line => line.startsWith('安装失败：')) ?? output.at(-1);
      const reason = code === 0 ? `install.sh 已结束，但当前版本是 ${installed ?? '未知'}` : last ?? `install.sh 退出代码 ${code}`;
      answer({ phase: 'failed', from, step, ...(installed ? { installed } : {}), message: `${reason}${installed && code !== 0 ? `（当前版本 ${installed}）` : ''}`, output });
      log(`在线更新失败：${reason}`);
    }
    return true;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  // Not strict: a helper rolled back by install.sh keeps working under a newer unit that passes options it does not know
  // (docs/update.md: the unit's options are only ever added).
  const { values } = parseArgs({ strict: false, options: { dir: { type: 'string' }, 'app-dir': { type: 'string' }, 'data-dir': { type: 'string' },
    'request-uid': { type: 'string' }, 'request-gid': { type: 'string' }, recover: { type: 'boolean' } } });
  const text = (value: string | boolean | undefined): string | undefined => typeof value === 'string' ? value : undefined;
  const dir = text(values.dir), appDir = text(values['app-dir']), dataDir = text(values['data-dir']);
  if (!dir || !appDir || !dataDir) throw new Error('需要 --dir、--app-dir 与 --data-dir');
  const uid = text(values['request-uid']), gid = text(values['request-gid']);
  let requestOwner: Owner | undefined;
  if (uid !== undefined || gid !== undefined) {
    if (![uid, gid].every(value => value && /^[1-9]\d{0,9}$/.test(value) && Number(value) < 0xffffffff)) throw new Error('控制面账户的 UID、GID 无效');
    requestOwner = { uid: Number(uid), gid: Number(gid) };
  }
  const log = (line: string): void => { process.stderr.write(`${line}\n`); };
  if (values.recover === true) {
    if (![dir, appDir, dataDir].every(isAbsolute)) throw new Error('目录须为绝对路径');
    checkDir(dir);
    if (recoverUpdate(dir, appDir, requestOwner ?? statSync(dataDir))) log('更新助手被中断，已把未结束的更新标为中断');
    return;
  }
  await runUpdateHelper({ dir, appDir, dataDir, requestOwner, log });
}

if (import.meta.main) main().catch(error => { process.stderr.write(`更新助手失败：${message(error)}\n`); process.exitCode = 1; });
