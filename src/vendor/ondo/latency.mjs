// All elapsed times use the local monotonic clock. Only the venue stamp needs a wall-clock comparison.
const WINDOW_MS = 5 * 60_000, MAX_SAMPLES = 1024;
const MARKET_METRICS = ['bboAge', 'bookInterval', 'restQueue', 'cancelAck', 'placeAck', 'withdraw', 'replace'];
const PROTECTIVE = new Set(['too_close', 'unprotected', 'no_book', 'stale_book', 'own_order_in_way']);
const retriedReports = new WeakSet();

// Sampling runs beside order processing and the dead-man heartbeat. A failed observer cannot change their result.
export function sample(fn, ...args) {
  try { return fn?.(...args); } catch { return undefined; }
}
export const cleanOrderAck = (order, status) => order?.status === status && order.filled === '0';
export const markRetriedReport = report => { retriedReports.add(report); };

function series() {
  const rows = [];
  let next = 0;
  return {
    add(ms, stamp) {
      if (!stamp || (ms !== null && !Number.isFinite(ms))) return;
      rows[next] = { ms, at: stamp.wall, mono: stamp.mono };
      next = (next + 1) % MAX_SAMPLES;
    },
    summarize(cutoff) {
      const values = [];
      let lastMs = null, lastAt = null, lastFailureAt = null, failed = 0, negative = 0;
      const first = rows.length === MAX_SAMPLES ? next : 0;
      for (let i = 0; i < rows.length; i++) {
        const { ms, at, mono } = rows[(first + i) % rows.length];
        if (mono < cutoff) continue;
        if (ms === null) { failed++; lastFailureAt = at; continue; }
        values.push(ms); lastMs = ms; lastAt = at;
        if (ms < 0) negative++;
      }
      values.sort((a, b) => a - b);
      const quantile = q => values[Math.ceil(values.length * q) - 1] ?? null;
      return { metric: { lastMs, p50Ms: quantile(0.5), p95Ms: quantile(0.95), n: values.length, lastAt, failed, lastFailureAt }, negative };
    },
  };
}

export function createOndoLatency({ markets, mode, startedAt, prefix, now = Date.now, monotonicNow = () => performance.now() }) {
  const rtt = series();
  let withdrawals = new WeakMap();
  const marketRows = new Map(markets.map(market => [market, {
    metrics: Object.fromEntries(MARKET_METRICS.map(name => [name, series()])), previousFrame: null, quoteEpoch: 0,
  }]));
  let stopped = null;

  function stamp() {
    const wall = now(), mono = monotonicNow();
    return Number.isFinite(wall) && Number.isFinite(mono) ? { wall, mono } : null;
  }
  function elapsed(market, name, start, end, success = true) {
    if (stopped || !start || !end || end.mono < start.mono) return;
    const record = name === 'wsRtt' ? rtt : marketRows.get(market)?.metrics[name];
    record?.add(success ? end.mono - start.mono : null, end);
  }
  function snapshot(stop = false) {
    if (stopped) return stopped;
    const current = stamp();
    if (!current) return null;
    const cutoff = current.mono - WINDOW_MS;
    const view = { mode, startedAt, stoppedAt: stop ? current.wall : null, windowMs: WINDOW_MS, maxSamples: MAX_SAMPLES,
      wsRtt: rtt.summarize(cutoff).metric, markets: [] };
    for (const [market, row] of marketRows) {
      const entry = { market, clockAheadN: 0 };
      for (const name of MARKET_METRICS) {
        const { metric, negative } = row.metrics[name].summarize(cutoff);
        entry[name] = metric;
        if (name === 'bboAge') entry.clockAheadN = negative;
      }
      view.markets.push(entry);
    }
    if (stop) stopped = view;
    return view;
  }
  return {
    stamp, elapsed, snapshot,
    // One round is local to run() for this market. Never carry a cancelled order over to a later tick.
    cancel(market, order, reason, round) {
      if (order.role !== 'quote' || !order.clientId.startsWith(prefix)) return;
      const protective = PROTECTIVE.has(reason);
      if (!protective) withdrawals.delete(order);
      const replace = round && reason === 'too_far' && !order.protectionLost && !order.cancelFailures && !order.wasOpen && order.remaining === order.size;
      if (!protective && !replace) return;
      const start = stamp();
      if (!start) return;
      // A rejected DELETE leaves the same quote resting during backoff. Its next acknowledgement
      // belongs to the original withdrawal, unless custody or the connection became uncertain.
      if (protective && !order.wasOpen && !order.reportedFill && !order.cancelFailures) withdrawals.set(order, start);
      const withdrawal = protective && !order.wasOpen ? withdrawals.get(order) : null;
      const pending = replace ? { start, old: order, epoch: marketRows.get(market).quoteEpoch, canceled: false } : null;
      if (pending) round.set(order.side, pending);
      return report => {
        const confirmed = cleanOrderAck(report, 'canceled') && !order.reportedFill;
        if (protective) {
          const continuous = withdrawal && withdrawals.get(order) === withdrawal && !order.wasOpen;
          elapsed(market, 'withdraw', withdrawal || start, stamp(), Boolean(continuous && confirmed));
          if (confirmed || order.wasOpen || order.reportedFill) withdrawals.delete(order);
        }
        if (pending) pending.canceled = confirmed && !retriedReports.has(report) && !order.protectionLost;
      };
    },
    placed(round, order, report) {
      const pending = round?.get(order.side);
      if (pending?.canceled && order.role === 'quote' && order.price !== pending.old.price && report.id !== pending.old.id
        && cleanOrderAck(report, 'open') && !retriedReports.has(report) && !order.reportedFill && !order.protectionLost) {
        pending.ack = stamp();
      }
    },
    confirmReplace(market, side, round) {
      const pending = round?.get(side);
      if (pending?.ack && !pending.old.protectionLost && !pending.old.reportedFill && pending.epoch === marketRows.get(market).quoteEpoch) {
        elapsed(market, 'replace', pending.start, pending.ack);
        round.delete(side);
      }
    },
    finishRound(market, round) {
      for (const pending of round.values()) elapsed(market, 'replace', pending.start, stamp(), false);
    },
    breakQuotes(market) { marketRows.get(market).quoteEpoch++; },
    book(market, sourceAt, received) {
      const row = marketRows.get(market);
      if (stopped || !row || !received || !Number.isFinite(sourceAt)) return;
      row.metrics.bboAge.add(received.wall - sourceAt, received);
      elapsed(market, 'bookInterval', row.previousFrame, received);
      row.previousFrame = received;
    },
    down() { withdrawals = new WeakMap(); for (const row of marketRows.values()) { row.previousFrame = null; row.quoteEpoch++; } },
  };
}
