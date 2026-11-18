// Public terminal feeds adapted from your-quantguy/gate-crossex at 423356d.
// Copyright (c) the original contributors. AGPL-3.0-only; see THIRD_PARTY_NOTICES.md.
import WebSocket from './node-ws.mjs';
import { AppError } from './model.mjs';
import { bookChannel, TERMINAL_SYMBOL } from './terminal-data.mjs';

const fields = {
  ticker: ['ts', 'lp', 'bp', 'ap', 'o'], trade: ['ts', 'i', 'p', 'q', 'S'],
  funding_rate: ['r', 'T'], mark_price: ['mp'], order_book_1: ['ts', 'b', 'a'], order_book_5: ['ts', 'b', 'a'],
};

/** One public socket shared by bounded terminal subscriptions. No caller supplies a URL or outbound frame. */
export function createTerminalFeed({ WebSocketImpl = WebSocket, clock = Date.now } = {}) {
  const listeners = new Map(), subscribed = new Set();
  let socket = null, retry = null, ping = null, closed = false;
  function send(event, symbols) {
    if (socket?.readyState !== 1) return;
    const changed = symbols.filter(s => event === 'subscribe' ? !subscribed.has(s) : subscribed.has(s));
    for (const channel of Object.keys(fields)) {
      const payload = channel.startsWith('order_book_') ? changed.filter(s => bookChannel(s) === channel) : changed;
      if (payload.length) socket.send(JSON.stringify({ time: Math.floor(clock() / 1000), event, channel, payload }));
    }
    for (const symbol of changed) if (event === 'subscribe') subscribed.add(symbol); else subscribed.delete(symbol);
  }
  function disconnect() {
    const old = socket;
    socket = null; subscribed.clear(); clearInterval(ping); clearTimeout(retry); retry = ping = null;
    try { old?.close(); } catch { /* already closed */ }
  }
  function lost() {
    disconnect();
    if (closed || !listeners.size) return;
    retry = setTimeout(() => { retry = null; connect(); }, 5000); retry.unref();
    for (const group of listeners.values()) for (const listener of group) listener.down();
  }
  function connect() {
    if (socket || retry || closed || !listeners.size) return;
    let ws;
    try { ws = new WebSocketImpl('wss://api.gateio.ws/ws/crossex/public', { maxPayload: 1000000, handshakeTimeout: 8000 }); }
    catch { lost(); return; }
    socket = ws;
    ws.on('open', () => { if (socket === ws) try { send('subscribe', [...listeners.keys()]); } catch { lost(); } });
    ws.on('error', () => { if (socket === ws) lost(); });
    ws.on('close', () => { if (socket === ws) lost(); });
    ws.on('message', raw => {
      if (socket !== ws || raw.length > 1000000) return;
      try {
        const m = JSON.parse(String(raw)), r = m?.result, group = listeners.get(r?.s);
        if (m.event !== 'update' || !group || !Object.hasOwn(fields, m.channel) || !subscribed.has(r.s)) return;
        if (m.channel.startsWith('order_book_') && bookChannel(r.s) !== m.channel) return;
        const result = { s: r.s };
        // Only small public fields cross the process boundary, including the venue timestamps.
        for (const key of fields[m.channel]) {
          const value = r[key];
          if (value === undefined) continue;
          if (key === 'b' || key === 'a') {
            const limit = m.channel === 'order_book_1' ? 1 : 5;
            if (!Array.isArray(value) || value.length > limit || value.some(row => !Array.isArray(row) || row.length < 2
              || row.slice(0, 2).some(v => !['number', 'string'].includes(typeof v) || String(v).length > 100))) return;
            result[key] = value.map(row => row.slice(0, 2));
          } else {
            if (!['number', 'string'].includes(typeof value) || String(value).length > 200) return;
            result[key] = value;
          }
        }
        const frame = { event: 'update', channel: m.channel, result };
        if (m.time_ms !== undefined && ['number', 'string'].includes(typeof m.time_ms) && String(m.time_ms).length <= 16) frame.time_ms = m.time_ms;
        for (const listener of group) listener.data(frame);
      } catch { /* malformed public frame */ }
    });
    ping = setInterval(() => { if (socket === ws && ws.readyState === 1) try { ws.ping(); } catch { lost(); } }, 25000); ping.unref();
  }
  return {
    subscribe(symbol, callbacks) {
      if (closed || typeof symbol !== 'string' || !TERMINAL_SYMBOL.test(symbol)) throw new AppError('合约格式无效');
      let group = listeners.get(symbol);
      if (!group) {
        if (listeners.size >= 12) throw new AppError('行情查询繁忙，请稍后重试', 429);
        group = new Set(); listeners.set(symbol, group);
      }
      group.add(callbacks); connect();
      try { send('subscribe', [symbol]); } catch { lost(); }
      return () => {
        if (!group.delete(callbacks) || group.size) return;
        listeners.delete(symbol);
        try { send('unsubscribe', [symbol]); } catch { lost(); }
        if (!listeners.size) disconnect();
      };
    },
    close() { closed = true; listeners.clear(); disconnect(); },
  };
}
