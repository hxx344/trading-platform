// The reward-market collector (docs/ondo.md §5): reads each watched market's public depth once a cycle, keeps the latest
// levels within 5 bps of the mid, and a ring of minute samples (mid and USD per 0.5 bps bucket out to 25 bps) for the
// averages and the volatility the page's simulation needs. Our own resting quotes (the quoting module's) are taken out,
// so the depth is what we compete with. Samples live in memory: a restart starts the averages over.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOndoClient, ONDO_MARKET, OndoError, type OndoClient, type OndoDepth, type OndoRules } from '../vendor/ondo/client.mjs';
import type { OndoRestingOrder } from '../vendor/ondo/mm.mjs';
import { BUCKET_BPS, BUCKETS, type OndoLevel, type OndoRewardConfig, type OndoRewardMarket, type OndoRewardsView } from './reward-types.ts';

/** The markets Ondo's reward rules list (docs/ondo.md §5). */
export const REWARD_MARKETS = ['US500', 'US100', 'DRAM', 'SOXL', 'MU', 'TSLA', 'NVDA', 'SPCX', 'INTC', 'META', 'AMD', 'COIN', 'MSTR', 'SNDK', 'CRCL', 'XAU', 'XAG', 'WTI', 'BTC', 'ETH'].map(name => `${name}-USD.P`);
export const REWARD_DEFAULTS: Readonly<OndoRewardConfig> = Object.freeze({ markets: REWARD_MARKETS, poolUsd: '125000', eligible: 20 });
export const CYCLE_MS = 60_000;
export const MAX_WINDOW_MIN = 360;
export const MIN_RETURNS = 10;
const RULES_MS = 15 * 60_000, LEVELS_BPS = 5, MAX_LEVELS = 40, FRESH_MS = 5000, BOOK_GAP_MS = 2000, MAX_MARKETS = 40;
// A return counts only between samples 30–120 s apart (a missed read must not pass a two-minute move as one minute).
const RETURN_GAP = [30_000, 120_000] as const;

export class RewardInputError extends Error { status = 400; }

interface Sample { at: number; mid: number; bid: Float32Array; ask: Float32Array; cover: [number, number] }
interface Slot {
  name: string;
  samples: Sample[];
  latest: { at: number; mid: number; bid: number; ask: number; levels: { bid: OndoLevel[]; ask: OndoLevel[] }; depth5: { bid: number; ask: number }; cover: [number, number] } | null;
  error: string | null;
  fetchedAt: number;
  pending: Promise<void> | null;
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
    // Fewer than 100 levels means the venue sent the whole side: everything out to 25 bps is known.
    return { buckets, shown, depth5: round(depth5), cover: levels.length < 100 ? Infinity : cover };
  };
  const bid = pass(bids, ours.buy, 1), ask = pass(asks, ours.sell, -1);
  return {
    sample: { at, mid, bid: bid.buckets, ask: ask.buckets, cover: [bid.cover, ask.cover] as [number, number] },
    latest: { at, mid, bid: best.bid, ask: best.ask, levels: { bid: bid.shown, ask: ask.shown }, depth5: { bid: bid.depth5, ask: ask.depth5 }, cover: [bid.cover, ask.cover] as [number, number] },
  };
}

const round = (value: number): number => Math.round(value * 100) / 100;
const coverOut = (value: number): number | null => value === Infinity ? 25 : Number.isFinite(value) ? round(Math.min(value, 25)) : null;

/** σ of one-minute log returns (zero mean), each return scaled to one minute by its gap; null below MIN_RETURNS. */
export function minuteVolatility(samples: readonly { at: number; mid: number }[]): { sigma1m: number | null; returns: number } {
  let sum = 0, count = 0;
  for (let i = 1; i < samples.length; i++) {
    const gap = samples[i].at - samples[i - 1].at;
    if (gap < RETURN_GAP[0] || gap > RETURN_GAP[1]) continue;
    const r = Math.log(samples[i].mid / samples[i - 1].mid) / Math.sqrt(gap / 60_000);
    if (Number.isFinite(r)) { sum += r * r; count += 1; }
  }
  return { sigma1m: count >= MIN_RETURNS ? Math.sqrt(sum / count) : null, returns: count };
}

export interface OndoRewards {
  initialize(): void;
  state(windowMin?: number): OndoRewardsView;
  save(input: unknown): OndoRewardsView;
  /** The latest levels of one market, read again when older than 5 s. */
  book(market: string): Promise<OndoRewardMarket>;
  /** The sampling loop until stopped. */
  run(context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void>;
  close(): void;
}

export function createOndoRewards({ dataDir, restingOrders = () => [], clientFactory = () => createOndoClient({ rps: 2, timeoutMs: 5000 }), now = Date.now, log = () => {} }: {
  dataDir: string;
  restingOrders?: () => OndoRestingOrder[];
  clientFactory?: () => OndoClient;
  now?: () => number;
  log?: (line: string) => void;
}): OndoRewards {
  const directory = join(dataDir, 'ondo-mm'), file = join(directory, 'rewards.json');
  let config: OndoRewardConfig = structuredClone(REWARD_DEFAULTS) as OndoRewardConfig, revision = 0, loadError: string | null = null;
  let rules: Map<string, OndoRules> | null = null, rulesAt = 0, rulesError: string | null = null, rulesPending: Promise<void> | null = null;
  const slots = new Map<string, Slot>();
  const startedAt = now();
  let client: OndoClient | null = null, cursor = 0;

  const api = () => client ??= clientFactory();
  const slot = (name: string): Slot => {
    let found = slots.get(name);
    if (!found) slots.set(name, found = { name, samples: [], latest: null, error: null, fetchedAt: 0, pending: null });
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

  /** Reads one market; `record` adds a minute sample (the cycle), otherwise only the latest levels move. */
  function read(target: Slot, record: boolean): Promise<void> {
    if (target.pending) return target.pending;
    target.pending = (async () => {
      try {
        const depth = await api().depth(target.name, 100);
        const at = now(), { sample, latest } = digest(depth, ours(target.name), at);
        target.latest = latest; target.error = null;
        if (record) {
          target.samples.push(sample);
          const oldest = at - MAX_WINDOW_MIN * 60_000;
          while (target.samples.length && target.samples[0].at < oldest) target.samples.shift();
        }
      } catch (error) { target.error = `盘口读取失败：${text(error)}`; }
      finally { target.fetchedAt = now(); target.pending = null; }
    })();
    return target.pending;
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
    const latest = target.latest;
    return {
      market: target.name,
      listed: rules ? rule !== undefined : null, trading: rule?.trading ?? null, tick: rule?.tick ?? null, makerFee: rule?.makerFee ?? null,
      at: latest?.at ?? null, mid: latest?.mid ?? null, bid: latest?.bid ?? null, ask: latest?.ask ?? null,
      spreadBps: latest ? round((latest.ask - latest.bid) / latest.mid * 1e4) : null,
      levels: latest?.levels ?? null, depth5: latest?.depth5 ?? null,
      cover: { bid: latest ? coverOut(latest.cover[0]) : null, ask: latest ? coverOut(latest.cover[1]) : null },
      avg: { samples: window.length, from: window[0]?.at ?? null, bid: average('bid'), ask: average('ask'), cover: { bid: minCover(0), ask: minCover(1) } },
      sigma1m, returns, error: target.error,
    };
  }

  const windowOf = (value: number | undefined) => value !== undefined && Number.isInteger(value) && value >= 5 && value <= MAX_WINDOW_MIN ? value : 60;

  function state(windowMin?: number): OndoRewardsView {
    const minutes = windowOf(windowMin);
    return {
      schema: 1, serverNow: now(), config: structuredClone(config), revision, windowMin: minutes, maxWindowMin: MAX_WINDOW_MIN, cycleMs: CYCLE_MS,
      startedAt, rulesError, loadError, markets: config.markets.map(name => view(slot(name), minutes)),
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
      while (!context.stopped()) {
        if (!rules || now() - rulesAt > RULES_MS) await refreshRules();
        const names = config.markets;
        if (names.length) {
          const name = names[cursor % names.length];
          cursor = (cursor + 1) % names.length;
          await read(slot(name), true);
        }
        // Spread the cycle over the markets so the reads go out one at a time.
        await context.pause(Math.max(1000, Math.floor(CYCLE_MS / Math.max(1, names.length))));
      }
    },
    close() { client?.close(); client = null; },
  };
}
