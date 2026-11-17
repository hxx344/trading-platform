// Four legs on the page (docs/oil.md 11): one preview of two same-venue pairs, and the two jobs a confirm creates shown as
// one group with an overall status. Kept free of the DOM so the server-side tests import it.
import { ACTIVE_STATUSES, VENUE_LABEL, isOilVenue } from './oil-form.ts';
import type { OilJob, OilPreview } from './oil-types.ts';

/** POST /api/four-leg/preview: each part is the same-venue preview the executor would give that venue's pair. */
export interface FourLegPreview<I> { id: string; fourLeg: true; expiresAt: number; intent: I; parts: [OilPreview, OilPreview]; notional: string; barrels?: string; notes: string[] }
export interface FourLegConfirmResult { accepted: boolean; duplicate: boolean; group: string; jobs: OilJob[] }
export const isFourLegPreview = <I>(value: object): value is FourLegPreview<I> => 'fourLeg' in value;

/** A job on its own, or the jobs of one four-leg group in the intent's venue order (one when the other is not listed). */
export type JobEntry = { group: null; jobs: [OilJob] } | { group: string; jobs: OilJob[] };

/** The jobs as the list shows them: a group where its first job stands, its jobs in venue order. */
export function groupJobs(jobs: readonly OilJob[]): JobEntry[] {
  const entries: JobEntry[] = [];
  for (const job of jobs) {
    if (!job.group) { entries.push({ group: null, jobs: [job] }); continue; }
    const entry = entries.find(item => item.group === job.group!.id);
    if (entry) { entry.jobs.push(job); entry.jobs.sort((a, b) => (a.group?.index ?? 0) - (b.group?.index ?? 0)); } else entries.push({ group: job.group.id, jobs: [job] });
  }
  return entries;
}

const venueText = (venue: string): string => isOilVenue(venue) ? VENUE_LABEL[venue] : venue;
const JOB_TEXT: Record<string, string> = { failed: '失败', stopped: '已停止', attention: '需人工处理', accepted: '已受理', running: '执行中' };
const short = (symbol: string): string => symbol.replace(/USDT$/, '');

/**
 * The group's overall status: completed when both jobs completed, running while either runs, otherwise incomplete with
 * which venue did not complete (one needing a person first). Once nothing runs, a fill that differs between the venues is
 * named too: barrels per contract for oil; for hynix the share of each leg's plan filled, the plans being equal notional.
 */
export function groupStatus(jobs: readonly OilJob[]): { status: 'completed' | 'running' | 'incomplete'; text: string; details: string[] } {
  const running = jobs.some(job => ACTIVE_STATUSES.includes(job.status));
  const details: string[] = [];
  if (jobs.length < 2) details.push('另一交易所的任务不在当前列表中，请到交易所核对');
  const open = jobs.filter(job => job.status !== 'completed' && !ACTIVE_STATUSES.includes(job.status))
    .sort((a, b) => Number(b.status === 'attention') - Number(a.status === 'attention'));
  for (const job of open) details.push(`${venueText(job.legs[0]?.venue ?? '')} 任务${JOB_TEXT[job.status] ?? job.status}${job.status === 'attention' ? '，请先处理' : ''}`);
  if (!running && jobs.length === 2) {
    const [a, b] = jobs as [OilJob, OilJob];
    const hynix = a.market === 'hynix';
    const fill = (leg: OilJob['legs'][number]): number => hynix ? Number(leg.filledQuantity) / Number(leg.plannedQuantity || 1) : Number(leg.filledBarrels);
    const shown = (leg: OilJob['legs'][number]): string => hynix ? `${Math.round(fill(leg) * 1000) / 10}%` : `${leg.filledBarrels} 桶`;
    for (const leg of a.legs) {
      const other = b.legs.find(item => item.symbol === leg.symbol);
      if (other && Math.abs(fill(leg) - fill(other)) > 1e-9) {
        details.push(`${short(leg.symbol)} 两所成交${hynix ? '比例' : '桶数'}不等：${venueText(leg.venue)} ${shown(leg)}，${venueText(other.venue)} ${shown(other)}`);
      }
    }
  }
  if (running) return { status: 'running', text: '执行中', details };
  if (jobs.length === 2 && jobs.every(job => job.status === 'completed')) return { status: 'completed', text: '已完成', details };
  return { status: 'incomplete', text: '四腿不完整', details };
}
