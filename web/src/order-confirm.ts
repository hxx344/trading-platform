import type { RequestIds } from './request-ids.ts';

/** 共享实盘下单确认、未知结果离开确认与结果文案工具（由原油/海力士/金油页及海力士调平共用）。 */
export const LEAVE_UNANSWERED_CONFIRM = '上次确认没有收到应答，可能已经受理并下单。返回修改后会放弃核对，再次预览确认会是新的请求，可能重复下单。确定返回？';

export type OrderConfirmMessage = { tone: 'ok' | 'err' | 'muted'; text: string };

export interface DialogConfirmGuard {
  confirm(message: string, options: { title: string; confirmLabel: string; tone: 'danger' }): Promise<boolean>;
  isAlive(): boolean;
}

export const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

// Only the confirm's own refusal (a bad body, an invalid preview, a lock or a cap) proves the request id was never accepted.
// A refusal given before the executor looks the id up (401, 403, 421, 5xx) or a reused id leaves the first request's result unknown.
export const confirmRefused = (error: unknown): boolean => {
  const status = statusOf(error);
  return (status === 400 || status === 409) && (error as { code?: unknown } | null)?.code !== 'request_reused';
};

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const acceptedJobText = (result: { duplicate?: boolean; job: { id: string } }, statusLabel: string, placement: '上方' | '下方' = '上方'): string =>
  `${result.duplicate ? '该请求已受理过' : '已受理'}：任务 ${result.job.id.slice(0, 8)}（${statusLabel}），进度见${placement}「成交进度与结果」`;

export const acceptedFourLegText = (result: { duplicate?: boolean; group: string; jobs: readonly { id: string }[] }): string =>
  `${result.duplicate ? '该请求已受理过' : '已受理'}：四腿组 ${result.group.slice(0, 8)}，任务 ${result.jobs.map(job => job.id.slice(0, 8)).join('、')}，进度见上方「成交进度与结果」`;

export interface OrderConfirmOptions<R> {
  previewId: string;
  confirmText: string;
  confirmTitle: string;
  dialog: DialogConfirmGuard;
  ids: RequestIds;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  currentPreviewId: () => string | undefined;
  send: (requestId: string) => Promise<R>;
  formatAccepted: (result: R) => string;
  onAccepted: (result: R) => void;
  clearPreview: () => void;
  setUnanswered: (id: string | null) => void;
  setMessage: (message: OrderConfirmMessage | null) => void;
}

/** 弹窗确认并按 previewId 发送幂等确认请求；未知结果保留 requestId 与 unanswered 状态。 */
export async function executeOrderConfirm<R>(options: OrderConfirmOptions<R>): Promise<void> {
  const {
    previewId, confirmText, confirmTitle, dialog, ids, isBusy, setBusy,
    currentPreviewId, send, formatAccepted, onAccepted, clearPreview, setUnanswered, setMessage,
  } = options;
  if (isBusy()) return;
  if (!await dialog.confirm(confirmText, { title: confirmTitle, confirmLabel: '确定发送', tone: 'danger' })) return;
  if (!dialog.isAlive() || isBusy() || currentPreviewId() !== previewId) return;
  setBusy(true);
  setMessage({ tone: 'muted', text: '发送中…' });
  try {
    const result = await ids.run('confirm', previewId, send, confirmRefused);
    if (!dialog.isAlive()) return;
    clearPreview();
    setUnanswered(null);
    setMessage({ tone: 'ok', text: formatAccepted(result) });
    onAccepted(result);
  } catch (error) {
    if (!dialog.isAlive()) return;
    // Without an answer the job may have been accepted: the retry reuses the request id, so it cannot run twice.
    // Only the confirm's own refusal settles it; anything else (no answer, 401, 5xx, a reused id) keeps the result unknown and the id for the retry.
    const unknown = !confirmRefused(error);
    setUnanswered(unknown ? previewId : null);
    setMessage({ tone: 'err', text: unknown ? `${errorText(error)}（结果未知，可再次点击确认，沿用同一请求编号）` : errorText(error) });
  } finally {
    setBusy(false);
  }
}

export interface LeaveOrderPreviewOptions {
  dialog: DialogConfirmGuard;
  isBusy: () => boolean;
  currentPreviewId: () => string | undefined;
  unansweredId: string | null;
  confirmText?: string;
  onClear: () => void;
}

/** 离开当前预览；若上一笔确认结果未知，先弹出危险确认再清理预览状态。 */
export async function leaveOrderPreview(options: LeaveOrderPreviewOptions): Promise<void> {
  const { dialog, isBusy, currentPreviewId, unansweredId, confirmText = LEAVE_UNANSWERED_CONFIRM, onClear } = options;
  if (isBusy()) return;
  const previewId = currentPreviewId();
  if (previewId && unansweredId === previewId) {
    if (!await dialog.confirm(confirmText, { title: '离开确认', confirmLabel: '确定返回', tone: 'danger' })) return;
    if (!dialog.isAlive() || isBusy() || currentPreviewId() !== previewId) return;
  }
  onClear();
}
