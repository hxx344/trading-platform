import { decimalUnits } from './decimal.mjs';
import { assessQuote, planQuote, quoteSize } from './quote.mjs';

const MIN_RATE_MS = 60_000, MAX_PENDING = 2048, MAX_IDS = 8192;
const MIN_BPS = decimalUnits('0.1'), MAX_BPS = decimalUnits('25');

// Only the short, still reorderable tail is replayed. Older counts and durations
// live in the checkpoint. Within one source millisecond a reopening precedes
// depth, then a halt precedes prints in ID order. Conflicting depths invalidate it.
const compareEvents = (a, b) => a.time - b.time || a.kind - b.kind || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const equalLevels = (a, b) => a.length === b.length && a.every(([p, q], i) => p === b[i][0] && q === b[i][1]);
const copyTrial = trial => ({ ...trial, rows: trial.rows.map(row => ({ ...row, open: row.open && { ...row.open } })) });

function retire(row, at) {
  if (row.open) row.activeMs += Math.max(0, Math.min(row.open.until, at) - row.open.since);
  row.open = null;
  row.pendingSince = null;
}
function endDepth(trial, at) {
  at = Math.max(trial.cursor, at);
  for (const row of trial.rows) retire(row, at);
  trial.until = null;
  trial.offset = null;
  trial.cursor = at;
}

export function createOndoObservation({ markets, cfg, startedAt, readRules, bookMaxAgeMs, rulesMaxAgeMs, dwellMs, minRestMs }) {
  const groups = new Map();
  for (const market of markets) {
    const rows = [];
    for (const distanceBps of [4, 8, 15]) {
      const target = decimalUnits(distanceBps);
      const inner = target - (cfg.target - cfg.min), outer = target + (cfg.max - cfg.target);
      const band = { target, min: inner < MIN_BPS ? MIN_BPS : inner, max: outer > MAX_BPS ? MAX_BPS : outer, wallMin: cfg.wallMin };
      for (const side of ['buy', 'sell']) rows.push({ side, distanceBps, band, touches: 0, sweeps: 0, activeMs: 0, open: null, pendingSince: null });
    }
    groups.set(market, { market, base: { rows, until: null, offset: null, rules: null, cursor: startedAt }, pending: [], seen: new Map(),
      through: -Infinity, lastDepth: null, clockAnchor: null, currentRules: null, quietUntil: -Infinity });
  }

  function apply(trial, event, latest) {
    const bound = time => Math.max(trial.cursor, Math.min(latest, time));
    if (event.kind === -1) { trial.rules = event.rules; trial.cursor = bound(event.local); return; }
    if (event.kind === 1) { endDepth(trial, bound(event.local)); trial.rules = null; return; }
    if (!trial.rules) return;
    // Source time determines event order. The estimated local instant cannot precede
    // earlier events or exceed the receipt of this or any already-received later event.
    const projected = trial.offset === null ? event.local : event.time + trial.offset;
    let at = bound(projected);
    if (event.kind === 2) {
      if (trial.until === null || at >= trial.until || projected >= trial.until || Math.abs(projected - event.local) >= bookMaxAgeMs) return;
      trial.cursor = at;
      const buy = event.aggressorSide === 'sell';
      for (const row of trial.rows) {
        const order = row.open;
        if (!order || (row.side === 'buy') !== buy || (buy ? event.price > order.price : event.price < order.price)) continue;
        if (!order.touched) { order.touched = true; row.touches += 1; }
        if (event.price !== order.price) { row.sweeps += 1; retire(row, at); }
      }
      return;
    }
    if (!event.depth) { endDepth(trial, at); return; }
    if (trial.until !== null && (projected > trial.until || Math.abs(projected - event.local) >= bookMaxAgeMs)) endDepth(trial, at);
    if (trial.offset === null) { at = bound(event.local); trial.offset = at - event.time; }
    trial.cursor = at;
    const depth = event.depth, rules = trial.rules;
    trial.until = Math.min(at + bookMaxAgeMs, event.local + bookMaxAgeMs, rules.at + rulesMaxAgeMs);
    for (const row of trial.rows) {
      if (row.open) {
        const current = row.open;
        const verdict = assessQuote(row.side, current.price, depth, depth, rules.tick, row.band);
        if (verdict.keep) row.pendingSince = null;
        else row.pendingSince ??= at;
        if (current.price % rules.tick === 0n && (verdict.keep || (!verdict.urgent
          && (at - row.pendingSince < dwellMs || at - current.since < minRestMs)))) {
          current.until = trial.until;
          continue;
        }
        retire(row, at);
      }
      const { price } = planQuote(row.side, depth, depth, rules.tick, row.band);
      if (price !== null && quoteSize(cfg.orderUsd, price, rules.step) > 0n) row.open = { price, since: at, until: trial.until, touched: false };
    }
  }

  function replay(trial, events, count, asOf) {
    if (!count) return;
    const upper = Array(count);
    let latest = asOf;
    for (let i = events.length - 1; i >= 0; i--) {
      latest = Math.min(latest, events[i].local);
      if (i < count) upper[i] = latest;
    }
    for (let i = 0; i < count; i++) apply(trial, events[i], upper[i]);
  }
  function commit(group, through) {
    let count = 0;
    while (count < group.pending.length && group.pending[count].time <= through) count++;
    if (count) { replay(group.base, group.pending, count, through + bookMaxAgeMs); group.pending.splice(0, count); }
    group.through = Math.max(group.through, through);
  }
  function disconnect(group, at) {
    replay(group.base, group.pending, group.pending.length, at);
    const anchor = group.lastDepth;
    group.through = Math.max(group.through, group.pending.at(-1)?.time ?? -Infinity, anchor ? anchor.time + (at - anchor.local) : -Infinity);
    endDepth(group.base, at);
    group.base.rules = null;
    group.pending.length = 0;
    group.lastDepth = null;
    group.clockAnchor = null;
    group.currentRules = null;
  }
  function enqueue(group, event) {
    if (event.local < group.quietUntil || event.time <= group.through) return;
    if (group.pending.length >= MAX_PENDING || group.seen.size >= MAX_IDS) {
      // The tail is incomplete. Discard that window and resume on a fresh book.
      endDepth(group.base, group.base.offset === null ? event.local : Math.min(event.local, group.through + group.base.offset));
      group.pending.length = 0; group.seen.clear(); group.lastDepth = null; group.clockAnchor = null;
      group.base.rules = group.currentRules;
      group.through = Math.max(group.through, event.local + bookMaxAgeMs);
      group.quietUntil = event.local + bookMaxAgeMs;
      return;
    }
    const index = group.pending.findLastIndex(prior => compareEvents(prior, event) <= 0) + 1;
    group.pending.splice(index, 0, event);
    if (event.kind === 0 && (!group.lastDepth || event.time > group.lastDepth.time)) {
      group.lastDepth = { time: event.time, local: event.local };
      group.clockAnchor ??= group.lastDepth;
    }
    if (event.kind === 2) group.seen.set(event.id, event.local);
  }
  function prepare(group, at) {
    const rules = readRules(group.market);
    if (!rules) { disconnect(group, at); return null; }
    const valid = rules.trading && rules.tick > 0n && rules.step > 0n && rules.at <= at && at < rules.at + rulesMaxAgeMs;
    const prior = group.currentRules;
    if (Boolean(valid) !== Boolean(prior) || (valid && (rules.at !== prior.at || rules.tick !== prior.tick || rules.step !== prior.step))) {
      group.currentRules = valid ? { tick: rules.tick, step: rules.step, at: rules.at } : null;
      const local = (valid || !rules.trading) && rules.at > 0 ? Math.min(at, rules.at) : at;
      if (group.clockAnchor) {
        const time = group.clockAnchor.time + (local - group.clockAnchor.local);
        const event = { kind: valid ? -1 : 1, time, local, rules: group.currentRules };
        if (time <= group.through) apply(group.base, event, at);
        else enqueue(group, event);
      } else group.base.rules = group.currentRules;
    }
    commit(group, at - bookMaxAgeMs);
    for (const [id, seenAt] of group.seen) {
      if (at - seenAt < 2 * bookMaxAgeMs) break;
      group.seen.delete(id);
    }
    return group.currentRules;
  }
  const timely = (source, at) => Number.isFinite(source) && at - source < bookMaxAgeMs && source - at <= bookMaxAgeMs;

  return {
    book(name, depth, at) {
      const group = groups.get(name); if (!group) return;
      prepare(group, at);
      if (!group.currentRules && !group.lastDepth) return;
      if (!depth || !timely(depth.time, at)) {
        if (!depth) disconnect(group, at);
        return;
      }
      const usable = depth.bids.length && depth.asks.length && depth.bids[0][0] < depth.asks[0][0] ? depth : null;
      const duplicate = group.pending.find(event => event.kind === 0 && event.time === depth.time);
      if (duplicate) {
        if (duplicate.depth && (!usable || !equalLevels(duplicate.depth.bids, usable.bids) || !equalLevels(duplicate.depth.asks, usable.asks))) duplicate.depth = null;
        return;
      }
      enqueue(group, { kind: 0, time: depth.time, local: at, depth: usable });
    },
    trade(name, print, at) {
      const group = groups.get(name); if (!group) return;
      prepare(group, at);
      if (!timely(print.time, at) || group.seen.has(print.id) || (!group.currentRules && !group.lastDepth)) return;
      enqueue(group, { kind: 2, time: print.time, local: at, id: print.id, price: print.price, aggressorSide: print.aggressorSide });
    },
    down(at) { for (const group of groups.values()) disconnect(group, at); },
    snapshot(at, ended = false) {
      const rows = [];
      for (const group of groups.values()) {
        prepare(group, at);
        const trial = copyTrial(group.base);
        replay(trial, group.pending, group.pending.length, at);
        for (const row of trial.rows) {
          const activeMs = row.activeMs + (row.open ? Math.max(0, Math.min(at, row.open.until) - row.open.since) : 0);
          const rate = count => activeMs >= MIN_RATE_MS ? count * 3_600_000 / activeMs : null;
          rows.push({ market: group.market, side: row.side, distanceBps: row.distanceBps, activeMs, touches: row.touches, sweeps: row.sweeps,
            touchesPerHour: rate(row.touches), sweepsPerHour: rate(row.sweeps) });
        }
      }
      return { startedAt, endedAt: ended ? at : null, rows };
    },
  };
}
