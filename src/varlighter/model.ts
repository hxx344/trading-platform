// Var（Variational Omni）与 Lighter（RH 链与主网）价差回归（docs/varlighter.md）：两边共有标的的配对、交易时段和价差口径。
// 只放纯数据规则，采集（feeds.ts）、基线（stats.ts）、策略（strategy.ts）与页面共用；不发请求、不读写文件。

/** 标的类别决定按哪套时段分组基线：美股与 ETF 按纽约时间的盘中、盘前盘后、夜盘、周末；贵金属分工作日与周末；其余不分。 */
export type AssetKind = 'equity' | 'etf' | 'crypto' | 'metal' | 'commodity' | 'private' | 'other';
export type Regime = 'rth' | 'ext' | 'overnight' | 'weekend' | 'weekday' | 'all';
export const REGIMES: readonly Regime[] = ['rth', 'ext', 'overnight', 'weekend', 'weekday', 'all'];
export const REGIME_NAMES: Record<Regime, string> = { rth: '美股盘中', ext: '盘前盘后', overnight: '美股夜盘', weekend: '周末', weekday: '工作日', all: '全天' };
export const KIND_NAMES: Record<AssetKind, string> = { equity: '美股', etf: 'ETF', crypto: '加密', metal: '贵金属', commodity: '大宗商品', private: '未上市', other: '其他' };

/** Var 的对手场所：Lighter RH 链与 Lighter 主网是两套独立的账户、目录、行情与市场编号。 */
export type Venue = 'rh' | 'lighter';
export const VENUES: readonly Venue[] = ['rh', 'lighter'];
export const VENUE_NAMES: Record<Venue, string> = { rh: 'Lighter RH', lighter: 'Lighter' };
/** 配对键「场所:代码」（如 rh:AAPL、lighter:BTC）：样本、参数、持仓与成交都按它区分，同一代码在两个场所是两个配对。 */
export const PAIR_KEY = /^(rh|lighter):([A-Z0-9]{1,20})$/;
export const pairKey = (venue: Venue, symbol: string): string => `${venue}:${symbol}`;
export function parsePairKey(key: string): { venue: Venue; symbol: string } | null {
  const match = PAIR_KEY.exec(key);
  return match ? { venue: match[1] as Venue, symbol: match[2] } : null;
}
/** 配对键里的代码；不是配对键时原样返回。 */
export const tickerOf = (key: string): string => parsePairKey(key)?.symbol ?? key;
export const venueOf = (key: string): Venue => parsePairKey(key)?.venue ?? 'rh';

/**
 * 两边合约规格已核对一致（同一标的、每股或每枚计价）的代码，2026-11-22 按两边公开目录（Var metadata/stats 的 name、
 * Lighter RH orderBookDetails 与平台的 underlying_tracking 说明）逐个比对；Lighter 主网与 RH 同一团队、同一套代码规则，
 * 主网独有的部分只收市值大、代码无歧义的加密与美股，2026-11-22 两边标记价都在 1% 以内。不在表里的共同代码记为「待确认」，
 * 页面确认前只采集、不进模拟盘；价格相差超过 IDENTITY_MAX_GAP_BPS 的直接排除（如 OPENAI：两边是不同的估值口径）。
 * 表对两个场所通用：代码含义由 Var 的合约说明决定，场所只影响 Lighter 一侧的市场编号与精度。
 */
export const KNOWN_KINDS: Readonly<Record<string, AssetKind>> = {
  BTC: 'crypto', ETH: 'crypto', SOL: 'crypto', HYPE: 'crypto', XRP: 'crypto', ZEC: 'crypto', NEAR: 'crypto', SUI: 'crypto',
  VVV: 'crypto', UNI: 'crypto', LINK: 'crypto', AAVE: 'crypto', XMR: 'crypto', TRX: 'crypto', ZRO: 'crypto', ENA: 'crypto',
  XPL: 'crypto', WLD: 'crypto',
  ADA: 'crypto', DOGE: 'crypto', BNB: 'crypto', AVAX: 'crypto', LTC: 'crypto', BCH: 'crypto', DOT: 'crypto', APT: 'crypto',
  ARB: 'crypto', OP: 'crypto', HBAR: 'crypto', XLM: 'crypto', TIA: 'crypto', SEI: 'crypto', TAO: 'crypto', ONDO: 'crypto',
  JUP: 'crypto', LDO: 'crypto', CRV: 'crypto', PENDLE: 'crypto', FIL: 'crypto', ICP: 'crypto', POL: 'crypto', WIF: 'crypto',
  TRUMP: 'crypto', PAXG: 'crypto', '1000PEPE': 'crypto', '1000BONK': 'crypto', '1000FLOKI': 'crypto',
  AAPL: 'equity', AMZN: 'equity', GOOGL: 'equity', META: 'equity', MSFT: 'equity', NVDA: 'equity', TSLA: 'equity', ORCL: 'equity',
  BABA: 'equity', BE: 'equity', USAR: 'equity', COIN: 'equity', CRCL: 'equity', AMD: 'equity', INTC: 'equity', MU: 'equity',
  CRWV: 'equity', PLTR: 'equity', MCD: 'equity', UBER: 'equity', BMNR: 'equity', TSM: 'equity', ASTS: 'equity', IREN: 'equity',
  SMCI: 'equity', SOFI: 'equity', AMC: 'equity', SNDK: 'equity', SKHY: 'equity',
  ARM: 'equity', ASML: 'equity', AVGO: 'equity', DELL: 'equity', GME: 'equity', HOOD: 'equity', IBM: 'equity', MRVL: 'equity',
  MSTR: 'equity', NBIS: 'equity', NOW: 'equity', QCOM: 'equity', RKLB: 'equity', TTWO: 'equity', MRNA: 'equity',
  QQQ: 'etf', SOXL: 'etf', IWM: 'etf', EWY: 'etf',
  XAU: 'metal', XAG: 'metal', XPD: 'metal', XPT: 'metal',
};
/**
 * 待确认代码的类别（只用于时段分组，不代表已核对）：SPCX 在 Var 是 SPAC 与新股 ETF，在 Lighter RH 登记为 Pre-IPO；
 * TENCENT 是港股，美股时段不适用，按「其他」；其余是主网上的小市值代币与个股。不在这里也不在已核对表里的按「其他」。
 */
export const REVIEW_KINDS: Readonly<Record<string, AssetKind>> = {
  SPCX: 'private', ANT: 'private', CASHCAT: 'crypto', PONS: 'crypto', USELESS: 'crypto',
  AAOI: 'equity', LITE: 'equity', CBRS: 'equity', STRC: 'equity', NATGAS: 'commodity',
  '0G': 'crypto', '2Z': 'crypto', AERO: 'crypto', APEX: 'crypto', ASTER: 'crypto', AVNT: 'crypto', AXS: 'crypto', AZTEC: 'crypto',
  BERA: 'crypto', BIO: 'crypto', CAP: 'crypto', CC: 'crypto', CRO: 'crypto', DASH: 'crypto', EIGEN: 'crypto', ETHFI: 'crypto',
  FARTCOIN: 'crypto', FOLKS: 'crypto', GMX: 'crypto', GRASS: 'crypto', JTO: 'crypto', KAITO: 'crypto', LINEA: 'crypto', MEGA: 'crypto',
  MNT: 'crypto', MON: 'crypto', MORPHO: 'crypto', NMR: 'crypto', PENGU: 'crypto', POPCAT: 'crypto', PYTH: 'crypto', QNT: 'crypto',
  RAY: 'crypto', RIVER: 'crypto', S: 'crypto', SKY: 'crypto', SPX: 'crypto', STABLE: 'crypto', STBL: 'crypto', STRK: 'crypto',
  SYRUP: 'crypto', VIRTUAL: 'crypto', WLFI: 'crypto', ZK: 'crypto', ZORA: 'crypto', WEN: 'crypto',
};
/** 两边标记价相差超过这个值（基点）就认定规格不同，不配对。 */
export const IDENTITY_MAX_GAP_BPS = 500;

export type Identity = 'verified' | 'review' | 'mismatch';
export interface VarListing { ticker: string; name: string; mark: number; fundingRate: number | null; fundingIntervalS: number | null; quote: VarQuote | null }
export interface VarQuote { at: number; bid0: number; ask0: number; bid1k: number; ask1k: number; bid100k: number | null; ask100k: number | null }
export interface RhMarket { symbol: string; marketId: number; mark: number | null; sizeDecimals: number; priceDecimals: number; minBase: number; minQuote: number; takerFeeBps: number | null; makerFeeBps: number | null }
/** 一个配对：key 是「场所:代码」，symbol 是两边共同的代码；rh 是该场所 Lighter 一侧的市场规格（字段名沿用 RH）。 */
export interface PairInfo { key: string; venue: Venue; symbol: string; name: string; kind: AssetKind; identity: Identity; gapBps: number | null; marketId: number; rh: RhMarket }

const SYMBOL = /^[A-Z0-9]{1,20}$/;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const decimal = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 64 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positive = (value: unknown): number | null => { const parsed = decimal(value); return parsed !== null && parsed > 0 ? parsed : null; };
function side(value: unknown): { bid: number; ask: number } | null {
  const row = object(value), bid = positive(row?.bid), ask = positive(row?.ask);
  return bid !== null && ask !== null && ask >= bid ? { bid, ask } : null;
}

/** Var 公开 metadata/stats 的报价：base、1k、100k 三档买卖价与报价时刻；缺档或倒挂的整条报价不用（100k 可以缺）。 */
export function parseVarQuote(value: unknown, receivedAt: number): VarQuote | null {
  const quotes = object(value);
  if (!quotes || typeof quotes.updated_at !== 'string') return null;
  const at = Date.parse(quotes.updated_at);
  // 报价时刻晚于本机收到时刻 5 秒以上说明时钟或数据有问题；早于 10 分钟的缓存报价不当行情。
  if (!Number.isFinite(at) || at > receivedAt + 5_000 || at < receivedAt - 600_000) return null;
  const base = side(quotes.base), small = side(quotes.size_1k), large = side(quotes.size_100k);
  if (!base || !small) return null;
  // 档位越大价差不会越窄；反过来说明这条报价不是同一时刻的。
  if (small.bid > base.bid || small.ask < base.ask) return null;
  if (large && (large.bid > small.bid || large.ask < small.ask)) return null;
  return { at, bid0: base.bid, ask0: base.ask, bid1k: small.bid, ask1k: small.ask, bid100k: large?.bid ?? null, ask100k: large?.ask ?? null };
}

/** metadata/stats 的 listings；无效行跳过，整体格式不对才抛错。funding_rate 按年化小数读（见 docs/varlighter.md 第 2 节）。 */
export function parseVarListings(input: unknown, receivedAt: number): VarListing[] {
  const listings = object(input)?.listings;
  if (!Array.isArray(listings)) throw new Error('Var 公开行情格式无效（缺 listings）');
  const result: VarListing[] = [];
  for (const raw of listings.slice(0, 5000)) {
    const row = object(raw);
    if (!row || typeof row.ticker !== 'string' || !SYMBOL.test(row.ticker)) continue;
    const mark = positive(row.mark_price);
    if (mark === null) continue;
    const rate = decimal(row.funding_rate), interval = decimal(row.funding_interval_s);
    result.push({ ticker: row.ticker, name: typeof row.name === 'string' ? row.name.slice(0, 80) : '', mark,
      fundingRate: rate !== null && Math.abs(rate) < 100 ? rate : null,
      fundingIntervalS: interval !== null && interval >= 3600 && interval <= 86_400 ? interval : null,
      quote: parseVarQuote(row.quotes, receivedAt) });
  }
  return result;
}

/** Lighter（RH 链或主网，两边接口相同）orderBookDetails 里在交易的永续；费率是百分数（0.0000 即 0%），换成基点。 */
export function parseRhMarkets(input: unknown, venue: Venue = 'rh'): RhMarket[] {
  const value = object(input);
  if (!value || value.code !== 200 || !Array.isArray(value.order_book_details)) throw new Error(`${VENUE_NAMES[venue]} 合约目录格式无效`);
  const result: RhMarket[] = [];
  for (const raw of value.order_book_details.slice(0, 2000)) {
    const row = object(raw);
    if (!row || row.market_type !== 'perp' || row.status !== 'active' || typeof row.symbol !== 'string' || !SYMBOL.test(row.symbol)) continue;
    if (!Number.isSafeInteger(row.market_id) || (row.market_id as number) < 0) continue;
    const sizeDecimals = row.supported_size_decimals ?? row.size_decimals, priceDecimals = row.supported_price_decimals ?? row.price_decimals;
    if (!Number.isInteger(sizeDecimals) || !Number.isInteger(priceDecimals) || (sizeDecimals as number) < 0 || (sizeDecimals as number) > 12 || (priceDecimals as number) < 0 || (priceDecimals as number) > 12) continue;
    const fee = (field: unknown) => { const percent = decimal(field); return percent !== null && percent >= 0 && percent <= 10 ? percent * 100 : null; };
    result.push({ symbol: row.symbol, marketId: row.market_id as number, mark: positive(row.mark_price), sizeDecimals: sizeDecimals as number, priceDecimals: priceDecimals as number,
      minBase: decimal(row.min_base_amount) ?? 0, minQuote: decimal(row.min_quote_amount) ?? 0, takerFeeBps: fee(row.taker_fee), makerFeeBps: fee(row.maker_fee) });
  }
  return result;
}

/** 同代码配对，按标记价差距与已核对表定身份；按代码、再按场所（RH 在前）排序。 */
export function pairMarkets(listings: readonly VarListing[], markets: readonly RhMarket[], venue: Venue = 'rh'): PairInfo[] {
  const byTicker = new Map(listings.map(item => [item.ticker, item]));
  const pairs: PairInfo[] = [];
  for (const rh of markets) {
    const listing = byTicker.get(rh.symbol);
    if (!listing) continue;
    const gapBps = rh.mark ? (listing.mark / rh.mark - 1) * 10_000 : null;
    const known = KNOWN_KINDS[rh.symbol], review = REVIEW_KINDS[rh.symbol];
    const identity: Identity = gapBps !== null && Math.abs(gapBps) > IDENTITY_MAX_GAP_BPS ? 'mismatch' : known ? 'verified' : 'review';
    pairs.push({ key: pairKey(venue, rh.symbol), venue, symbol: rh.symbol, name: listing.name, kind: known ?? review ?? 'other', identity, gapBps, marketId: rh.marketId, rh });
  }
  return sortPairs(pairs);
}
export const sortPairs = (pairs: PairInfo[]): PairInfo[] => pairs.sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : VENUES.indexOf(a.venue) - VENUES.indexOf(b.venue));

// ---- 时段 ----
const NEW_YORK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
let cachedMinute = -1, cachedClock: { day: number; minutes: number } = { day: 0, minutes: 0 };
/** 纽约当地的星期与当天分钟数（按分钟缓存一次格式化）。 */
export function newYorkClock(time: number): { day: number; minutes: number } {
  const minute = Math.floor(time / 60_000);
  if (minute === cachedMinute) return cachedClock;
  const parts = NEW_YORK.formatToParts(new Date(minute * 60_000));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  cachedMinute = minute;
  cachedClock = { day: WEEKDAYS[get('weekday')] ?? 0, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
  return cachedClock;
}

/**
 * 样本所属时段。美股与 ETF：周一至周五 9:30–16:00 盘中，4:00–9:30 与 16:00–20:00 盘前盘后，其余工作日时间夜盘，
 * 周五 20:00 至周日 20:00 周末；未上市与其他同美股（多数跟美股流动性走）。贵金属与大宗商品：周五 17:00 至周日 18:00 为周末。
 * 交易所假日不单列（已知限制，见文档第 9 节）。
 */
export function regimeOf(kind: AssetKind, time: number): Regime {
  if (kind === 'crypto') return 'all';
  const { day, minutes } = newYorkClock(time);
  if (kind === 'metal' || kind === 'commodity') {
    const weekend = day === 6 || (day === 5 && minutes >= 17 * 60) || (day === 0 && minutes < 18 * 60);
    return weekend ? 'weekend' : 'weekday';
  }
  if (day === 6 || (day === 5 && minutes >= 20 * 60) || (day === 0 && minutes < 20 * 60)) return 'weekend';
  if (day === 0) return 'overnight';
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'rth';
  if ((minutes >= 4 * 60 && minutes < 9 * 60 + 30) || (minutes >= 16 * 60 && minutes < 20 * 60)) return 'ext';
  return 'overnight';
}
export function regimesOf(kind: AssetKind): Regime[] {
  if (kind === 'crypto') return ['all'];
  if (kind === 'metal' || kind === 'commodity') return ['weekday', 'weekend'];
  return ['rth', 'ext', 'overnight', 'weekend'];
}

// ---- 样本与价差 ----
/** 一个对齐样本：Var 报价时刻 t 与该场所 Lighter 在 t 之前最近的盘口。档位价格缺失为 null。字段名的 rh 指 Lighter 一侧。 */
export interface Sample {
  /** 配对键「场所:代码」。 */ symbol: string;
  /** Var 报价时刻（毫秒）。 */ t: number;
  /** 本机收到 Var 报价的时刻。 */ receivedAt: number;
  regime: Regime;
  varMark: number; varBid0: number; varAsk0: number; varBid1k: number; varAsk1k: number; varBid100k: number | null; varAsk100k: number | null;
  /** 年化小数（推测口径），无则 null。 */ varFunding: number | null;
  /** 对齐所用 Lighter 盘口的时刻。 */ rhAt: number;
  rhBid0: number; rhAsk0: number; rhMark: number | null; rhIndex: number | null;
  /** 每小时资金费率（小数），正数多头付费。 */ rhFunding: number | null;
  /** 1k / 100k 美元的成交均价：对齐的一档价加上最近一次盘口快照里的冲击（见 feeds.ts）；没有快照时为 null。 */
  rhBid1k: number | null; rhAsk1k: number | null; rhBid100k: number | null; rhAsk100k: number | null;
  /**
   * 本机拿到这条 Var 报价、开始判断那一刻的 Lighter 一档（比 rhAt 晚约 20 秒以上）。模拟盘与回测按它成交并复核信号；
   * 行情流当时不可用或 v0.81.0 以前的样本为 null。
   */
  rhBidRx: number | null; rhAskRx: number | null;
  /** 判断时刻用 Var token 按名义金额询到的买卖价与 Var 给的报价时刻；没有 token、询价失败或该类别不询价时为 null（v0.82.0 起记录）。 */
  varBidTk: number | null; varAskTk: number | null; varTkAt: number | null;
}

/**
 * 按判断时刻的价重算的样本：Lighter 各档整体平移到那一刻的一档上（冲击沿用对齐时的）；Var 价在有 token 询价时换成询价，否则不变。
 * 没有记录那一刻的一档时返回 null。
 */
export function executionSample(sample: Sample): Sample | null {
  const bid = sample.rhBidRx, ask = sample.rhAskRx;
  if (bid === null || ask === null || !(bid > 0) || ask < bid) return null;
  const down = (value: number | null) => value === null ? null : bid - Math.max(0, sample.rhBid0 - value);
  const up = (value: number | null) => value === null ? null : ask + Math.max(0, value - sample.rhAsk0);
  const moved: Sample = { ...sample, rhBid0: bid, rhAsk0: ask, rhBid1k: down(sample.rhBid1k), rhAsk1k: up(sample.rhAsk1k), rhBid100k: down(sample.rhBid100k), rhAsk100k: up(sample.rhAsk100k) };
  // 有 Var token 询价时 Var 一侧也换成判断时刻的价：它是按这个配对的名义金额询的，所以各档都用它。
  const varBid = sample.varBidTk, varAsk = sample.varAskTk;
  if (varBid === null || varAsk === null || !(varBid > 0) || varAsk < varBid) return moved;
  return { ...moved, varBid0: varBid, varAsk0: varAsk, varBid1k: varBid, varAsk1k: varAsk, varBid100k: varBid, varAsk100k: varAsk };
}

/** 样本带不带可用的 Var token 询价。 */
export const hasTokenQuote = (sample: Sample): boolean => sample.varBidTk !== null && sample.varAskTk !== null && sample.varBidTk > 0 && sample.varAskTk >= sample.varBidTk;

export type SizeBucket = '1k' | '100k';
/** 名义金额对应的报价档：不超过 1000 美元用 1k 档，更大用 100k 档（偏保守）。 */
export const bucketOf = (notional: number): SizeBucket => notional <= 1000 ? '1k' : '100k';

export interface Spread {
  /** 两边中间价的基差（基点，相对 Lighter 中间价）：Var 贵为正。 */ mid: number;
  /** 卖 Var、买 Lighter 的可成交价差（基点）。 */ sellVar: number;
  /** 买 Var、卖 Lighter 的可成交价差（基点）。 */ buyVar: number;
  /** Lighter 一侧是否用一档价代替了按金额的成交均价。 */ estimated: boolean;
  prices: { varBid: number; varAsk: number; rhBid: number; rhAsk: number; rhMid: number };
}
export const midBasis = (sample: Sample): number => {
  const rhMid = (sample.rhBid0 + sample.rhAsk0) / 2;
  return ((sample.varBid0 + sample.varAsk0) / 2 / rhMid - 1) * 10_000;
};
/** 指定档位的可成交价差；100k 档在 Lighter 没有完整盘口时不可算（null）。 */
export function spreadOf(sample: Sample, bucket: SizeBucket): Spread | null {
  const rhMid = (sample.rhBid0 + sample.rhAsk0) / 2;
  let varBid: number | null, varAsk: number | null, rhBid: number | null, rhAsk: number | null, estimated = false;
  if (bucket === '1k') {
    varBid = sample.varBid1k; varAsk = sample.varAsk1k;
    rhBid = sample.rhBid1k; rhAsk = sample.rhAsk1k;
    if (rhBid === null || rhAsk === null) { rhBid = sample.rhBid0; rhAsk = sample.rhAsk0; estimated = true; }
  } else {
    varBid = sample.varBid100k; varAsk = sample.varAsk100k; rhBid = sample.rhBid100k; rhAsk = sample.rhAsk100k;
  }
  if (varBid === null || varAsk === null || rhBid === null || rhAsk === null || !(rhMid > 0)) return null;
  return { mid: midBasis(sample), sellVar: (varBid - rhAsk) / rhMid * 10_000, buyVar: (varAsk - rhBid) / rhMid * 10_000, estimated, prices: { varBid, varAsk, rhBid, rhAsk, rhMid } };
}
