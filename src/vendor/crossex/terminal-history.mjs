import { CANDLE_LIMIT, INTERVALS, normalizeCandles } from './terminal-data.mjs';

const GAP_RETRY_MS = 300_000;
class SupersededCandle extends Error {}
const clockError = '本机时间早于上次行情采集，保留已核实数据';

export function createTerminalHistory(store, candleReader, clock) {
  store?.db.exec(`CREATE TABLE IF NOT EXISTS terminal_candles (
    identity TEXT NOT NULL, interval TEXT NOT NULL, opened_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (identity, interval, opened_at)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS terminal_candles_observed ON terminal_candles(identity, interval, observed_at)`);

  function saved(identity, interval) {
    const now = clock(), step = INTERVALS[interval], current = Math.floor(now / step) * step;
    const rows = store?.prepare(`SELECT observed_at, json FROM terminal_candles
      WHERE identity=? AND interval=? AND opened_at<? ORDER BY opened_at DESC LIMIT ?`)
      .all(identity, interval, current, CANDLE_LIMIT) ?? [];
    const candles = normalizeCandles(rows.map(row => JSON.parse(row.json)), interval, now);
    // A late repair anywhere in this contract's archive can be its most recent observation.
    const latest = store?.prepare('SELECT MAX(observed_at) AS at FROM terminal_candles WHERE identity=? AND interval=?').get(identity, interval);
    // After a rollback, reveal each archived close as the clock passes its end, even if the venue is offline.
    const next = store?.prepare(`SELECT opened_at FROM terminal_candles
      WHERE identity=? AND interval=? AND opened_at>=? ORDER BY opened_at LIMIT 1`).get(identity, interval, current);
    return { closed: new Map(candles.map(c => [c.time, c])), asOf: rows[0]?.observed_at ?? null,
      lastObservedAt: latest?.at ?? 0, nextArchivedClose: next ? next.opened_at + step : null };
  }

  function applySaved(history, durable) {
    history.closed = durable.closed;
    history.window = null;
    history.asOf = Math.max(history.asOf ?? 0, durable.asOf ?? 0) || null;
    history.lastObservedAt = Math.max(history.lastObservedAt, durable.lastObservedAt);
    history.nextArchivedClose = durable.nextArchivedClose;
    return history;
  }

  function restore(identity, interval, history) {
    if (history && (history.nextArchivedClose === null || clock() < history.nextArchivedClose)) return history;
    const durable = saved(identity, interval);
    if (history) return applySaved(history, durable);
    return { ...durable, partial: null,
      attempt: -Infinity, gaps: new Map(), error: null, flight: null, controller: new AbortController() };
  }

  function snapshot(history, interval) {
    const step = INTERVALS[interval], current = Math.floor(clock() / step) * step;
    if (history.window?.current !== current) {
      const closed = [...history.closed.values()].filter(c => c.time < current).sort((a, b) => a.time - b.time)
        .slice(-CANDLE_LIMIT).map(c => ({ ...c, closed: true }));
      history.window = { current, closed };
    }
    const partial = history.partial?.time === current ? { ...history.partial, closed: false } : null;
    return { closed: history.window.closed, partial };
  }

  async function refresh(history, identity, quote, interval) {
    const now = clock(), step = INTERVALS[interval], current = Math.floor(now / step) * step;
    if (now < history.lastObservedAt) {
      history.partial = null;
      history.error = clockError;
      return;
    }
    const newClose = history.asOf !== null && Math.floor(history.asOf / step) * step < current;
    const first = current - (CANDLE_LIMIT - 1) * step, ranges = [];
    for (const at of history.gaps.keys()) if (at < first) history.gaps.delete(at);
    for (let t = first; t <= current; t += step) {
      // Only a new close needs its predecessor checked again. Within one interval the live bar is the entire warm tail.
      if (t < current && history.closed.has(t) && !(newClose && t === current - 2 * step)) continue;
      if (t < current - 2 * step && now - (history.gaps.get(t) ?? -Infinity) < GAP_RETRY_MS) continue;
      const end = Math.min(t + step - 1, now), previous = ranges.at(-1);
      if (previous && previous.to + 1 === t) previous.to = end;
      else ranges.push({ from: t, to: end });
    }
    let failed = false;
    // Refresh the tail first. Each round also repairs at most two disjoint older gaps.
    for (const range of ranges.reverse().slice(0, 3)) {
      const { signal } = history.controller;
      if (signal.aborted) return;
      try {
        const response = await candleReader(quote, interval, signal, range);
        if (signal.aborted) return;
        if (clock() < now) { history.partial = null; history.error = clockError; return; }
        // A request crossing the interval boundary cannot turn a partial quote into a final close.
        const rows = normalizeCandles(response, interval, now, CANDLE_LIMIT)
          .filter(c => c.time >= range.from && c.time <= range.to);
        const closed = rows.filter(c => c.time + step <= now);
        if (store && closed.length) store.transaction(() => {
          const upsert = store.prepare(`INSERT INTO terminal_candles VALUES (?,?,?,?,?)
            ON CONFLICT(identity,interval,opened_at) DO UPDATE SET observed_at=excluded.observed_at, json=excluded.json
            WHERE excluded.observed_at >= terminal_candles.observed_at`);
          for (const c of closed) {
            if (upsert.run(identity, interval, c.time, now, JSON.stringify(c)).changes !== 1) throw new SupersededCandle();
          }
        });
        for (const c of closed) history.closed.set(c.time, c);
        if (closed.length) history.window = null;
        if (history.closed.size > CANDLE_LIMIT) {
          const times = [...history.closed.keys()].sort((a, b) => b - a);
          for (const t of times.slice(CANDLE_LIMIT)) history.closed.delete(t);
        }
        if (range.to === now) {
          history.partial = rows.find(c => c.time === current) ?? null;
          history.partialAt = history.partial ? now : null;
          if (rows.length) history.asOf = now;
        }
        if (rows.length) history.lastObservedAt = now;
        for (let t = range.from; t < current && t <= range.to; t += step) {
          if (!history.closed.has(t)) history.gaps.set(t, now);
          else history.gaps.delete(t);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof SupersededCandle) {
          // The transaction rolled back. Show the actual stored versions, including the
          // newer correction that stopped the batch, and keep the last confirmed tail time.
          history.partial = null;
          try {
            applySaved(history, saved(identity, interval));
            history.error = clockError;
          } catch { history.error = '已保存的历史 K 线暂不可读'; }
          return;
        }
        failed = true;
        if (range.to === now) history.partial = null;
        // A broken older range must leave the next round's repair budget available to other gaps.
        if (range.to < current) for (let t = range.from; t <= range.to; t += step) history.gaps.set(t, now);
      }
    }
    history.error = failed ? '历史 K 线暂未更新，保留已核实数据' : null;
  }
  return { restore, refresh, snapshot };
}
