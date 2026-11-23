// Var/Lighter 价差页（docs/varlighter.md 第 10 节）不依赖 DOM 的部分：读数格式、总览排序、参数表单到请求的转换、
// 走势图的行数据。由 web/test/varlighter-form.test.mjs 覆盖。
import type { Regime, Venue } from '../../../src/varlighter/model.ts';
import type { Direction, GlobalParams, SymbolParams } from '../../../src/varlighter/strategy.ts';
import type { Settings, StateRow, SymbolPoint } from '../../../src/varlighter/views.ts';
import type { VarLighterTab } from '../route-parse.ts';

export const VARLIGHTER_BASE = '/api/varlighter';
export type { VarLighterTab };
export const VARLIGHTER_TABS: readonly { id: VarLighterTab; label: string }[] = [
  { id: 'overview', label: '价差总览' }, { id: 'detail', label: '标的详情' }, { id: 'paper', label: '模拟盘' }, { id: 'ready', label: '实盘准备' },
];
/** 详情页地址里的是配对键「场所:代码」，只含字母数字与冒号，不需要转义。 */
export const varLighterHref = (tab: VarLighterTab, key?: string | null): string =>
  tab === 'overview' ? '#/varlighter' : tab === 'detail' ? `#/varlighter/detail${key ? `/${encodeURIComponent(key).replace(/%3A/g, ':')}` : ''}` : `#/varlighter/${tab}`;
/** Var 的对手场所（与 src/varlighter/model.ts 的 VENUES、VENUE_NAMES 一致；页面不引入后端模块的值）。 */
export const VENUE_OPTIONS: readonly { id: Venue; label: string; short: string }[] = [{ id: 'rh', label: 'Lighter RH', short: 'RH' }, { id: 'lighter', label: 'Lighter', short: '主网' }];
export const venueShort = (venue: Venue): string => VENUE_OPTIONS.find(item => item.id === venue)?.short ?? venue;
/** 配对键拆成代码与场所，用于成交、持仓等只带配对键的记录。 */
export function pairLabel(key: string): { symbol: string; venue: Venue | null; short: string } {
  const match = /^(rh|lighter):(.+)$/.exec(key);
  if (!match) return { symbol: key, venue: null, short: '' };
  const venue = match[1] as Venue;
  return { symbol: match[2]!, venue, short: venueShort(venue) };
}
/** 状态里的字节数（解码后的文本）折成每天的量，便于判断流量。 */
export function bytesPerDay(bytes: number, since: number | null, now: number): string {
  if (since === null || now - since < 60_000) return '—';
  const perDay = bytes / ((now - since) / 86_400_000);
  return perDay >= 1e9 ? `${(perDay / 1e9).toFixed(2)} GB/天` : `${(perDay / 1e6).toFixed(0)} MB/天`;
}

export const REGIME_LABELS: Record<Regime, string> = { rth: '美股盘中', ext: '盘前盘后', overnight: '美股夜盘', weekend: '周末', weekday: '工作日', all: '全天' };
export const ALL_REGIMES: readonly Regime[] = ['rth', 'ext', 'overnight', 'weekend', 'weekday', 'all'];
export const DIRECTION_LABELS: Record<Direction, string> = { var_rich: '卖 Var · 买 Lighter', var_cheap: '买 Var · 卖 Lighter' };
/** 表格里的简写：对手腿总是反向，只写 Var 一侧。 */
export const DIRECTION_SHORT: Record<Direction, string> = { var_rich: '卖 Var', var_cheap: '买 Var' };
export const ALL_DIRECTIONS: readonly Direction[] = ['var_rich', 'var_cheap'];
export const REASON_LABELS: Record<string, string> = { revert: '回归平仓', stop: '止损', timeout: '超时平仓', manual: '手动平仓' };
export const IDENTITY_LABELS: Record<string, string> = { verified: '已核对', review: '待确认', mismatch: '规格不同' };

// ---- 读数 ----
const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
/** 基点，带正负号。 */
export const bps = (value: number | null | undefined, digits = 1): string => finite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(digits)}` : '—';
export const plain = (value: number | null | undefined, digits = 1): string => finite(value) ? value.toFixed(digits) : '—';
export const usd = (value: number | null | undefined, digits = 2): string => {
  if (!finite(value)) return '—';
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${value < 0 ? '−' : ''}$${text}`;
};
export const signedUsd = (value: number | null | undefined, digits = 2): string => finite(value) ? `${value > 0 ? '+' : ''}${usd(value, digits)}` : '—';
export const percent = (value: number | null | undefined, digits = 0): string => finite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
/** 价格保留 6 位有效数字。 */
export const price = (value: number | null | undefined): string => finite(value) ? Number(value.toPrecision(6)).toString() : '—';
export function duration(ms: number | null | undefined): string {
  if (!finite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  return `${(minutes / 1440).toFixed(1)} 天`;
}
export function age(at: number | null | undefined, now: number): string {
  if (!finite(at)) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return `${seconds} 秒前`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86_400)} 天前`;
}
/** 两边资金费统一折成年化百分比：Var 公开口径是年化小数，Lighter 是每小时小数。 */
export function fundingAnnual(varAnnual: number | null, rhHourly: number | null): { var: string; rh: string } {
  return { var: finite(varAnnual) ? `${(varAnnual * 100).toFixed(1)}%` : '—', rh: finite(rhHourly) ? `${(rhHourly * 24 * 365 * 100).toFixed(1)}%` : '—' };
}
export const tone = (value: number | null | undefined): 'up' | 'down' | '' => !finite(value) || value === 0 ? '' : value > 0 ? 'up' : 'down';

// ---- 总览 ----
/** 离入场最近的一侧：偏离减去入场阈值，≥ 0 表示已达到开仓条件（还要过风控）。 */
export function signal(row: Pick<StateRow, 'rich' | 'cheap' | 'entryBps'>): { direction: Direction; deviation: number; gap: number } | null {
  const rich = row.rich, cheap = row.cheap;
  if (!finite(rich) && !finite(cheap)) return null;
  const direction: Direction = !finite(cheap) || (finite(rich) && rich >= cheap) ? 'var_rich' : 'var_cheap';
  const deviation = direction === 'var_rich' ? rich! : cheap!;
  return { direction, deviation, gap: deviation - row.entryBps };
}

export type SortKey = 'symbol' | 'mid' | 'z' | 'gap' | 'cost' | 'samples' | 'kind';
export const SORT_LABELS: Record<SortKey, string> = { gap: '离入场', z: '偏离 σ', mid: '中间价基差', cost: '往返成本', samples: '24h 样本', symbol: '标的', kind: '类别' };
/** 排序：缺数的行总在最后；同值按标的代码。 */
export function sortRows(rows: readonly StateRow[], key: SortKey, descending: boolean): StateRow[] {
  const value = (row: StateRow): number | string | null => {
    switch (key) {
      case 'symbol': return row.symbol;
      case 'kind': return row.kind;
      case 'mid': return row.mid;
      case 'z': return finite(row.z) ? Math.abs(row.z) : null;
      case 'gap': return signal(row)?.gap ?? null;
      case 'cost': return row.cost;
      case 'samples': return row.samples24h;
    }
  };
  return [...rows].sort((a, b) => {
    const x = value(a), y = value(b);
    if (x === null && y === null) return a.symbol.localeCompare(b.symbol);
    if (x === null) return 1;
    if (y === null) return -1;
    const order = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
    return (descending ? -order : order) || a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key);
  });
}
export function matchesQuery(row: Pick<StateRow, 'symbol' | 'name'>, query: string): boolean {
  const text = query.trim().toUpperCase();
  return !text || row.symbol.includes(text) || row.name.toUpperCase().includes(text);
}
export type VenueFilter = Venue | 'all';
export const matchesVenue = (row: Pick<StateRow, 'venue'>, filter: VenueFilter): boolean => filter === 'all' || row.venue === filter;

// ---- 参数表单 ----
type NumberField<K extends string> = { key: K; label: string; min: number; max: number; integer?: boolean; unit: string; hint?: string };
export const SYMBOL_FIELDS: readonly NumberField<Exclude<keyof SymbolParams, 'enabled' | 'regimes' | 'directions'>>[] = [
  { key: 'notionalUsd', label: '每笔名义金额', min: 10, max: 100_000, unit: '美元', hint: '≤ 1000 用 1k 档报价，以上用 100k 档（需要 Lighter 完整盘口）' },
  { key: 'entryBps', label: '入场偏离', min: 0.5, max: 2000, unit: '基点', hint: '可成交价差偏离基线中位数至少这么多才开仓' },
  { key: 'exitBps', label: '出场偏离', min: -500, max: 500, unit: '基点', hint: '中间价基差回到基线 ± 这么多以内平仓；须小于入场偏离' },
  { key: 'stopBps', label: '止损', min: 1, max: 5000, unit: '基点', hint: '按可成交价算的浮亏' },
  { key: 'maxHoldMinutes', label: '最长持有', min: 1, max: 43_200, integer: true, unit: '分钟' },
  { key: 'cooldownMinutes', label: '平仓后冷却', min: 0, max: 1440, integer: true, unit: '分钟' },
];
export const GLOBAL_FIELDS: readonly NumberField<Exclude<keyof GlobalParams, 'paused'>>[] = [
  { key: 'windowHours', label: '基线窗口', min: 1, max: 720, integer: true, unit: '小时', hint: '修改后各标的基线按新窗口重建' },
  { key: 'minSamples', label: '基线最少样本', min: 10, max: 50_000, integer: true, unit: '个', hint: '同时段样本不足时改用全天基线，只展示、不开仓' },
  { key: 'slippageBps', label: '滑点', min: 0, max: 100, unit: '基点 / 每腿每次' },
  { key: 'varFeeBps', label: 'Var 手续费', min: 0, max: 100, unit: '基点' },
  { key: 'rhFeeBps', label: 'Lighter 手续费', min: 0, max: 100, unit: '基点' },
  { key: 'maxQuoteAgeSec', label: '报价时效上限', min: 5, max: 600, integer: true, unit: '秒', hint: '收到时 Var 报价已过去的时间，超过不开仓' },
  { key: 'minNetBps', label: '最低预期净利', min: 0, max: 500, unit: '基点', hint: '偏离 − 出场 − 半个往返成本 − 滑点与手续费，低于这个数不开仓' },
  { key: 'maxOpenPositions', label: '最多持仓数', min: 1, max: 100, integer: true, unit: '笔' },
  { key: 'maxTotalNotionalUsd', label: '名义合计上限', min: 10, max: 10_000_000, unit: '美元' },
  { key: 'dailyLossLimitUsd', label: '当日亏损上限', min: 1, max: 10_000_000, unit: '美元', hint: '按 UTC 日计' },
];

export type SymbolForm = { enabled: boolean; regimes: Regime[]; directions: Direction[] } & Record<(typeof SYMBOL_FIELDS)[number]['key'], string>;
export type GlobalForm = { paused: boolean } & Record<(typeof GLOBAL_FIELDS)[number]['key'], string>;

const text = (value: number) => String(value);
export function symbolForm(params: SymbolParams): SymbolForm {
  const form = { enabled: params.enabled, regimes: [...params.regimes], directions: [...params.directions] } as SymbolForm;
  for (const field of SYMBOL_FIELDS) form[field.key] = text(params[field.key]);
  return form;
}
export function globalForm(params: GlobalParams): GlobalForm {
  const form = { paused: params.paused } as GlobalForm;
  for (const field of GLOBAL_FIELDS) form[field.key] = text(params[field.key]);
  return form;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
function readNumber<K extends string>(field: NumberField<K>, raw: string): Parsed<number> {
  const trimmed = raw.trim();
  const value = trimmed === '' ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, error: `${field.label}须填数字` };
  if (value < field.min || value > field.max) return { ok: false, error: `${field.label}须在 ${field.min} 到 ${field.max} 之间` };
  if (field.integer && !Number.isInteger(value)) return { ok: false, error: `${field.label}须为整数` };
  return { ok: true, value };
}
/** 表单 → 标的参数（与服务端 readSymbolParams 同样的范围；服务端仍会再校验）。 */
export function symbolRequest(form: SymbolForm): Parsed<SymbolParams> {
  const out = { enabled: form.enabled, regimes: ALL_REGIMES.filter(item => form.regimes.includes(item)), directions: ALL_DIRECTIONS.filter(item => form.directions.includes(item)) } as SymbolParams;
  for (const field of SYMBOL_FIELDS) {
    const parsed = readNumber(field, form[field.key]);
    if (!parsed.ok) return parsed;
    out[field.key] = parsed.value;
  }
  if (out.exitBps >= out.entryBps) return { ok: false, error: '出场偏离须小于入场偏离' };
  if (!out.regimes.length) return { ok: false, error: '至少选择一个时段' };
  if (!out.directions.length) return { ok: false, error: '至少选择一个方向' };
  return { ok: true, value: out };
}
export function globalRequest(form: GlobalForm): Parsed<GlobalParams> {
  const out = { paused: form.paused } as GlobalParams;
  for (const field of GLOBAL_FIELDS) {
    const parsed = readNumber(field, form[field.key]);
    if (!parsed.ok) return parsed;
    out[field.key] = parsed.value;
  }
  return { ok: true, value: out };
}

/** 保存参数的请求体：总带当前版本号，服务端发现版本已变时拒绝（409），页面刷新后重填。 */
export function settingsBody(settings: Pick<Settings, 'revision'>, change: { symbol?: { symbol: string; params: SymbolParams }; global?: GlobalParams; confirmed?: string[]; venues?: Venue[] }): Record<string, unknown> {
  const body: Record<string, unknown> = { revision: settings.revision };
  if (change.venues) body.venues = VENUE_OPTIONS.map(item => item.id).filter(venue => change.venues!.includes(venue));
  if (change.symbol) body.symbols = { [change.symbol.symbol]: change.symbol.params };
  if (change.global) body.global = change.global;
  if (change.confirmed) body.confirmed = [...new Set(change.confirmed)].sort();
  return body;
}
export const toggleConfirmed = (confirmed: readonly string[], symbol: string, on: boolean): string[] =>
  on ? [...new Set([...confirmed, symbol])].sort() : confirmed.filter(item => item !== symbol);

export const BACKTEST_HOURS: readonly number[] = [24, 72, 168, 336];
/** 回测请求：表单参数与当前全局参数一起发，服务端按这份参数重放，不改已保存的参数。 */
export function backtestBody(symbol: string, hours: number, form: SymbolForm, global: GlobalParams): Parsed<Record<string, unknown>> {
  if (!Number.isInteger(hours) || hours < 1 || hours > 336) return { ok: false, error: '回测时长须为 1 到 336 小时' };
  const params = symbolRequest({ ...form, enabled: true });
  if (!params.ok) return params;
  const { enabled: _enabled, ...rest } = params.value;
  return { ok: true, value: { symbol, hours, params: rest, global } };
}

// ---- 走势图 ----
export interface ChartRow { time: number; mid: number | null; sellVar: number | null; buyVar: number | null; median: number | null; upper: number | null; lower: number | null }
/** 走势图的行：入场线是基线中位数 ± 入场偏离，卖 Var 价差越过上线或买 Var 价差跌破下线即达到开仓条件。 */
export function chartRows(points: readonly SymbolPoint[], entryBps: number): ChartRow[] {
  return points.map(point => ({
    time: point.t, mid: point.mid, sellVar: point.sellVar, buyVar: point.buyVar, median: point.median,
    upper: point.median === null ? null : point.median + entryBps, lower: point.median === null ? null : point.median - entryBps,
  }));
}
/** 纵轴范围取所有可见序列的 1–99 分位，避免单个跳点把曲线压扁。 */
export function chartRange(rows: readonly ChartRow[]): [number, number] | null {
  const values: number[] = [];
  for (const row of rows) for (const value of [row.mid, row.sellVar, row.buyVar, row.upper, row.lower]) if (finite(value)) values.push(value);
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))]!;
  return values.length < 50 ? [values[0]!, values.at(-1)!] : [at(0.01), at(0.99)];
}
export const clamp = (value: number, [low, high]: readonly [number, number]): number => Math.min(high, Math.max(low, value));
