// The reward-market collector (docs/ondo.md §5): once a minute it subscribes to the public depth channel for 10 s and takes
// each watched market's latest pushed book every second; a market the feed did not deliver is read over REST instead. It
// keeps the latest levels within 5 bps of the mid and a ring of minute samples (USD per 0.5 bps bucket out to 25 bps,
// averaged over the minute's snapshots, and the mid's returns) for the averages and the volatility the page's simulation
// needs. Our own resting quotes (the quoting module's) are taken out, so the depth is what we compete with. Samples live
// in memory: a restart starts the averages over.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOndoClient, ONDO_MARKET, OndoError, type OndoClient, type OndoDepth, type OndoRules } from '../vendor/ondo/client.mjs';
import type { OndoRestingOrder } from '../vendor/ondo/mm.mjs';
import { createOndoStream, type OndoBook, type OndoStream, type OndoStreamFactory } from '../vendor/ondo/stream.mjs';
import { formatDecimalUnits } from '../vendor/ondo/decimal.mjs';
import { BUCKET_BPS, BUCKETS, type OndoLevel, type OndoRewardConfig, type OndoRewardMarket, type OndoRewardsView } from './reward-types.ts';

/** The markets Ondo's reward rules list (docs/ondo.md §5). */
export const REWARD_MARKETS = ['US500', 'US100', 'DRAM', 'SOXL', 'MU', 'TSLA', 'NVDA', 'SPCX', 'INTC', 'META', 'AMD', 'COIN', 'MSTR', 'SNDK', 'CRCL', 'XAU', 'XAG', 'WTI', 'BTC', 'ETH'].map(name => `${name}-USD.P`);
export const REWARD_DEFAULTS: Readonly<OndoRewardConfig> = Object.freeze({ markets: REWARD_MARKETS, poolUsd: '125000', eligible: 20 });
/** Each minute the feed is open for BURST_MS and every market's latest pushed book is taken once a TICK_MS. */
export const CYCLE_MS = 60_000, BURST_MS = 10_000, TICK_MS = 1000;
/**
 * Levels per side asked of the feed, the most it sends: the dense books (XAU, US500, BTC) reach only 5–15 bps in 40 levels
 * and over 100 bps in 100 (docs/ondo.md §5).
 */
export const FEED_LEVELS = 100;
export const MAX_WINDOW_MIN = 360;
export const MIN_RETURNS = 20;
const RULES_MS = 15 * 60_000, LEVELS_BPS = 5, MAX_LEVELS = 40, FRESH_MS = 5000, BOOK_GAP_MS = 2000, MAX_MARKETS = 40;
/** A pushed book older than this at a tick is not taken (the feed went quiet for that market). */
const PUSH_FRESH_MS = 2000;
// A return is taken between the mids of snapshots 5–120 s apart and scaled to a minute; a longer gap (a missed minute)
// restarts from the next snapshot instead of passing a long move as one return.
const RETURN_GAP = [5_000, 120_000] as const;

export class RewardInputError extends Error { status = 400; }

/** One snapshot reduced to buckets. */
interface Snapshot { at: number; mid: number; bid: Float32Array; ask: Float32Array; cover: [number, number] }
/** One minute: the snapshots' average buckets and smallest cover, the last mid, and the sum of the returns' squares scaled to a minute. */
interface Sample extends Snapshot { n: number; rv: number; rn: number; source: 'ws' | 'rest' }
interface Minute { n: number; at: number; mid: number; bid: Float64Array; ask: Float64Array; cover: [number, number]; rv: number; rn: number }
interface Slot {
  name: string;
  samples: Sample[];
  /** The snapshots taken this minute, not yet a sample. */
  minute: Minute | null;
  /** The last snapshot a return was measured from. */
  anchor: { at: number; mid: number } | null;
  /** The feed's latest book of this market and when it arrived; `taken` is the arrival time of the last one used. */
  pushed: { book: OndoBook; at: number } | null;
  taken: number;
  latest: { at: number; mid: number; bid: number; ask: number; levels: { bid: OndoLevel[]; ask: OndoLevel[] }; depth5: { bid: number; ask: number }; cover: [number, number] } | null;
  error: string | null;
  fetchedAt: number;
  pending: Promise<void> | null;
  /** The read in flight was started by the page, and the cycle asked for a sample of it meanwhile. */
  record: boolean;
}

const text = (error: unknown): string => error instanceof OndoError ? `Ondo 接口出错（${error.code}）` : error instanceof Error ? error.message.slice(0, 160) : '未知错误';

export function validateRewardConfig(value: unknown): OndoRewardConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RewardInputError('奖励设置格式无效');
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter(key => !['markets', 'poolUsd', 'eligible'].includes(key));
  if (extra.length) throw new RewardInputError('奖励设置含有未知字段');
  const { markets, poolUsd, eligible } = raw;
  if (!Array.isArray(markets) || markets.length < 1 || markets.length > MAX_MARKETS || markets.some(item => typeof item !== 'string' || !ONDO_MARKET.test(item)) || new Set(markets).size !== markets.length) {
    throw new RewardInputError(`市场须为 1–${MAX_MARKETS} 个不重复的 Ondo 永续代码（如 NVDA-USD.P）`);
  }
  if (typeof poolUsd !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(poolUsd) || Number(poolUsd) <= 0) throw new RewardInputError('每周奖池须为大于 0 的美元数（最多两位小数）');
  if (typeof eligible !== 'number' || !Number.isInteger(eligible) || eligible < 1 || eligible > 100) throw new RewardInputError('参与分配的市场数须为 1–100 的整数');
  return { markets: [...markets] as string[], poolUsd, eligible };
}

/** Levels of one side as numbers, best first; a malformed level fails the whole snapshot. */
function side(raw: unknown): { price: string; size: string; p: number; q: number }[] {
  if (!Array.isArray(raw)) throw new OndoError('invalid_data');
  return raw.map(level => {
    if (!Array.isArray(level) || level.length < 2) throw new OndoError('invalid_data');
    const price = String(level[0]), size = String(level[1]), p = Number(price), q = Number(size);
    if (!/^\d+(?:\.\d+)?$/.test(price) || !/^\d+(?:\.\d+)?$/.test(size) || !(p > 0) || !(q >= 0)) throw new OndoError('invalid_data');
    return { price, size, p, q };
  });
}

/** A pushed book (exact units) as REST-shaped decimal strings, so both go through digest. */
export function bookDepth(market: string, book: OndoBook): OndoDepth {
  const rows = (levels: [bigint, bigint][]) => levels.map(([price, size]) => [formatDecimalUnits(price), formatDecimalUnits(size)]);
  return { market, bids: rows(book.bids), asks: rows(book.asks) } as OndoDepth;
}

/** One snapshot reduced to what the view keeps; `ours` is size per price on each side, taken out of the depth. */
export function digest(depth: OndoDepth, ours: { buy: Map<number, number>; sell: Map<number, number> }, at: number) {
  const bids = side(depth.bids), asks = side(depth.asks);
  if (!bids.length || !asks.length) throw new Error('盘口一侧为空');
  const best = { bid: bids[0].p, ask: asks[0].p };
  if (!(best.bid < best.ask)) throw new Error('盘口买一不低于卖一');
  const mid = (best.bid + best.ask) / 2;
  const pass = (levels: typeof bids, own: Map<number, number>, sign: 1 | -1) => {
    const buckets = new Float32Array(BUCKETS), shown: OndoLevel[] = [];
    let cum = 0, depth5 = 0, cover = 0;
    for (const level of levels) {
      const bps = sign * (mid - level.p) / mid * 1e4;
      cover = Math.max(cover, bps);
      const oursSize = Math.min(level.q, own.get(level.p) ?? 0), othersUsd = (level.q - oursSize) * level.p;
      if (bps < BUCKETS * BUCKET_BPS) buckets[Math.max(0, Math.floor(bps / BUCKET_BPS))] += othersUsd;
      if (bps <= LEVELS_BPS) {
        cum += othersUsd; depth5 += othersUsd;
        if (shown.length < MAX_LEVELS) shown.push({ price: level.price, size: level.size, usd: round(othersUsd), bps: round(bps), cumUsd: round(cum), oursUsd: round(oursSize * level.p) });
      }
    }
    // Ondo sends at most 100 levels a side, which on a dense book may still end short of 25 bps, so a short side is not
    // taken as whole: the farthest level seen is the cover, and a thin book is reported as such too.
    return { buckets, shown, depth5: round(depth5), cover };
  };
  const bid = pass(bids, ours.buy, 1), ask = pass(asks, ours.sell, -1);
  return {
    sample: { at, mid, bid: bid.buckets, ask: ask.buckets, cover: [bid.cover, ask.cover] as [number, number] },
    latest: { at, mid, bid: best.bid, ask: best.ask, levels: { bid: bid.shown, ask: ask.shown }, depth5: { bid: bid.depth5, ask: ask.depth5 }, cover: [bid.cover, ask.cover] as [number, number] },
  };
}

const round = (value: number): number => Math.round(value * 100) / 100;
// Never round a partial reward band up to a full one.
const coverOut = (value: number): number | null => Number.isFinite(value) ? Math.floor(Math.min(value, 25) * 100) / 100 : null;

/** σ of the mid's log returns scaled to one minute (zero mean) over the samples; null below MIN_RETURNS returns. */
export function minuteVolatility(samples: readonly { rv: number; rn: number }[]): { sigma1m: number | null; returns: number } {
  let sum = 0, count = 0;
  for (const sample of samples) { sum += sample.rv; count += sample.rn; }
  return { sigma1m: count >= MIN_RETURNS ? Math.sqrt(sum / count) : null, returns: count };
}

/** Adds one snapshot to the slot's minute, with the return from the last anchor when the gap is in range. */
function accumulate(target: Slot, snapshot: Snapshot): void {
  const minute = target.minute ??= { n: 0, at: 0, mid: 0, bid: new Float64Array(BUCKETS), ask: new Float64Array(BUCKETS), cover: [Infinity, Infinity], rv: 0, rn: 0 };
  minute.n += 1; minute.at = snapshot.at; minute.mid = snapshot.mid;
  for (let i = 0; i < BUCKETS; i++) { minute.bid[i] += snapshot.bid[i]; minute.ask[i] += snapshot.ask[i]; }
  minute.cover = [Math.min(minute.cover[0], snapshot.cover[0]), Math.min(minute.cover[1], snapshot.cover[1])];
  const anchor = target.anchor, gap = anchor ? snapshot.at - anchor.at : Infinity;
  if (gap < RETURN_GAP[0]) return;
  if (anchor && gap <= RETURN_GAP[1]) {
    const r = Math.log(snapshot.mid / anchor.mid);
    if (Number.isFinite(r)) { minute.rv += r * r * 60_000 / gap; minute.rn += 1; }
  }
  target.anchor = { at: snapshot.at, mid: snapshot.mid };
}

/** Closes the slot's minute into a sample. */
function flush(target: Slot, source: Sample['source']): void {
  const minute = target.minute;
  if (!minute) return;
  target.minute = null;
  const mean = (sums: Float64Array) => Float32Array.from(sums, value => value / minute.n);
  target.samples.push({ at: minute.at, mid: minute.mid, bid: mean(minute.bid), ask: mean(minute.ask), cover: minute.cover, n: minute.n, rv: minute.rv, rn: minute.rn, source });
  const oldest = minute.at - MAX_WINDOW_MIN * 60_000;
  while (target.samples.length && target.samples[0].at < oldest) target.samples.shift();
}

export interface OndoRewards {
  initialize(): void;
  config(): OndoRewardConfig;
  state(windowMin?: number): OndoRewardsView;
  save(input: unknown): OndoRewardsView;
  /** The latest levels of one market, read again over REST when older than 5 s. */
  book(market: string): Promise<OndoRewardMarket>;
  /** The sampling loop until stopped: a feed burst each minute, then REST for the markets it missed. */
  run(context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void>;
  close(): void;
}

export function createOndoRewards({ dataDir, restingOrders = () => [], clientFactory = () => createOndoClient({ rps: 2, timeoutMs: 5000 }), streamFactory = createOndoStream, now = Date.now, log = () => {} }: {
  dataDir: string;
  restingOrders?: () => OndoRestingOrder[];
  clientFactory?: () => OndoClient;
  /** The public depth feed (no credentials are passed). */
  streamFactory?: OndoStreamFactory;
  now?: () => number;
  log?: (line: string) => void;
}): OndoRewards {
  const directory = join(dataDir, 'ondo-mm'), file = join(directory, 'rewards.json');
  let config: OndoRewardConfig = structuredClone(REWARD_DEFAULTS) as OndoRewardConfig, revision = 0, loadError: string | null = null;
  let rules: Map<string, OndoRules> | null = null, rulesAt = 0, rulesError: string | null = null, rulesPending: Promise<void> | null = null;
  const slots = new Map<string, Slot>();
  const startedAt = now();
  let client: OndoClient | null = null, feed: OndoStream | null = null, closed = false;
  let lastBurst: { at: number; pushed: number; of: number; error: string | null } | null = null;

  // After close nothing opens a new client: a read that comes later fails at once instead of going out.
  const api = (): OndoClient => { if (closed) throw new OndoError('closed'); return client ??= clientFactory(); };
  const slot = (name: string): Slot => {
    let found = slots.get(name);
    if (!found) slots.set(name, found = { name, samples: [], minute: null, anchor: null, pushed: null, taken: 0, latest: null, error: null, fetchedAt: 0, pending: null, record: false });
    return found;
  };
  const sync = () => { for (const name of [...slots.keys()]) if (!config.markets.includes(name)) slots.delete(name); for (const name of config.markets) slot(name); };

  function ours(name: string) {
    const buy = new Map<number, number>(), sell = new Map<number, number>();
    for (const order of restingOrders()) {
      if (order.market !== name) continue;
      const book = order.side === 'buy' ? buy : sell, price = Number(order.price);
      book.set(price, (book.get(price) ?? 0) + Number(order.size));
    }
    return { buy, sell };
  }

  async function refreshRules(): Promise<void> {
    if (rulesPending) return rulesPending;
    rulesPending = (async () => {
      try { rules = await api().markets(); rulesError = null; }
      catch (error) { rulesError = `交易规则读取失败：${text(error)}`; }
      finally { rulesAt = now(); rulesPending = null; }
    })();
    return rulesPending;
  }

  /** Reads one market over REST; `record` makes it the minute's sample (the cycle), otherwise only the latest levels move. */
  function read(target: Slot, record: boolean): Promise<void> {
    if (target.pending) { if (record) target.record = true; return target.pending; }
    target.record = record;
    target.pending = (async () => {
      try {
        const depth = await api().depth(target.name, 100);
        const at = now(), sourceAt = typeof depth.time === 'number' ? depth.time : typeof depth.time === 'string' ? Date.parse(depth.time) : NaN;
        if (Number.isFinite(sourceAt) ? Math.abs(at - sourceAt) > FRESH_MS : target.record) throw new Error('交易所盘口时刻缺失或过期');
        const { sample, latest } = digest(depth, ours(target.name), at);
        target.latest = latest; target.error = null;
        // Only a slot still watched is sampled (the list may have changed while the read was out).
        if (target.record && slots.get(target.name) === target) { accumulate(target, sample); flush(target, 'rest'); }
      } catch (error) { target.error = `盘口读取失败：${text(error)}`; }
      finally { target.fetchedAt = now(); target.pending = null; target.record = false; }
    })();
    return target.pending;
  }

  /**
   * One feed burst: subscribes to `names` for BURST_MS and, once a TICK_MS, adds each market's newest book (if it came
   * after the last one taken and is still fresh) to the market's minute. Closes the feed, turns the minutes into samples
   * and returns the markets that got no snapshot.
   */
  async function burst(context: { pause(ms: number): Promise<void> }, names: string[], halted: () => boolean): Promise<string[]> {
    const start = now();
    let pushed = 0, error: string | null = null;
    // Ondo refuses the whole subscription when one market is unknown (an error frame, then nothing): only the markets the
    // trading rules list are asked for once the rules are in; the rest are read over REST like any market the feed missed.
    const listed = rules ? names.filter(name => rules!.has(name)) : names;
    const current = feed = streamFactory({ markets: listed, depth: FEED_LEVELS, now, onBook(market, book, at) {
      const target = slots.get(market);
      if (target && book && current === feed) target.pushed = { book, at };
    } });
    try {
      current.start();
      for (let tick = 1; tick * TICK_MS <= BURST_MS && !halted(); tick++) {
        await context.pause(Math.max(1, start + tick * TICK_MS - now()));
        if (halted()) break;
        for (const name of names) {
          const target = slots.get(name), book = target?.pushed;
          const at = now();
          if (!target || !book || book.at <= target.taken || book.at > at || at - book.at > PUSH_FRESH_MS
            || !Number.isFinite(book.book.time) || Math.abs(at - book.book.time) > PUSH_FRESH_MS) continue;
          target.taken = book.at;
          try {
            const { sample, latest } = digest(bookDepth(name, book.book), ours(name), book.at);
            target.latest = latest; target.error = null;
            accumulate(target, sample);
          } catch (failure) { target.error = `盘口推送无效：${text(failure)}`; }
        }
      }
      error = current.status().error;
    } finally {
      current.close();
      if (feed === current) feed = null;
    }
    // A burst cut short by a stop is not a minute: its snapshots are dropped (the latest levels stay).
    const whole = !halted(), missing: string[] = [];
    for (const name of names) {
      const target = slots.get(name);
      if (!target) continue;
      target.pushed = null;
      if (!whole) target.minute = null;
      else if (target.minute) { pushed += 1; flush(target, 'ws'); } else missing.push(name);
    }
    if (whole) lastBurst = { at: start, pushed, of: names.length, error };
    return missing;
  }

  function view(target: Slot, windowMin: number): OndoRewardMarket {
    const rule = rules?.get(target.name);
    const from = now() - windowMin * 60_000, window = target.samples.filter(sample => sample.at >= from);
    const average = (key: 'bid' | 'ask') => {
      const sum = new Array<number>(BUCKETS).fill(0);
      for (const sample of window) for (let i = 0; i < BUCKETS; i++) sum[i] += sample[key][i];
      return sum.map(value => window.length ? round(value / window.length) : 0);
    };
    const minCover = (index: 0 | 1) => window.length ? coverOut(Math.min(...window.map(sample => sample.cover[index]))) : null;
    const { sigma1m, returns } = minuteVolatility(window);
    const latest = target.latest, last = target.samples.at(-1);
    return {
      market: target.name,
      listed: rules ? rule !== undefined : null, trading: rule?.trading ?? null, tick: rule?.tick ?? null, makerFee: rule?.makerFee ?? null,
      at: latest?.at ?? null, mid: latest?.mid ?? null, bid: latest?.bid ?? null, ask: latest?.ask ?? null,
      spreadBps: latest ? round((latest.ask - latest.bid) / latest.mid * 1e4) : null,
      levels: latest?.levels ?? null, depth5: latest?.depth5 ?? null,
      cover: { bid: latest ? coverOut(latest.cover[0]) : null, ask: latest ? coverOut(latest.cover[1]) : null },
      avg: { samples: window.length, snapshots: window.reduce((sum, sample) => sum + sample.n, 0), from: window[0]?.at ?? null, to: window.at(-1)?.at ?? null,
        bid: average('bid'), ask: average('ask'), cover: { bid: minCover(0), ask: minCover(1) } },
      sigma1m, returns, source: last?.source ?? null, error: target.error,
    };
  }

  const windowOf = (value: number | undefined) => value !== undefined && Number.isInteger(value) && value >= 5 && value <= MAX_WINDOW_MIN ? value : 60;

  function state(windowMin?: number): OndoRewardsView {
    const minutes = windowOf(windowMin);
    return {
      schema: 1, serverNow: now(), config: structuredClone(config), revision, windowMin: minutes, maxWindowMin: MAX_WINDOW_MIN, cycleMs: CYCLE_MS, burstMs: BURST_MS,
      minReturns: MIN_RETURNS, feed: lastBurst ? { ...lastBurst } : null, startedAt, rulesError, loadError, markets: config.markets.map(name => view(slot(name), minutes)),
    };
  }

  return {
    initialize() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        const raw = readFileSync(file, 'utf8');
        if (raw.length > 64 * 1024) throw new Error('too large');
        const saved = JSON.parse(raw) as { revision?: unknown; config?: unknown };
        config = validateRewardConfig(saved.config); revision = Number.isSafeInteger(saved.revision) ? saved.revision as number : 0;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { loadError = '已保存的奖励设置无法读取，已用默认值，保存后生效'; log(`Ondo 奖励设置读取失败：${text(error)}`); }
      }
      sync();
    },
    config: () => structuredClone(config),
    state,
    save(input) {
      const next = validateRewardConfig(input);
      try {
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ revision: revision + 1, config: next }, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, file);
      } catch (error) {
        log(`Ondo 奖励设置写入失败：${text(error)}`);
        throw Object.assign(new Error('奖励设置无法保存，请恢复存储后重试'), { status: 503 });
      }
      config = next; revision += 1; loadError = null; sync();
      return state();
    },
    async book(market) {
      if (!config.markets.includes(market)) throw new RewardInputError('不在观察列表里的市场');
      const target = slot(market);
      // At most one read per market every BOOK_GAP_MS, however many pages ask.
      if (now() - (target.latest?.at ?? 0) > FRESH_MS && now() - target.fetchedAt > BOOK_GAP_MS) await read(target, false);
      else if (target.pending) await target.pending;
      return view(target, 60);
    },
    async run(context) {
      const halted = () => context.stopped() || closed;
      while (!halted()) {
        const started = now();
        if (!rules || now() - rulesAt > RULES_MS) await refreshRules();
        if (halted()) break;
        const names = [...config.markets];
        const missing = await burst(context, names, halted);
        // The markets the feed did not deliver this minute, over REST one after another (the client keeps to 2 a second),
        // as long as the minute lasts.
        for (const name of missing) {
          if (halted() || now() - started > CYCLE_MS - BOOK_GAP_MS) break;
          const target = slots.get(name);
          if (target) await read(target, true);
        }
        if (halted()) break;
        await context.pause(Math.max(250, CYCLE_MS - Math.max(0, now() - started)));
      }
    },
    close() { closed = true; feed?.close(); feed = null; client?.close(); client = null; },
  };
}
