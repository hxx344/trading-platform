export type ConfirmDialogOptions = {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  signal?: AbortSignal;
};

export type AlertDialogOptions = {
  title?: string;
  okLabel?: string;
  tone?: 'error' | 'warning' | 'info';
  signal?: AbortSignal;
};

export type DialogRequest =
  | {
    kind: 'confirm';
    message: string;
    title: string;
    confirmLabel: string;
    cancelLabel: string;
    tone: 'default' | 'danger';
    signal?: AbortSignal;
    settled: boolean;
    cleanup?: () => void;
    resolve: (confirmed: boolean) => void;
  }
  | {
    kind: 'alert';
    message: string;
    title: string;
    okLabel: string;
    tone: 'error' | 'warning' | 'info';
    signal?: AbortSignal;
    settled: boolean;
    cleanup?: () => void;
    resolve: () => void;
  };

export type HostApi = {
  enqueue: (request: DialogRequest) => void;
  cancel: (request: DialogRequest) => void;
  cancelAllConfirms: () => void;
};

export type DialogControllerEnv = {
  hasDocument?: () => boolean;
  addHashChange?: (listener: () => void) => () => void;
};

export type DialogController = ReturnType<typeof createDialogController>;

/** 创建隔离的弹窗队列控制器：保障单确认互斥、幂等结算、AbortSignal 清理与路由切换取消。 */
export function createDialogController(env: DialogControllerEnv = {}) {
  const hasDocument = env.hasDocument ?? (() => typeof document !== 'undefined');
  let activeHost: HostApi | null = null;
  const pendingQueue: DialogRequest[] = [];
  let hasOpenOrPendingConfirm = false;

  const settle = (request: DialogRequest, confirmed: boolean): void => {
    if (request.settled) return;
    request.settled = true;
    request.cleanup?.();
    request.cleanup = undefined;
    if (request.kind === 'confirm') {
      hasOpenOrPendingConfirm = false;
      request.resolve(confirmed);
    } else {
      request.resolve();
    }
  };

  const cancelFromPending = (request: DialogRequest): void => {
    const index = pendingQueue.indexOf(request);
    if (index >= 0) pendingQueue.splice(index, 1);
    settle(request, false);
  };

  const cancelAllConfirmsOnNavigation = (): void => {
    for (let i = pendingQueue.length - 1; i >= 0; i--) {
      const item = pendingQueue[i]!;
      if (item.kind === 'confirm') cancelFromPending(item);
    }
    activeHost?.cancelAllConfirms();
  };

  const addHashChange = env.addHashChange ?? ((listener: () => void) => {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  });
  const unbindHashChange = addHashChange(cancelAllConfirmsOnNavigation);

  const dispatch = (request: DialogRequest): void => {
    if (request.signal) {
      if (request.signal.aborted) {
        settle(request, false);
        return;
      }
      const onAbort = () => {
        if (activeHost) activeHost.cancel(request);
        else cancelFromPending(request);
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      request.cleanup = () => request.signal?.removeEventListener('abort', onAbort);
    }
    if (activeHost) {
      activeHost.enqueue(request);
      return;
    }
    pendingQueue.push(request);
  };

  const confirm = (message: string, options?: ConfirmDialogOptions): Promise<boolean> => {
    if (!hasDocument()) return Promise.resolve(true);
    if (options?.signal?.aborted || hasOpenOrPendingConfirm) return Promise.resolve(false);
    hasOpenOrPendingConfirm = true;
    return new Promise(resolve => {
      dispatch({
        kind: 'confirm',
        message,
        title: options?.title ?? '确认操作',
        confirmLabel: options?.confirmLabel ?? '确定',
        cancelLabel: options?.cancelLabel ?? '取消',
        tone: options?.tone ?? 'default',
        signal: options?.signal,
        settled: false,
        resolve,
      });
    });
  };

  const alert = (message: string, options?: AlertDialogOptions): Promise<void> => {
    if (!hasDocument()) return Promise.resolve();
    if (options?.signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      dispatch({
        kind: 'alert',
        message,
        title: options?.title ?? '提示',
        okLabel: options?.okLabel ?? '知道了',
        tone: options?.tone ?? 'info',
        signal: options?.signal,
        settled: false,
        resolve,
      });
    });
  };

  const attachHost = (host: HostApi, onDrain?: (drained: DialogRequest[]) => void): (() => void) => {
    activeHost = host;
    if (pendingQueue.length) {
      const drained = pendingQueue.splice(0, pendingQueue.length);
      if (onDrain) onDrain(drained);
      else for (const item of drained) host.enqueue(item);
    }
    return () => {
      if (activeHost === host) activeHost = null;
    };
  };

  const dispose = (): void => {
    unbindHashChange();
  };

  return {
    confirm,
    alert,
    attachHost,
    settle,
    cancelFromPending,
    cancelAllConfirmsOnNavigation,
    dispose,
  };
}

const defaultController = createDialogController();

/** 深色模态确认框，替代原生 window.confirm；同一时刻只允许一个确认框打开，重复触发返回 false。 */
export const confirmDialog = defaultController.confirm;

/** 深色模态提示框，替代原生 window.alert。 */
export const alertDialog = defaultController.alert;

export const attachDialogHost = defaultController.attachHost;
export const settleDialogRequest = defaultController.settle;
