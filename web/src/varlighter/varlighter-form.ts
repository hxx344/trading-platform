// DEX 价差页（docs/varlighter.md 第 10 节、docs/dexspread.md 第 7 节）不依赖 DOM 的部分：读数格式、总览排序、参数表单到请求的转换、
// 配对键与场所名、手动配对的表单、走势图的行数据。由 web/test/varlighter-form.test.mjs 覆盖。
import type { AssetKind, Combo, CustomPair, Regime, VarPriceSource, VenueId } from '../../../src/varlighter/model.ts';
import type { Direction, GlobalParams, SymbolParams } from '../../../src/varlighter/strategy.ts';
import type { Settings, StateRow, SymbolPoint } from '../../../src/varlighter/views.ts';
import type { VarLighterTab } from '../route-parse.ts';

export const VARLIGHTER_BASE = '/api/varlighter';
export const VAR_QUOTE_LABELS: Record<VarPriceSource, string> = { token: '按量询价', '0': '公开一档', '1k': '公开 1 千美元档', '100k': '公开 10 万美元档' };
export type { VarLighterTab };
export const VARLIGHTER_TABS: readonly { id: VarLighterTab; label: string }[] = [
  { id: 'overview', label: '价差总览' }, { id: 'detail', label: '标的详情' }, { id: 'paper', label: '模拟盘' }, { id: 'ready', label: '实盘准备' },
];
/** 详情页地址里的是配对键「场所:代码|场所:代码[@乘数]」：冒号、竖线与 @ 在地址片段里合法，保留原样便于阅读。 */
export const varLighterHref = (tab: VarLighterTab, key?: string | null): string =>
  tab === 'overview' ? '#/varlighter' : tab === 'detail' ? `#/varlighter/detail${key ? `/${encodeURIComponent(key).replace(/%3A/g, ':').replace(/%7C/g, '|').replace(/%40/g, '@')}` : ''}` : `#/varlighter/${tab}`;
/** 场所（与 src/varlighter/model.ts 的 VENUE_IDS、VENUE_NAMES、VENUE_SHORT 一致；页面不引入后端模块的值）。 */
export const VENUE_OPTIONS: readonly { id: VenueId; label: string; short: string }[] = [
  { id: 'var', label: 'Var', short: 'Var' }, { id: 'rh', label: 'Lighter RH', short: 'RH' }, { id: 'lighter', label: 'Lighter', short: '主网' }, { id: 'entropy', label: 'Entropy', short: 'Entropy' },
];
export const venueShort = (venue: VenueId): string => VENUE_OPTIONS.find(item => item.id === venue)?.short ?? venue;
export const venueLabel = (venue: VenueId): string => VENUE_OPTIONS.find(item => item.id === venue)?.label ?? venue;
/** 自动配对的场所组合（与 model.ts 的 COMBOS 同序）。 */
export const COMBO_OPTIONS: readonly Combo[] = ['var|rh', 'var|lighter', 'var|entropy', 'rh|lighter', 'rh|entropy', 'lighter|entropy'];
export const comboLabel = (combo: Combo): string => { const [a, b] = combo.split('|') as [VenueId, VenueId]; return `${venueLabel(a)} ↔ ${venueLabel(b)}`; };
export const comboShort = (combo: Combo): string => { const [a, b] = combo.split('|') as [VenueId, VenueId]; return `${venueShort(a)}↔${venueShort(b)}`; };
const LEG = /^(var|rh|lighter|entropy):([A-Za-z0-9._-]{1,24})$/;
/** 配对键拆成两腿：用于成交、持仓等只带配对键的记录；认不出时 a、b 为 null。 */
export function pairLabel(key: string): { symbol: string; a: VenueId | null; b: VenueId | null; short: string; ratio: number } {
  const [body = '', ratioText] = key.split('@');
  const [left, right] = body.split('|');
  const a = left ? LEG.exec(left) : null, b = right ? LEG.exec(right) : null;
  if (!a || !b) return { symbol: key, a: null, b: null, short: '', ratio: 1 };
  const ratio = ratioText ? Number(ratioText) : 1;
  const symbol = `${a[2] === b[2] ? a[2] : `${a[2]} / ${b[2]}`}${ratio !== 1 ? ` ×${ratioText}` : ''}`;
  return { symbol, a: a[1] as VenueId, b: b[1] as VenueId, short: `${venueShort(a[1] as VenueId)}↔${venueShort(b[1] as VenueId)}`, ratio };
}
/** 状态里的字节数（解码后的文本）折成每天的量，便于判断流量。 */
export function bytesPerDay(bytes: number, since: number | null, now: number): string {
  if (since === null || now - since < 60_000) return '—';
  const perDay = bytes / ((now - since) / 86_400_000);
  return perDay >= 1e9 ? `${(perDay / 1e9).toFixed(2)} GB/天` : `${(perDay / 1e6).toFixed(0)} MB/天`;
}

export const REGIME_LABELS: Record<Regime, string> = { rth: '美股盘中', ext: '盘前盘后', overnight: '美股夜盘', weekend: '周末', weekday: '工作日', all: '全天' };
export const ALL_REGIMES: readonly Regime[] = ['rth', 'ext', 'overnight', 'weekend', 'weekday', 'all'];
export const DIRECTION_LABELS: Record<Direction, string> = { a_rich: '卖 A · 买 B', a_cheap: '买 A · 卖 B' };
export const ALL_DIRECTIONS: readonly Direction[] = ['a_rich', 'a_cheap'];
/** 带场所名的方向：卖 Var · 买 RH。 */
export const directionLabel = (direction: Direction, a: VenueId | null, b: VenueId | null): string =>
  a && b ? direction === 'a_rich' ? `卖 ${venueShort(a)} · 买 ${venueShort(b)}` : `买 ${venueShort(a)} · 卖 ${venueShort(b)}` : DIRECTION_LABELS[direction];
/** 表格里的简写：B 腿总是反向，只写 A 一侧。 */
export const directionShort = (direction: Direction, a: VenueId | null): string => `${direction === 'a_rich' ? '卖' : '买'} ${a ? venueShort(a) : 'A'}`;
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
/** 两腿资金费（都已是每小时小数，Var 的年化在后端折过）折成年化百分比。 */
export function fundingAnnual(aHourly: number | null, bHourly: number | null): { a: string; b: string } {
  const annual = (value: number | null) => finite(value) ? `${(value * 24 * 365 * 100).toFixed(1)}%` : '—';
  return { a: annual(aHourly), b: annual(bHourly) };
}
export const tone = (value: number | null | undefined): 'up' | 'down' | '' => !finite(value) || value === 0 ? '' : value > 0 ? 'up' : 'down';

// ---- 总览 ----
/** 离入场最近的一侧：偏离减去入场阈值，≥ 0 表示已达到开仓条件（还要过风控）。 */
export function signal(row: Pick<StateRow, 'rich' | 'cheap' | 'entryBps'>): { direction: Direction; deviation: number; gap: number } | null {
  const rich = row.rich, cheap = row.cheap;
  if (!finite(rich) && !finite(cheap)) return null;
  const direction: Direction = !finite(cheap) || (finite(rich) && rich >= cheap) ? 'a_rich' : 'a_cheap';
  const deviation = direction === 'a_rich' ? rich! : cheap!;
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
  return !text || row.symbol.toUpperCase().includes(text) || row.name.toUpperCase().includes(text);
}
/** 总览的组合筛选：全部、某个自动组合（只含该组合的自动配对），或手动配对。 */
export type ComboFilter = Combo | 'custom' | 'all';
export const rowCombo = (row: Pick<StateRow, 'a' | 'b'>): string => `${row.a.venue}|${row.b.venue}`;
export const matchesCombo = (row: Pick<StateRow, 'a' | 'b' | 'custom'>, filter: ComboFilter): boolean =>
  filter === 'all' || (filter === 'custom' ? row.custom : !row.custom && rowCombo(row) === filter);

// ---- 参数表单 ----
type NumberField<K extends string> = { key: K; label: string; min: number; max: number; integer?: boolean; unit: string; hint?: string; /** 可留空（null） */ optional?: boolean };
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
  { key: 'varFeeBps', label: 'Var 手续费', min: 0, max: 100, unit: '基点', optional: true, hint: '留空按目录费率（Var 目录为 0）' },
  { key: 'rhFeeBps', label: 'Lighter RH 手续费', min: 0, max: 100, unit: '基点', optional: true, hint: '留空按目录费率' },
  { key: 'lighterFeeBps', label: 'Lighter 主网手续费', min: 0, max: 100, unit: '基点', optional: true, hint: '留空按目录费率' },
  { key: 'entropyFeeBps', label: 'Entropy 手续费', min: 0, max: 100, unit: '基点', optional: true, hint: '留空按目录费率（按部署方费率与增长模式折算）；两者都取不到不开仓' },
  { key: 'maxQuoteAgeSec', label: '报价时效上限', min: 5, max: 600, integer: true, unit: '秒', hint: '收到时较慢一腿的报价已过去的时间，超过不开仓' },
  { key: 'minNetBps', label: '最低预期净利', min: 0, max: 500, unit: '基点', hint: '偏离 − 出场 − 半个往返成本 − 滑点与手续费，低于这个数不开仓' },
  { key: 'maxOpenPositions', label: '最多持仓数', min: 1, max: 100, integer: true, unit: '笔' },
  { key: 'maxTotalNotionalUsd', label: '名义合计上限', min: 10, max: 10_000_000, unit: '美元' },
  { key: 'dailyLossLimitUsd', label: '当日亏损上限', min: 1, max: 10_000_000, unit: '美元', hint: '按 UTC 日计' },
];

export type SymbolForm = { enabled: boolean; regimes: Regime[]; directions: Direction[] } & Record<(typeof SYMBOL_FIELDS)[number]['key'], string>;
export type GlobalForm = { paused: boolean } & Record<(typeof GLOBAL_FIELDS)[number]['key'], string>;

const text = (value: number | null) => value === null ? '' : String(value);
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
function readNumber<K extends string>(field: NumberField<K>, raw: string): Parsed<number | null> {
  const trimmed = raw.trim();
  if (field.optional && trimmed === '') return { ok: true, value: null };
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
    out[field.key] = parsed.value!;
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
    (out as unknown as Record<string, number | null>)[field.key] = parsed.value;
  }
  return { ok: true, value: out };
}

/** 保存参数的请求体：总带当前版本号，服务端发现版本已变时拒绝（409），页面刷新后重填。 */
export function settingsBody(settings: Pick<Settings, 'revision'>, change: { symbol?: { symbol: string; params: SymbolParams }; global?: GlobalParams; confirmed?: string[]; combos?: Combo[]; pairs?: CustomPair[] }): Record<string, unknown> {
  const body: Record<string, unknown> = { revision: settings.revision };
  if (change.combos) body.combos = COMBO_OPTIONS.filter(combo => change.combos!.includes(combo));
  if (change.pairs) body.pairs = change.pairs;
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
export interface ChartRow { time: number; mid: number | null; sellA: number | null; buyA: number | null; median: number | null; upper: number | null; lower: number | null }
/** 走势图的行：入场线是基线中位数 ± 入场偏离，卖 A 价差越过上线或买 A 价差跌破下线即达到开仓条件。 */
export function chartRows(points: readonly SymbolPoint[], entryBps: number): ChartRow[] {
  return points.map(point => ({
    time: point.t, mid: point.mid, sellA: point.sellA, buyA: point.buyA, median: point.median,
    upper: point.median === null ? null : point.median + entryBps, lower: point.median === null ? null : point.median - entryBps,
  }));
}
/** 纵轴范围取所有可见序列的 1–99 分位，避免单个跳点把曲线压扁。 */
export function chartRange(rows: readonly ChartRow[]): [number, number] | null {
  const values: number[] = [];
  for (const row of rows) for (const value of [row.mid, row.sellA, row.buyA, row.upper, row.lower]) if (finite(value)) values.push(value);
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))]!;
  return values.length < 50 ? [values[0]!, values.at(-1)!] : [at(0.01), at(0.99)];
}
export const clamp = (value: number, [low, high]: readonly [number, number]): number => Math.min(high, Math.max(low, value));

// ---- 手动配对 ----
export const KIND_OPTIONS: readonly { id: AssetKind; label: string }[] = [
  { id: 'equity', label: '美股' }, { id: 'etf', label: 'ETF' }, { id: 'crypto', label: '加密' }, { id: 'metal', label: '贵金属' }, { id: 'commodity', label: '大宗商品' }, { id: 'private', label: '未上市' }, { id: 'other', label: '其他' },
];
export interface CustomPairForm { aVenue: VenueId; aSymbol: string; bVenue: VenueId; bSymbol: string; ratio: string; kind: AssetKind; note: string }
export const EMPTY_PAIR_FORM: CustomPairForm = { aVenue: 'var', aSymbol: '', bVenue: 'entropy', bSymbol: '', ratio: '1', kind: 'equity', note: '' };
/** 与后端 formatRatio 一致。 */
// 10 位有效数字，再限到小数 10 位：键的写法（PAIR_KEY）最多 10 位小数，如 0.000001234567891 须写成 0.0000012346。
export const formatRatio = (ratio: number): string => String(Number(Number(ratio.toPrecision(10)).toFixed(10)));
/** 配对键（与后端 pairKey 一致）：乘数为 1 时不写。 */
export const customPairKey = (pair: Pick<CustomPair, 'a' | 'b' | 'ratio'>): string => `${pair.a.venue}:${pair.a.symbol}|${pair.b.venue}:${pair.b.symbol}${pair.ratio === 1 ? '' : `@${formatRatio(pair.ratio)}`}`;
/** 手动配对表单 → 请求里的一项（服务端仍会再校验）。existing 是已有的配对键，自动配对与手动配对都算。 */
export function customPairRequest(form: CustomPairForm, existing: readonly string[]): Parsed<CustomPair> {
  const aSymbol = form.aSymbol.trim(), bSymbol = form.bSymbol.trim();
  if (form.aVenue === form.bVenue) return { ok: false, error: '两条腿须在不同场所' };
  const symbol = /^[A-Za-z0-9._-]{1,24}$/;
  if (!symbol.test(aSymbol) || !symbol.test(bSymbol)) return { ok: false, error: '代码须为 1–24 位字母、数字或 . _ -' };
  const ratio = Number(form.ratio.trim());
  if (!form.ratio.trim() || !Number.isFinite(ratio) || ratio < 1e-6 || ratio > 1e6) return { ok: false, error: '乘数须为 0.000001 到 1000000 之间的数' };
  const note = form.note.trim();
  if (note.length > 80) return { ok: false, error: '备注须为 80 字以内' };
  const pair: CustomPair = { a: { venue: form.aVenue, symbol: aSymbol }, b: { venue: form.bVenue, symbol: bSymbol }, ratio: Number(formatRatio(ratio)), kind: form.kind, note };
  if (existing.includes(customPairKey(pair))) return { ok: false, error: `${customPairKey(pair)} 已在配对里` };
  return { ok: true, value: pair };
}
