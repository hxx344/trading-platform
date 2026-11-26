import { isVerifiedExecution, parseChainArbScan, SCAN_HISTORY_MS, type ScanExecution, type ScanRow, type ScanView } from '../../src/chain-arb/scan-model.ts';
import { initialChainArbForm } from './chain-arb-form.ts';
import { parseBackgroundSettings, type BackgroundSettings, type BackgroundView } from '../../src/chain-arb/background-model.ts';
import type { ChainArbVenue } from '../../src/chain-arb/model.ts';

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
  return { form: { ...form, chain: row.chain, address: row.address, symbol: row.symbol, source: 'scan' as const,
    ...(row.venue ? { venue: row.venue } : {}) }, autoGas: true };
}

export async function readTimedScan<T>(read: () => Promise<T>, now = () => performance.now()) {
  const startedAt = now();
  return { startedAt, view: await read() };
}
export type TimedScan = { startedAt: number; view: ScanView };
export type TimedBackground = { startedAt: number; view: BackgroundView };
export const HISTORY_DISPLAY_LIMIT = 20;
export type VerifiedScanRow = ScanRow & { execution: ScanExecution };
function verifiedRow(row: ScanRow): row is VerifiedScanRow {
  return isVerifiedExecution(row.execution);
}

/** A delayed reply spends its trip time out of every row's lifetime, independently. */
export function scanBands(scan: TimedScan | null, samplingOnly: boolean, now: number, includeFreshCooldownRows = false) {
  const live: VerifiedScanRow[] = [], history: VerifiedScanRow[] = [];
  let nextDeadline = Infinity;
  if (scan) {
    const { startedAt, view } = scan;
    const sampleOnly = samplingOnly || !(view.phase === 'scanning' || (includeFreshCooldownRows && view.phase === 'cooldown'));
    const toLocal = (timestamp: number) => startedAt + (timestamp - view.asOf);
    const addSample = (row: VerifiedScanRow) => {
      const deadline = toLocal(row.at + SCAN_HISTORY_MS);
      if (now < deadline) {
        history.push(row);
        nextDeadline = Math.min(nextDeadline, deadline);
      }
    };
    for (const row of view.rows) {
      if (!verifiedRow(row)) continue;
      const deadline = toLocal(row.expiresAt);
      if (!sampleOnly && now < deadline) {
        live.push(row);
        nextDeadline = Math.min(nextDeadline, deadline);
      } else addSample(row);
    }
    for (const row of view.history) if (verifiedRow(row)) addSample(row);
    live.sort((a, b) => b.netBps - a.netBps || b.netUsdt - a.netUsdt);
    history.sort((a, b) => b.at - a.at);
  }
  return { live, history: history.slice(0, HISTORY_DISPLAY_LIMIT), nextDeadline };
}

export function venueScanForm(settings: BackgroundSettings, venue: ChainArbVenue): ScanForm {
  const { chain, amount, spotFeeBps, perpFeeBps, spotCosts, perpCosts } = settings;
  return { chain, amount, spotFeeBps, perpFeeBps, spotCosts, perpCosts, ...settings.fees?.[venue] };
}

export type BackgroundDraft = ScanForm & Pick<BackgroundSettings, 'enabled' | 'venues' | 'fees'> & { thresholdBps: string };
export function backgroundDraft(settings: BackgroundSettings): BackgroundDraft {
  return { ...settings, thresholdBps: String(settings.thresholdBps) };
}
export function saveBackgroundDraft(draft: BackgroundDraft) {
  const threshold = draft.thresholdBps.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(threshold)
    || Number(threshold) === 0 && /[1-9]/.test(threshold.split(/e/i)[0])) throw new Error('请输入非负的通知阈值（bp）');
  return parseBackgroundSettings({ ...draft, thresholdBps: Number(threshold) });
}

export function backgroundBands(sample: TimedBackground | null, samplingOnly: boolean, now: number) {
  const live: VerifiedScanRow[] = [], history: VerifiedScanRow[] = [];
  let nextDeadline = Infinity;
  if (sample) for (const venue of sample.view.settings.venues) {
    const view = sample.view.results[venue];
    if (!view) continue;
    const bands = scanBands({ startedAt: sample.startedAt, view }, samplingOnly || !sample.view.settings.enabled, now, true);
    live.push(...bands.live.filter(row => (row.venue ?? 'gate') === venue));
    history.push(...bands.history.filter(row => (row.venue ?? 'gate') === venue));
    nextDeadline = Math.min(nextDeadline, bands.nextDeadline);
  }
  live.sort((a, b) => b.netBps - a.netBps || b.netUsdt - a.netUsdt);
  history.sort((a, b) => b.at - a.at || b.netBps - a.netBps);
  return { live, history: history.slice(0, HISTORY_DISPLAY_LIMIT), nextDeadline };
}
