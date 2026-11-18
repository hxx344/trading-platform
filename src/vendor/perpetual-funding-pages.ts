import type { FundingHistoryRange, SettledFundingRecord } from './exchange-funding-history.mjs';

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
    for (const { time, rate } of page.records) {
      if (records.has(time) && records.get(time) !== rate) throw new Error('Conflicting CEX funding settlements');
      records.set(time, rate);
    }
    if (page.coverage && onProgress) onProgress({ coverage: page.coverage, records: within(page.coverage) });
    cursor = page.next;
  } while (cursor);
  return within(range);
}
