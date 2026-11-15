// 改写自 project-aggregation 工作台 modules/monitor/lib/read-activity.ts（提交 c84ba27）。本服务的页面总是独立打开，
// 没有工作台宿主的可见性与后台更新开关，所以只保留独立打开时的语义：页面可读 = 调用方处于活动状态且浏览器在线；
// 页面隐藏时按后台读处理（至少 30 秒一次）。observeReadActivity 未改。
const hiddenNow = () => typeof document !== 'undefined' && document.hidden;

export const backgroundReadDelay = (delay: number, hidden = hiddenNow()) => hidden ? Math.max(30_000, delay) : delay;
export const readsAllowed = (active: boolean) => active && (typeof navigator === 'undefined' || navigator.onLine);

/** Resume selected reads after foreground/network/BFCache restoration without changing action state. */
export function observeReadActivity(synchronize: () => void, refresh = synchronize) {
  let background = hiddenNow();
  const update = () => {
    const previous = background;
    background = hiddenNow();
    if (previous && !background) refresh(); else synchronize();
  };
  const restore = () => refresh();
  document.addEventListener('visibilitychange', update);
  window.addEventListener('online', restore); window.addEventListener('offline', update);
  window.addEventListener('focus', restore); window.addEventListener('pageshow', restore);
  synchronize();
  return () => {
    document.removeEventListener('visibilitychange', update);
    window.removeEventListener('online', restore); window.removeEventListener('offline', update);
    window.removeEventListener('focus', restore); window.removeEventListener('pageshow', restore);
  };
}
