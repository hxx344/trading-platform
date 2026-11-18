// 来源：project-aggregation 工作台 server/trading-ondo-stream.mjs（提交 7745181）。本服务增加公开逐笔与永续账户断线撤单。
import { Buffer } from 'node:buffer';
import { ondoWsLogin } from './transport.mjs';
import { decimalUnits } from './decimal.mjs';
import { sample } from './latency.mjs';

const URL = 'wss://api.ondoperps.xyz/ws';
const MAX_BYTES = 1024 * 1024;
const MAX_LEVELS = 200;
const CONNECT_MS = 8000, LOGIN_MS = 8000;
const PING_MS = 5000, SILENCE_MS = 15_000;
const DEAD_MAN = 'cancelAllOrdersAfterPerps', DEAD_MAN_SECONDS = 30;
const RETRY_MS = [1000, 2000, 4000, 8000, 15_000, 30_000], AUTH_RETRY_MS = 60_000;
const PRIVATE = ['ordersPerps', 'fillsPerps', 'positionsPerps'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function levels(rows, ascending) {
  if (!Array.isArray(rows) || rows.length > MAX_LEVELS) throw new Error('levels');
  let last = null;
  return rows.map(row => {
    if (!Array.isArray(row) || row.length < 2) throw new Error('level');
    const price = decimalUnits(row[0]), size = decimalUnits(row[1]);
    if (price <= 0n || size <= 0n || (last !== null && (ascending ? price <= last : price >= last))) throw new Error('level');
    last = price;
    return [price, size];
  });
}
/** One depth snapshot in exact units, or null when it is malformed or crossed. */
export function parseOndoBook(row) {
  try {
    const time = Date.parse(row.time);
    const bids = levels(row.bids, false), asks = levels(row.asks, true);
    if (!Number.isFinite(time) || (bids.length && asks.length && bids[0][0] >= asks[0][0])) return null;
    return { time, bids, asks };
  } catch { return null; }
}

function parsePublicTrade(row) {
  if (typeof row.id !== 'string' || !row.id.length || row.id.length > 256 || typeof row.time !== 'string'
    || typeof row.price !== 'string' || !['buy', 'sell'].includes(row.aggressor_side)) throw new Error('trade');
  const time = Date.parse(row.time), price = decimalUnits(row.price);
  if (!Number.isFinite(time) || price <= 0n) throw new Error('trade');
  return { id: row.id, time, price, aggressorSide: row.aggressor_side };
}

// One socket: full depth snapshots of `markets` (about four a second) and,
// with credentials, the account's order, fill and position channels. It sends
// nothing but login, subscriptions and pings. A lost, silent or refused
// connection reports onDown at once (every book it gave is void) and is
// reopened after 1-30 s, 60 s after a refused login, without a retry limit:
// reconnecting places no order. Private payloads are passed on unparsed; the
// caller treats them as hints and reads the account over REST.
export function createOndoStream({ markets, credentials = null, privateOnly = false, depth = 50, onBook, onTrade, onPublicReady, latency, heartbeatAllowed = () => true, onPrivate = () => {}, onDown = () => {},
  WebSocketImpl = globalThis.WebSocket, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const wanted = new Set(markets);
  const observeTrades = !credentials && typeof onTrade === 'function';
  let socket = null, era = 0, closed = false, started = false, failures = 0, lastFrame = 0, error = null;
  let open = false, loggedIn = false, subscribed = new Set();
  let heartbeatAckAt = null, armingAttempted = false;
  let pendingPings = 0, singlePing = null;
  let resumeAfterExpiry = null;
  const timers = new Set();
  let retryTimer = null;

  function schedule(fn, ms) {
    const timer = setTimeoutImpl(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer); timer?.unref?.();
    return timer;
  }
  function clearTimers() { for (const timer of timers) clearTimeoutImpl(timer); timers.clear(); retryTimer = null; }
  function fail(reason, auth = false) {
    const old = socket;
    const expiryWait = armingAttempted ? (DEAD_MAN_SECONDS + 1) * 1000 : 0;
    armingAttempted = false;
    if (pendingPings) sample(latency?.missedPings, pendingPings);
    pendingPings = 0; singlePing = null;
    sample(latency?.down);
    era += 1; socket = null; open = false; loggedIn = false; subscribed = new Set(); heartbeatAckAt = null;
    clearTimers();
    error = reason;
    // Close reasons and socket errors are not propagated: they can echo credentials.
    try { old?.close(); } catch { /* already unusable */ }
    onDown(reason);
    if (closed) return;
    // A quick reconnect/ping must not renew the previous connection's timer over leftover GTC orders.
    const wait = Math.max(expiryWait, auth ? AUTH_RETRY_MS : RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
    failures += 1;
    retryTimer = schedule(() => { retryTimer = null; connect(); }, wait);
  }
  const authorized = () => !credentials || (heartbeatAllowed() && (!resumeAfterExpiry || resumeAfterExpiry()));
  function send(value) {
    if (!authorized()) { fail('account_unverified'); return false; }
    try { socket.send(JSON.stringify(value)); return true; } catch { fail('send_failed'); return false; }
  }
  function watch(current) {
    schedule(function beat() {
      if (current !== era || !open) return;
      if (now() - lastFrame >= SILENCE_MS) { fail('silent'); return; }
      // A busy depth feed only proves the inbound path. Require a round trip on the socket that armed the timer.
      if (subscribed.has(DEAD_MAN) && !deadManReady()) { fail('heartbeat_timeout'); return; }
      // The protocol has no ping id. With overlapping pings, discard RTTs until every outstanding pong has arrived.
      const sent = sample(latency?.stamp);
      if (send({ op: 'ping' }) && current === era) {
        if (latency) {
          pendingPings++;
          singlePing = pendingPings === 1 ? sent : null;
        }
        schedule(beat, PING_MS);
      }
    }, PING_MS);
  }
  const privateReady = () => loggedIn && PRIVATE.every(channel => subscribed.has(channel));
  const publicReady = () => subscribed.has('depthBooksPerps') && (!observeTrades || subscribed.has('tradesPerps'));
  const deadManReady = () => loggedIn && subscribed.has(DEAD_MAN) && heartbeatAckAt !== null && now() - heartbeatAckAt < SILENCE_MS;
  function receive(data, received) {
    const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    if (raw.length > MAX_BYTES) throw new Error('size');
    const message = JSON.parse(raw);
    if (!object(message)) throw new Error('shape');
    lastFrame = now();
    if (message.type === 'pong') {
      if (subscribed.has(DEAD_MAN)) heartbeatAckAt = lastFrame;
      if (pendingPings > 0) {
        if (pendingPings === 1 && singlePing) sample(latency?.elapsed, null, 'wsRtt', singlePing, received);
        else sample(latency?.missedPings, 1);
        pendingPings--; singlePing = null;
      }
      return;
    }
    if (message.type === 'loggedIn') {
      if (!credentials || loggedIn) return;
      loggedIn = true;
      for (const channel of PRIVATE) if (!send({ op: 'subscribe', channel })) return;
      armingAttempted = true;
      send({ op: 'subscribe', channel: DEAD_MAN, timeout_seconds: DEAD_MAN_SECONDS });
      return;
    }
    if (message.type === 'subscribed') {
      if (message.channel === DEAD_MAN) {
        if (!credentials || !loggedIn) return;
        if (!authorized()) { fail('account_unverified'); return; }
        resumeAfterExpiry = null;
        heartbeatAckAt = lastFrame;
      }
      const wasReady = publicReady();
      if (typeof message.channel === 'string') subscribed.add(message.channel);
      if (!privateOnly && !wasReady && publicReady()) onPublicReady?.(lastFrame);
      if ((privateOnly || publicReady()) && (!credentials || privateReady())) { failures = 0; error = null; }
      return;
    }
    if (message.type === 'unsubscribed' && (message.channel === 'depthBooksPerps' || (observeTrades && message.channel === 'tradesPerps'))) {
      fail('public_unsubscribed'); return;
    }
    if (message.type === 'unsubscribed' && (message.channel === DEAD_MAN || PRIVATE.includes(message.channel))) {
      fail('protection_lost');
      return;
    }
    if (message.type === 'error') {
      // The text is not kept. An error before the private channels are confirmed is treated as a refused login.
      fail(credentials && !privateReady() ? 'login_refused' : 'venue_error', !!credentials && !privateReady());
      return;
    }
    if (message.type !== 'update' || typeof message.channel !== 'string') return;
    if (!privateOnly && message.channel === 'depthBooksPerps') {
      if (!Array.isArray(message.data)) throw new Error('shape');
      const frameEra = era;
      const frameBooks = received ? new Map() : null;
      for (const row of message.data) {
        if (!object(row) || !wanted.has(row.market)) continue;
        const book = parseOndoBook(row);
        onBook(row.market, book, lastFrame);
        // If a market appears several times in one frame, its newest complete BBO represents this arrival.
        if (frameBooks && book?.bids.length && book.asks.length) frameBooks.set(row.market, Math.max(frameBooks.get(row.market) ?? -Infinity, book.time));
      }
      if (frameBooks && frameEra === era) for (const [market, sourceAt] of frameBooks) sample(latency?.book, market, sourceAt, received);
    } else if (message.channel === 'tradesPerps' && observeTrades && publicReady()) {
      if (!Array.isArray(message.data)) throw new Error('shape');
      for (const row of message.data) {
        if (!object(row) || typeof row.market !== 'string') throw new Error('trade');
        if (wanted.has(row.market)) onTrade(row.market, parsePublicTrade(row), lastFrame);
      }
    } else if (PRIVATE.includes(message.channel) && privateReady()) onPrivate(message.channel, message.data);
  }
  function connect() {
    if (closed || socket) return;
    if (!authorized()) {
      retryTimer = schedule(() => { retryTimer = null; connect(); }, 1000);
      return;
    }
    if (typeof WebSocketImpl !== 'function') { error = 'unsupported'; return; }
    const current = ++era;
    let ws;
    try { ws = new WebSocketImpl(URL); } catch { fail('connect_failed'); return; }
    socket = ws;
    try { ws.binaryType = 'arraybuffer'; } catch { /* text frames only */ }
    const active = () => socket === ws && current === era && !closed;
    schedule(() => { if (active() && !open) fail('connect_timeout'); }, CONNECT_MS);
    ws.addEventListener('open', () => {
      if (!active()) return;
      open = true; lastFrame = now();
      if (!privateOnly && !send({ op: 'subscribe', channel: 'depthBooksPerps', markets: [...wanted], limit: depth })) return;
      if (observeTrades) {
        if (!send({ op: 'subscribe', channel: 'tradesPerps', markets: [...wanted], numPastTrades: 0 })) return;
      }
      if (observeTrades || onPublicReady) schedule(() => { if (active() && !publicReady()) fail('public_timeout'); }, CONNECT_MS);
      if (credentials) {
        let login;
        try { login = ondoWsLogin(credentials, String(Math.trunc(now()))); } catch { fail('login_refused', true); return; }
        if (!send(login)) return;
        schedule(() => { if (active() && (!privateReady() || !deadManReady())) fail('login_timeout'); }, LOGIN_MS);
      }
      watch(current);
    });
    ws.addEventListener('message', event => {
      if (!active()) return;
      const received = sample(latency?.stamp);
      try { receive(event.data, received); } catch { if (active()) fail('invalid_data'); }
    });
    ws.addEventListener('error', () => { if (active()) fail('socket_error'); });
    ws.addEventListener('close', () => { if (active()) fail('disconnected'); });
  }
  return {
    start() { if (!started && !closed) { started = true; connect(); } },
    expireOrders(confirmedClear) {
      if (closed || !credentials) return;
      resumeAfterExpiry = confirmedClear;
      if (socket) fail('cancel_unconfirmed');
    },
    status: () => ({ connected: open, publicReady: open && publicReady(), privateReady: open && privateReady(), deadManReady: open && deadManReady(), lastFrameAt: lastFrame || null, error }),
    close() {
      if (closed) return;
      closed = true;
      pendingPings = 0; singlePing = null;
      sample(latency?.down);
      const old = socket;
      era += 1; socket = null; open = false; loggedIn = false; subscribed = new Set();
      clearTimers();
      try { old?.close(); } catch { /* already unusable */ }
    },
  };
}
