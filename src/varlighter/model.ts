// DEX 价差（docs/dexspread.md，原 Var/Lighter 价差 docs/varlighter.md）：两个场所两条腿的配对、交易时段和价差口径。
// 只放纯数据规则，采集（feeds.ts）、基线（stats.ts）、策略（strategy.ts）与页面共用；不发请求、不读写文件。
// A 腿、B 腿可以是任意两个不同的场所；基差 = A 中间价 ÷（乘数 × B 中间价）− 1。

/** 标的类别决定按哪套时段分组基线：美股与 ETF 按纽约时间的盘中、盘前盘后、夜盘、周末；贵金属分工作日与周末；其余不分。 */
export type AssetKind = 'equity' | 'etf' | 'crypto' | 'metal' | 'commodity' | 'private' | 'other';
export const ASSET_KINDS: readonly AssetKind[] = ['equity', 'etf', 'crypto', 'metal', 'commodity', 'private', 'other'];
export type Regime = 'rth' | 'ext' | 'overnight' | 'weekend' | 'weekday' | 'all';
export const REGIMES: readonly Regime[] = ['rth', 'ext', 'overnight', 'weekend', 'weekday', 'all'];
export const REGIME_NAMES: Record<Regime, string> = { rth: '美股盘中', ext: '盘前盘后', overnight: '美股夜盘', weekend: '周末', weekday: '工作日', all: '全天' };
export const KIND_NAMES: Record<AssetKind, string> = { equity: '美股', etf: 'ETF', crypto: '加密', metal: '贵金属', commodity: '大宗商品', private: '未上市', other: '其他' };

// ---- 场所 ----
/**
 * 场所：Var（Variational Omni，每分钟拉一次公开报价，报价自带时刻）；Lighter RH 链与 Lighter 主网（两套独立的账户、目录与行情流）；
 * Entropy（Hyperliquid HIP-3 的 `io` 市场）。后三个是实时行情流（live），Var 是轮询（polled）。
 */
export type VenueId = 'var' | 'rh' | 'lighter' | 'entropy';
export const VENUE_IDS: readonly VenueId[] = ['var', 'rh', 'lighter', 'entropy'];
/** 有实时行情流的场所（Var 之外）。 */
export type LiveVenue = Exclude<VenueId, 'var'>;
export const LIVE_VENUES: readonly LiveVenue[] = ['rh', 'lighter', 'entropy'];
export const VENUE_NAMES: Record<VenueId, string> = { var: 'Var', rh: 'Lighter RH', lighter: 'Lighter', entropy: 'Entropy' };
export const VENUE_SHORT: Record<VenueId, string> = { var: 'Var', rh: 'RH', lighter: '主网', entropy: 'Entropy' };
export const isLive = (venue: VenueId): venue is LiveVenue => venue !== 'var';
/** 兼容旧接口：v0.87.0 以前只有 Var 对两个 Lighter 场所，`Venue` 指 Lighter 一侧。 */
export type Venue = 'rh' | 'lighter';

/**
 * 自动配对的场所组合「A|B」：两个场所里同代码的永续自动成对（A 在前）。默认开 Var 对 RH、主网、Entropy 与主网对 Entropy；
 * RH 对主网、RH 对 Entropy 可在实盘准备页打开（docs/dexspread.md 第 4 节）。
 */
export type Combo = 'var|rh' | 'var|lighter' | 'var|entropy' | 'rh|lighter' | 'rh|entropy' | 'lighter|entropy';
export const COMBOS: readonly Combo[] = ['var|rh', 'var|lighter', 'var|entropy', 'rh|lighter', 'rh|entropy', 'lighter|entropy'];
export const DEFAULT_COMBOS: readonly Combo[] = ['var|rh', 'var|lighter', 'var|entropy', 'lighter|entropy'];
export const comboVenues = (combo: Combo): [VenueId, VenueId] => combo.split('|') as [VenueId, VenueId];
export const comboName = (combo: Combo): string => comboVenues(combo).map(venue => VENUE_NAMES[venue]).join(' ↔ ');

// ---- 配对键 ----
export interface Leg { venue: VenueId; symbol: string }
/** 腿的代码：Var 与 Lighter 是大写字母数字；Entropy 去掉 `io:` 前缀后同样写法（目录里有小写的也照收）。 */
export const LEG_SYMBOL = /^[A-Za-z0-9._-]{1,24}$/;
/** 乘数：B 一单位折成 A 的单位数（A 价 ≈ 乘数 × B 价），十进制文本，0.000001 到 1000000，最多 10 位有效数字。 */
export const RATIO_MIN = 0.000001, RATIO_MAX = 1_000_000;
const VENUE_PATTERN = VENUE_IDS.join('|');
/** 配对键「A场所:A代码|B场所:B代码」，乘数不是 1 时另带「@乘数」，如 `var:AAPL|rh:AAPL`、`var:OPENAI|entropy:OAI@0.137`。 */
export const PAIR_KEY = new RegExp(`^(${VENUE_PATTERN}):([A-Za-z0-9._-]{1,24})\\|(${VENUE_PATTERN}):([A-Za-z0-9._-]{1,24})(?:@(\\d{1,7}(?:\\.\\d{1,10})?))?$`);
/** v0.87.0 以前的配对键「场所:代码」：A 腿总是 Var。 */
export const LEGACY_KEY = /^(rh|lighter):([A-Z0-9]{1,20})$/;
// 10 位有效数字，再限到小数 10 位：键的写法（PAIR_KEY）最多 10 位小数，如 0.000001234567891 须写成 0.0000012346。
export const formatRatio = (ratio: number): string => String(Number(Number(ratio.toPrecision(10)).toFixed(10)));
export const legKey = (leg: Leg): string => `${leg.venue}:${leg.symbol}`;
export function pairKey(a: Leg, b: Leg, ratio = 1): string {
  return `${legKey(a)}|${legKey(b)}${ratio === 1 ? '' : `@${formatRatio(ratio)}`}`;
}
export interface ParsedKey { a: Leg; b: Leg; ratio: number }
export function parsePairKey(key: string): ParsedKey | null {
  const match = PAIR_KEY.exec(key);
  if (!match || match[1] === match[3]) return null;
  const ratio = match[5] === undefined ? 1 : Number(match[5]);
  // 乘数的写法唯一：键里的数字须与 formatRatio 的结果一致，1 不写，避免同一配对有两个键。
  if (match[5] !== undefined && (ratio === 1 || !(ratio >= RATIO_MIN && ratio <= RATIO_MAX) || formatRatio(ratio) !== match[5])) return null;
  return { a: { venue: match[1] as VenueId, symbol: match[2] }, b: { venue: match[3] as VenueId, symbol: match[4] }, ratio };
}
export const isPairKey = (key: string): boolean => parsePairKey(key) !== null;
/** 旧键 `rh:AAPL` → `var:AAPL|rh:AAPL`；新键原样；都不是返回 null。 */
export function upgradeKey(key: string): string | null {
  const legacy = LEGACY_KEY.exec(key);
  if (legacy) return pairKey({ venue: 'var', symbol: legacy[2] }, { venue: legacy[1] as Venue, symbol: legacy[2] });
  return isPairKey(key) ? key : null;
}
/** 新键对应的旧键（只有 Var 对 Lighter 两个场所、同代码、乘数 1 的有）：读 v0.87.0 以前的样本表用。 */
export function legacyKeyOf(key: string): string | null {
  const parsed = parsePairKey(key);
  if (!parsed || parsed.ratio !== 1 || parsed.a.venue !== 'var' || parsed.a.symbol !== parsed.b.symbol || !/^[A-Z0-9]{1,20}$/.test(parsed.a.symbol)) return null;
  return parsed.b.venue === 'rh' || parsed.b.venue === 'lighter' ? `${parsed.b.venue}:${parsed.a.symbol}` : null;
}
/** 页面与事件里的配对名：同代码写一次，否则「A / B」，乘数不是 1 时带「×乘数」。 */
export function pairTitle(key: string): string {
  const parsed = parsePairKey(key);
  if (!parsed) return key;
  const base = parsed.a.symbol === parsed.b.symbol ? parsed.a.symbol : `${parsed.a.symbol} / ${parsed.b.symbol}`;
  return parsed.ratio === 1 ? base : `${base} ×${formatRatio(parsed.ratio)}`;
}
export const pairVenues = (key: string): string => { const parsed = parsePairKey(key); return parsed ? `${VENUE_SHORT[parsed.a.venue]} ↔ ${VENUE_SHORT[parsed.b.venue]}` : ''; };

/**
 * 两边合约规格已核对一致（同一标的、每股或每枚计价）的代码，2026-11-22 按两边公开目录（Var metadata/stats 的 name、
 * Lighter RH orderBookDetails 与平台的 underlying_tracking 说明）逐个比对；Lighter 主网与 RH 同一团队、同一套代码规则，
 * 主网独有的部分只收市值大、代码无歧义的加密与美股，2026-11-22 两边标记价都在 1% 以内。不在表里的共同代码记为「待确认」，
 * 页面确认前只采集、不进模拟盘；价格相差超过 IDENTITY_MAX_GAP_BPS 的直接排除（如 OPENAI：两边是不同的估值口径）。
 * Entropy 一侧另要求在 ENTROPY_SHARES 里（见下）。
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
  OAI: 'private', ANTH: 'private', ANTHROPIC: 'private', TCNT: 'other', XIAOMI: 'other', SKHX: 'equity', DRAM: 'equity', GPRO: 'equity', IONQ: 'equity',
};
/**
 * Entropy 上按「每股」计价、已与别家股票合约逐个对过规格的代码（同 src/vendor/perpetual-additional-exchanges.mjs 的 ENTROPY_EQUITIES）。
 * 其余是 Entropy 独立合约（OAI、ANTH 是市值报价：1 美元代表 10 亿美元市值），自动配对只能是「待确认」，多数要手动配对并填乘数。
 */
export const ENTROPY_SHARES: ReadonlySet<string> = new Set(['SNDK', 'NBIS', 'GPRO', 'IONQ']);
/**
 * 自动配对的代码别名（docs/dexspread.md 第 10.4 节）：同一标的、同一计价单位，只是各场所代码不同。同组代码在自动配对里当作同代码，乘数 1；
 * 这样配出的配对一律「待确认」，按标记价相差超过 5% 时仍是「规格不同」。
 * ANTH（Entropy）与 ANTHROPIC（Lighter RH、主网）都按 10 亿股完全稀释估值报价（1 单位约 17.68 股）；Var 与 Lighter 的 ANT 是每股，不在这组。
 */
export const SYMBOL_ALIASES: readonly (readonly string[])[] = [['ANTHROPIC', 'ANTH']];
const ALIAS_GROUP = new Map(SYMBOL_ALIASES.flatMap((group, index) => group.map(symbol => [symbol, index] as const)));
/** 两个代码在自动配对里算不算同一标的：相同，或在同一别名组。 */
export const sameSymbol = (x: string, y: string): boolean => x === y || (ALIAS_GROUP.has(x) && ALIAS_GROUP.get(x) === ALIAS_GROUP.get(y));
/** 一个代码在自动配对里对得上的代码：自己在前，再是同组别名。 */
const matchSymbols = (symbol: string): readonly string[] => {
  const index = ALIAS_GROUP.get(symbol);
  return index === undefined ? [symbol] : [symbol, ...SYMBOL_ALIASES[index].filter(item => item !== symbol)];
};
/** 两边标记价（按乘数折算后）相差超过这个值（基点）就认定规格不同，不配对。 */
export const IDENTITY_MAX_GAP_BPS = 500;
export const kindOf = (symbol: string): AssetKind => KNOWN_KINDS[symbol] ?? REVIEW_KINDS[symbol] ?? 'other';

export type Identity = 'verified' | 'review' | 'mismatch';
export interface VarListing { ticker: string; name: string; mark: number; fundingRate: number | null; fundingIntervalS: number | null; quote: VarQuote | null }
export interface VarQuote { at: number; bid0: number; ask0: number; bid1k: number; ask1k: number; bid100k: number | null; ask100k: number | null }
/** Lighter（RH 或主网）目录的一个市场（字段名沿用 RH）。 */
export interface RhMarket { symbol: string; marketId: number; mark: number | null; sizeDecimals: number; priceDecimals: number; minBase: number; minQuote: number; takerFeeBps: number | null; makerFeeBps: number | null }
/**
 * 一个场所的一个市场：`id` 是行情流里的市场编号（Lighter 的 market_id、Entropy 目录里的序号；Var 为 0）；`coin` 是 Entropy 的完整代码（`io:AAPL`）。
 * 精度不知道时为 null（Var 没有公开精度）。`takerFeeBps` 取不到为 null。`fundingHourly` 是每小时资金费率（小数）。
 */
export interface MarketSpec {
  venue: VenueId; symbol: string; name: string; id: number; coin?: string;
  mark: number | null; index: number | null; fundingHourly: number | null;
  sizeDecimals: number | null; priceDecimals: number | null; minBase: number; minQuote: number; takerFeeBps: number | null;
  /** Entropy HIP-3 目录里的部署方系数与增长模式（供实盘返佣对账留档）。 */
  deployerFeeScale?: number | null; growthMode?: 'enabled' | 'disabled' | null;
}
export interface LegInfo extends Leg { market: MarketSpec }
/**
 * 一个配对：key 见 PAIR_KEY；symbol 是页面上的代码（同代码写一次，否则「A / B」）。custom 为手动配对（实盘准备页「配对管理」）。
 * `rh`、`marketId`、`venue` 是旧接口字段：B 腿是 Lighter 时为它的规格与场所，否则为 B 腿的。
 */
export interface PairInfo {
  key: string; a: LegInfo; b: LegInfo; ratio: number; symbol: string; name: string; kind: AssetKind; identity: Identity; gapBps: number | null;
  custom: boolean; note: string;
}

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
/** Var 的年化资金费（推测口径）折成每小时，与其他场所同一口径。 */
export const varHourly = (annual: number | null): number | null => annual === null ? null : annual / (365 * 24);
export const varMarket = (listing: VarListing): MarketSpec => ({
  venue: 'var', symbol: listing.ticker, name: listing.name, id: 0, mark: listing.mark, index: null, fundingHourly: varHourly(listing.fundingRate),
  sizeDecimals: null, priceDecimals: null, minBase: 0, minQuote: 0, takerFeeBps: 0,
});

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
export const lighterMarket = (venue: Venue, market: RhMarket): MarketSpec => ({
  venue, symbol: market.symbol, name: '', id: market.marketId, mark: market.mark, index: null, fundingHourly: null,
  sizeDecimals: market.sizeDecimals, priceDecimals: market.priceDecimals, minBase: market.minBase, minQuote: market.minQuote, takerFeeBps: market.takerFeeBps,
});

/**
 * Entropy（Hyperliquid HIP-3 `io`）目录与市场状态：`metaAndAssetCtxs`（dex=io）返回 [meta, ctxs]。下架的、抵押不是 USDC（collateralToken 0）的不收。
 * 手续费按 src/vendor/perpetual-additional-exchanges.mjs 同样的算法（API 基础档 4.5 基点 × 部署方系数 × 增长模式），字段缺失时为 null（不开仓）。
 */
export function parseEntropyMarkets(input: unknown): MarketSpec[] {
  if (!Array.isArray(input) || input.length !== 2) throw new Error('Entropy 目录格式无效');
  const meta = object(input[0]), contexts = input[1];
  if (!meta || !Array.isArray(meta.universe) || !Array.isArray(contexts)) throw new Error('Entropy 目录格式无效');
  if (meta.collateralToken !== 0) throw new Error('Entropy 抵押资产发生变化');
  const result: MarketSpec[] = [];
  meta.universe.slice(0, 500).forEach((raw, index) => {
    const item = object(raw), context = object(contexts[index]);
    if (!item || item.isDelisted === true || typeof item.name !== 'string' || !/^io:[A-Za-z0-9._-]{1,24}$/.test(item.name)) return;
    const sizeDecimals = item.szDecimals;
    if (!Number.isInteger(sizeDecimals) || (sizeDecimals as number) < 0 || (sizeDecimals as number) > 12) return;
    const scale = decimal(item.deployerFeeScale), growth = item.growthMode;
    const growthMode = growth === 'enabled' || growth === 'disabled' ? growth : null;
    const known = scale !== null && scale >= 0 && scale <= 3 && growthMode !== null;
    const takerFeeBps = known ? 4.5 * (scale < 1 ? 1 + scale : 2 * scale) * (growthMode === 'enabled' ? 0.1 : 1) : null;
    const funding = decimal(context?.funding);
    result.push({
      venue: 'entropy', symbol: item.name.slice(3), name: '', id: index, coin: item.name, mark: positive(context?.markPx), index: positive(context?.oraclePx),
      fundingHourly: funding !== null && Math.abs(funding) < 1 ? funding : null,
      // Hyperliquid 永续价格最多 5 位有效数字、小数位不超过 6 − szDecimals。
      sizeDecimals: sizeDecimals as number, priceDecimals: Math.max(0, 6 - (sizeDecimals as number)), minBase: 0, minQuote: 10, takerFeeBps,
      deployerFeeScale: scale, growthMode,
    });
  });
  return result;
}

/** 两腿标记价（B 按乘数折算）的差距，基点；任一边没有标记价为 null。 */
export function gapOf(a: MarketSpec, b: MarketSpec, ratio: number): number | null {
  return a.mark && b.mark ? (a.mark / (ratio * b.mark) - 1) * 10_000 : null;
}
/** 自动配对的规格身份：价差超过 5% 规格不同；已核对表里的、且 Entropy 一侧是每股合约的为已核对；其余待确认。 */
export function autoIdentity(symbol: string, a: MarketSpec, b: MarketSpec, gapBps: number | null): Identity {
  if (gapBps !== null && Math.abs(gapBps) > IDENTITY_MAX_GAP_BPS) return 'mismatch';
  const entropy = a.venue === 'entropy' || b.venue === 'entropy';
  return KNOWN_KINDS[symbol] && (!entropy || ENTROPY_SHARES.has(symbol)) ? 'verified' : 'review';
}
const comboRank = (key: string): number => { const parsed = parsePairKey(key); return parsed ? VENUE_IDS.indexOf(parsed.a.venue) * 10 + VENUE_IDS.indexOf(parsed.b.venue) : 99; };
/** 一个组合的自动配对：两个场所里代码相同（或在同一别名组，见 SYMBOL_ALIASES）的市场。 */
export function comboPairs(combo: Combo, aMarkets: readonly MarketSpec[], bMarkets: readonly MarketSpec[]): PairInfo[] {
  const bySymbol = new Map(bMarkets.map(market => [market.symbol, market]));
  const pairs: PairInfo[] = [];
  const [aVenue, bVenue] = comboVenues(combo);
  for (const a of aMarkets) {
    if (!LEG_SYMBOL.test(a.symbol)) continue;
    for (const symbol of matchSymbols(a.symbol)) {
      const b = bySymbol.get(symbol);
      if (!b) continue;
      const gapBps = gapOf(a, b, 1), key = pairKey({ venue: aVenue, symbol: a.symbol }, { venue: bVenue, symbol: b.symbol });
      const alias = a.symbol !== b.symbol;
      // 别名配对不进已核对表：价差超 5% 规格不同，否则待确认。
      const identity: Identity = !alias ? autoIdentity(a.symbol, a, b, gapBps) : gapBps !== null && Math.abs(gapBps) > IDENTITY_MAX_GAP_BPS ? 'mismatch' : 'review';
      const kind = kindOf(a.symbol) !== 'other' ? kindOf(a.symbol) : kindOf(b.symbol);
      pairs.push({
        key, a: { venue: aVenue, symbol: a.symbol, market: a }, b: { venue: bVenue, symbol: b.symbol, market: b },
        ratio: 1, symbol: alias ? pairTitle(key) : a.symbol, name: a.name || b.name, kind, identity, gapBps, custom: false, note: '',
      });
    }
  }
  return pairs;
}
/** 旧接口：Var listings 对一个 Lighter 场所的自动配对。 */
export function pairMarkets(listings: readonly VarListing[], markets: readonly RhMarket[], venue: Venue = 'rh'): PairInfo[] {
  return sortPairs(comboPairs(`var|${venue}`, listings.map(varMarket), markets.map(market => lighterMarket(venue, market))));
}
/** 手动配对的定义（存在参数里）：两腿、乘数、类别与备注。 */
export interface CustomPair { a: Leg; b: Leg; ratio: number; kind: AssetKind; note: string }
/** 手动配对：两腿都要在各自场所的目录里；按乘数折算后标记价差超过 5% 为规格不同，否则待确认（须人工确认才能启用）。 */
export function customPairInfo(custom: CustomPair, a: MarketSpec, b: MarketSpec): PairInfo {
  const gapBps = gapOf(a, b, custom.ratio);
  const identity: Identity = gapBps !== null && Math.abs(gapBps) > IDENTITY_MAX_GAP_BPS ? 'mismatch' : 'review';
  const key = pairKey(custom.a, custom.b, custom.ratio);
  return { key, a: { ...custom.a, market: a }, b: { ...custom.b, market: b }, ratio: custom.ratio, symbol: pairTitle(key), name: a.name || b.name, kind: custom.kind, identity, gapBps, custom: true, note: custom.note };
}
/** 按页面代码、再按组合（Var 对 RH 在前）排序。 */
export const sortPairs = (pairs: PairInfo[]): PairInfo[] => pairs.sort((x, y) => x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : comboRank(x.key) - comboRank(y.key) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

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
/** 样本导出（`GET /api/varlighter/samples`）的列顺序；由 Record 推出，Sample 加字段而这里漏写时类型检查报错。 */
const SAMPLE_FIELD_SET: Record<keyof Sample, true> = {
  symbol: true, t: true, receivedAt: true, regime: true, ratio: true,
  aAt: true, aMark: true, aIndex: true, aFunding: true, aBid0: true, aAsk0: true, aBid1k: true, aAsk1k: true, aBid100k: true, aAsk100k: true, aBidRx: true, aAskRx: true, aBidTk: true, aAskTk: true, aTkAt: true,
  bAt: true, bMark: true, bIndex: true, bFunding: true, bBid0: true, bAsk0: true, bBid1k: true, bAsk1k: true, bBid100k: true, bAsk100k: true, bBidRx: true, bAskRx: true, bBidTk: true, bAskTk: true, bTkAt: true,
  decisionAt: true, aRxAt: true, bRxAt: true, aTkQty: true, bTkQty: true, aTkReceivedAt: true, bTkReceivedAt: true, captureKind: true,
};
export const SAMPLE_FIELDS = Object.keys(SAMPLE_FIELD_SET) as (keyof Sample)[];
/** 两腿列格式。新增可空列追加在末尾，既有两腿缓存可按列名续拉。 */
export const SAMPLE_FORMAT = 2;

/**
 * 一个对齐样本：时刻 t 是较慢一腿的报价时刻（有 Var 的配对是 Var 报价时刻，两腿都是行情流时是本机采样时刻），
 * 另一腿取它的行情流在 t 之前最近的一档。价格都是各场所原始报价（B 腿没有乘过乘数）。档位缺失为 null。
 * `*Rx` 是本机开始判断那一刻该腿的一档（只有行情流腿有）；`*Tk` 是判断时刻按名义金额询到的价（只有 Var 腿、有 token 时有）。
 * 资金费都是每小时小数（Var 的年化按 365×24 折算），正数多头付费。
 */
export interface Sample {
  /** 配对键。 */ symbol: string;
  /** 样本时刻（毫秒）。 */ t: number;
  /** 本机收到较慢一腿报价的时刻。 */ receivedAt: number;
  regime: Regime;
  /** 乘数：A 价 ≈ 乘数 × B 价。 */ ratio: number;
  aAt: number; aMark: number | null; aIndex: number | null; aFunding: number | null;
  aBid0: number; aAsk0: number; aBid1k: number | null; aAsk1k: number | null; aBid100k: number | null; aAsk100k: number | null;
  aBidRx: number | null; aAskRx: number | null; aBidTk: number | null; aAskTk: number | null; aTkAt: number | null;
  bAt: number; bMark: number | null; bIndex: number | null; bFunding: number | null;
  bBid0: number; bAsk0: number; bBid1k: number | null; bAsk1k: number | null; bBid100k: number | null; bAsk100k: number | null;
  bBidRx: number | null; bAskRx: number | null; bBidTk: number | null; bAskTk: number | null; bTkAt: number | null;
  /** 异步采集结束后的决策时刻；旧样本没有这些证据。RxAt 是行情流一档最后确认时刻。 */
  decisionAt: number | null; aRxAt: number | null; bRxAt: number | null;
  /** 询价应答里经核对的该场所原始合约数量，以及本机收到应答的时刻。标的和场所在对应腿的配对键里。 */
  aTkQty: number | null; bTkQty: number | null; aTkReceivedAt: number | null; bTkReceivedAt: number | null;
  /** aligned 仅来自已证明不采决策盘口的原始旧表；无法区分的历史记录为 null。 */
  captureKind: 'decision' | 'aligned' | null;
}

type Side = 'a' | 'b';
/** 两腿都是行情流的配对（采样节拍不受 Var 限制，基线按分钟抽样）。 */
export const bothLive = (key: string): boolean => { const parsed = parsePairKey(key); return !!parsed && isLive(parsed.a.venue) && isLive(parsed.b.venue); };

export type SizeBucket = '1k' | '100k';
/** 名义金额对应的报价档：不超过 1000 美元用 1k 档，更大用 100k 档（偏保守）。 */
export const bucketOf = (notional: number): SizeBucket => notional <= 1000 ? '1k' : '100k';
/** 按数量折算的市值与名义金额相差不超过这个比例时，沿用名义金额的档位。 */
export const BUCKET_DRIFT = 0.2;
/**
 * 按实际数量取价的一条腿（持仓平仓与止损、Var 精确询价后的对冲腿）用哪一档：市值在名义金额 ±20% 以内沿用名义金额的档位，
 * 超出才按市值取档。1000 美元的仓正好在分档线上，价格涨一分钱市值就过线；不留这段余量，它的平仓与止损会按 10 万美元的盘口冲击算。
 */
export const sizeBucket = (usd: number, notionalUsd: number): SizeBucket =>
  bucketOf(Math.abs(usd - notionalUsd) <= notionalUsd * BUCKET_DRIFT ? notionalUsd : usd);

/**
 * 可成交价差。prices 里 B 腿的价已乘过乘数（折成 A 的单位），持仓数量按 A 的单位算；B 腿实际数量 = 数量 × 乘数，
 * 实际价格 = 折算价 ÷ 乘数。乘数为 1 时两者相同。
 */
export interface Spread {
  /** 两边中间价的基差（基点，相对折算后的 B 中间价）：A 贵为正。 */ mid: number;
  /** 卖 A、买 B 的可成交价差（基点）。 */ sellA: number;
  /** 买 A、卖 B 的可成交价差（基点）。 */ buyA: number;
  /** 有腿降档、使用历史盘口，或所需金额超出公开档位时为估算。 */ estimated: boolean;
  prices: { aBid: number; aAsk: number; bBid: number; bAsk: number; bMid: number };
  /** Var 成交价来源，0 表示公开一档。精确询价另带折算成 A 的实际数量。 */
  varSource?: VarPriceSource; varQtyA?: number;
}
export const midBasis = (sample: Sample): number => {
  const bMid = sample.ratio * ((sample.bBid0 + sample.bAsk0) / 2);
  return ((sample.aBid0 + sample.aAsk0) / 2 / bMid - 1) * 10_000;
};
interface LegPrice { bid: number; ask: number; mid: number; estimated: boolean }
function combineSpread(a: LegPrice, b: LegPrice, ratio: number): Spread {
  const bMid = ratio * b.mid, bBid = ratio * b.bid, bAsk = ratio * b.ask;
  return { mid: (a.mid / bMid - 1) * 10_000, sellA: (a.bid - bAsk) / bMid * 10_000, buyA: (a.ask - bBid) / bMid * 10_000,
    estimated: a.estimated || b.estimated, prices: { aBid: a.bid, aAsk: a.ask, bBid, bAsk, bMid } };
}
type Bucket = SizeBucket | '0';
export type VarPriceSource = 'token' | Bucket;

function publicLeg(sample: Sample, side: Side, bucket: SizeBucket, bid: number, ask: number, closing: boolean): (LegPrice & { bucket: Bucket }) | null {
  let used: Bucket = bucket;
  if (sample[`${side}Bid${used}`] === null || sample[`${side}Ask${used}`] === null) {
    if (bucket === '100k' && !closing) return null;
    used = sample[`${side}Bid1k`] !== null && sample[`${side}Ask1k`] !== null ? '1k' : '0';
  }
  // 对手腿盘口的冲击沿用对齐时刻，整体平移到选用的一档；历史报价的平移量为零。
  const filledBid = bid - Math.max(0, sample[`${side}Bid0`] - sample[`${side}Bid${used}`]!);
  const filledAsk = ask + Math.max(0, sample[`${side}Ask${used}`]! - sample[`${side}Ask0`]);
  if (!(filledBid > 0 && filledAsk >= filledBid)) return null;
  return { bid: filledBid, ask: filledAsk, mid: (bid + ask) / 2, estimated: used !== bucket, bucket: used };
}

/** 指定公共档位的可成交价差。开仓信号只看对齐样本，大档缺价时不能用小档发现信号。 */
export function spreadOf(sample: Sample, bucket: SizeBucket): Spread | null {
  const a = publicLeg(sample, 'a', bucket, sample.aBid0, sample.aAsk0, false);
  const b = publicLeg(sample, 'b', bucket, sample.bBid0, sample.bAsk0, false);
  return a && b ? combineSpread(a, b, sample.ratio) : null;
}

export interface QuoteTarget { notionalUsd: number; qty?: number; ratio?: number; symbol?: string }
/** Var 原生合约数量。新单按标记价取四位有效数字；持仓只用可精确表示的实际数量（B 腿为 A 数量乘乘数）。 */
export function varQuoteQty(target: QuoteTarget, side: Side, ratio: number, mark: number | null): string | null {
  const held = target.qty !== undefined;
  const raw = held ? target.qty! * (side === 'a' ? 1 : ratio) : target.notionalUsd / (mark ?? 0);
  if (!(raw > 0 && raw < 1e12)) return null;
  const rounded = held ? raw : Number(raw.toPrecision(4));
  if (rounded >= 1e12) return null;
  const text = rounded.toFixed(8).replace(/\.?0+$/, '');
  const qty = Number(text);
  if (!(qty > 0) || (held && Math.abs(qty - raw) > 2 * Number.EPSILON * raw)) return null;
  return text;
}

export const TOKEN_QUOTE_MAX_AGE_MS = 15_000;
interface FillLeg extends LegPrice { at: number | null; varSource?: VarPriceSource; varQtyA?: number }
function tokenFill(sample: Sample, side: Side, target: QuoteTarget): FillLeg | null {
  const qty = sample[`${side}TkQty`], bid = sample[`${side}BidTk`], ask = sample[`${side}AskTk`];
  if (qty === null || bid === null || ask === null || !(bid > 0 && ask >= bid)) return null;
  const at = sample[`${side}TkAt`], received = sample[`${side}TkReceivedAt`], decision = sample.decisionAt;
  if (at === null || received === null || decision === null || !(received <= decision && at <= received + 2_000 && decision - at <= TOKEN_QUOTE_MAX_AGE_MS)) return null;
  const expected = varQuoteQty(target, side, sample.ratio, sample[`${side}Mark`]);
  if (expected === null || qty !== Number(expected)) return null;
  return { bid, ask, mid: (bid + ask) / 2, at, estimated: false, varSource: 'token', varQtyA: side === 'a' ? qty : qty / sample.ratio };
}
function decisionTop(sample: Sample, side: Side): { bid: number; ask: number } | null {
  const bid = sample[`${side}BidRx`], ask = sample[`${side}AskRx`];
  return bid !== null && ask !== null && bid > 0 && ask >= bid ? { bid, ask } : null;
}
/** 仅用于解释该样本为何无法成交。 */
export function missingDecisionTop(sample: Sample): boolean {
  const pair = parsePairKey(sample.symbol);
  return !!pair && (['a', 'b'] as const).some(side => isLive(pair[side].venue) && !decisionTop(sample, side));
}
function fillLeg(sample: Sample, side: Side, venue: VenueId, target: QuoteTarget, execution: boolean, hedgeQtyA?: number): FillLeg | null {
  const closing = target.qty !== undefined;
  let bid = sample[`${side}Bid0`], ask = sample[`${side}Ask0`], at: number | null = sample[`${side}At`], missingTop = false;
  if (execution && venue === 'var') {
    const token = tokenFill(sample, side, target);
    if (token) return token;
  } else if (execution && isLive(venue)) {
    const top = decisionTop(sample, side);
    if (top) {
      bid = top.bid; ask = top.ask; at = sample[`${side}RxAt`];
    } else {
      if (!closing) return null;
      missingTop = true;
    }
  }
  const qtyA = target.qty ?? hedgeQtyA;
  const usd = qtyA === undefined ? target.notionalUsd : qtyA * (side === 'a' ? 1 : sample.ratio) * ((bid + ask) / 2);
  const level = publicLeg(sample, side, sizeBucket(usd, target.notionalUsd), bid, ask, closing);
  return level && { ...level, at, estimated: level.estimated || usd > 100_000 || missingTop || (execution && at === null),
    varSource: venue === 'var' ? level.bucket : undefined };
}

/** 逐腿选取目标数量的成交价与来源时刻。持仓缺完整盘口时可按公共小档估算；开仓必须有全部行情流腿的判断盘口。 */
export function targetSpread(sample: Sample, target: QuoteTarget, execution: boolean): { spread: Spread; oldestAt: number | null } | null {
  const pair = parsePairKey(sample.symbol);
  if (!pair || pair.ratio !== sample.ratio || (target.symbol !== undefined && target.symbol !== sample.symbol) || (target.ratio !== undefined && target.ratio !== sample.ratio)) return null;
  // 先决定 Var 腿是否按精确数量成交，对手腿再按实际对冲数量取公共档。无 Var 的配对照常从 A 开始。
  const first = pair.b.venue === 'var' ? 'b' : 'a', second = first === 'a' ? 'b' : 'a';
  const one = fillLeg(sample, first, pair[first].venue, target, execution);
  if (!one) return null;
  const two = fillLeg(sample, second, pair[second].venue, target, execution, one.varQtyA);
  const a = first === 'a' ? one : two, b = first === 'b' ? one : two;
  if (!a || !b) return null;
  const spread = combineSpread(a, b, sample.ratio), source = a.varSource ?? b.varSource, qty = a.varQtyA ?? b.varQtyA;
  if (source !== undefined) spread.varSource = source;
  if (qty !== undefined) spread.varQtyA = qty;
  return { spread, oldestAt: a.at === null || b.at === null ? null : Math.min(a.at, b.at) };
}
