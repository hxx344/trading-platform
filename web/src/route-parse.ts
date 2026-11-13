// The page's views live in the address hash (#/pair/<pair>, #/status, #/logs, #/settings, #/oil, #/monitor), so a reload or a shared
// link opens the same view. Kept free of the DOM so the server-side tests can import it.
export type Route = { page: 'overview' } | { page: 'pair'; pairId: string | null } | { page: 'status' } | { page: 'logs' } | { page: 'settings' } | { page: 'oil' } | { page: 'monitor' };
const PAIR_ID = /^[0-9A-Za-z_-]{1,64}$/;

export function parseRoute(hash: string): Route {
  if (hash === '#/status') return { page: 'status' };
  if (hash === '#/logs') return { page: 'logs' };
  if (hash === '#/settings') return { page: 'settings' };
  if (hash === '#/oil') return { page: 'oil' };
  if (hash === '#/monitor') return { page: 'monitor' };
  if (hash === '#/pair' || hash === '#/pair/') return { page: 'pair', pairId: null };
  if (hash.startsWith('#/pair/')) {
    let id: string;
    try { id = decodeURIComponent(hash.slice(7)); } catch { return { page: 'pair', pairId: null }; }
    return { page: 'pair', pairId: PAIR_ID.test(id) ? id : null };
  }
  return { page: 'overview' };
}
export const pairHref = (pairId: string): string => `#/pair/${encodeURIComponent(pairId)}`;
