// DEX 价差子模块「Binance & 多参考源领先测速」纯算法、目录解析与多源匹配、参数校验（R2）：
// - 支持最多 7 个免 Key 领先参考源（Binance 合约/现货/股票、Hyperliquid xyz、Coinbase 现货、OKX/Bybit 永续）与 3 个 DEX 目标场所；
// - 使用同机单调时钟（monoMs）判定同门槛跃动跟随与 100ms 网格 500ms 收益率互相关；
// - 提供常驻 30 分钟有界滑动窗口（LeadTracker）及稀疏网格变化点 / 已结算事件落盘回调，并与离线 Worker 共用统计学纯函数。
import { kindOf, LEG_SYMBOL, SYMBOL_ALIASES, type MarketSpec } from './model.ts';
import { ParamsError } from './strategy.ts';
import type {
  LeadAssetCategory,
  LeadCandidateView,
  LeadEventVenueView,
  LeadFollowStatus,
  LeadRefCatalogEntry,
  LeadRefSource,
  LeadSource,
  LeadStreamView,
  LeadVenue,
  LeadVenueStatsView,
  LeadWatcherConfig,
  LeadWatcherRecentRow,
  LeadWatcherView,
  LeadXcorrPoint,
  LeadXcorrView,
} from './views.ts';

export const LEAD_REF_SOURCES: readonly LeadRefSource[] = [
  'binance_perp',
  'binance_spot',
  'binance_equity',
  'hl_xyz',
  'coinbase_spot',
  'okx_perp',
  'bybit_perp',
];
export const LEAD_VENUES: readonly LeadVenue[] = ['lighter', 'rh', 'entropy'];
export const LEAD_SOURCES: readonly LeadSource[] = [...LEAD_REF_SOURCES, ...LEAD_VENUES];

export const LEAD_REF_NAMES: Record<LeadRefSource, string> = {
  binance_perp: 'Binance 合约',
  binance_spot: 'Binance 现货',
  binance_equity: 'Binance 股票',
  hl_xyz: 'Hyperliquid xyz',
  coinbase_spot: 'Coinbase 现货',
  okx_perp: 'OKX 永续',
  bybit_perp: 'Bybit 永续',
};
export const LEAD_VENUE_NAMES: Record<LeadVenue, string> = {
  lighter: 'Lighter 主网',
  rh: 'Lighter RH',
  entropy: 'Entropy',
};
export const LEAD_SOURCE_NAMES: Record<LeadSource, string> = {
  ...LEAD_REF_NAMES,
  ...LEAD_VENUE_NAMES,
};

export const LEAD_SOURCE_CODES: Record<LeadSource, number> = {
  binance_perp: 0,
  binance_spot: 1,
  binance_equity: 2,
  hl_xyz: 3,
  coinbase_spot: 4,
  okx_perp: 5,
  bybit_perp: 6,
  lighter: 7,
  rh: 8,
  entropy: 9,
};
export const LEAD_CODE_TO_SOURCE: Record<number, LeadSource> = Object.fromEntries(
  Object.entries(LEAD_SOURCE_CODES).map(([source, code]) => [code, source as LeadSource]),
);

export const LEAD_MAX_WATCHERS = 3;
export const LEAD_RETENTION_DAYS = 7;
export const LEAD_RECENT_WINDOW_MS = 30 * 60_000;
export const LEAD_XCORR_MAX_WINDOW_MS = 6 * 3_600_000;
export const LEAD_GRID_ANCHOR_MS = 30_000;

export const DEFAULT_LEAD_WATCHER_PARAMS: Omit<LeadWatcherConfig, 'symbol' | 'leads' | 'targets'> = {
  thresholdBps: 3,
  impulseWindowMs: 1_000,
  followRatio: 0.5,
  maxWaitMs: 10_000,
  cooldownMs: 2_000,
};

export const LEAD_LIMITS = {
  thresholdBps: [0.5, 500] as const,
  impulseWindowMs: [100, 10_000] as const,
  followRatio: [0.2, 1.0] as const,
  maxWaitMs: [1_000, 30_000] as const,
  cooldownMs: [500, 30_000] as const,
};

export const LEAD_GRID_STEP_MS = 100;
export const LEAD_RETURN_HORIZON_STEPS = 5; // 500 ms
export const LEAD_XCORR_MIN_LAG_MS = -1_000;
export const LEAD_XCORR_MAX_LAG_MS = 3_000;
export const LEAD_XCORR_MIN_SAMPLES = 50;
export const LEAD_PRE_WINDOW_MS = 1_500;
export const LEAD_BASE_STALE_MS = 60_000;
export const LEAD_BASIS_MAX_GAP_PCT = 0.05;
export const LEAD_SERIES_POINTS_MAX = 300;
export const LEAD_MAX_EVENTS_VIEW = 100;
const LEAD_GRID_ANCHOR_STEPS = LEAD_GRID_ANCHOR_MS / LEAD_GRID_STEP_MS;
const MAX_TICKS_PER_STREAM = 8_000;
const MAX_RECENT_SETTLED = 2_000;

export interface QuoteTick {
  monoMs: number;
  wallMs: number;
  bid: number;
  ask: number;
  mid: number;
  exchangeMs: number | null;
}

export interface PersistLeadEvent {
  symbol: string;
  runId: number;
  leadSource: LeadRefSource;
  at: number;
  direction: 1 | -1;
  baseMid: number;
  triggerMid: number;
  moveBps: number;
  thresholdBps: number;
  followBps: number;
  venues: Partial<Record<LeadVenue, LeadEventVenueView>>;
}

export interface PersistLeadGrid {
  symbol: string;
  at: number;
  source: LeadSource;
  runId: number;
  gridIdx: number;
  segId: number;
  mid: number | null;
}

export interface LeadAnalyzeRequest {
  symbol: string;
  leadSource: LeadRefSource | null;
  from: number;
  to: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class LeadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (message: string): never => {
  throw new ParamsError(message);
};

function readNumber(value: unknown, min: number, max: number, name: string, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`${name}须为 ${min} 到 ${max} 之间的${integer ? '整数' : '数'}`);
  }
  return value as number;
}

export const WATCHER_SYMBOL_RE = /^[A-Z0-9._-]{1,24}$/;
export const LEAD_REF_SYMBOL_RE = /^[A-Za-z0-9:._-]{1,36}$/;
const STABLE_QUOTES = new Set(['USDT', 'USDC']);

export function normalizeLeadRefSymbol(source: LeadRefSource, raw: string): string {
  const trimmed = raw.trim();
  return source === 'hl_xyz' ? trimmed : trimmed.toUpperCase();
}

/** 校验并规整常驻测速标的（支持 7 Lead 源与 3 DEX 目标，无持续时长上限）。 */
export function readLeadWatcherConfig(raw: unknown): LeadWatcherConfig {
  if (!isObject(raw)) return fail('测速参数须为对象');
  const allowed = ['symbol', 'leads', 'targets', 'thresholdBps', 'impulseWindowMs', 'followRatio', 'maxWaitMs', 'cooldownMs'];
  const unknown = Object.keys(raw).find(key => !allowed.includes(key));
  if (unknown) return fail(`测速参数包含未知字段 ${unknown.slice(0, 40)}`);

  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
  if (!WATCHER_SYMBOL_RE.test(symbol)) return fail('基础标的代码无效（应为 1–24 位大写字母或数字，如 NVDA、BTC）');

  if (!isObject(raw.leads)) return fail('参考领先源映射无效');
  const unknownLead = Object.keys(raw.leads).find(key => !(LEAD_REF_SOURCES as readonly string[]).includes(key));
  if (unknownLead) return fail(`包含不支持的领先源 ${unknownLead.slice(0, 24)}`);

  const leads: Partial<Record<LeadRefSource, string>> = {};
  for (const src of LEAD_REF_SOURCES) {
    const val = raw.leads[src];
    if (val === undefined || val === null) continue;
    if (typeof val !== 'string') return fail(`${LEAD_REF_NAMES[src]} 代码须为文本`);
    const trimmed = val.trim();
    if (!trimmed) continue;
    if (!LEAD_REF_SYMBOL_RE.test(trimmed)) return fail(`${LEAD_REF_NAMES[src]} 代码格式无效`);
    leads[src] = normalizeLeadRefSymbol(src, trimmed);
  }
  if (!Object.keys(leads).length) return fail('至少选择一个参考领先源并填写标的代码');

  if (!isObject(raw.targets)) return fail('目标 DEX 场所映射无效');
  const unknownVenue = Object.keys(raw.targets).find(key => !(LEAD_VENUES as readonly string[]).includes(key));
  if (unknownVenue) return fail(`包含不支持的目标场所 ${unknownVenue.slice(0, 24)}`);

  const targets: Partial<Record<LeadVenue, string>> = {};
  for (const venue of LEAD_VENUES) {
    const val = raw.targets[venue];
    if (val === undefined || val === null) continue;
    if (typeof val !== 'string') return fail(`${LEAD_VENUE_NAMES[venue]} 代码须为文本`);
    const trimmed = val.trim();
    if (!trimmed) continue;
    if (!LEG_SYMBOL.test(trimmed)) return fail(`${LEAD_VENUE_NAMES[venue]} 代码无效`);
    targets[venue] = trimmed;
  }
  if (!Object.keys(targets).length) return fail('至少选择一个目标 DEX 场所并填写标的代码');

  const pick = <K extends keyof typeof DEFAULT_LEAD_WATCHER_PARAMS>(key: K) =>
    raw[key] === undefined ? DEFAULT_LEAD_WATCHER_PARAMS[key] : raw[key];

  return {
    symbol,
    leads,
    targets,
    thresholdBps: readNumber(pick('thresholdBps'), ...LEAD_LIMITS.thresholdBps, '触发阈值（基点）', false),
    impulseWindowMs: readNumber(pick('impulseWindowMs'), ...LEAD_LIMITS.impulseWindowMs, '变化窗口（毫秒）', true),
    followRatio: readNumber(pick('followRatio'), ...LEAD_LIMITS.followRatio, '跟进判定比例', false),
    maxWaitMs: readNumber(pick('maxWaitMs'), ...LEAD_LIMITS.maxWaitMs, '最大等待时间（毫秒）', true),
    cooldownMs: readNumber(pick('cooldownMs'), ...LEAD_LIMITS.cooldownMs, '事件冷却时间（毫秒）', true),
  };
}

/** 校验离线分析请求 `{ symbol, leadSource?, hours?, from?, to? }`（跨度 1 分钟 – 7 天）。 */
export function readLeadAnalyzeRequest(raw: unknown, nowMs: number): LeadAnalyzeRequest {
  if (!isObject(raw)) return fail('分析查询参数须为对象');
  const allowed = ['symbol', 'leadSource', 'hours', 'from', 'to'];
  const unknown = Object.keys(raw).find(key => !allowed.includes(key));
  if (unknown) return fail(`分析查询包含未知字段 ${unknown.slice(0, 40)}`);

  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
  if (!WATCHER_SYMBOL_RE.test(symbol)) return fail('分析标的代码无效');

  let leadSource: LeadRefSource | null = null;
  if (raw.leadSource !== undefined && raw.leadSource !== null && raw.leadSource !== '') {
    if (typeof raw.leadSource !== 'string' || !(LEAD_REF_SOURCES as readonly string[]).includes(raw.leadSource)) {
      return fail('指定的主参考领先源无效');
    }
    leadSource = raw.leadSource as LeadRefSource;
  }

  const maxSpan = LEAD_RETENTION_DAYS * 86_400_000;
  let from: number;
  let to: number;
  if (raw.from !== undefined || raw.to !== undefined) {
    if (typeof raw.from !== 'number' || typeof raw.to !== 'number' || !Number.isFinite(raw.from) || !Number.isFinite(raw.to)) {
      return fail('起止时间戳须为有效毫秒数');
    }
    from = Math.floor(raw.from);
    to = Math.floor(raw.to);
    if (from < 0 || to <= from || to - from < 60_000 || to - from > maxSpan) {
      return fail(`查询时间跨度须在 1 分钟到 ${LEAD_RETENTION_DAYS} 天之间`);
    }
  } else {
    const hours = raw.hours === undefined ? 6 : readNumber(raw.hours, 1, LEAD_RETENTION_DAYS * 24, '查询小时数', false);
    to = nowMs;
    from = Math.max(0, Math.round(to - hours * 3_600_000));
  }
  return { symbol, leadSource, from, to };
}

/** 校验 watcher 停启/删除的请求体 `{ symbol, enabled?, updatedAt }`。 */
export function readLeadWatcherMutation(raw: unknown, requireEnabled: boolean): { symbol: string; enabled: boolean; updatedAt: number } {
  if (!isObject(raw)) return fail('请求格式须为对象');
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
  if (!WATCHER_SYMBOL_RE.test(symbol)) return fail('标的代码无效');
  if (typeof raw.updatedAt !== 'number' || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0) {
    return fail('缺少有效的状态版本号 updatedAt');
  }
  let enabled = false;
  if (requireEnabled) {
    if (typeof raw.enabled !== 'boolean') return fail('缺少有效的启停标识 enabled');
    enabled = raw.enabled;
  }
  return { symbol, enabled, updatedAt: raw.updatedAt };
}

// ---- 多领先源公开目录解析 ----

/** Binance USDⓈ-M 永续 `GET /fapi/v1/exchangeInfo`。 */
export function parseBinanceExchangeInfo(raw: unknown): LeadRefCatalogEntry[] {
  if (!isObject(raw) || !Array.isArray(raw.symbols)) throw new Error('Binance 合约目录格式无效');
  const seen = new Map<string, LeadRefCatalogEntry>();
  for (const item of raw.symbols) {
    if (!isObject(item)) continue;
    if (item.status !== 'TRADING') continue;
    if (item.contractType !== 'PERPETUAL' && item.contractType !== 'TRADIFI_PERPETUAL') continue;
    const quoteAsset = typeof item.quoteAsset === 'string' ? item.quoteAsset.toUpperCase() : '';
    const marginAsset = typeof item.marginAsset === 'string' ? item.marginAsset.toUpperCase() : '';
    if (!STABLE_QUOTES.has(quoteAsset) || marginAsset !== quoteAsset) continue;
    const symbol = typeof item.symbol === 'string' ? item.symbol.trim().toUpperCase() : '';
    const baseAsset = typeof item.baseAsset === 'string' ? item.baseAsset.trim().toUpperCase() : '';
    if (!symbol || !baseAsset || !LEAD_REF_SYMBOL_RE.test(symbol) || !WATCHER_SYMBOL_RE.test(baseAsset)) continue;
    seen.set(symbol, { symbol, baseAsset, quoteAsset, contractType: item.contractType });
  }
  return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Binance 现货免 Key 轻量盘口快照 `GET /api/v3/ticker/bookTicker`。 */
export function parseBinanceSpotTickers(raw: unknown): LeadRefCatalogEntry[] {
  if (!Array.isArray(raw)) throw new Error('Binance 现货目录格式无效');
  const seen = new Map<string, LeadRefCatalogEntry>();
  for (const item of raw) {
    if (!isObject(item)) continue;
    const symbol = typeof item.symbol === 'string' ? item.symbol.trim().toUpperCase() : '';
    if (!symbol || !/^[A-Z0-9]{4,32}$/.test(symbol)) continue;
    const bid = Number(item.bidPrice), ask = Number(item.askPrice);
    if (!(bid > 0 && ask >= bid)) continue;
    const quoteAsset = symbol.endsWith('USDT') ? 'USDT' : symbol.endsWith('USDC') ? 'USDC' : '';
    if (!quoteAsset) continue;
    const baseAsset = symbol.slice(0, -quoteAsset.length);
    if (!WATCHER_SYMBOL_RE.test(baseAsset)) continue;
    seen.set(symbol, { symbol, baseAsset, quoteAsset });
  }
  return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Hyperliquid `dex: 'xyz'` `POST /info {"type":"metaAndAssetCtxs","dex":"xyz"}`。 */
export function parseHyperliquidXyzCatalog(raw: unknown): LeadRefCatalogEntry[] {
  if (!Array.isArray(raw) || !isObject(raw[0]) || !Array.isArray(raw[0].universe)) {
    throw new Error('Hyperliquid xyz 目录格式无效');
  }
  const seen = new Map<string, LeadRefCatalogEntry>();
  for (const item of raw[0].universe) {
    if (!isObject(item) || typeof item.name !== 'string') continue;
    if (item.isDelisted === true) continue;
    const rawName = item.name.trim();
    if (!rawName || !LEAD_REF_SYMBOL_RE.test(rawName)) continue;
    const coin = rawName.includes(':') ? rawName : `xyz:${rawName}`;
    const baseAsset = coin.split(':').at(-1)!.toUpperCase();
    if (!WATCHER_SYMBOL_RE.test(baseAsset)) continue;
    seen.set(coin, { symbol: coin, baseAsset, quoteAsset: 'USDC', contractType: 'HIP3' });
  }
  return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** OKX 永续 `GET /api/v5/public/instruments?instType=SWAP`。 */
export function parseOkxSwapCatalog(raw: unknown): LeadRefCatalogEntry[] {
  if (!isObject(raw) || !Array.isArray(raw.data)) throw new Error('OKX 永续目录格式无效');
  const seen = new Map<string, LeadRefCatalogEntry>();
  for (const item of raw.data) {
    if (!isObject(item)) continue;
    if (item.instType !== 'SWAP' || item.state !== 'live') continue;
    const settle = typeof item.settleCcy === 'string' ? item.settleCcy.toUpperCase() : '';
    if (!STABLE_QUOTES.has(settle)) continue;
    const instId = typeof item.instId === 'string' ? item.instId.trim().toUpperCase() : '';
    const baseAsset = instId.split('-')[0] ?? '';
    if (!instId || !WATCHER_SYMBOL_RE.test(baseAsset) || !LEAD_REF_SYMBOL_RE.test(instId)) continue;
    seen.set(instId, { symbol: instId, baseAsset, quoteAsset: settle, contractType: 'SWAP' });
  }
  return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Bybit 线型永续 `GET /v5/market/instruments-info?category=linear&limit=1000`。 */
export function parseBybitLinearCatalog(raw: unknown): LeadRefCatalogEntry[] {
  if (!isObject(raw) || !isObject(raw.result) || !Array.isArray(raw.result.list)) {
    throw new Error('Bybit 永续目录格式无效');
  }
  const seen = new Map<string, LeadRefCatalogEntry>();
  for (const item of raw.result.list) {
    if (!isObject(item)) continue;
    if (item.status !== 'Trading' || item.contractType !== 'LinearPerpetual') continue;
    const quoteAsset = typeof item.quoteCoin === 'string' ? item.quoteCoin.toUpperCase() : '';
    if (!STABLE_QUOTES.has(quoteAsset)) continue;
    const symbol = typeof item.symbol === 'string' ? item.symbol.trim().toUpperCase() : '';
    const baseAsset = typeof item.baseCoin === 'string' ? item.baseCoin.trim().toUpperCase() : '';
    if (!symbol || !WATCHER_SYMBOL_RE.test(baseAsset) || !LEAD_REF_SYMBOL_RE.test(symbol)) continue;
    seen.set(symbol, { symbol, baseAsset, quoteAsset, contractType: 'LinearPerpetual' });
  }
  return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Coinbase 美元现货 `GET /products`。 */
export function parseCoinbaseSpotCatalog(raw: unknown): LeadRefCatalogEntry[] {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.products) ? raw.products : null;
  if (!list) throw new Error('Coinbase 现货目录格式无效');
  const seen = new Map<string, LeadRefCatalogEntry>();
  for (const item of list) {
    if (!isObject(item)) continue;
    if (item.trading_disabled === true || item.cancel_only === true) continue;
    if (typeof item.status === 'string' && item.status !== 'online') continue;
    const quoteAsset = String(item.quote_currency ?? item.quote_currency_id ?? '').toUpperCase();
    if (quoteAsset !== 'USD' && quoteAsset !== 'USDC') continue;
    const baseAsset = String(item.base_currency ?? item.base_currency_id ?? '').trim().toUpperCase();
    const id = String(item.id ?? item.product_id ?? '').trim().toUpperCase();
    if (!id || !WATCHER_SYMBOL_RE.test(baseAsset) || !LEAD_REF_SYMBOL_RE.test(id)) continue;
    // 优先 USD 计价，不覆盖已有的 -USD
    const existing = seen.get(baseAsset);
    if (!existing || (existing.quoteAsset !== 'USD' && quoteAsset === 'USD')) {
      seen.set(baseAsset, { symbol: id, baseAsset, quoteAsset });
    }
  }
  return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// ---- 别名组、候选构建与标的归类 ----

export const LEAD_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ...SYMBOL_ALIASES,
  ['ANT', 'ANTHROPIC', 'ANTH'],
  ['OPENAI', 'OAI'],
  ['XAU', 'GOLD'],
  ['XAG', 'SILVER'],
];

function aliasCandidates(base: string): string[] {
  const candidates = [base];
  for (const group of LEAD_ALIAS_GROUPS) {
    if (group.includes(base)) {
      for (const alias of group) if (!candidates.includes(alias)) candidates.push(alias);
    }
  }
  return candidates;
}

function canonicalBase(rawBase: string): string {
  const upper = rawBase.toUpperCase();
  const plain = upper.startsWith('1000') && upper.length > 4 ? upper.slice(4) : upper;
  for (const group of LEAD_ALIAS_GROUPS) {
    if (group.includes(plain)) {
      // 同组中用优先主标识去重（如 ANTHROPIC/ANTH 归于组首或常见名）
      if (group[0] === 'ANT' || group[0] === 'ANTHROPIC') return 'ANTHROPIC';
      if (group[0] === 'OPENAI') return 'OPENAI';
      if (group[0] === 'XAU') return 'XAU';
      if (group[0] === 'XAG') return 'XAG';
      return group[0]!;
    }
  }
  return plain;
}

function lookupWithVariants(base: string, map: ReadonlyMap<string, string>): string | undefined {
  const exact = map.get(base);
  if (exact) return exact;
  for (const alias of aliasCandidates(base)) {
    const hit = map.get(alias);
    if (hit) return hit;
  }
  const scaled = base.startsWith('1000') && base.length > 4 ? base.slice(4) : `1000${base}`;
  return map.get(scaled);
}

function indexRefCatalog(entries: readonly LeadRefCatalogEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  // 优先保留 USDT / USD 计价，再备选 USDC
  for (const item of entries) {
    const base = item.baseAsset.toUpperCase();
    const existing = map.get(base);
    if (!existing || (item.quoteAsset === 'USDT' || item.quoteAsset === 'USD')) {
      map.set(base, item.symbol);
    }
  }
  return map;
}

function classifyLeadAsset(base: string, perpType?: string): LeadAssetCategory {
  const raw = kindOf(base);
  const alt = base.startsWith('1000') && base.length > 4 ? kindOf(base.slice(4)) : kindOf(`1000${base}`);
  const k = raw !== 'other' ? raw : alt;
  if (k === 'equity' || k === 'etf') return 'us_equity';
  if (k === 'crypto') return 'crypto';
  if (k === 'metal' || k === 'commodity' || perpType === 'TRADIFI_PERPETUAL') return 'tradfi';
  return 'other';
}

/**
 * 构建支持 7 个 Lead 源 + 3 个 DEX 目标的候选清单：
 * 以 DEX 已上架市场为主锚，为每个标的一次配齐多条领先通道与目标 DEX。
 */
export function buildLeadCandidates(
  contracts: Record<LeadRefSource, readonly LeadRefCatalogEntry[]>,
  dexMarkets: Record<LeadVenue, readonly MarketSpec[]>,
): LeadCandidateView[] {
  const dexMaps: Record<LeadVenue, Map<string, string>> = {
    lighter: new Map(),
    rh: new Map(),
    entropy: new Map(),
  };
  const allBases = new Map<string, string>();

  for (const venue of LEAD_VENUES) {
    for (const m of dexMarkets[venue] ?? []) {
      const upper = m.symbol.toUpperCase();
      if (!dexMaps[venue].has(upper)) dexMaps[venue].set(upper, m.symbol);
      const canon = canonicalBase(upper);
      const prev = allBases.get(canon);
      if (!prev || (upper.startsWith('1000') && !prev.startsWith('1000'))) {
        allBases.set(canon, upper);
      }
    }
  }

  const refMaps: Record<Exclude<LeadRefSource, 'binance_equity'>, Map<string, string>> = {
    binance_perp: indexRefCatalog(contracts.binance_perp),
    binance_spot: indexRefCatalog(contracts.binance_spot),
    hl_xyz: indexRefCatalog(contracts.hl_xyz),
    coinbase_spot: indexRefCatalog(contracts.coinbase_spot),
    okx_perp: indexRefCatalog(contracts.okx_perp),
    bybit_perp: indexRefCatalog(contracts.bybit_perp),
  };

  const perpTypes = new Map<string, string>();
  for (const c of contracts.binance_perp) {
    if (c.contractType) perpTypes.set(c.baseAsset.toUpperCase(), c.contractType);
  }

  const rows: LeadCandidateView[] = [];
  const seenCanon = new Set<string>();

  for (const [canon, preferredSymbol] of allBases) {
    if (seenCanon.has(canon)) continue;
    seenCanon.add(canon);

    const targets: Partial<Record<LeadVenue, string>> = {};
    for (const venue of LEAD_VENUES) {
      const hit = lookupWithVariants(preferredSymbol, dexMaps[venue]);
      if (hit) targets[venue] = hit;
    }
    const targetCount = Object.keys(targets).length;
    if (!targetCount) continue;

    const leads: Partial<Record<LeadRefSource, string>> = {};
    for (const src of ['binance_perp', 'binance_spot', 'hl_xyz', 'coinbase_spot', 'okx_perp', 'bybit_perp'] as const) {
      const hit = lookupWithVariants(preferredSymbol, refMaps[src]);
      if (hit) leads[src] = hit;
    }

    const perpBase = contracts.binance_perp.find(c => c.symbol === leads.binance_perp)?.contractType;
    const category = classifyLeadAsset(preferredSymbol, perpBase ?? perpTypes.get(preferredSymbol));
    // 美股与美股 ETF 免 Key 自动补充 Binance 股票 @quote 实时通道
    if (category === 'us_equity' && WATCHER_SYMBOL_RE.test(preferredSymbol)) {
      leads.binance_equity = preferredSymbol;
    }

    const leadCount = Object.keys(leads).length;
    if (!leadCount) continue;

    rows.push({
      symbol: preferredSymbol,
      kind: category,
      leads,
      targets,
      leadCount,
      targetCount,
    });
  }

  const catRank: Record<LeadAssetCategory, number> = { us_equity: 3, crypto: 2, tradfi: 1, other: 0 };
  return rows.sort((a, b) =>
    b.targetCount - a.targetCount
    || b.leadCount - a.leadCount
    || catRank[b.kind] - catRank[a.kind]
    || a.symbol.localeCompare(b.symbol));
}

// ---- 共享数学与统计学纯函数（内存滑窗与离线 Worker 同口径） ----

export function quantile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  const weight = pos - lo;
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

export interface GridReturnSeries {
  minIdx: number;
  values: Float64Array;
  count: number;
}

/** 从连续网格细胞构造按 `idx - minIdx` 对齐的 500ms 收益率数组（仅同一 `segId` 且连续无缺口生效）。 */
export function buildReturnSeriesFromMap(
  cells: ReadonlyMap<number, { mid: number; segId: number }>,
): GridReturnSeries {
  const h = LEAD_RETURN_HORIZON_STEPS;
  if (cells.size < LEAD_XCORR_MIN_SAMPLES + h) return { minIdx: 0, values: new Float64Array(0), count: 0 };
  let firstIdx = Infinity;
  let lastIdx = -Infinity;
  for (const idx of cells.keys()) {
    if (idx < firstIdx) firstIdx = idx;
    if (idx > lastIdx) lastIdx = idx;
  }
  const startIdx = firstIdx + h;
  if (lastIdx < startIdx) return { minIdx: 0, values: new Float64Array(0), count: 0 };
  const values = new Float64Array(lastIdx - startIdx + 1);
  values.fill(Number.NaN);
  let count = 0;
  for (const [idx, cur] of cells) {
    if (idx < startIdx) continue;
    const prev = cells.get(idx - h);
    if (!prev || prev.segId !== cur.segId || !(prev.mid > 0) || !(cur.mid > 0)) continue;
    let continuous = true;
    for (let step = 1; step < h; step++) {
      const midCell = cells.get(idx - step);
      if (!midCell || midCell.segId !== cur.segId) { continuous = false; break; }
    }
    if (!continuous) continue;
    values[idx - startIdx] = (cur.mid - prev.mid) / prev.mid;
    count++;
  }
  return { minIdx: startIdx, values, count };
}

/** 从已对齐的连续中间价与段标识定长数组构造 500ms 收益率数组（离线 Worker 专用，零哈希查找）。 */
export function buildReturnSeriesFromDenseArrays(
  minGridIdx: number,
  mids: Float64Array,
  segIds: Int32Array,
): GridReturnSeries {
  const h = LEAD_RETURN_HORIZON_STEPS;
  if (mids.length < LEAD_XCORR_MIN_SAMPLES + h) return { minIdx: 0, values: new Float64Array(0), count: 0 };
  const values = new Float64Array(mids.length - h);
  values.fill(Number.NaN);
  let count = 0;
  for (let i = h; i < mids.length; i++) {
    const curMid = mids[i]!;
    const prevMid = mids[i - h]!;
    const seg = segIds[i]!;
    if (!(curMid > 0) || !(prevMid > 0) || seg <= 0 || segIds[i - h] !== seg) continue;
    let continuous = true;
    for (let step = 1; step < h; step++) {
      if (segIds[i - step] !== seg || !(mids[i - step]! > 0)) { continuous = false; break; }
    }
    if (!continuous) continue;
    values[i - h] = (curMid - prevMid) / prevMid;
    count++;
  }
  return { minIdx: minGridIdx + h, values, count };
}

/** 扫描 `[-1000ms .. +3000ms]` 滞后上的 500ms 收益率 Pearson 互相关（正滞后表示 X 领先 Y）。 */
export function computeXcorrFromReturns(
  xSeries: GridReturnSeries,
  ySeries: GridReturnSeries,
  xName: string,
  yName: string,
): { xcorr: LeadXcorrView | null; reason: string | null } {
  if (xSeries.count < LEAD_XCORR_MIN_SAMPLES) {
    return { xcorr: null, reason: `${xName} 连续在线采样不足 5 秒` };
  }
  if (ySeries.count < LEAD_XCORR_MIN_SAMPLES) {
    return { xcorr: null, reason: `${yName} 连续在线采样不足 5 秒` };
  }

  const minLagSteps = Math.round(LEAD_XCORR_MIN_LAG_MS / LEAD_GRID_STEP_MS);
  const maxLagSteps = Math.round(LEAD_XCORR_MAX_LAG_MS / LEAD_GRID_STEP_MS);
  const xArr = xSeries.values;
  const yArr = ySeries.values;

  const points: LeadXcorrPoint[] = [];
  let bestPoint: LeadXcorrPoint | null = null;
  let zeroCorr: number | null = null;
  let zeroSamples = 0;
  let anyPairEnough = false;
  let maxVar = 0;

  for (let k = minLagSteps; k <= maxLagSteps; k++) {
    let n = 0;
    let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
    const offset = xSeries.minIdx + k - ySeries.minIdx;
    const lo = Math.max(0, -offset);
    const hi = Math.min(xArr.length, yArr.length - offset);
    for (let i = lo; i < hi; i++) {
      const x = xArr[i]!;
      const y = yArr[i + offset]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      n++;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
    }
    const lagMs = k * LEAD_GRID_STEP_MS;
    if (n < LEAD_XCORR_MIN_SAMPLES) continue;
    anyPairEnough = true;
    const varX = sumXX - (sumX * sumX) / n;
    const varY = sumYY - (sumY * sumY) / n;
    maxVar = Math.max(maxVar, varX, varY);
    if (varX <= 1e-12 || varY <= 1e-12) continue;
    const corr = Math.max(-1, Math.min(1, (sumXY - (sumX * sumY) / n) / Math.sqrt(varX * varY)));
    const point: LeadXcorrPoint = { lagMs, corr: Number(corr.toFixed(4)), samples: n };
    points.push(point);
    if (lagMs === 0) { zeroCorr = point.corr; zeroSamples = n; }
    if (!bestPoint || point.corr > bestPoint.corr || (point.corr === bestPoint.corr && Math.abs(point.lagMs) < Math.abs(bestPoint.lagMs))) {
      bestPoint = point;
    }
  }

  if (!anyPairEnough) return { xcorr: null, reason: '双方重叠在线采样不足 5 秒' };
  if (!bestPoint) return { xcorr: null, reason: maxVar <= 1e-12 ? '价格尚未出现波动' : '双方有效波动不足' };
  return {
    xcorr: {
      peakLagMs: bestPoint.lagMs,
      peakCorr: bestPoint.corr,
      zeroCorr,
      samples: zeroSamples || bestPoint.samples,
      points,
    },
    reason: null,
  };
}

export interface VenueStatAccum {
  followedLags: number[];
  unfollowed: number;
  disconnected: number;
  noData: number;
  cancelled: number;
  pending: number;
}

export function summarizeVenueStats(
  venue: LeadVenue,
  symbol: string,
  acc: VenueStatAccum,
  xcorr: LeadXcorrView | null,
  xcorrReason: string | null,
): LeadVenueStatsView {
  const sorted = [...acc.followedLags].sort((a, b) => a - b);
  const followed = sorted.length;
  const resolved = followed + acc.unfollowed;
  let bnLeadCount = 0;
  let dexLeadCount = 0;
  let tieCount = 0;
  let sum = 0;
  for (const lag of sorted) {
    sum += lag;
    if (lag > 0) bnLeadCount++;
    else if (lag < 0) dexLeadCount++;
    else tieCount++;
  }
  const q = (p: number) => {
    const val = quantile(sorted, p);
    return val !== null ? Math.round(val) : null;
  };
  return {
    venue,
    name: LEAD_VENUE_NAMES[venue],
    symbol,
    followed,
    unfollowed: acc.unfollowed,
    disconnected: acc.disconnected,
    noData: acc.noData,
    cancelled: acc.cancelled,
    pending: acc.pending,
    followRate: resolved > 0 ? Number((followed / resolved).toFixed(4)) : null,
    bnLeadCount,
    dexLeadCount,
    tieCount,
    bnLeadRate: followed > 0 ? Number((bnLeadCount / followed).toFixed(4)) : null,
    medianMs: q(0.5),
    meanMs: followed > 0 ? Math.round(sum / followed) : null,
    p25Ms: q(0.25),
    p75Ms: q(0.75),
    p90Ms: q(0.9),
    p95Ms: q(0.95),
    minMs: sorted.length ? sorted[0]! : null,
    maxMs: sorted.length ? sorted.at(-1)! : null,
    xcorr,
    xcorrReason,
  };
}

// ---- 常驻多源追踪器 ----

interface StreamTrackerState {
  symbol: string;
  connected: boolean;
  lastError: string | null;
  reconnects: number;
  segmentStart: number | null;
  segId: number;
  ticksCount: number;
  lastTick: QuoteTick | null;
  recentTickMonos: number[];
  exchangeLags: number[];
  ticks: QuoteTick[];
  lastEmittedMid: number | null;
  lastEmittedSegId: number;
  lastEmittedGridIdx: number;
}

interface EventVenueState {
  status: LeadFollowStatus;
  baseMid: number | null;
  baseMono: number | null;
  followMono: number | null;
  lagMs: number | null;
  maxMoveBps: number | null;
}

interface InternalEvent {
  id: number;
  leadSource: LeadRefSource;
  wallMs: number;
  triggerMono: number;
  bnCrossMono: number;
  preStartMono: number;
  direction: 1 | -1;
  baseMid: number;
  triggerMid: number;
  moveBps: number;
  venues: Partial<Record<LeadVenue, EventVenueState>>;
  emitted: boolean;
}

interface SettledRecentEvent {
  monoMs: number;
  leadSource: LeadRefSource;
  venues: Partial<Record<LeadVenue, LeadEventVenueView>>;
}

function upperBound(ticks: readonly QuoteTick[], monoMs: number): number {
  let lo = 0, hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid]!.monoMs <= monoMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lastAtOrBefore(ticks: readonly QuoteTick[], monoMs: number, minMono: number): { tick: QuoteTick; nextIdx: number } | null {
  const hi = upperBound(ticks, monoMs);
  if (!hi) return null;
  const tick = ticks[hi - 1]!;
  return tick.monoMs >= minMono ? { tick, nextIdx: hi } : null;
}

const isRefSource = (source: LeadSource): source is LeadRefSource =>
  (LEAD_REF_SOURCES as readonly string[]).includes(source);

export interface LeadTrackerOptions {
  symbol: string;
  runId: number;
  config: LeadWatcherConfig;
  startedAt: number;
  startMono: number;
  onSettled?: (event: PersistLeadEvent) => void;
  onGridPoint?: (point: PersistLeadGrid) => void;
}

/**
 * 单个常驻标的的多领先源实时追踪器：
 * - 各自计算最多 7 个 Lead 源相对最多 3 个 DEX 目标场所的同门槛跃动跟随；
 * - 内存中只留近 30 分钟滑窗统计（长跑数周内存恒定有界）；
 * - 将已结算事件与稀疏 100ms 网格变化点（含 30s 心跳锚点与断线 NULL 哨兵）回调给批量刷盘控制器。
 */
export class LeadTracker {
  readonly symbol: string;
  readonly runId: number;
  readonly config: LeadWatcherConfig;
  readonly startedAt: number;
  readonly startMono: number;
  readonly activeLeads: readonly LeadRefSource[];
  readonly activeVenues: readonly LeadVenue[];

  private finished = false;
  private gridOriginMono: number | null = null;
  private gridOriginWall: number | null = null;
  private lastGridIndex = -1;
  private nextEventId = 0;

  private readonly streams: Record<LeadSource, StreamTrackerState>;
  private readonly lastTriggerMono: Partial<Record<LeadRefSource, number>> = {};
  private readonly pendingEvents = new Set<InternalEvent>();
  private readonly recentSettled: SettledRecentEvent[] = [];
  private readonly onSettled?: (event: PersistLeadEvent) => void;
  private readonly onGridPoint?: (point: PersistLeadGrid) => void;

  constructor(options: LeadTrackerOptions) {
    this.symbol = options.symbol;
    this.runId = options.runId;
    this.config = options.config;
    this.startedAt = options.startedAt;
    this.startMono = options.startMono;
    this.onSettled = options.onSettled;
    this.onGridPoint = options.onGridPoint;
    this.activeLeads = LEAD_REF_SOURCES.filter(src => Boolean(options.config.leads[src]));
    this.activeVenues = LEAD_VENUES.filter(v => Boolean(options.config.targets[v]));

    const mk = (sym: string): StreamTrackerState => ({
      symbol: sym,
      connected: false,
      lastError: null,
      reconnects: 0,
      segmentStart: null,
      segId: 0,
      ticksCount: 0,
      lastTick: null,
      recentTickMonos: [],
      exchangeLags: [],
      ticks: [],
      lastEmittedMid: null,
      lastEmittedSegId: 0,
      lastEmittedGridIdx: -1,
    });
    this.streams = {
      binance_perp: mk(options.config.leads.binance_perp ?? ''),
      binance_spot: mk(options.config.leads.binance_spot ?? ''),
      binance_equity: mk(options.config.leads.binance_equity ?? ''),
      hl_xyz: mk(options.config.leads.hl_xyz ?? ''),
      coinbase_spot: mk(options.config.leads.coinbase_spot ?? ''),
      okx_perp: mk(options.config.leads.okx_perp ?? ''),
      bybit_perp: mk(options.config.leads.bybit_perp ?? ''),
      lighter: mk(options.config.targets.lighter ?? ''),
      rh: mk(options.config.targets.rh ?? ''),
      entropy: mk(options.config.targets.entropy ?? ''),
    };
  }

  private ensureOrigin(monoMs: number, wallMs: number): void {
    if (this.gridOriginMono !== null) return;
    const remainder = monoMs >= 0 ? monoMs % LEAD_GRID_STEP_MS : 0;
    this.gridOriginMono = monoMs - remainder;
    this.gridOriginWall = Math.round(wallMs - remainder);
  }

  private gridIndex(monoMs: number): number {
    return Math.max(0, Math.floor((monoMs - this.gridOriginMono!) / LEAD_GRID_STEP_MS));
  }

  private cellWallMs(idx: number): number {
    return this.gridOriginWall! + idx * LEAD_GRID_STEP_MS;
  }

  private isSourceActive(source: LeadSource): boolean {
    return isRefSource(source) ? Boolean(this.config.leads[source]) : Boolean(this.config.targets[source]);
  }

  private emitGrid(source: LeadSource, idx: number, segId: number, mid: number | null, force = false): void {
    const stream = this.streams[source];
    if (mid === null) {
      stream.lastEmittedMid = null;
      stream.lastEmittedSegId = segId;
      stream.lastEmittedGridIdx = idx;
      this.onGridPoint?.({ symbol: this.symbol, at: this.cellWallMs(idx), source, runId: this.runId, gridIdx: idx, segId, mid: null });
      return;
    }
    const anchorDue = stream.lastEmittedGridIdx < 0 || idx - stream.lastEmittedGridIdx >= LEAD_GRID_ANCHOR_STEPS;
    if (!force && stream.lastEmittedMid === mid && stream.lastEmittedSegId === segId && !anchorDue) return;
    stream.lastEmittedMid = mid;
    stream.lastEmittedSegId = segId;
    stream.lastEmittedGridIdx = idx;
    this.onGridPoint?.({ symbol: this.symbol, at: this.cellWallMs(idx), source, runId: this.runId, gridIdx: idx, segId, mid });
  }

  /** 将所有在线流的 30s 心跳锚点推进到 `targetIdx`（不跨断线或超过 60s 静默）。 */
  private advanceAnchors(targetIdx: number): void {
    if (this.gridOriginMono === null || targetIdx <= this.lastGridIndex) return;
    const stepBase = Math.max(this.lastGridIndex + 1, targetIdx - LEAD_GRID_ANCHOR_STEPS * 2);
    for (const source of LEAD_SOURCES) {
      if (!this.isSourceActive(source)) continue;
      const stream = this.streams[source];
      if (!stream.connected || stream.segmentStart === null || !stream.lastTick) continue;
      if (stream.lastTick.monoMs < stream.segmentStart) continue;
      const nextAnchorIdx = stream.lastEmittedGridIdx < 0
        ? targetIdx
        : stream.lastEmittedGridIdx + LEAD_GRID_ANCHOR_STEPS;
      if (nextAnchorIdx > targetIdx) continue;
      const emitIdx = Math.max(stepBase, nextAnchorIdx);
      const cellMono = this.gridOriginMono + emitIdx * LEAD_GRID_STEP_MS;
      // 最后锚点停在 30s，配合 Worker 侧 30s 最大连续填充上限，确保静默期总外推严格不超过 LEAD_BASE_STALE_MS (60s)。
      if (cellMono - stream.lastTick.monoMs > LEAD_BASE_STALE_MS - LEAD_GRID_ANCHOR_MS) continue;
      this.emitGrid(source, emitIdx, stream.segId, stream.lastTick.mid, true);
    }
    this.lastGridIndex = targetIdx;
  }

  setConnected(source: LeadSource, connected: boolean, monoMs: number, wallMs = Date.now(), error: string | null = null, reconnects?: number): void {
    if (this.finished || !this.isSourceActive(source)) return;
    const stream = this.streams[source];
    if (reconnects !== undefined) stream.reconnects = reconnects;
    if (connected) {
      const wasDown = !stream.connected;
      stream.connected = true;
      stream.lastError = error;
      if (wasDown || stream.segmentStart === null) {
        stream.segId++;
        stream.segmentStart = monoMs;
      }
      return;
    }

    const hadLiveSegment = stream.connected && stream.segmentStart !== null && stream.lastTick !== null && this.gridOriginMono !== null;
    if (hadLiveSegment) {
      const idx = this.gridIndex(monoMs);
      this.advanceAnchors(Math.max(0, idx - 1));
    }
    stream.connected = false;
    if (error !== null) stream.lastError = error;
    if (stream.segmentStart !== null) {
      stream.segmentStart = null;
      stream.segId++;
    }
    if (hadLiveSegment) {
      const idx = this.gridIndex(monoMs);
      this.emitGrid(source, idx, stream.segId, null, true);
    }

    if (isRefSource(source)) {
      // 主导源断线，仅清理它已有的待判定事件（其余等待源继续照常跑）
      for (const ev of [...this.pendingEvents]) {
        if (ev.leadSource !== source) continue;
        for (const venue of this.activeVenues) {
          const vs = ev.venues[venue];
          if (vs && vs.status === 'pending') vs.status = 'disconnected';
        }
        this.settleEvent(ev, monoMs);
      }
    } else {
      for (const ev of [...this.pendingEvents]) {
        const vs = ev.venues[source];
        if (vs && vs.status === 'pending') {
          vs.status = 'disconnected';
          this.checkEventSettled(ev, monoMs);
        }
      }
    }
    void wallMs;
  }

  private settleEvent(ev: InternalEvent, monoMs: number): void {
    this.pendingEvents.delete(ev);
    if (ev.emitted) return;
    ev.emitted = true;

    const venueViews: Partial<Record<LeadVenue, LeadEventVenueView>> = {};
    for (const venue of this.activeVenues) {
      const vs = ev.venues[venue]!;
      venueViews[venue] = {
        status: vs.status,
        lagMs: vs.lagMs,
        maxMoveBps: vs.maxMoveBps === null ? null : Number(vs.maxMoveBps.toFixed(2)),
      };
    }

    this.recentSettled.push({ monoMs, leadSource: ev.leadSource, venues: venueViews });
    this.pruneRecent(monoMs);

    this.onSettled?.({
      symbol: this.symbol,
      runId: this.runId,
      leadSource: ev.leadSource,
      at: ev.wallMs,
      direction: ev.direction,
      baseMid: ev.baseMid,
      triggerMid: ev.triggerMid,
      moveBps: Number(ev.moveBps.toFixed(2)),
      thresholdBps: this.config.thresholdBps,
      followBps: this.config.thresholdBps * this.config.followRatio,
      venues: venueViews,
    });
  }

  private checkEventSettled(ev: InternalEvent, monoMs: number): void {
    for (const venue of this.activeVenues) {
      if (ev.venues[venue]?.status === 'pending') return;
    }
    this.settleEvent(ev, monoMs);
  }

  private pruneRecent(monoMs: number): void {
    const cutoff = monoMs - LEAD_RECENT_WINDOW_MS;
    while (this.recentSettled.length && (this.recentSettled.length > MAX_RECENT_SETTLED || this.recentSettled[0]!.monoMs < cutoff)) {
      this.recentSettled.shift();
    }
  }

  /** 推进待判定事件超时、清理 30m 滑窗旧事件并维持 30s 稀疏心跳锚点。 */
  tickTimeouts(monoMs: number): void {
    if (this.finished) return;
    if (this.gridOriginMono !== null) this.advanceAnchors(this.gridIndex(monoMs));

    for (const ev of [...this.pendingEvents]) {
      if (monoMs < ev.triggerMono + this.config.maxWaitMs) continue;
      for (const venue of this.activeVenues) {
        const vs = ev.venues[venue];
        if (vs && vs.status === 'pending') vs.status = 'unfollowed';
      }
      this.checkEventSettled(ev, monoMs);
    }
    this.pruneRecent(monoMs);
  }

  onTick(source: LeadSource, tick: QuoteTick): void {
    if (this.finished || !this.isSourceActive(source)) return;
    if (!(tick.bid > 0 && tick.ask >= tick.bid && tick.mid > 0)) return;

    this.ensureOrigin(tick.monoMs, tick.wallMs);
    const stream = this.streams[source];
    if (!stream.connected) {
      stream.connected = true;
      stream.lastError = null;
      stream.segId++;
      stream.segmentStart = tick.monoMs;
    } else {
      stream.lastError = null;
      if (stream.segmentStart === null) stream.segmentStart = tick.monoMs;
    }

    const gIdx = this.gridIndex(tick.monoMs);
    this.advanceAnchors(gIdx);

    stream.ticksCount++;
    stream.lastTick = tick;
    stream.recentTickMonos.push(tick.monoMs);
    while (stream.recentTickMonos.length && tick.monoMs - stream.recentTickMonos[0]! > 10_000) {
      stream.recentTickMonos.shift();
    }
    if (tick.exchangeMs !== null) {
      stream.exchangeLags.push(tick.wallMs - tick.exchangeMs);
      if (stream.exchangeLags.length > 25) stream.exchangeLags.shift();
    }

    stream.ticks.push(tick);
    const keepBufferMs = Math.max(LEAD_BASE_STALE_MS + LEAD_PRE_WINDOW_MS, this.config.maxWaitMs + this.config.impulseWindowMs) + 5_000;
    while (stream.ticks.length > 2 && tick.monoMs - stream.ticks[1]!.monoMs > keepBufferMs) {
      stream.ticks.shift();
    }
    while (stream.ticks.length > MAX_TICKS_PER_STREAM) {
      stream.ticks.shift();
    }

    this.emitGrid(source, gIdx, stream.segId, tick.mid, false);
    this.lastGridIndex = Math.max(this.lastGridIndex, gIdx);

    this.tickTimeouts(tick.monoMs);

    if (!isRefSource(source)) {
      this.updatePendingForVenue(source, tick);
      return;
    }

    this.evaluateImpulse(source, tick);
  }

  /** 对静默但仍在线的一档做心跳保活（刷新有效期与稀疏锚点，不虚增价变计数）。 */
  confirmAlive(source: LeadSource, monoMs: number, wallMs: number): void {
    if (this.finished || !this.isSourceActive(source)) return;
    const stream = this.streams[source];
    if (!stream.connected || stream.segmentStart === null || !stream.lastTick) return;
    if (stream.lastTick.monoMs < stream.segmentStart || monoMs <= stream.lastTick.monoMs) return;
    this.ensureOrigin(monoMs, wallMs);
    const gIdx = this.gridIndex(monoMs);
    this.advanceAnchors(gIdx);
    const refreshed: QuoteTick = { ...stream.lastTick, monoMs, wallMs };
    stream.lastTick = refreshed;
    stream.ticks.push(refreshed);
    const keepBufferMs = Math.max(LEAD_BASE_STALE_MS + LEAD_PRE_WINDOW_MS, this.config.maxWaitMs + this.config.impulseWindowMs) + 5_000;
    while (stream.ticks.length > 2 && monoMs - stream.ticks[1]!.monoMs > keepBufferMs) {
      stream.ticks.shift();
    }
    while (stream.ticks.length > MAX_TICKS_PER_STREAM) {
      stream.ticks.shift();
    }
    this.emitGrid(source, gIdx, stream.segId, refreshed.mid, false);
    this.lastGridIndex = Math.max(this.lastGridIndex, gIdx);
  }

  private updatePendingForVenue(venue: LeadVenue, tick: QuoteTick): void {
    const followBps = this.config.thresholdBps * this.config.followRatio;
    for (const ev of [...this.pendingEvents]) {
      const vs = ev.venues[venue];
      if (!vs || vs.status !== 'pending' || vs.baseMid === null) continue;
      if (tick.monoMs > ev.triggerMono + this.config.maxWaitMs) {
        vs.status = 'unfollowed';
        this.checkEventSettled(ev, tick.monoMs);
        continue;
      }
      if (tick.monoMs < ev.preStartMono) continue;
      const move = ev.direction * ((tick.mid - vs.baseMid) / vs.baseMid) * 10_000;
      if (vs.maxMoveBps === null || move > vs.maxMoveBps) vs.maxMoveBps = move;
      if (move >= followBps) {
        vs.status = 'followed';
        vs.followMono = tick.monoMs;
        vs.lagMs = Math.round(tick.monoMs - ev.bnCrossMono);
        this.checkEventSettled(ev, tick.monoMs);
      }
    }
  }

  private evaluateImpulse(leadSource: LeadRefSource, tick: QuoteTick): void {
    const lead = this.streams[leadSource];
    const prevTrigger = this.lastTriggerMono[leadSource] ?? -Infinity;
    if (tick.monoMs - prevTrigger < this.config.cooldownMs) return;

    const hardFloorMono = Math.max(
      lead.segmentStart ?? -Infinity,
      Number.isFinite(prevTrigger) ? prevTrigger : -Infinity,
    );
    const windowStartMono = Math.max(tick.monoMs - this.config.impulseWindowMs, hardFloorMono);

    let bestBase: QuoteTick | null = null;
    let bestMove = 0;
    let bestIdx = -1;
    let sawWindowBoundary = false;
    for (let i = lead.ticks.length - 1; i >= 0; i--) {
      const candidate = lead.ticks[i]!;
      if (candidate.monoMs < hardFloorMono) break;
      const isCarry = candidate.monoMs < windowStartMono;
      if (isCarry && (sawWindowBoundary || tick.monoMs - candidate.monoMs > LEAD_BASE_STALE_MS)) break;
      const move = ((tick.mid - candidate.mid) / candidate.mid) * 10_000;
      if (Math.abs(move) > Math.abs(bestMove)) {
        bestMove = move;
        bestBase = candidate;
        bestIdx = i;
      }
      if (candidate.monoMs === windowStartMono) sawWindowBoundary = true;
      if (isCarry) break;
    }
    if (!bestBase || Math.abs(bestMove) < this.config.thresholdBps) return;

    const direction: 1 | -1 = bestMove > 0 ? 1 : -1;
    const followBps = this.config.thresholdBps * this.config.followRatio;

    let bnCrossMono = tick.monoMs;
    for (let i = bestIdx; i < lead.ticks.length; i++) {
      const pt = lead.ticks[i]!;
      const signedMove = direction * ((pt.mid - bestBase.mid) / bestBase.mid) * 10_000;
      if (signedMove >= followBps) {
        bnCrossMono = pt.monoMs;
        break;
      }
    }

    const preFloor = Math.max(bnCrossMono - LEAD_PRE_WINDOW_MS, hardFloorMono);
    let preStartMono = bestBase.monoMs;
    if (bestBase.monoMs <= preFloor) {
      preStartMono = preFloor;
    } else {
      for (let i = bestIdx - 1; i >= 0; i--) {
        const pt = lead.ticks[i]!;
        if (pt.monoMs < hardFloorMono) break;
        const drift = Math.abs((pt.mid - bestBase.mid) / bestBase.mid) * 10_000;
        if (drift >= 0.25 * followBps) break;
        if (pt.monoMs < preFloor) {
          if (tick.monoMs - pt.monoMs <= LEAD_BASE_STALE_MS) preStartMono = preFloor;
          break;
        }
        preStartMono = pt.monoMs;
      }
    }

    this.lastTriggerMono[leadSource] = tick.monoMs;
    const ev: InternalEvent = {
      id: ++this.nextEventId,
      leadSource,
      wallMs: tick.wallMs,
      triggerMono: tick.monoMs,
      bnCrossMono,
      preStartMono,
      direction,
      baseMid: bestBase.mid,
      triggerMid: tick.mid,
      moveBps: bestMove,
      venues: {},
      emitted: false,
    };

    for (const venue of this.activeVenues) {
      const target = this.streams[venue];
      if (!target.connected || target.segmentStart === null) {
        ev.venues[venue] = { status: 'no_data', baseMid: null, baseMono: null, followMono: null, lagMs: null, maxMoveBps: null };
        continue;
      }
      const minBaseMono = Math.max(preStartMono - LEAD_BASE_STALE_MS, target.segmentStart);
      const baseAtPre = lastAtOrBefore(target.ticks, preStartMono, minBaseMono);
      const baseAtBest = preStartMono < bestBase.monoMs ? lastAtOrBefore(target.ticks, bestBase.monoMs, minBaseMono) : baseAtPre;
      let chosen = baseAtPre;
      if (!chosen) {
        chosen = baseAtBest;
      } else if (baseAtBest && baseAtBest.tick.monoMs > chosen.tick.monoMs) {
        let preLed = false;
        for (let i = chosen.nextIdx; i < baseAtBest.nextIdx; i++) {
          const pt = target.ticks[i]!;
          const leadMove = direction * ((pt.mid - chosen.tick.mid) / chosen.tick.mid) * 10_000;
          if (leadMove >= 0.25 * followBps) { preLed = true; break; }
        }
        if (!preLed) chosen = baseAtBest;
      }
      if (!chosen) {
        ev.venues[venue] = { status: 'no_data', baseMid: null, baseMono: null, followMono: null, lagMs: null, maxMoveBps: null };
        continue;
      }
      const baseTick = chosen.tick;
      const vs: EventVenueState = {
        status: 'pending',
        baseMid: baseTick.mid,
        baseMono: baseTick.monoMs,
        followMono: null,
        lagMs: null,
        maxMoveBps: 0,
      };
      for (let i = chosen.nextIdx; i < target.ticks.length; i++) {
        const pt = target.ticks[i]!;
        if (pt.monoMs > tick.monoMs) break;
        if (pt.monoMs < preStartMono) continue;
        const move = direction * ((pt.mid - baseTick.mid) / baseTick.mid) * 10_000;
        if (vs.maxMoveBps === null || move > vs.maxMoveBps) vs.maxMoveBps = move;
        if (move >= followBps) {
          vs.status = 'followed';
          vs.followMono = pt.monoMs;
          vs.lagMs = Math.round(pt.monoMs - bnCrossMono);
          break;
        }
      }
      ev.venues[venue] = vs;
    }

    if (this.activeVenues.some(v => ev.venues[v]?.status === 'pending')) {
      this.pendingEvents.add(ev);
    } else {
      this.settleEvent(ev, tick.monoMs);
    }
  }

  /** 暂停或停服时结算在途事件并写入所有在线流的断线哨兵（`mid: null`）。 */
  finalize(wallMs: number, monoMs: number): void {
    if (this.finished) return;
    this.tickTimeouts(monoMs);
    this.finished = true;
    for (const ev of [...this.pendingEvents]) {
      for (const venue of this.activeVenues) {
        const vs = ev.venues[venue];
        if (vs && vs.status === 'pending') vs.status = 'cancelled';
      }
      this.settleEvent(ev, monoMs);
    }
    if (this.gridOriginMono !== null) {
      const idx = this.gridIndex(monoMs);
      for (const source of LEAD_SOURCES) {
        if (!this.isSourceActive(source)) continue;
        const stream = this.streams[source];
        if (stream.connected && stream.segmentStart !== null && stream.lastTick) {
          stream.segId++;
          this.emitGrid(source, idx, stream.segId, null, true);
        }
        stream.connected = false;
        stream.segmentStart = null;
      }
    }
    void wallMs;
  }

  watcherView(meta: { enabled: boolean; status: 'running' | 'waiting_catalog' | 'paused'; createdAt: number; updatedAt: number }, wallMs: number, monoMs: number): LeadWatcherView {
    if (!this.finished) this.tickTimeouts(monoMs);
    const refMid = this.streams[this.activeLeads[0]!]?.lastTick?.mid ?? null;
    const rateWindowSec = Math.max(1, Math.min(10, Math.max(1, (monoMs - this.startMono) / 1000)));

    const activeSources: LeadSource[] = [...this.activeLeads, ...this.activeVenues];
    const streams: LeadStreamView[] = activeSources.map(source => {
      const s = this.streams[source];
      const tick = s.lastTick;
      const spreadBps = tick && tick.mid > 0 ? Number((((tick.ask - tick.bid) / tick.mid) * 10_000).toFixed(2)) : null;
      const recentCount = s.recentTickMonos.filter(t => monoMs - t <= 10_000).length;
      const basisBps = !isRefSource(source) && tick && refMid && Math.abs(tick.mid / refMid - 1) <= LEAD_BASIS_MAX_GAP_PCT
        ? Number((((tick.mid - refMid) / refMid) * 10_000).toFixed(2))
        : null;
      return {
        source,
        name: LEAD_SOURCE_NAMES[source],
        symbol: s.symbol,
        connected: s.connected,
        lastError: s.lastError,
        reconnects: s.reconnects,
        ticks: s.ticksCount,
        ticksPerSec: Number((recentCount / rateWindowSec).toFixed(1)),
        bid: tick?.bid ?? null,
        ask: tick?.ask ?? null,
        mid: tick?.mid ?? null,
        spreadBps,
        lastTickAt: tick?.wallMs ?? null,
        exchangeLagMs: median(s.exchangeLags) !== null ? Math.round(median(s.exchangeLags)!) : null,
        basisBps,
      };
    });

    const byLead = new Map<LeadRefSource, { events: number; lags: Record<LeadVenue, number[]>; unfollowed: Record<LeadVenue, number>; bnLead: Record<LeadVenue, number> }>();
    for (const src of this.activeLeads) {
      byLead.set(src, {
        events: 0,
        lags: { lighter: [], rh: [], entropy: [] },
        unfollowed: { lighter: 0, rh: 0, entropy: 0 },
        bnLead: { lighter: 0, rh: 0, entropy: 0 },
      });
    }
    for (const ev of this.recentSettled) {
      const rec = byLead.get(ev.leadSource);
      if (!rec) continue;
      rec.events++;
      for (const venue of this.activeVenues) {
        const cell = ev.venues[venue];
        if (!cell) continue;
        if (cell.status === 'followed' && cell.lagMs !== null) {
          rec.lags[venue].push(cell.lagMs);
          if (cell.lagMs > 0) rec.bnLead[venue]++;
        } else if (cell.status === 'unfollowed') {
          rec.unfollowed[venue]++;
        }
      }
    }

    const recentSummary: LeadWatcherRecentRow[] = this.activeLeads.map(leadSource => {
      const rec = byLead.get(leadSource)!;
      const venues: LeadWatcherRecentRow['venues'] = {};
      for (const venue of this.activeVenues) {
        const lags = rec.lags[venue];
        const unfollowed = rec.unfollowed[venue];
        const followed = lags.length;
        const resolved = followed + unfollowed;
        const m = median(lags);
        venues[venue] = {
          followed,
          unfollowed,
          followRate: resolved > 0 ? Number((followed / resolved).toFixed(4)) : null,
          medianMs: m !== null ? Math.round(m) : null,
          bnLeadRate: followed > 0 ? Number((rec.bnLead[venue] / followed).toFixed(4)) : null,
        };
      }
      return {
        leadSource,
        name: LEAD_REF_NAMES[leadSource],
        symbol: this.config.leads[leadSource]!,
        events: rec.events,
        venues,
      };
    });

    return {
      symbol: this.symbol,
      config: this.config,
      enabled: meta.enabled,
      status: meta.status,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      startedAt: this.startedAt,
      runId: this.runId,
      recentWindowSec: Math.round(LEAD_RECENT_WINDOW_MS / 1_000),
      recentEventCount: this.recentSettled.length,
      streams,
      recentSummary,
    };
  }
}
