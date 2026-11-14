// Replaces the workbench's hub-bridge.ts (modules/crossex/src/hub-bridge.ts, commit 7745181): this page is not inside
// a hub iframe, so there is no host activity, navigation or "changed" message. What remains is the read lifecycle:
// reads run while the tab is visible and the browser is online, and pause otherwise (use-live-resource does the same).
import { useEffect, useState } from 'react';

export type PageActivity = { active: boolean; readActive: boolean; background: boolean };

export function observeNetworkActivity(update: () => void, source: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {
  source.addEventListener('online', update); source.addEventListener('offline', update);
  return () => { source.removeEventListener('online', update); source.removeEventListener('offline', update); };
}
export const BACKGROUND_POLL_MS = 30_000;
export function readPollDelay(delay: number, background: boolean) { return background || document.hidden ? Math.max(BACKGROUND_POLL_MS, delay) : delay; }
export function observeReadWake(update: () => void) {
  document.addEventListener('visibilitychange', update);
  window.addEventListener('focus', update); window.addEventListener('pageshow', update);
  return () => { document.removeEventListener('visibilitychange', update); window.removeEventListener('focus', update); window.removeEventListener('pageshow', update); };
}

const current = (): PageActivity => {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const visible = typeof document === 'undefined' || !document.hidden;
  return { active: online && visible, readActive: online && visible, background: !visible };
};

/** Reads pause while the tab is hidden or offline and resume (with an immediate read) when it comes back. */
export function usePageActivity(): PageActivity {
  const [state, setState] = useState(current);
  useEffect(() => {
    const update = () => {
      const next = current();
      setState(previous => previous.active === next.active && previous.readActive === next.readActive && previous.background === next.background ? previous : next);
    };
    document.addEventListener('visibilitychange', update);
    const stopNetwork = observeNetworkActivity(update);
    update();
    return () => { stopNetwork(); document.removeEventListener('visibilitychange', update); };
  }, []);
  return state;
}
