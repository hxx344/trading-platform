// 资金费组合（docs/fundingbook.md）的场所默认值、账户与参数。页面每次保存整份参数，这里整份校验。
export const VENUE_SPECS = [
  { id: 'lighter', name: 'Lighter', quotes: ['USDC'], takerBps: 0, mmrPct: 2, maxLeverage: 10 },
  { id: 'bybit', name: 'Bybit', quotes: ['USDT'], takerBps: 5.5, mmrPct: 1, maxLeverage: 10 },
  { id: 'bitget', name: 'Bitget', quotes: ['USDT'], takerBps: 6, mmrPct: 1, maxLeverage: 10 },
  { id: 'okx', name: 'OKX', quotes: ['USDT'], takerBps: 5, mmrPct: 1, maxLeverage: 10 },
  { id: 'hyperliquid', name: 'Hyperliquid', quotes: ['USDC', 'USD'], takerBps: 4.5, mmrPct: 2, maxLeverage: 10 },
  { id: 'binance', name: 'Binance', quotes: ['USDT'], takerBps: 5, mmrPct: 1, maxLeverage: 10 },
] as const;
export type VenueId = typeof VENUE_SPECS[number]['id'];
export const venueSpec = (id: string) => VENUE_SPECS.find(spec => spec.id === id);

/** 小时收盘价按标的取一份（各场所同一标的的价格几乎相同），依次找第一个有这个标的的场所；Lighter 没有成交价历史接口。 */
export const PRICE_VENUES: readonly VenueId[] = ['binance', 'bybit', 'okx', 'bitget', 'hyperliquid'];

export interface Account {
  id: string;
  venue: VenueId;
  /** 维持保证金率（百分比），按持仓名义金额计。各所按档位递增，这里填本账户规模下的实际档位。 */
  mmrPct: number;
  maxLeverage: number;
  takerBps: number;
}

export interface Settings {
  enabled: boolean;
  /** 模拟盘的起始本金（美元）；改了要重置模拟盘才生效。 */
  capital: number;
  accounts: Account[];
  bases: string[];
  shortDays: number;
  longDays: number;
  /** 调整均值里短窗口的权重，其余给长窗口。 */
  shortWeight: number;
  volDays: number;
  /** 每个账户的权益减去维持保证金之后，至少是 1 日波动金额的这么多倍。 */
  safetySigma: number;
  horizonDays: number;
  slippageBps: number;
  reservePct: number;
  /** 全部账户持仓名义金额合计不超过本金的这么多倍。 */
  maxGrossLeverage: number;
  minLegUsd: number;
  roundMinutes: number;
  /** 每轮规划后按规划更新模拟盘；关闭时只出规划，模拟持仓不动。 */
  paperAuto: boolean;
}

const account = (id: string, venue: VenueId): Account => {
  const spec = venueSpec(venue)!;
  return { id, venue, mmrPct: spec.mmrPct, maxLeverage: spec.maxLeverage, takerBps: spec.takerBps };
};
export const DEFAULT_SETTINGS: Settings = {
  enabled: false, capital: 10_000,
  accounts: [account('lighter-1', 'lighter'), account('bybit-1', 'bybit'), account('bitget-1', 'bitget'), account('okx-1', 'okx')],
  bases: ['BTC', 'ETH', 'SOL', 'BNB'],
  shortDays: 9, longDays: 30, shortWeight: 0.5, volDays: 30, safetySigma: 5, horizonDays: 90,
  slippageBps: 2, reservePct: 5, maxGrossLeverage: 12, minLegUsd: 50, roundMinutes: 60, paperAuto: true,
};

export const MAX_ACCOUNTS = 8;
export const MAX_BASES = 12;
type NumericKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
const RANGES: Record<NumericKey, readonly [number, number, boolean, string]> = {
  capital: [100, 1e9, false, '本金'], shortDays: [1, 30, true, '短窗口天数'], longDays: [7, 90, true, '长窗口天数'],
  shortWeight: [0, 1, false, '短窗口权重'], volDays: [7, 90, true, '波动率窗口天数'], safetySigma: [1, 20, false, '安全距离倍数'],
  horizonDays: [7, 365, true, '持有期天数'], slippageBps: [0, 100, false, '滑点'], reservePct: [0, 50, false, '预留比例'],
  maxGrossLeverage: [0.5, 50, false, '总名义倍数上限'], minLegUsd: [1, 1e6, false, '最小单腿金额'], roundMinutes: [5, 1440, true, '规划间隔'],
};
const ACCOUNT_RANGES = { mmrPct: [0.1, 20, '维持保证金率'], maxLeverage: [1, 100, '最大杠杆'], takerBps: [0, 50, '吃单费率'] } as const;
const SETTING_KEYS = ['enabled', 'accounts', 'bases', 'paperAuto', ...Object.keys(RANGES)];

export class StateFormatError extends Error {
  readonly reason: 'structure' | 'unsupported';
  constructor(message: string, reason: 'structure' | 'unsupported' = 'structure') { super(message); this.reason = reason; }
}
export class SettingsError extends StateFormatError { override name = 'SettingsError'; }
export const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const BASE_ID = /^[A-Z0-9]{1,12}$/;
const inRange = (value: unknown, low: number, high: number, integer = false): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high && (!integer || Number.isInteger(value));

/** 校验一整份参数；多出的键、缺的键、越界的值都拒绝。 */
export function parseSettings(raw: unknown): Settings {
  const input = record(raw);
  if (!input) throw new SettingsError('参数须为对象');
  const unknown = Object.keys(input).filter(key => !SETTING_KEYS.includes(key));
  if (unknown.length) throw new SettingsError(`不认识的参数：${unknown.join('、').slice(0, 100)}`, 'unsupported');
  if (typeof input.enabled !== 'boolean' || typeof input.paperAuto !== 'boolean') throw new SettingsError('启用与模拟盘开关须为 true 或 false');
  const numbers = {} as Record<NumericKey, number>;
  for (const key of Object.keys(RANGES) as NumericKey[]) {
    const [low, high, integer, label] = RANGES[key];
    if (!inRange(input[key], low, high, integer)) throw new SettingsError(`${label}须为 ${low} 到 ${high} 之间的${integer ? '整数' : '数'}`);
    numbers[key] = input[key];
  }
  if (numbers.longDays < numbers.shortDays) throw new SettingsError('长窗口天数不能小于短窗口天数');
  if (!Array.isArray(input.accounts) || input.accounts.length > MAX_ACCOUNTS) throw new SettingsError(`账户须为列表，最多 ${MAX_ACCOUNTS} 个`);
  const accounts = input.accounts.map((item): Account => {
    const value = record(item);
    if (!value) throw new SettingsError('账户须为对象');
    if (Object.keys(value).some(key => !['id', 'venue', 'mmrPct', 'maxLeverage', 'takerBps'].includes(key))) throw new SettingsError('账户只含名称、场所、维持保证金率、最大杠杆与吃单费率', 'unsupported');
    if (typeof value.id !== 'string' || !ACCOUNT_ID.test(value.id)) throw new SettingsError('账户名称须为 1 到 24 位小写字母、数字或连字符');
    if (typeof value.venue !== 'string' || !venueSpec(value.venue)) throw new SettingsError(`账户 ${value.id} 的场所不在支持的列表里`);
    for (const key of Object.keys(ACCOUNT_RANGES) as (keyof typeof ACCOUNT_RANGES)[]) {
      const [low, high, label] = ACCOUNT_RANGES[key];
      if (!inRange(value[key], low, high)) throw new SettingsError(`账户 ${value.id} 的${label}须为 ${low} 到 ${high} 之间的数`);
    }
    return { id: value.id, venue: value.venue as VenueId, mmrPct: value.mmrPct as number, maxLeverage: value.maxLeverage as number, takerBps: value.takerBps as number };
  });
  if (new Set(accounts.map(item => item.id)).size !== accounts.length) throw new SettingsError('账户名称不能重复');
  if (!Array.isArray(input.bases) || input.bases.length > MAX_BASES) throw new SettingsError(`标的须为列表，最多 ${MAX_BASES} 个`);
  const bases = input.bases.map(base => {
    if (typeof base !== 'string' || !BASE_ID.test(base)) throw new SettingsError('标的须为 1 到 12 位大写字母或数字，例如 BTC');
    return base;
  });
  if (new Set(bases).size !== bases.length) throw new SettingsError('标的不能重复');
  if (input.enabled && (accounts.length < 2 || bases.length < 1)) throw new SettingsError('启用前至少要有 2 个账户和 1 个标的');
  return { enabled: input.enabled, paperAuto: input.paperAuto, accounts, bases, ...numbers };
}

/** 兼容既有读取契约中仅缺 paperAuto 的旧参数，其他必填项和未知字段均走整份校验。 */
export function storedSettings(raw: unknown): Settings {
  const input = record(raw);
  return parseSettings(input && !Object.hasOwn(input, 'paperAuto') ? { ...input, paperAuto: DEFAULT_SETTINGS.paperAuto } : raw);
}
