// Online update (docs/update.md), the service's side: it reads the latest stable release from GitHub on a timer, and when
// the page confirms an update it leaves one request in the import hand-off directory for the root update helper
// (update-helper.ts, started by trading-platform-update.path), whose answer it reads back for the page. The request
// carries a version only; the helper checks it again and runs that release's install.sh.
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError, exactKeys } from '../contracts.ts';
import { readBounded } from './import-channel.ts';
import type { InstalledVersion, ReleaseInfo, UpdateRequest, UpdateResult, UpdateView } from './update-types.ts';
export type { InstalledVersion, ReleaseInfo, UpdatePhase, UpdateRequest, UpdateResult, UpdateView } from './update-types.ts';

export const UPDATE_REQUEST_FILE = 'update-request.json';
export const UPDATE_RESULT_FILE = 'update-result.json';
/** Written by install.sh once trading-platform-update.path is enabled and running; without it the page offers no update. */
export const UPDATE_READY_FILE = '.update-helper';
export const RELEASE_REPO = 'hxx344/trading-platform';
/** A request nobody took within this long (helper not armed, or it failed to start) no longer blocks a new one. */
export const UPDATE_REQUEST_STALE_MS = 120_000;
/** The helper unit's TimeoutStartSec (1800 s), its TimeoutStopSec (300 s) and a margin: a result still running past it was cut short. */
export const UPDATE_RUNNING_STALE_MS = 2_160_000;
/** The longest a rate limit stops the checks. */
export const UPDATE_MAX_WAIT_MS = 3_600_000;
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
export const UPDATE_FIRST_CHECK_MS = 60_000;
/** How often the release page's redirect is read between the API checks (probe() below). */
export const UPDATE_PROBE_INTERVAL_MS = 60_000;
/** The shortest time between two API checks brought forward by the probe, should the page and the API disagree for long. */
export const UPDATE_PROBE_API_GAP_MS = 5 * 60_000;
export const UPDATE_MANUAL_GAP_MS = 60_000;
const UPDATE_CHECK_TIMEOUT_MS = 20_000;
/** Backoff after failed automatic checks (not rate limits, which wait for GitHub's own reset time). */
const BACKOFF_MS = [1, 2, 4, 8, 15].map(minutes => minutes * 60_000);
const MAX_REQUEST_BYTES = 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_RELEASE_BYTES = 1024 * 1024;
const MAX_NOTES = 4000;
const VERSION = /^v(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value);

/** Orders two vX.Y.Z versions; neither may be anything else. */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a), y = VERSION.exec(b);
  if (!x || !y) throw new Error(`版本号无效：${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d !== 0) return Math.sign(d); }
  return 0;
}

/** The release this process runs from: its VERSION file ("v0.49.1 <commit>"), written by deploy/package.sh. */
export function readInstalledVersion(root = fileURLToPath(new URL('../..', import.meta.url))): InstalledVersion {
  let text: string | null = null;
  try { text = readFileSync(join(root, 'VERSION'), 'utf8'); } catch { /* a development checkout */ }
  if (text !== null) {
    const [version = '', commit] = text.split('\n')[0]!.trim().split(/\s+/);
    if (!isVersion(version)) throw new Error(`${join(root, 'VERSION')} 里的版本号无效`);
    return { version, commit: commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null, packaged: true };
  }
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  const tagged = `v${String(version)}`;
  if (!isVersion(tagged)) throw new Error('package.json 里的版本号无效');
  return { version: tagged, commit: null, packaged: false };
}

/**
 * install.sh's marker that the update helper is armed: `<程序目录>/.update-helper`, beside `releases/` in the root-owned
 * program directory (the service may only read it; the hand-off directory would let the service plant a symbolic link
 * for root to follow). The service runs from `<程序目录>/releases/<包>/` (the `current` link resolved); anything else,
 * such as a development checkout, has no marker.
 */
export function updateReadyFile(root = fileURLToPath(new URL('../..', import.meta.url))): string | null {
  const real = realpathSync(root);
  return basename(dirname(real)) === 'releases' ? join(dirname(dirname(real)), UPDATE_READY_FILE) : null;
}

/** The body up to MAX_RELEASE_BYTES, read as it arrives: a longer answer is cut off, not held in memory first. */
async function boundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RELEASE_BYTES) { await reader.cancel().catch(() => undefined); throw new Error('GitHub 返回的版本信息过大'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The release notes' 「更新说明」 part (release.yml writes it first, then the install command), or the whole text. */
export function releaseNotes(body: string): string {
  const text = body.replace(/\r\n/g, '\n');
  const start = text.search(/^## 更新说明[^\n]*$/m);
  let part = text;
  if (start >= 0) {
    const rest = text.slice(start).replace(/^[^\n]*\n?/, '');
    const end = rest.search(/^## /m);
    part = end >= 0 ? rest.slice(0, end) : rest;
  }
  part = part.trim();
  return part.length > MAX_NOTES ? `${part.slice(0, MAX_NOTES)}…` : part;
}

/** GitHub's latest-release answer, reduced to what the page shows; anything unexpected is refused. */
export function parseRelease(raw: unknown, repo = RELEASE_REPO): ReleaseInfo {
  if (!raw || typeof raw !== 'object') throw new Error('GitHub 返回的不是对象');
  const value = raw as Record<string, unknown>;
  if (!isVersion(value.tag_name)) throw new Error(`最新正式版的标签不是 vX.Y.Z：${String(value.tag_name).slice(0, 40)}`);
  const url = typeof value.html_url === 'string' && value.html_url.startsWith(`https://github.com/${repo}/releases/`) ? value.html_url : `https://github.com/${repo}/releases/tag/${value.tag_name}`;
  const published = typeof value.published_at === 'string' && Number.isFinite(Date.parse(value.published_at)) ? value.published_at : null;
  return {
    version: value.tag_name,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 200) : value.tag_name,
    notes: typeof value.body === 'string' ? releaseNotes(value.body) : '',
    publishedAt: published,
    url,
  };
}

export function parseUpdateRequest(raw: unknown): UpdateRequest {
  const value = exactKeys(raw, ['id', 'version', 'at']);
  if (typeof value.id !== 'string' || !UUID.test(value.id)) throw new Error('请求编号无效');
  if (!isVersion(value.version)) throw new Error('目标版本无效');
  if (typeof value.at !== 'number' || !Number.isSafeInteger(value.at)) throw new Error('请求时间无效');
  return { id: value.id, version: value.version, at: value.at };
}

/** The helper's latest answer, as it wrote it; null before the first one. */
export function readUpdateResult(dir: string): UpdateResult | null {
  const text = readBounded(join(dir, UPDATE_RESULT_FILE), MAX_RESULT_BYTES);
  if (text === null) return null;
  const value = JSON.parse(text) as UpdateResult;
  if (!value || typeof value !== 'object' || !['running', 'done', 'failed'].includes(value.phase)) throw new Error('更新结果格式不对');
  return value;
}

/** Writes a small file under `dir` by a private temporary name and a rename, so a reader never sees half of it. */
export function writeHandoff(dir: string, name: string, text: string, chown?: (fd: number) => void): void {
  const temporary = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { chown?.(fd); writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, join(dir, name));
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export type UpdateFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface UpdateOptions {
  current: InstalledVersion;
  /** The import hand-off directory (--import-dir); without it the page shows the versions but cannot update. */
  dir: string | null;
  /** install.sh's marker that the update helper is armed (updateReadyFile()); null: never armed (a development checkout). */
  readyFile: string | null;
  fetchImpl?: UpdateFetch;
  now?: () => number;
  repo?: string;
  log?: (line: string) => void;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const clock = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });

/** The service's update state: the release check and the hand-off to the root helper. */
export function createUpdates({ current, dir, readyFile, fetchImpl = fetch, now = Date.now, repo = RELEASE_REPO, log = line => { process.stderr.write(`${line}\n`); } }: UpdateOptions) {
  let latest: ReleaseInfo | null = null, checkedAt: number | null = null, error: string | null = null;
  let retryAt: number | null = null, nextAt = now() + UPDATE_FIRST_CHECK_MS, failures = 0, manualAt = 0;
  let probeAt = nextAt + UPDATE_PROBE_INTERVAL_MS, probeError: string | null = null, broughtForwardAt = -Infinity;
  let checking: Promise<void> | null = null;
  /** The last request this service wrote (readJob). */
  let submitted: UpdateRequest | null = null;
  const stop = new AbortController();

  async function fetchLatest(): Promise<void> {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'trading-platform-updater', 'x-github-api-version': '2022-11-28' },
        redirect: 'follow', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS)]),
      });
    } catch (cause) {
      throw new Error(cause instanceof Error && cause.name === 'TimeoutError' ? '连接 GitHub 超时' : `连接 GitHub 失败：${message(cause).slice(0, 200)}`);
    }
    const text = await boundedText(response);
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset')), after = Number(response.headers.get('retry-after'));
      const limited = response.headers.get('x-ratelimit-remaining') === '0' || Number.isFinite(after) && after > 0 || response.status === 429;
      if (limited) {
        const until = Number.isFinite(after) && after > 0 ? now() + after * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + 15 * 60_000;
        // A far-off time (a proxy's, or a wrong clock) must not stop the checks for good: at most an hour.
        retryAt = Math.min(Math.max(until, now() + 60_000), now() + UPDATE_MAX_WAIT_MS);
        throw new Error(`GitHub 接口额度已用完，${clock(retryAt)} 后恢复`);
      }
      throw new Error('GitHub 拒绝访问（HTTP 403）');
    }
    if (response.status === 404) throw new Error('仓库还没有正式版');
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('GitHub 返回的不是有效 JSON'); }
    latest = parseRelease(parsed, repo);
  }

  function run(): Promise<void> {
    checking ??= (async () => {
      try {
        await fetchLatest();
        checkedAt = now(); error = null; failures = 0; nextAt = now() + UPDATE_CHECK_INTERVAL_MS;
        probeAt = now() + UPDATE_PROBE_INTERVAL_MS;
      } catch (cause) {
        error = message(cause);
        failures++;
        nextAt = now() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!;
      } finally { checking = null; }
    })();
    return checking;
  }

  /**
   * The cheap check between the API ones. github.com answers releases/latest with a redirect to the latest stable
   * release's tag page, and that request is outside the API's hourly quota (60 without a token), which a read every
   * minute would use up. It tells the tag only: one other than the release last read brings the next API check forward
   * for the details, and the same one confirms the last check. A probe that fails changes nothing but a log line; the
   * API checks go on at their own pace.
   */
  async function probe(): Promise<void> {
    probeAt = now() + UPDATE_PROBE_INTERVAL_MS;
    let tag: string;
    try {
      let response: Response;
      try {
        response = await fetchImpl(`https://github.com/${repo}/releases/latest`, {
          method: 'HEAD', headers: { 'user-agent': 'trading-platform-updater' },
          redirect: 'manual', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS)]),
        });
      } catch (cause) {
        throw new Error(cause instanceof Error && cause.name === 'TimeoutError' ? '连接 GitHub 超时' : `连接 GitHub 失败：${message(cause).slice(0, 200)}`);
      }
      await response.body?.cancel().catch(() => undefined);
      const prefix = `https://github.com/${repo}/releases/tag/`, location = response.headers.get('location') ?? '';
      const found = location.startsWith(prefix) ? location.slice(prefix.length) : '';
      if (response.status < 300 || response.status >= 400 || !isVersion(found)) throw new Error(`发布页的应答无法识别（HTTP ${response.status}）`);
      tag = found;
    } catch (cause) {
      if (stop.signal.aborted) return;
      if (probeError === null) log(`每分钟的新版本探测失败（${message(cause)}），恢复前只靠每 ${UPDATE_CHECK_INTERVAL_MS / 60_000} 分钟一次的检查发现新版本`);
      probeError = message(cause);
      return;
    }
    if (probeError !== null) { log('每分钟的新版本探测已恢复'); probeError = null; }
    const at = now();
    if (tag === latest?.version) { if (error === null) checkedAt = at; return; }
    // After a failed API check its backoff decides the next one; a tag the API keeps answering differently is asked
    // about again only after the gap.
    if (failures === 0 && at - broughtForwardAt >= UPDATE_PROBE_API_GAP_MS) { broughtForwardAt = at; nextAt = at; }
  }

  function readJob(): { job: UpdateView['job']; pending: UpdateView['pending']; jobError?: string } {
    if (!dir) return { job: null, pending: null };
    try {
      const at = now();
      const raw = readUpdateResult(dir);
      const job: UpdateView['job'] = raw && raw.phase === 'running' && at - raw.startedAt > UPDATE_RUNNING_STALE_MS ? { ...raw, stale: true } : raw;
      let pending: UpdateView['pending'] = null;
      const text = readBounded(join(dir, UPDATE_REQUEST_FILE), MAX_REQUEST_BYTES);
      if (text !== null) {
        try { const request = parseUpdateRequest(JSON.parse(text)); pending = { ...request, stale: at - request.at > UPDATE_REQUEST_STALE_MS }; }
        catch { /* the helper answers a bad request itself */ }
      }
      // The helper removes the request file before its first result: this service's last request still waits until a
      // result answers it (its id, or an id-less failure written after it), for at most the request's own limit.
      const answered = raw !== null && (raw.id === submitted?.id || raw.id === null && raw.at >= (submitted?.at ?? 0));
      if (!pending && submitted && !answered && at - submitted.at <= UPDATE_REQUEST_STALE_MS) pending = { ...submitted, stale: false };
      return { job, pending };
    } catch (cause) { return { job: null, pending: null, jobError: `无法读取更新结果：${message(cause)}` }; }
  }

  function status(): UpdateView {
    const enabled = dir !== null && readyFile !== null && existsSync(readyFile);
    return {
      current, latest, checkedAt, checking: checking !== null, error, retryAt: retryAt !== null && retryAt > now() ? retryAt : null,
      manualAt: manualAt + UPDATE_MANUAL_GAP_MS,
      available: latest !== null && compareVersions(latest.version, current.version) > 0,
      enabled, ...readJob(),
    };
  }

  return {
    status,
    /** The page's 「检查更新」: at most once a minute, and never before GitHub's reset time. */
    async check(): Promise<UpdateView> {
      if (!checking) {
        const at = now();
        if (retryAt !== null && retryAt > at) throw new ContractError(429, 'update_rate_limited', `GitHub 接口额度已用完，${clock(retryAt)} 后再检查`);
        if (at - manualAt < UPDATE_MANUAL_GAP_MS) throw new ContractError(429, 'update_check_wait', `刚检查过，请 ${Math.ceil((manualAt + UPDATE_MANUAL_GAP_MS - at) / 1000)} 秒后再检查`);
        manualAt = at;
      }
      await run();
      return status();
    },
    /**
     * The background check: the API once the interval (or the backoff after a failure) and any rate-limit wait have
     * passed, and in between the probe every minute, which may make the API check due at once.
     */
    async tick(): Promise<void> {
      const due = (): boolean => { const at = now(); return at >= nextAt && (retryAt === null || at >= retryAt); };
      if (stop.signal.aborted || checking) return;
      if (!due() && now() >= probeAt) await probe();
      if (stop.signal.aborted || checking || !due()) return;
      await run();
    },
    /** Shutdown: a check in flight gives up rather than hold the stop for its timeout. */
    abort(): void { stop.abort(); },
    /** The page's 「确认更新」 to `version`, which must be the latest release seen and newer than this one. */
    apply(body: unknown): UpdateView {
      const { version } = exactKeys(body, ['version']);
      if (!isVersion(version)) throw new ContractError(400, 'update_version', '目标版本须形如 v0.1.0');
      if (!dir || readyFile === null || !existsSync(readyFile)) throw new ContractError(409, 'update_disabled', '在线更新尚未启用：先在服务器上执行一次一键部署命令');
      if (!latest || latest.version !== version) throw new ContractError(409, 'update_changed', '最新正式版已变化，请重新检查');
      if (error !== null) throw new ContractError(409, 'update_check_failed', '上次检查没有成功，请重新检查后再更新');
      if (!current.packaged) throw new ContractError(409, 'update_unpackaged', '本机不是安装脚本装的程序包，不能在页面更新');
      if (compareVersions(version, current.version) <= 0) throw new ContractError(409, 'update_current', '已是最新正式版');
      const { job, pending, jobError } = readJob();
      if (jobError) throw new ContractError(503, 'update_unavailable', jobError);
      if (pending && !pending.stale) throw new ContractError(409, 'update_busy', '上一个更新请求还没有被处理，请稍候');
      if (job && job.phase === 'running' && !job.stale) throw new ContractError(409, 'update_busy', '正在更新，请等待结束');
      const request: UpdateRequest = { id: randomUUID(), version, at: now() };
      try { writeHandoff(dir, UPDATE_REQUEST_FILE, JSON.stringify(request)); }
      catch (cause) { throw new ContractError(503, 'update_unavailable', `无法提交更新请求：${(cause as NodeJS.ErrnoException).code ?? message(cause)}`); }
      submitted = request;
      return status();
    },
  };
}

export type Updates = ReturnType<typeof createUpdates>;
