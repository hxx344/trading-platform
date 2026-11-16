// Feishu alerts on the two hynix legs' notional balance (docs/hynix.md 7.1, 7.4), judged after each positions round. State
// lives in memory only: a restart starts the 60 s count again.
import { units } from '../decimal.ts';
import { VENUE_NAMES, type Venue } from '../contracts.ts';
import type { BalanceLeg, BalanceSettings } from './balance.ts';
import type { BalanceRow } from './market.ts';

/**
 * A level above ok must hold this long before the first alert, and ok must hold this long after an alert before the
 * recovery: a gap hovering at the line would otherwise send an alert and a recovery every minute or so. Unrecovered, the
 * alert is repeated every BALANCE_ALERT_REPEAT_MS.
 */
export const BALANCE_ALERT_DELAY_MS = 60_000;
export const BALANCE_ALERT_REPEAT_MS = 30 * 60_000;
/** A send failing every round logs the same venue and reason once in this long. */
export const BALANCE_FAILURE_LOG_MS = 10 * 60_000;

type Alerted = 'rebalance' | 'hard';
interface VenueState { since: number; alerted: Alerted | null; sentAt: number | null; okSince: number | null }

/** Rounded half away from zero to two decimals, for the message only. */
export function fixed2(value: string): string {
  const scaled = units(value), negative = scaled < 0n, magnitude = negative ? -scaled : scaled, step = 10n ** 16n;
  const cents = (magnitude + step / 2n) / step;
  return `${negative && cents !== 0n ? '-' : ''}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

const SIDE = { long: '多', short: '空' } as const;
const legText = (leg: BalanceLeg) => `${SIDE[leg.side]} ${leg.symbol} ${leg.quantity}（名义 ${fixed2(leg.notional)} USDT）`;
const orderText = (order: { symbol: string; side: 'long' | 'short'; action: 'open' | 'close'; quantity: string } | { error: string }) =>
  'error' in order ? `不提供（${order.error}）` : `${order.action === 'close' ? '平' : '开'}${SIDE[order.side]} ${order.symbol} ${order.quantity}`;

/** The reading in one message: legs, gap and its side, percent, both lines and the two suggestions (no account id). */
export function describeBalance(row: Exclude<BalanceRow, { status: 'unavailable' }>, settings: BalanceSettings): string {
  const lines = `调平线 ${settings.rebalancePercent}%、硬上限 ${settings.hardPercent}%、最小差额 ${settings.minGapUsdt} USDT`;
  if (row.status === 'none') return `${VENUE_NAMES[row.venue]} 海力士两腿均无持仓`;
  if (row.status === 'unpaired') return `${VENUE_NAMES[row.venue]} 两腿不成对：${row.reason}；持仓 ${row.legs.map(legText).join('、')}；不提供调平建议，请先人工处理（${lines}）`;
  const net = row.netSide === null ? '两腿相等' : `${row.netSide === 'long' ? '多头腿' : '空头腿'}较大，净${SIDE[row.netSide]}`;
  const suggest = row.suggest ? `；建议：减仓调平 ${orderText(row.suggest.reduce)}；加仓调平 ${orderText(row.suggest.add)}` : '';
  return `${VENUE_NAMES[row.venue]} 多头腿 ${row.long.symbol} ${row.long.quantity}（名义 ${fixed2(row.long.notional)} USDT），空头腿 ${row.short.symbol} ${row.short.quantity}（名义 ${fixed2(row.short.notional)} USDT）；`
    + `净敞口 ${fixed2(row.gap)} USDT（${net}），占较大一腿 ${fixed2(row.percent)}%；${lines}${suggest}`;
}

export interface BalanceAlertOptions {
  notify(text: string): void;
  /** True while the venue has an unfinished hynix job: its legs fill one after the other, so nothing is judged meanwhile. */
  busy(venue: Venue): boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * judge(rows, settings) once per positions round. An unavailable row or a busy venue keeps its state as it is: no alert, no
 * recovery, neither count cleared. A send that throws changes nothing, so the next round tries again.
 */
export function createBalanceAlerts({ notify, busy, now = Date.now, log = line => process.stderr.write(`${line}\n`) }: BalanceAlertOptions) {
  const states = new Map<Venue, VenueState>(), failures = new Map<Venue, { reason: string; at: number }>();
  const send = (venue: Venue, text: string): boolean => {
    try { notify(text); failures.delete(venue); return true; }
    catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : String(error), last = failures.get(venue), time = now();
      if (!last || last.reason !== reason || time - last.at >= BALANCE_FAILURE_LOG_MS) {
        log(`海力士两腿平衡告警发送失败（${VENUE_NAMES[venue]}）：${reason}`);
        failures.set(venue, { reason, at: time });
      }
      return false;
    }
  };
  function judgeRow(row: BalanceRow, settings: BalanceSettings): void {
    if (row.status === 'unavailable' || busy(row.venue)) return;
    const time = now(), state = states.get(row.venue), detail = describeBalance(row, settings);
    if (row.level === 'ok') {
      if (state?.alerted) {
        state.okSince ??= time;
        if (time - state.okSince < BALANCE_ALERT_DELAY_MS) return;
      }
      if (state?.alerted && !send(row.venue, `【海力士两腿已恢复平衡】${row.status === 'none' ? `${VENUE_NAMES[row.venue]} 海力士持仓已全部平掉` : detail}`)) return;
      states.delete(row.venue);
      return;
    }
    const level: Alerted = row.level, title = level === 'hard' ? '【海力士两腿失衡·尽快处理】' : '【海力士两腿失衡·建议调平】';
    const current = state ?? { since: time, alerted: null, sentAt: null, okSince: null };
    current.okSince = null;
    states.set(row.venue, current);
    if (current.alerted === null) {
      if (time - current.since < BALANCE_ALERT_DELAY_MS) return;
      if (send(row.venue, `${title}${detail}`)) Object.assign(current, { alerted: level, sentAt: time });
    } else if (level === 'hard' && current.alerted === 'rebalance') {
      if (send(row.venue, `【海力士两腿失衡升级·尽快处理】${detail}`)) Object.assign(current, { alerted: level, sentAt: time });
    } else if (time - current.sentAt! >= BALANCE_ALERT_REPEAT_MS) {
      if (send(row.venue, `${title}${detail}（持续 ${Math.floor((time - current.since) / 60_000)} 分钟未恢复）`)) Object.assign(current, { alerted: level, sentAt: time });
    }
  }
  return {
    judge(rows: readonly BalanceRow[], settings: BalanceSettings): void {
      for (const row of rows) judgeRow(row, settings);
    },
  };
}
export type BalanceAlerts = ReturnType<typeof createBalanceAlerts>;
