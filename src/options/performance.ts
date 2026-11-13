// The 收益 page's arithmetic: every fill of the service's own orders attributed to the opening it belongs to, the
// exchange's closed-position evidence, and the sampled mark-to-market path. Ported from the workbench
// (modules/greeks/app/performance.py build_performance, commit 0c5a219); the deviations are in docs/options.md §2 (收益).
// Only uniquely attributable, completely reconciled openings held to expiry enter the curve. Amounts are exact decimal
// units throughout and rounded to 8 places only on output.
import { decimal, fromUnits, units } from '../decimal.ts';
import type { ExecutionRecord, Position } from './account.ts';
import type { Row } from './client.ts';
import type { Side, StrategyMode } from './strategy.ts';

const ONE = units('1');
const EPS = units('0.00000001');
const ROUND = 10n ** 10n;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const EXPIRY_PATTERN = /^BTC-(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})-\d+(?:\.\d+)?-[CP](?:-USDT|-USDC)?$/;

/** An exchange number as exact units: a decimal string as written, a float by its shortest form (exponent written out). */
export function exact(value: unknown): bigint {
  if (typeof value === 'string') return units(decimal(value));
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('收益数值无效');
  const text = String(value), match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return units(text);
  const [, sign, whole, fraction = '', exponent] = match;
  const digits = whole! + fraction, point = whole!.length + Number(exponent);
  const plain = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [integer, decimals = ''] = plain.split('.');
  // Places beyond the 18 the decimal type keeps are below any exchange precision.
  return units(`${sign}${integer}${decimals.slice(0, 18) ? `.${decimals.slice(0, 18)}` : ''}`);
}
const mul = (left: bigint, right: bigint): bigint => left * right / ONE;
const div = (left: bigint, right: bigint): bigint => left * ONE / right;
const abs = (value: bigint): bigint => value < 0n ? -value : value;
const sum = (values: Iterable<bigint>): bigint => { let total = 0n; for (const value of values) total += value; return total; };
const round = (value: bigint): bigint => (value >= 0n ? value + ROUND / 2n : value - ROUND / 2n) / ROUND * ROUND;
/** Rounded to 8 places, as the workbench's amount(). */
export const amount = (value: bigint): number => Number(fromUnits(round(value)));
/** The same rounding as a canonical decimal string, for storage. */
export const amountText = (value: bigint): string => fromUnits(round(value));

export const settlementCurrency = (symbol: string): 'USDT' | 'USDC' => symbol.endsWith('-USDT') ? 'USDT' : 'USDC';

/** 08:00 UTC on the expiry day in the symbol; null when the symbol does not name one. */
export function optionExpiry(symbol: string): number | null {
  const match = EXPIRY_PATTERN.exec(symbol.toUpperCase());
  if (!match) return null;
  const day = Number(match[1]), month = MONTHS.indexOf(match[2]!), year = 2000 + Number(match[3]);
  const time = Date.UTC(year, month, day, 8);
  return new Date(time).getUTCDate() === day ? time : null;
}

/** What the report needs of a task (engine Task satisfies it). */
export interface GroupInput {
  type: 'open' | 'close'; status: string; acceptedAt: number; strategyStatus: 'open' | 'closed' | null; mode: StrategyMode;
  legs: Record<string, { side: Side; qty: string }>; closureEvidence: Record<string, Row[]>; openingGroup: string | null;
}
/** What the report needs of an order record (engine JournalEntry satisfies it). */
export interface JournalInput { taskId: string; symbol: string; side: Side; filledQty: string; reduceOnly: boolean; terminal: boolean }
export interface Sample { time: number; pnl: string }
export interface PerformanceInput {
  groups: Readonly<Record<string, GroupInput>>; executions: readonly ExecutionRecord[]; journal: Readonly<Record<string, JournalInput>>;
  /** The latest positions, or null when they are not fresh enough to value a holding. */
  positions: readonly Position[] | null;
  samples: ReadonlyMap<string, readonly Sample[]>; sampleSeconds: number;
}
export interface SamplePoint { time: number; pnl: number; terminal?: true }
export interface SeriesPoint extends SamplePoint { groupId: string; cumulative: number }
export type GroupStatus = 'open' | 'closed' | 'pending';
export type ClosureKind = 'early' | 'expiry' | 'unknown' | 'holding';
export interface GroupReport {
  id: string; openedAt: number | null; strategyMode: StrategyMode | null; closedAt: number | null; currency: string; status: GroupStatus; issues: string[];
  legCount: number; openPremium: number | null; openFee: number | null; closeFee: number | null; deliveryFee: number;
  netPnl: number | null; floatingPnl: number | null; markToMarketPnl: number | null; expiry: number | null; eligible: boolean;
  closureKind: ClosureKind; exclusionReason: string; remainingQty: number; source: 'executions' | 'exchange_closed_positions';
  fills: ExecutionRecord[]; samples: SamplePoint[]; sampleCount: number;
}
export interface SeriesReport {
  currency: string; points: SeriesPoint[]; totalPnl: number; closedCount: number; wins: number; maxDrawdown: number;
  sampleSeconds: number; sampledCount: number; unsampledCount: number;
}
export interface PerformanceReport { groups: GroupReport[]; series: SeriesReport[]; unassignedCloses: number }

interface Lot { execution: ExecutionRecord; remaining: bigint; qty: bigint; price: bigint; fee: bigint }
interface Bucket {
  id: string; meta: GroupInput | null; lots: Lot[]; closes: ExecutionRecord[]; issues: string[];
  openFee: bigint; closeFee: bigint; premium: bigint; realized: bigint; opened: number | null; closed: number | null; currencies: Set<string>;
}
const legKey = (symbol: string, side: string): string => `${symbol}|${side}`;
const splitLeg = (key: string): [string, string] => [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)];
const SIDES = new Set(['Buy', 'Sell']);
/** A finished opening that filled nothing (failed / stopped) is not a combination opening. */
const NOTHING_FILLED = new Set(['failed', 'stopped']);

export function buildPerformance({ groups, executions, journal, positions, samples, sampleSeconds }: PerformanceInput): PerformanceReport {
  const expiries = new Map<string, number | null>();
  const expiryFor = (symbol: string): number | null => {
    if (!expiries.has(symbol)) expiries.set(symbol, optionExpiry(symbol));
    return expiries.get(symbol)!;
  };
  const meta = (id: string | null | undefined): GroupInput | undefined => id && Object.hasOwn(groups, id) ? groups[id] : undefined;
  const groupOfLink = (link: string): string | null => Object.hasOwn(journal, link) ? journal[link]!.taskId : null;

  const journalByGroup = new Map<string, JournalInput[]>(), pendingCloses = new Set<string>();
  for (const entry of Object.values(journal)) {
    journalByGroup.set(entry.taskId, [...journalByGroup.get(entry.taskId) ?? [], entry]);
    const group = meta(entry.taskId);
    if (group && !entry.terminal && group.openingGroup) pendingCloses.add(group.openingGroup);
  }
  const buckets = new Map<string, Bucket>();
  const bucket = (id: string, group: GroupInput | null): Bucket => ({ id, meta: group, lots: [], closes: [], issues: [], openFee: 0n, closeFee: 0n, premium: 0n, realized: 0n, opened: null, closed: null, currencies: new Set() });
  for (const [id, group] of Object.entries(groups)) if (group.type === 'open') buckets.set(id, bucket(id, group));

  const ordered = [...new Map(executions.map(item => [item.execId, item])).values()].sort((a, b) => a.execTime - b.execTime || (a.execId < b.execId ? -1 : a.execId > b.execId ? 1 : 0));
  let unassigned = 0;
  for (const execution of ordered) {
    const groupId = groupOfLink(execution.orderLinkId) ?? execution.taskId;
    const group = meta(groupId);
    const isClose = execution.reduceOnly || group?.type === 'close' || execution.orderLinkId.startsWith('tpo-close-') || (execution.closedSize ?? 0) > 0;
    if (!isClose && !groupId) continue; // Unrelated trades are not strategy returns.
    if (execution.execType !== 'Trade' && execution.execType !== 'BlockTrade') continue; // Delivery comes from closed-position evidence.
    let qty: bigint, price: bigint, fee: bigint;
    try {
      qty = exact(execution.execQty); price = exact(execution.execPrice); fee = exact(execution.execFee);
      if (qty <= 0n || price < 0n || !SIDES.has(execution.side) || !execution.symbol.startsWith('BTC-') || !Number.isSafeInteger(execution.execTime)) throw new Error('invalid');
    } catch {
      if (groupId && buckets.has(groupId)) buckets.get(groupId)!.issues.push('成交数据不完整');
      continue;
    }
    const currency = settlementCurrency(execution.symbol);
    const currencyOk = execution.feeCurrency === currency || (!execution.feeCurrency && fee === 0n);
    if (!isClose) {
      const target = buckets.get(groupId!) ?? bucket(groupId!, null);
      buckets.set(groupId!, target);
      if (!currencyOk) target.issues.push('手续费币种无法换算');
      target.currencies.add(currency);
      target.lots.push({ execution, remaining: qty, qty, price, fee });
      target.openFee += fee;
      target.premium += (execution.side === 'Sell' ? 1n : -1n) * mul(qty, price);
      target.opened = Math.min(target.opened ?? execution.execTime, execution.execTime);
      continue;
    }
    const opening = group?.openingGroup ?? execution.openingGroup;
    if (!opening) { unassigned += 1; continue; } // A matching symbol alone cannot prove a manual close belongs here.
    const target = buckets.get(opening);
    const lots = target ? target.lots.filter(lot => lot.execution.symbol === execution.symbol && lot.execution.side !== execution.side && lot.remaining > EPS) : [];
    if (!lots.length) {
      target?.issues.push('平仓成交缺少对应开仓记录');
      unassigned += 1;
      continue;
    }
    if (sum(lots.map(lot => lot.remaining)) + EPS < qty || (execution.closedSize !== null && abs(exact(execution.closedSize) - qty) > EPS)) {
      target!.issues.push('平仓数量与开仓记录不符');
      continue;
    }
    if (!currencyOk) target!.issues.push('手续费币种无法换算');
    let remaining = qty, pnl = -fee;
    for (const lot of lots) {
      const matched = remaining < lot.remaining ? remaining : lot.remaining;
      pnl += (execution.side === 'Sell' ? 1n : -1n) * mul(price - lot.price, matched) - div(mul(lot.fee, matched), lot.qty);
      lot.remaining -= matched;
      remaining -= matched;
      if (remaining <= EPS) break;
    }
    target!.realized += pnl;
    target!.closeFee += fee;
    target!.closes.push(execution);
    target!.closed = execution.execTime;
  }

  const earlyGroups = new Set<string>();
  for (const item of ordered) {
    const opening = item.openingGroup ?? meta(groupOfLink(item.orderLinkId) ?? item.taskId)?.openingGroup;
    const expiry = expiryFor(item.symbol);
    if (opening && buckets.has(opening) && expiry !== null && item.execTime < expiry) earlyGroups.add(opening);
  }
  const remainingOwners = new Map<string, Set<string>>(), positionsByLeg = new Map<string, Position[]>(), evidenceOwners = new Map<string, Set<string>>();
  for (const [id, item] of buckets) for (const lot of item.lots) if (lot.remaining > EPS) {
    const key = legKey(lot.execution.symbol, lot.execution.side);
    remainingOwners.set(key, (remainingOwners.get(key) ?? new Set()).add(id));
  }
  for (const position of positions ?? []) {
    const key = legKey(position.symbol, position.side);
    positionsByLeg.set(key, [...positionsByLeg.get(key) ?? [], position]);
  }
  const identityOf = (row: Row): string => JSON.stringify([row.symbol, row.side, String(row.openTime), String(row.closeTime)]);
  for (const [id, group] of Object.entries(groups)) for (const rows of Object.values(group.closureEvidence ?? {})) for (const row of rows) {
    const identity = identityOf(row);
    evidenceOwners.set(identity, (evidenceOwners.get(identity) ?? new Set()).add(id));
  }

  const rows: GroupReport[] = [];
  for (const [id, item] of buckets) {
    const group = item.meta, lots = item.lots;
    const evidence = group?.closureEvidence ?? {};
    if (group && NOTHING_FILLED.has(group.status) && !lots.length && !Object.keys(evidence).length) continue;
    const actual = new Map<string, bigint>();
    for (const lot of lots) { const key = legKey(lot.execution.symbol, lot.execution.side); actual.set(key, (actual.get(key) ?? 0n) + lot.qty); }
    let expected = new Map<string, bigint>();
    for (const entry of journalByGroup.get(id) ?? []) {
      if (entry.reduceOnly) continue;
      const key = legKey(entry.symbol, entry.side);
      try { expected.set(key, (expected.get(key) ?? 0n) + exact(entry.filledQty)); } catch { item.issues.push('开仓成交仍待确认'); }
      if (!entry.terminal) item.issues.push('开仓成交仍待确认');
    }
    const fromLegs = (): Map<string, bigint> => {
      const legs = new Map<string, bigint>();
      for (const [symbol, leg] of Object.entries(group?.legs ?? {})) {
        try { legs.set(legKey(symbol, leg.side), exact(leg.qty)); } catch { /* A leg without a quantity sets no target. */ }
      }
      return legs;
    };
    if (!expected.size && group) expected = fromLegs();
    for (const [key, qty] of expected) if (abs((actual.get(key) ?? 0n) - qty) > EPS) item.issues.push('开仓成交历史尚未补齐');
    let closed = lots.length > 0 && lots.every(lot => lot.remaining <= EPS);
    let source: GroupReport['source'] = 'executions', deliveryFee = 0n;
    let earlyClose = item.closes.some(close => { const expiry = expiryFor(close.symbol); return expiry !== null && close.execTime < expiry; });
    earlyClose ||= earlyGroups.has(id); // Even an unmatched partial fill is evidence of an early reduction.
    let verifiedExpiry = false;
    // Exchange closure evidence replaces, never adds to, fill-based P&L.
    const targets = expected.size ? expected : actual.size ? actual : fromLegs();
    if (Object.keys(evidence).length && targets.size) {
      try {
        let net = 0n, openingFee = 0n, closingFee = 0n, delivery = 0n, premium = 0n;
        const opened: number[] = [], closedTimes: number[] = [], currencies = new Set<string>(), seen = new Set<string>();
        let expiryVerified = true, evidenceEarly = false;
        for (const [key, qty] of targets) {
          if (qty <= EPS) continue;
          const [symbol, side] = splitLeg(key);
          let total = 0n;
          for (const row of evidence[key] ?? []) {
            const identity = identityOf(row);
            if (seen.has(identity)) continue;
            seen.add(identity);
            const owners = evidenceOwners.get(identity);
            if (row.symbol !== symbol || row.side !== side || owners?.size !== 1 || !owners.has(id)) throw new Error('Ambiguous closure evidence');
            const openedAt = Number(row.openTime), closedAt = Number(row.closeTime);
            if (!Number.isSafeInteger(openedAt) || !Number.isSafeInteger(closedAt) || closedAt < openedAt || (group && openedAt < group.acceptedAt)) throw new Error('Invalid closure times');
            const expiry = expiryFor(symbol);
            evidenceEarly ||= (expiry !== null && closedAt < expiry) || exact(row.totalCloseFee) !== 0n;
            expiryVerified &&= expiry !== null && closedAt >= expiry;
            const rowQty = exact(row.qty);
            total += rowQty;
            net += exact(row.totalPnl);
            openingFee += exact(row.totalOpenFee);
            closingFee += exact(row.totalCloseFee);
            delivery += exact(row.deliveryFee);
            premium += (side === 'Sell' ? 1n : -1n) * mul(exact(row.avgEntryPrice), rowQty);
            opened.push(openedAt);
            closedTimes.push(closedAt);
            currencies.add(settlementCurrency(symbol));
          }
          if (abs(total - qty) > EPS) throw new Error('Closure quantity mismatch');
        }
        if (!closedTimes.length) throw new Error('No closure amounts');
        Object.assign(item, { realized: net, openFee: openingFee, closeFee: closingFee, premium, opened: Math.min(...opened), closed: Math.max(...closedTimes), currencies, issues: [] });
        closed = true; source = 'exchange_closed_positions'; deliveryFee = delivery;
        earlyClose ||= evidenceEarly;
        verifiedExpiry = expiryVerified && !earlyClose;
      } catch {
        if (!closed) item.issues.push('交割或平仓收益待核对');
      }
    }
    if (group?.strategyStatus === 'closed' && !closed) item.issues.push('已结束组合的成交或交割记录不完整');
    if (!lots.length && source === 'executions') item.issues.push('等待实际开仓成交记录');
    if (item.currencies.size !== 1) item.issues.push('结算币种待核对');
    if (pendingCloses.has(id)) item.issues.push('平仓成交仍待确认');
    const issues = [...new Set(item.issues)];
    let floating: bigint | null = null;
    if (positions && !closed && lots.length && !issues.length) {
      const residuals = new Map<string, bigint>();
      for (const lot of lots) { const key = legKey(lot.execution.symbol, lot.execution.side); residuals.set(key, (residuals.get(key) ?? 0n) + lot.remaining); }
      let total = 0n, complete = true;
      for (const [key, qty] of residuals) {
        if (qty <= EPS) continue;
        const [symbol, side] = splitLeg(key);
        const matches = (positionsByLeg.get(key) ?? []).filter(position => { try { return abs(exact(position.size) - qty) <= EPS; } catch { return false; } });
        if (matches.length !== 1 || remainingOwners.get(key)?.size !== 1) { complete = false; break; }
        // This combination's own cost, not the account-wide average.
        const mark = exact(matches[0]!.markPrice);
        total += sum(lots.filter(lot => lot.execution.symbol === symbol && lot.execution.side === side).map(lot => (side === 'Buy' ? 1n : -1n) * mul(mark - lot.price, lot.remaining)));
      }
      if (complete) floating = total;
    }
    const currency = item.currencies.size === 1 ? [...item.currencies][0]! : '待确认';
    const legSymbols = [...(actual.size ? actual : targets).keys()].map(key => splitLeg(key)[0]);
    const expirySet = new Set(legSymbols.map(expiryFor));
    const expiry = expirySet.size === 1 ? [...expirySet][0]! : null;
    const eligible = closed && !issues.length && verifiedExpiry && expiry !== null;
    const closureKind: ClosureKind = earlyClose ? 'early' : eligible ? 'expiry' : closed ? 'unknown' : 'holding';
    const exclusionReason = eligible ? '' : earlyClose ? '有提前平仓（含部分减仓），整组不纳入综合统计' : closed ? '到期结算证据待核实' : '持仓尚未到期结束';
    const remainingFees = sum(lots.map(lot => div(mul(lot.fee, lot.remaining), lot.qty)));
    const known = lots.length > 0 || source !== 'executions';
    rows.push({
      id, openedAt: item.opened ?? group?.acceptedAt ?? null, strategyMode: group?.mode ?? null,
      closedAt: closed && item.closed !== null ? item.closed : null, currency,
      status: issues.length ? 'pending' : closed ? 'closed' : 'open', issues, legCount: (actual.size ? actual : targets).size,
      openPremium: known ? amount(item.premium) : null, openFee: known ? amount(item.openFee) : null, closeFee: known ? amount(item.closeFee) : null,
      deliveryFee: amount(deliveryFee), netPnl: issues.length ? null : amount(item.realized), floatingPnl: floating === null ? null : amount(floating),
      markToMarketPnl: floating !== null && !issues.length ? amount(item.realized + floating - remainingFees) : null,
      expiry, eligible, closureKind, exclusionReason, remainingQty: closed ? 0 : amount(sum(lots.map(lot => lot.remaining))), source,
      fills: [...lots.map(lot => lot.execution), ...item.closes], samples: [], sampleCount: 0,
    });
  }
  rows.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
  for (const row of rows) {
    let history: SamplePoint[] = [...samples.get(row.id) ?? []].map(sample => ({ time: sample.time, pnl: Number(sample.pnl) })) /* stored by amountText, already rounded */.sort((a, b) => a.time - b.time);
    if (row.status === 'closed' && row.closedAt !== null) {
      history = history.filter(sample => sample.time < row.closedAt!);
      history.push({ time: row.closedAt, pnl: row.netPnl!, terminal: true });
    }
    row.samples = history;
    row.sampleCount = history.filter(point => !point.terminal).length;
  }
  const series: SeriesReport[] = [];
  for (const currency of [...new Set(rows.filter(row => row.eligible).map(row => row.currency))].sort()) {
    const completed = rows.filter(row => row.eligible && row.currency === currency);
    const timeline = completed.flatMap(row => row.samples.map(point => ({ ...point, groupId: row.id }))).sort((a, b) => a.time - b.time || (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0));
    let total = 0n, peak = 0n, drawdown = 0n;
    const latest = new Map<string, bigint>(), points: SeriesPoint[] = [];
    for (let index = 0; index < timeline.length;) {
      const time = timeline[index]!.time, simultaneous: typeof timeline = [];
      while (index < timeline.length && timeline[index]!.time === time) simultaneous.push(timeline[index++]!);
      for (const point of simultaneous) {
        const value = exact(point.pnl);
        total += value - (latest.get(point.groupId) ?? 0n);
        latest.set(point.groupId, value);
      }
      if (total > peak) peak = total;
      if (peak - total > drawdown) drawdown = peak - total;
      points.push({ ...simultaneous.at(-1)!, cumulative: amount(total) }); // One point per time, as the workbench.
    }
    series.push({
      currency, points, totalPnl: amount(total), closedCount: completed.length, wins: completed.filter(row => row.netPnl! > 0).length, maxDrawdown: amount(drawdown),
      sampleSeconds, sampledCount: completed.reduce((count, row) => count + row.sampleCount, 0), unsampledCount: completed.filter(row => row.sampleCount === 0).length,
    });
  }
  return { groups: rows, series, unassignedCloses: unassigned };
}

/**
 * At most about `limit` points for a chart: the first and last, every terminal point, both sides of every gap longer
 * than `gapMs`, and the lowest and highest of each equal slice. `gapBefore` marks where the line breaks, since the
 * spacing of thinned points no longer shows the gaps.
 */
export function thinPoints<T extends { time: number; terminal?: true }>(points: readonly T[], limit: number, gapMs: number, value: (point: T) => number): (T & { gapBefore?: true })[] {
  const gap = points.map((point, index) => index > 0 && point.time - points[index - 1]!.time > gapMs);
  const keep = new Set<number>();
  if (points.length <= limit) points.forEach((_, index) => keep.add(index));
  else {
    keep.add(0).add(points.length - 1);
    points.forEach((point, index) => { if (point.terminal) keep.add(index); if (gap[index]) keep.add(index - 1).add(index); });
    const slices = Math.max(1, Math.floor(limit / 2)), size = Math.ceil(points.length / slices);
    for (let start = 0; start < points.length; start += size) {
      let low = start, high = start;
      for (let index = start; index < Math.min(points.length, start + size); index++) {
        if (value(points[index]!) < value(points[low]!)) low = index;
        if (value(points[index]!) > value(points[high]!)) high = index;
      }
      keep.add(low).add(high);
    }
  }
  const result: (T & { gapBefore?: true })[] = [];
  let broken = false;
  points.forEach((point, index) => {
    broken ||= gap[index]!;
    if (!keep.has(index)) return;
    result.push(broken && result.length ? { ...point, gapBefore: true } : { ...point });
    broken = false;
  });
  return result;
}
