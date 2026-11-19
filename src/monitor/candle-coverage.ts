/** All ranges are half open and aligned to native closed bars. The cursor for an old gap is independent of the tail. */
export interface CandleCoverage { through: number; repairAfter: number; repairCursor: number }
export interface CandleRange { start: number; end: number; kind: 'tail' | 'gap' | 'late' }
export const CANDLE_GAP_RETRY_MS = 3_600_000;

export function candleCoverage(saved: unknown, legacyThrough: number, step: number, fetchedAt: number): CandleCoverage {
  if (!saved) return { through: legacyThrough, repairAfter: 0, repairCursor: 0 };
  const value = saved as CandleCoverage;
  const boundary = (t: number) => Number.isSafeInteger(t) && t >= 0 && t <= fetchedAt && t % step === 0;
  if (!boundary(value.through) || !boundary(value.repairCursor) || !Number.isSafeInteger(value.repairAfter)
    || value.repairAfter < 0 || value.repairAfter > fetchedAt + CANDLE_GAP_RETRY_MS) throw Error('K 线历史读取进度无效');
  return { ...value };
}

export function nextCandleRange<Row extends { time: number }>(coverage: CandleCoverage, rows: readonly Row[], present: (row: Row) => boolean,
  first: number, step: number, now: number): CandleRange | null {
  const target = Math.floor(now / step) * step;
  if (coverage.through > target || first >= target) return null;
  if (coverage.through < target) return { start: Math.max(first, coverage.through - step), end: target, kind: 'tail' };
  const last = rows.at(-1);
  if (now - target >= 60_000 && now - target < 180_000 && (!last || last.time !== target - step || !present(last))) {
    return { start: target - step, end: target, kind: 'late' };
  }
  if (now < coverage.repairAfter) return null;
  function missing(start: number, end: number): CandleRange | null {
    let expected = start;
    for (const row of rows) {
      if (row.time < expected || !present(row)) continue;
      if (row.time >= end) break;
      if (row.time > expected) return { start: expected, end: Math.min(row.time, expected + 96 * step), kind: 'gap' };
      expected += step;
    }
    return expected < end ? { start: expected, end: Math.min(end, expected + 96 * step), kind: 'gap' } : null;
  }
  const cursor = Math.min(target, Math.max(first, coverage.repairCursor));
  const gap = missing(cursor, target) ?? missing(first, cursor);
  if (!gap) coverage.repairAfter = now + CANDLE_GAP_RETRY_MS;
  return gap;
}

/** Advance only together with the verified rows in the caller's SQLite transaction. */
export function afterCandleRange(previous: CandleCoverage, work: CandleRange, end: number, now: number): CandleCoverage {
  if (work.kind === 'gap') return { ...previous, repairCursor: end, repairAfter: now + CANDLE_GAP_RETRY_MS };
  if (work.kind === 'late') return previous;
  return { ...previous, through: end, repairAfter: previous.repairAfter || now + CANDLE_GAP_RETRY_MS };
}

export function candleCheckOverdue(through: number, step: number, now: number, grace: number): boolean {
  return !through || through > now || now > through + step + grace;
}
