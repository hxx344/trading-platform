// 已结束实盘持仓的汇总（实盘页的累计、结果计数与分组）：启动时从库里读一次分组行，之后每结束一笔在内存里累加，
// 页面每次刷新不再逐行解析全表。只给页面看，风控用的当日已实现盈亏仍直接读库。
import type { LivePosition } from './live.ts';
import type { LiveSummaryRow } from './store.ts';
import type { LiveBreakdownRow, LiveOutcomeCounts } from './views.ts';

const DAY_MS = 86_400_000;
export const BREAKDOWN_PAIRS_MAX = 50, BREAKDOWN_DAYS = 14;
/** 第一腿发出去却没成交时写进持仓说明的话；汇总按它认 v0.112.x 没有逐单记录的旧记录，改它会让旧记录被数成发单前放弃。 */
export const FIRST_LEG_MISSED_NOTE = '第一腿没有成交';
const emptyCounts = (): LiveOutcomeCounts => ({ traded: 0, notFilled: 0, other: 0, singleLeg: 0, unsent: 0 });
const dayName = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * 第一腿有没有发出去过：有成交，或逐单记录里有开仓 A 腿，或说明写着第一腿没有成交（v0.112.x 没有逐单记录）。
 * 其余没成交的是发单前就放弃的（意图过期、发单前的报价或实时价差复核没过、凭据不在）。store.liveSummaryRows 的 SQL 与页面的 firstLegSent 同口径。
 */
export const firstLegSent = (position: Pick<LivePosition, 'a' | 'orders' | 'note'>): boolean =>
  position.a.qty > 0 || position.orders?.some(order => order.role === 'openA') === true || (position.note ?? '').includes(FIRST_LEG_MISSED_NOTE);

/** 一笔已结束的持仓对应的汇总行；口径与 store.liveSummaryRows 的分组相同（有成交按 A 腿开仓量大于 0，日期按结束时刻的 UTC 日）。 */
export function summaryRowOf(position: LivePosition): LiveSummaryRow | null {
  if (position.closedAt === null) return null;
  const netUsd = position.netUsd ?? 0;
  return { symbol: position.symbol, day: Math.floor(position.closedAt / DAY_MS), reason: position.closeReason ?? '', traded: position.a.qty > 0, singleLeg: position.singleLeg === true, sent: firstLegSent(position), count: 1, netUsd, wins: netUsd > 0 ? 1 : 0 };
}

export function createLiveSummary(rows: readonly LiveSummaryRow[]) {
  const totals = { trades: 0, netUsd: 0, wins: 0 };
  const total = emptyCounts(), days = new Map<number, LiveOutcomeCounts>();
  const byPair = new Map<string, LiveBreakdownRow>(), byDay = new Map<number, LiveBreakdownRow>(), byReason = new Map<string, LiveBreakdownRow>();
  const bump = <K>(map: Map<K, LiveBreakdownRow>, id: K, key: string, row: LiveSummaryRow) => {
    let entry = map.get(id);
    if (!entry) map.set(id, entry = { key, trades: 0, wins: 0, netUsd: 0 });
    entry.trades += row.count; entry.wins += row.wins; entry.netUsd += row.netUsd;
  };
  function add(row: LiveSummaryRow): void {
    let counts = days.get(row.day);
    if (!counts) days.set(row.day, counts = emptyCounts());
    for (const target of [total, counts]) {
      if (row.traded) { target.traded += row.count; if (row.singleLeg) target.singleLeg += row.count; }
      else if (row.reason === 'not_filled') { target.notFilled += row.count; if (!row.sent) target.unsent = (target.unsent ?? 0) + row.count; }
      else target.other += row.count;
    }
    if (!row.traded) return;
    totals.trades += row.count; totals.netUsd += row.netUsd; totals.wins += row.wins;
    bump(byPair, row.symbol, row.symbol, row);
    bump(byDay, row.day, dayName(row.day), row);
    bump(byReason, row.reason, row.reason, row);
  }
  for (const row of rows) add(row);
  return {
    add,
    /** 有成交的已结束持仓：笔数、净额、盈利笔数。 */
    totals: () => ({ ...totals }),
    outcomes(time: number): { today: LiveOutcomeCounts; total: LiveOutcomeCounts } {
      return { today: { ...(days.get(Math.floor(time / DAY_MS)) ?? emptyCounts()) }, total: { ...total } };
    },
    breakdown(time: number): { byPair: LiveBreakdownRow[]; byDay: LiveBreakdownRow[]; byReason: LiveBreakdownRow[] } {
      const today = Math.floor(time / DAY_MS), recent: LiveBreakdownRow[] = [];
      for (let day = today; day > today - BREAKDOWN_DAYS; day--) { const entry = byDay.get(day); if (entry) recent.push({ ...entry }); }
      return {
        byPair: [...byPair.values()].sort((x, y) => Math.abs(y.netUsd) - Math.abs(x.netUsd) || (x.key < y.key ? -1 : 1)).slice(0, BREAKDOWN_PAIRS_MAX).map(entry => ({ ...entry })),
        byDay: recent,
        byReason: [...byReason.values()].sort((x, y) => y.trades - x.trades || (x.key < y.key ? -1 : 1)).map(entry => ({ ...entry })),
      };
    },
  };
}
export type LiveSummary = ReturnType<typeof createLiveSummary>;
