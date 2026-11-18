import type { FundingHistoryRange, SettledFundingRecord } from './exchange-funding-history.mjs';

export const MAX_FUNDING_PAGES = 32;
export interface BitgetCursor { page: number; before: number }
export interface BitgetFundingPage { records: SettledFundingRecord[]; next: BitgetCursor | null; coverage: FundingHistoryRange | null }
export type FundingProgress = (progress: { coverage: FundingHistoryRange; records: SettledFundingRecord[] }) => void;

/** The cache owner accepts confirmed contiguous history before asking the collector for another numbered page. */
export async function collectBitgetPages(range: FundingHistoryRange, read: (cursor: BitgetCursor | null) => Promise<BitgetFundingPage>, onProgress?: FundingProgress): Promise<SettledFundingRecord[]> {
  const records = new Map<number, number>();
  const within = ({ from, to }: FundingHistoryRange) => [...records].filter(([time]) => time >= from && time <= to).sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate }));
  let cursor: BitgetCursor | null = null;
  do {
    const page: BitgetFundingPage = await read(cursor);
    if (page.next && (page.next.page !== (cursor?.page ?? 1) + 1 || (cursor && page.next.before >= cursor.before))) throw new Error('CEX funding history pagination did not advance');
    for (const { time, rate } of page.records) {
      if (records.has(time) && records.get(time) !== rate) throw new Error('Conflicting CEX funding settlements');
      records.set(time, rate);
    }
    if (page.coverage && onProgress) onProgress({ coverage: page.coverage, records: within(page.coverage) });
    if (page.next && page.next.page > MAX_FUNDING_PAGES) throw new Error('CEX funding history pagination exceeded page limit');
    cursor = page.next;
  } while (cursor);
  return within(range);
}
