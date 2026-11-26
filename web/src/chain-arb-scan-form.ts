import { parseChainArbScan, SCAN_HISTORY_MS, type ScanRow, type ScanView } from '../../src/chain-arb/scan-model.ts';
import { initialChainArbForm } from './chain-arb-form.ts';

export const initialScanForm = {
  chain: 'all', amount: initialChainArbForm.amount,
  spotFeeBps: initialChainArbForm.spotFeeBps, perpFeeBps: initialChainArbForm.perpFeeBps,
  spotCosts: '0', perpCosts: '0',
};
export type ScanForm = typeof initialScanForm;

export function scanQuery(form: ScanForm) {
  const fields = Object.fromEntries(Object.entries(form).map(([name, value]) => [name, value.trim()]));
  const input = parseChainArbScan(fields);
  return { input, path: '/api/monitor/perpetual/chain-arb-scan?' + new URLSearchParams({ ...input }) };
}

export function reviewScanRow(form: ScanForm, row: ScanRow) {
  return { form: { ...form, chain: row.chain, address: row.address, symbol: row.symbol, source: 'scan' as const }, autoGas: true };
}

export async function readTimedScan(read: () => Promise<ScanView>, now = () => performance.now()) {
  const startedAt = now();
  return { startedAt, view: await read() };
}
export type TimedScan = Awaited<ReturnType<typeof readTimedScan>>;
export const HISTORY_DISPLAY_LIMIT = 20;

/** A delayed reply spends its trip time out of every row's lifetime, independently. */
export function scanBands(scan: TimedScan | null, samplingOnly: boolean, now: number) {
  const live: ScanRow[] = [], history: ScanRow[] = [];
  let nextDeadline = Infinity;
  if (scan) {
    const { startedAt, view } = scan;
    const sampleOnly = samplingOnly || view.phase !== 'scanning';
    const toLocal = (timestamp: number) => startedAt + (timestamp - view.asOf);
    const addSample = (row: ScanRow) => {
      const deadline = toLocal(row.at + SCAN_HISTORY_MS);
      if (now < deadline) {
        history.push(row);
        nextDeadline = Math.min(nextDeadline, deadline);
      }
    };
    for (const row of view.rows) {
      const deadline = toLocal(row.expiresAt);
      if (!sampleOnly && now < deadline) {
        live.push(row);
        nextDeadline = Math.min(nextDeadline, deadline);
      } else addSample(row);
    }
    for (const row of view.history) addSample(row);
    live.sort((a, b) => b.netBps - a.netBps || b.netUsdt - a.netUsdt);
    history.sort((a, b) => b.at - a.at);
  }
  return { live, history: history.slice(0, HISTORY_DISPLAY_LIMIT), nextDeadline };
}
