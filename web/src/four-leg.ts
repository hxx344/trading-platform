// Four legs on the page (docs/oil.md 11): one preview of two same-venue pairs, and the two jobs a confirm creates shown as
// one group with an overall status. Kept free of the DOM so the server-side tests import it.
import { ACTIVE_STATUSES, VENUE_LABEL, isOilVenue } from './oil-form.ts';
import type { OilJob, OilPreview } from './oil-types.ts';
import { fillGapText, fillGaps, type FillLeg } from '../../src/four-leg-fill.ts';

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

export type GroupState = 'completed' | 'running' | 'incomplete' | 'unbalanced' | 'unlisted';

/**
 * The group's overall status: running while either job runs; with only one job listed (the server brings the other job
 * along, so only an older server or a deleted row leaves it out) a neutral note; otherwise incomplete with which venue did
 * not complete (one needing a person first). Once nothing runs, fills that differ between the venues are named by the
 * executor's own rule (src/four-leg-fill.ts, the one its Feishu alert uses), and two completed jobs with such a gap are
 * "unbalanced".
 */
export function groupStatus(jobs: readonly OilJob[]): { status: GroupState; text: string; details: string[] } {
  const running = jobs.some(job => ACTIVE_STATUSES.includes(job.status));
  if (jobs.length < 2) return running ? { status: 'running', text: '执行中', details: [] } : { status: 'unlisted', text: '另一所未列出', details: ['另一交易所的任务不在当前列表中，可在该交易所的成交记录里核对'] };
  const details: string[] = [];
  const open = jobs.filter(job => job.status !== 'completed' && !ACTIVE_STATUSES.includes(job.status))
    .sort((a, b) => Number(b.status === 'attention') - Number(a.status === 'attention'));
  for (const job of open) details.push(`${venueText(job.legs[0]?.venue ?? '')} 任务${JOB_TEXT[job.status] ?? job.status}${job.status === 'attention' ? '，请先处理' : ''}`);
  let gaps = 0;
  if (!running) {
    const [a, b] = jobs as [OilJob, OilJob];
    const legs = (job: OilJob): FillLeg[] => job.legs.map(leg => ({ venue: venueText(leg.venue), symbol: leg.symbol, filled: leg.filledQuantity, planned: leg.plannedQuantity, step: leg.quantityStep ?? '0',
      shown: job.market === 'hynix' ? `${leg.filledQuantity} / ${leg.plannedQuantity}` : `${leg.filledBarrels} / ${leg.plannedBarrels} 桶` }));
    const found = fillGaps(legs(a), legs(b));
    gaps = found.length;
    details.push(...found.map(fillGapText));
  }
  if (running) return { status: 'running', text: '执行中', details };
  if (jobs.every(job => job.status === 'completed')) return gaps ? { status: 'unbalanced', text: '两所成交不等', details } : { status: 'completed', text: '已完成', details };
  return { status: 'incomplete', text: '四腿不完整', details };
}
