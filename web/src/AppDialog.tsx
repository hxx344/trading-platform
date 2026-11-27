import { CircleAlert, Info, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  alertDialog,
  attachDialogHost,
  confirmDialog,
  settleDialogRequest,
  type AlertDialogOptions,
  type ConfirmDialogOptions,
  type DialogRequest,
  type HostApi,
} from './app-dialog-queue.ts';

export { alertDialog, confirmDialog };
export type { AlertDialogOptions, ConfirmDialogOptions };

/** 绑定当前组件生命周期：卸载或路由跳转时自动取消待确认对话框并告知调用方不再执行后续写入。 */
export function useDialogGuard() {
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  if (!controllerRef.current) controllerRef.current = new AbortController();
  useEffect(() => {
    mountedRef.current = true;
    if (controllerRef.current?.signal.aborted) controllerRef.current = new AbortController();
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);
  const confirm = useCallback((message: string, options?: Omit<ConfirmDialogOptions, 'signal'>) =>
    confirmDialog(message, { ...options, signal: controllerRef.current?.signal }), []);
  const alert = useCallback((message: string, options?: Omit<AlertDialogOptions, 'signal'>) =>
    alertDialog(message, { ...options, signal: controllerRef.current?.signal }), []);
  const isAlive = useCallback(() => mountedRef.current && !controllerRef.current?.signal.aborted, []);
  return { confirm, alert, isAlive };
}

/** 挂载在 App 根部的全局暗色弹窗宿主，按队列顺序串行展示。 */
export function AppDialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const current = queue[0] ?? null;

  useEffect(() => {
    const host: HostApi = {
      enqueue: request => setQueue(prev => [...prev, request]),
      cancel: request => {
        settleDialogRequest(request, false);
        setQueue(prev => prev.filter(item => item !== request));
      },
      cancelAllConfirms: () => {
        setQueue(prev => {
          for (const item of prev) {
            if (item.kind === 'confirm') settleDialogRequest(item, false);
          }
          return prev.filter(item => item.kind !== 'confirm');
        });
      },
    };
    return attachDialogHost(host, drained => setQueue(prev => [...prev, ...drained]));
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    if (!current || !node) return;
    if (!node.open) node.showModal();
    if (current.kind === 'confirm') cancelRef.current?.focus();
    else okRef.current?.focus();
    return () => { if (node.open) node.close(); };
  }, [current]);

  if (!current) return null;

  const finish = (confirmed: boolean) => {
    settleDialogRequest(current, confirmed);
    setQueue(prev => prev.filter(item => item !== current));
  };

  const isDanger = current.kind === 'confirm' ? current.tone === 'danger' : current.tone === 'error';
  const Icon = current.tone === 'info' ? Info : CircleAlert;

  return createPortal(
    <dialog
      ref={dialogRef}
      className={`tp-dialog${isDanger ? ' tp-dialog-danger' : ''}`}
      aria-labelledby="tp-dialog-title"
      aria-describedby="tp-dialog-message"
      onCancel={event => { event.preventDefault(); finish(false); }}
      onClick={event => { if (event.target === dialogRef.current) finish(false); }}
    >
      <div className="tp-dialog-card">
        <header className="tp-dialog-head">
          <div className="tp-dialog-title">
            <Icon size={18} aria-hidden="true" />
            <h2 id="tp-dialog-title">{current.title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭对话框" onClick={() => finish(false)}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="tp-dialog-body">
          <p id="tp-dialog-message">{current.message}</p>
        </div>
        <footer className="tp-dialog-foot">
          {current.kind === 'confirm' ? <>
            <button ref={cancelRef} type="button" className="button secondary" onClick={() => finish(false)}>{current.cancelLabel}</button>
            <button type="button" className={`button ${current.tone === 'danger' ? 'danger' : 'primary'}`} onClick={() => finish(true)}>{current.confirmLabel}</button>
          </> : (
            <button ref={okRef} type="button" className="button primary" onClick={() => finish(true)}>{current.okLabel}</button>
          )}
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
