// What the 系统更新 button and dialog say about the service's update view (docs/update.md). Pure, so the wording and the
// rules for when the update may start are tested without a browser. Wording follows the workbench's UpdateStatus.tsx
// (project-aggregation c03c83f), reduced to the one package this service has.
import type { UpdateView } from '../../src/service/update-types.ts';

export type { UpdateView };
export type UpdateJob = NonNullable<UpdateView['job']>;
export type UpdateTone = '' | 'available' | 'attention';

/** The page's own state next to the service's view. */
export interface UpdatePageState {
  view: UpdateView | null;
  /** The last read failed (network, timeout, restart); the view shown is the last one read. */
  offline: boolean;
  /** A check or the confirm is in flight from this page. */
  busy: 'check' | 'apply' | null;
  /** The job this page submitted or saw running; only its success reloads the page. */
  watched: string | null;
  /** A confirm went out without an answer: blocked until a read shows what the server has. */
  uncertain?: boolean;
  /** The service's version in the first view this page load read; null until then. */
  loaded?: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Boundary check of GET /api/update and the check / apply answers; a body that does not fit counts as a failed read. */
export function parseUpdateView(raw: unknown): UpdateView {
  const ok = isObject(raw) && isObject(raw.current) && typeof raw.current.version === 'string' && typeof raw.current.packaged === 'boolean'
    && typeof raw.enabled === 'boolean' && typeof raw.available === 'boolean' && typeof raw.checking === 'boolean'
    && (raw.latest === null || isObject(raw.latest) && typeof raw.latest.version === 'string')
    && (raw.pending === null || isObject(raw.pending) && typeof raw.pending.id === 'string' && typeof raw.pending.stale === 'boolean')
    && (raw.job === null || isObject(raw.job) && typeof raw.job.phase === 'string' && Array.isArray(raw.job.output));
  if (!ok) throw new Error('系统更新状态无法识别，稍后自动重试');
  return raw as unknown as UpdateView;
}

/**
 * The job this page keeps watching after a view arrives. A job seen running is watched; the watch stays while this
 * page's request waits for the helper or its job runs or has just succeeded (the reload), and ends on anything else:
 * a failure, an interrupted run, a request nobody took, or a result for another request (the helper answers an
 * unusable request file with id null).
 */
export function nextWatched(watched: string | null, view: UpdateView): string | null {
  const job = view.job;
  if (job && job.id && jobPhase(job) === 'running') return job.id;
  if (watched === null) return null;
  if (view.pending && view.pending.id === watched && !view.pending.stale) return watched;
  if (job && job.id === watched && job.phase === 'done') return watched;
  return null;
}

/** The update runs: a request waits for the helper, or the helper's result is still running and not stale. */
export function updating(view: UpdateView | null): boolean {
  if (!view) return false;
  if (view.pending && !view.pending.stale) return true;
  return view.job?.phase === 'running' && view.job.stale !== true;
}

/** The job's result as the page shows it: a running result past the helper's limit counts as interrupted. */
export function jobPhase(job: UpdateJob): 'running' | 'done' | 'failed' | 'interrupted' {
  if (job.phase === 'running') return job.stale ? 'interrupted' : 'running';
  return job.phase;
}

export const jobLabels = { running: '正在更新', done: '更新已完成', failed: '上次更新未完成', interrupted: '上次更新已中断' } as const;
export const stepLabels = { download: '下载并核对安装脚本', install: '下载程序包、检查配置并更新组件' } as const;

/**
 * The page reloads after the job it watched succeeds, or when the service runs another version than the one this page
 * loaded with and no update is under way (an update started from another page or device, or a page-only switch the
 * page never saw running). The first view sets the loaded version, so a reload cannot repeat itself.
 */
export function reloading(state: UpdatePageState): boolean {
  const { view } = state;
  const job = view?.job;
  if (job && job.phase === 'done' && job.id !== null && job.id === state.watched) return true;
  return !!view && !!state.loaded && view.current.version !== state.loaded && !updating(view);
}

/** Reads that fail for this long in a row stop going on in a hidden tab; the next visible read starts them again. */
export const BACKGROUND_SILENCE_MS = 10 * 60_000;

/**
 * Reads go on while the page is hidden as long as this page follows an update, so its success reloads the page, and
 * until the page has read its loaded version, so a tab opened in the background still notices a later update.
 * `silentMs` is, while the last read failed, how long ago the last successful read was (or the page mounted, before
 * any), and 0 otherwise; a service that stays unreachable that long ends the hidden reads. It must not follow the read
 * status: a hidden read that stops reports 'paused' with the failure kept, which would turn the reads straight back on.
 */
export function readsInBackground(state: UpdatePageState, silentMs: number): boolean {
  if (silentMs > BACKGROUND_SILENCE_MS) return false;
  return !state.loaded || state.watched !== null || updating(state.view) || state.busy === 'apply' || !!state.uncertain;
}

/** The loaded version is the service's version in the first view; later views never move it. */
export function nextLoaded(loaded: string | null, view: UpdateView): string {
  return loaded ?? view.current.version;
}

export function summaryOf(state: UpdatePageState): string {
  const { view } = state;
  if (reloading(state)) return '更新已完成，正在刷新页面';
  if (state.offline) return updating(view) || state.watched ? '更新中，等待重连' : '连接待恢复';
  if (updating(view) || state.busy === 'apply' || state.uncertain) return '更新进行中';
  if (view?.checking || state.busy === 'check') return '正在检查版本';
  if (!view) return '正在读取状态';
  if (!view.enabled) return '待启用';
  if (view.error) return '检查失败';
  if (view.available && view.latest) return `发现新版本 ${view.latest.version}`;
  const job = view.job ? jobPhase(view.job) : null;
  const issue = job === 'failed' || job === 'interrupted' ? jobLabels[job] : '';
  if (view.latest) return issue ? `已是最新正式版，${issue}` : '已是最新正式版';
  return issue || '尚无检查结果';
}

export function toneOf(state: UpdatePageState): UpdateTone {
  const { view } = state;
  if (reloading(state)) return 'available';
  if (state.offline || !view) return state.offline ? 'attention' : '';
  if (!view.enabled || view.error || view.jobError || view.pending?.stale) return 'attention';
  const job = view.job ? jobPhase(view.job) : null;
  if (job === 'failed' || job === 'interrupted') return 'attention';
  return view.available ? 'available' : '';
}

/** Why 查看更新 / 确认更新 cannot go ahead now; null when it can. */
export function blockedReason(state: UpdatePageState): string | null {
  const { view } = state;
  if (!view) return '正在读取状态';
  if (state.offline) return '连接待恢复';
  if (!view.enabled) return '在线更新待启用';
  if (!view.current.packaged) return '开发环境不能在页面更新';
  if (state.busy !== null) return '请求进行中';
  if (state.uncertain) return '确认结果未知，正在读取服务器记录';
  if (view.checking) return '正在检查版本';
  if (updating(view)) return '更新进行中';
  if (view.error) return '版本检查失败，请稍后重新检查';
  if (!view.available || !view.latest) return '没有可更新的正式版';
  if (view.jobError) return view.jobError;
  return null;
}

/** Month-day hour:minute in the browser's zone, like the workbench; '尚未检查' without a time. */
export function dateTime(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return '尚未检查';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
}
