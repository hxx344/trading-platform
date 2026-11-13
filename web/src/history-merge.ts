// How a history list combines its live newest page with older pages read on demand. Kept free of the DOM so the
// server-side tests can import it.
type Row = { id: string };
export interface HistoryView<R extends Row> {
  rows: Map<string, R>;
  /** Where "load older" continues from. */
  next: string | null;
  /** Older pages were added since the list last restarted from the live page. */
  olderLoaded: boolean;
}
export const emptyHistory = <R extends Row>(): HistoryView<R> => ({ rows: new Map(), next: null, olderLoaded: false });

/**
 * Adds a fresh live page. Rows seen earlier stay (a row that slid off the live page is kept, not dropped into a hole),
 * the live page's copy wins. When the live page shares no row with what is shown while more rows lie past it, the rows
 * in between were never read: the list restarts from the live page, so "load older" fills that stretch first.
 */
export function mergeLive<R extends Row>(view: HistoryView<R>, page: { items: R[]; next: string | null }): HistoryView<R> {
  if (page.next !== null && view.rows.size && !page.items.some(row => view.rows.has(row.id))) {
    return { rows: new Map(page.items.map(row => [row.id, row])), next: page.next, olderLoaded: false };
  }
  const rows = new Map(view.rows);
  for (const row of page.items) rows.set(row.id, row);
  return { rows, next: view.olderLoaded ? view.next : page.next, olderLoaded: view.olderLoaded };
}

/** Adds an older page read from `cursor`; dropped when the list moved on (restarted, or another page was added) meanwhile. */
export function mergeOlder<R extends Row>(view: HistoryView<R>, cursor: string, page: { items: R[]; next: string | null }): HistoryView<R> {
  if (view.next !== cursor) return view;
  const rows = new Map(view.rows);
  for (const row of page.items) if (!rows.has(row.id)) rows.set(row.id, row);
  return { rows, next: page.next, olderLoaded: true };
}
