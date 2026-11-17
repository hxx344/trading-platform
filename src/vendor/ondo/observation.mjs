import { decimalUnits } from './decimal.mjs';
import { assessQuote, planQuote, quoteSize } from './quote.mjs';

const MIN_RATE_MS = 60_000;
const MIN_BPS = decimalUnits('0.1'), MAX_BPS = decimalUnits('25');

// Each distance is a separate two-sided trial on the same public tape. Shift the
// configured distance band around the new target, retaining its inward/outward margins.
export function createOndoObservation({ markets, cfg, startedAt, readRules, bookMaxAgeMs, rulesMaxAgeMs, dwellMs, minRestMs }) {
  const groups = new Map();
  for (const market of markets) {
    const rows = [];
    for (const distanceBps of [4, 8, 15]) {
      const target = decimalUnits(distanceBps);
      const inner = target - (cfg.target - cfg.min), outer = target + (cfg.max - cfg.target);
      const band = { target, min: inner < MIN_BPS ? MIN_BPS : inner, max: outer > MAX_BPS ? MAX_BPS : outer, wallMin: cfg.wallMin };
      for (const side of ['buy', 'sell']) rows.push({ side, distanceBps, band, touches: 0, sweeps: 0, activeMs: 0,
        open: null, recent: [], pendingSince: null, sweptAt: -Infinity });
    }
    groups.set(market, { market, rows, seen: new Map(), after: -Infinity, sourceAt: -Infinity, receivedAt: null, bookUntil: 0 });
  }

  // Local receipt time starts a virtual order. Keep a short history of retired prices:
  // a public print for the previous price can arrive just after the depth that moved it.
  function retire(row, at, sourceAt) {
    const order = row.open;
    if (!order) return;
    order.until = Math.max(order.since, Math.min(order.until, at));
    order.sourceUntil = Math.min(order.sourceUntil, sourceAt);
    row.activeMs += order.until - order.since;
    row.recent.push(order);
    row.open = null;
    row.pendingSince = null;
  }
  const sourceTimeAt = (group, local) => group.receivedAt === null ? -Infinity : group.sourceAt + (local - group.receivedAt);
  function interrupt(group, at) {
    const sourceAt = sourceTimeAt(group, at);
    for (const row of group.rows) {
      retire(row, at, sourceAt);
      row.recent.length = 0;
    }
    group.bookUntil = 0;
    group.after = Math.max(group.after, sourceAt);
    group.receivedAt = null;
  }
  function tradable(group, at) {
    const rules = readRules(group.market);
    if (rules?.trading && rules.tick > 0n && rules.step > 0n && rules.at <= at && at < rules.at + rulesMaxAgeMs) return rules;
    // If a rules refresh reported a halt between frames, exposure ended when it was reported.
    interrupt(group, !rules?.trading && rules?.at > 0 ? Math.min(at, rules.at) : at);
    return null;
  }

  function book(name, depth, at) {
    const group = groups.get(name);
    if (!group) return;
    const rules = tradable(group, at);
    if (!rules) return;
    if (!depth?.bids.length || !depth.asks.length || depth.bids[0][0] >= depth.asks[0][0]) { interrupt(group, at); return; }
    if (depth.time < group.after || depth.time <= group.sourceAt) return; // old era, duplicate or out of order
    // The venue and host clocks can differ. Cap both gross skew and delayed delivery
    // relative to the preceding frame, keeping all exposure durations on the local clock.
    const deliveryLag = group.receivedAt === null ? 0 : sourceTimeAt(group, at) - depth.time;
    if (!Number.isFinite(depth.time) || depth.time > at + bookMaxAgeMs || at - depth.time >= bookMaxAgeMs || deliveryLag >= bookMaxAgeMs) {
      interrupt(group, at); return;
    }
    if (group.bookUntil && at > group.bookUntil) interrupt(group, group.bookUntil);
    group.sourceAt = depth.time;
    group.receivedAt = at;
    group.bookUntil = Math.min(at + bookMaxAgeMs - Math.max(0, deliveryLag), rules.at + rulesMaxAgeMs);
    const sourceUntil = depth.time + (group.bookUntil - at);
    for (const row of group.rows) {
      row.recent = row.recent.filter(order => order.until >= at - bookMaxAgeMs);
      if (row.open) {
        const current = row.open;
        const verdict = assessQuote(row.side, current.price, depth, depth, rules.tick, row.band);
        if (verdict.keep) row.pendingSince = null;
        else row.pendingSince ??= at;
        if (current.price % rules.tick === 0n && (verdict.keep || (!verdict.urgent
          && (at - row.pendingSince < dwellMs || at - current.since < minRestMs)))) {
          current.until = group.bookUntil;
          current.sourceUntil = sourceUntil;
          continue;
        }
        retire(row, at, depth.time);
      }
      if (depth.time <= row.sweptAt) continue; // rearm after a distinct post-sweep depth
      const { price } = planQuote(row.side, depth, depth, rules.tick, row.band);
      if (price !== null && quoteSize(cfg.orderUsd, price, rules.step) > 0n) {
        row.open = { price, since: at, until: group.bookUntil, sourceSince: depth.time, sourceUntil, touched: false, swept: false };
      }
    }
  }

  function trade(name, print, at) {
    const group = groups.get(name);
    if (!group || !tradable(group, at) || !group.bookUntil || at >= group.bookUntil) return;
    const localPrintTime = group.receivedAt + (print.time - group.sourceAt);
    if (print.time < group.after || print.time > at + bookMaxAgeMs || at - print.time >= bookMaxAgeMs
      || at - localPrintTime >= bookMaxAgeMs || localPrintTime > at + bookMaxAgeMs) return;
    // With bounded clock skew a print can pass the raw time window for at most twice its width.
    for (const [id, seenAt] of group.seen) {
      if (at - seenAt < 2 * bookMaxAgeMs) break;
      group.seen.delete(id);
    }
    if (group.seen.has(print.id)) return;
    group.seen.set(print.id, at);
    const side = print.aggressorSide === 'sell' ? 'buy' : 'sell';
    for (const row of group.rows) {
      if (row.side !== side) continue;
      const covers = order => order && order.sourceSince <= print.time && print.time < order.sourceUntil;
      const order = covers(row.open) ? row.open : row.recent.findLast(covers);
      if (!order || (side === 'buy' ? print.price > order.price : print.price < order.price)) continue;
      if (!order.touched) { order.touched = true; row.touches += 1; }
      if (print.price === order.price || order.swept) continue;
      order.swept = true;
      row.sweeps += 1;
      row.sweptAt = Math.max(row.sweptAt, print.time);
      const localEnd = Math.max(order.since, Math.min(order.until, localPrintTime, at));
      if (order === row.open) retire(row, localEnd, print.time);
      else {
        // A late print cut short a previously closed interval.
        row.activeMs -= order.until - localEnd;
        order.until = localEnd;
        order.sourceUntil = print.time;
      }
    }
  }

  return {
    book, trade,
    down(at) { for (const group of groups.values()) interrupt(group, at); },
    snapshot(at, ended = false) {
      const rows = [];
      for (const group of groups.values()) {
        tradable(group, at);
        for (const row of group.rows) {
          const openMs = row.open ? Math.max(0, Math.min(at, row.open.until) - row.open.since) : 0;
          const activeMs = row.activeMs + openMs;
          const rate = count => activeMs >= MIN_RATE_MS ? count * 3_600_000 / activeMs : null;
          rows.push({ market: group.market, side: row.side, distanceBps: row.distanceBps, activeMs, touches: row.touches, sweeps: row.sweeps,
            touchesPerHour: rate(row.touches), sweepsPerHour: rate(row.sweeps) });
        }
      }
      return { startedAt, endedAt: ended ? at : null, rows };
    },
  };
}
