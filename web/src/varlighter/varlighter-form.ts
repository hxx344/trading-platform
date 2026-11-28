// DEX 价差页（docs/varlighter.md 第 10 节、docs/dexspread.md 第 7 节）不依赖 DOM 的部分：读数格式、总览排序、参数表单到请求的转换、
// 配对键与场所名、手动配对的表单、走势图的行数据。由 web/test/varlighter-form.test.mjs 覆盖。
import type { KeyVenue } from '../../../src/dex/keys.ts';
import type { AccountFunding, AccountTrade } from '../../../src/varlighter/accounts.ts';
import type { LiveExecSettings, LiveLimits, LiveOrderRole, LivePosition, LiveSettings } from '../../../src/varlighter/live.ts';
import type { AssetKind, Combo, CustomPair, Regime, VarPriceSource, VenueId } from '../../../src/varlighter/model.ts';
import type { AutoParams, Direction, GlobalParams, SymbolParams } from '../../../src/varlighter/strategy.ts';
import type { AccountsView, LiveBreakdownRow, LiveOutcomeCounts, LivePositionMark, LiveView, Settings, StateRow, StateView, SymbolPoint, VenueAccountView, VenuePositionView } from '../../../src/varlighter/views.ts';
import type { VarLighterTab } from '../route-parse.ts';

export const VARLIGHTER_BASE = '/api/varlighter';
export const VAR_QUOTE_LABELS: Record<VarPriceSource, string> = { token: '按量询价', '0': '公开一档', '1k': '公开 1 千美元档', '100k': '公开 10 万美元档', interpolated: '公开深度插值', mixed: '公开买卖盘分别取价' };
export type { VarLighterTab };
export const VARLIGHTER_TABS: readonly { id: VarLighterTab; label: string }[] = [
  { id: 'overview', label: '价差总览' }, { id: 'detail', label: '标的详情' }, { id: 'accounts', label: '账户资产' }, { id: 'ready', label: '实盘准备' }, { id: 'lead', label: '领先测速' },
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
export const REASON_LABELS: Record<string, string> = {
  revert: '回归平仓', stop: '止损', timeout: '超时平仓', manual: '手动平仓', signal: '策略平仓', not_filled: '未开成', single_leg: '单腿', dismissed: '已人工处理',
  // v0.112.0 以前的实盘持仓跟随的模拟持仓不在了时的平仓原因，只出现在旧记录里。
  paper_gone: '模拟持仓不在了',
};
/** 平仓原因的中文名，不认识的照原样显示。 */
export const reasonLabel = (reason: string | null | undefined): string => reason ? REASON_LABELS[reason] ?? reason : '—';
/** 实盘持仓的阶段（总览与失联列表用）。 */
export const LIVE_STATE_LABELS: Record<string, string> = { opening: '开仓中', open: '持有', closing: '平仓中', stuck: '待处理', closed: '已结束' };
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
export function parseState(raw: unknown): StateView {
  const value = raw as StateView | null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.rows) || !value.sources || !value.settings) throw new Error('应答格式不对');
  if (value.rows.every(row => row.directions !== undefined)) return value;
  return { ...value, rows: value.rows.map(row => row.directions !== undefined ? row
    : { ...row, directions: value.settings.symbols?.[row.key]?.directions ?? ALL_DIRECTIONS }) };
}

type SignalRow = Pick<StateRow, 'rich' | 'cheap' | 'entryBps' | 'directions'>;
/** 只比较允许开仓的方向。若两侧同时过线，与策略 decide 一样优先卖 A。 */
export function signal(row: SignalRow): { direction: Direction; deviation: number; gap: number } | null {
  const allowed = row.directions === undefined ? ALL_DIRECTIONS : row.directions;
  if (!Array.isArray(allowed) || !finite(row.entryBps)) return null;
  const rich = allowed.includes('a_rich') ? row.rich : null;
  const cheap = allowed.includes('a_cheap') ? row.cheap : null;
  if (finite(rich) && (rich >= row.entryBps || !finite(cheap) || rich >= cheap)) return { direction: 'a_rich', deviation: rich, gap: rich - row.entryBps };
  return finite(cheap) ? { direction: 'a_cheap', deviation: cheap, gap: cheap - row.entryBps } : null;
}

export type SortKey = 'symbol' | 'mid' | 'z' | 'gap' | 'cost' | 'samples' | 'kind';

// ---- 总览的简洁视图 ----
export type OverviewMode = 'simple' | 'full';
export const OVERVIEW_MODE_KEY = 'trading-platform:varlighter:overview-mode';
export const OVERVIEW_MODES: readonly { id: OverviewMode; label: string; hint: string }[] = [
  { id: 'simple', label: '简洁', hint: '只看价差、距开仓、方向与成本' }, { id: 'full', label: '完整', hint: '加上基线、偏离 σ、可成交价差、资金费与样本数' },
];
/** 浏览器里存的视图；没存过或认不出时用简洁视图。 */
export const readOverviewMode = (raw: string | null): OverviewMode => raw === 'full' ? 'full' : 'simple';
/** 简洁视图表头上有的排序列。 */
export const SIMPLE_SORT_KEYS: readonly SortKey[] = ['symbol', 'mid', 'gap', 'cost'];
/** 离开仓线的进度：ratio 是偏离占开仓线的比例（0 到 1，反向偏离记 0），short 是还差的基点数。 */
export function entryProgress(row: SignalRow): { direction: Direction; deviation: number; entry: number; ratio: number; short: number; reached: boolean } | null {
  const hit = signal(row);
  if (!hit || !finite(row.entryBps)) return null;
  const reached = hit.gap >= 0;
  const ratio = reached ? 1 : row.entryBps > 0 ? Math.min(1, Math.max(0, hit.deviation / row.entryBps)) : 0;
  return { direction: hit.direction, deviation: hit.deviation, entry: row.entryBps, ratio, short: Math.max(0, -hit.gap), reached };
}
/** 方向拆成卖出与买入的场所：A 偏贵时卖 A 买 B，反之买 A 卖 B。 */
export const directionSides = (direction: Direction, a: VenueId, b: VenueId): { sell: VenueId; buy: VenueId } => direction === 'a_rich' ? { sell: a, buy: b } : { sell: b, buy: a };
/** 「为什么没开仓」的一行小字：tone 决定颜色（bad 是到了入场线却被挡），title 是悬停时的全文（含最近一次没开成）。 */
export type GateNote = { tone: 'bad' | 'warn' | 'ok' | 'dim'; text: string; title: string };
/** 已启用、无持仓的配对现在为什么没开仓；旧服务没有 gate、或有持仓与未启用的配对（gate 为 null）时为 null。 */
export function gateNote(row: Pick<StateRow, 'gate' | 'sampleAt'>, now: number | null): GateNote | null {
  const gate = row.gate;
  if (now === null || !gate || (gate.reached && sampleStale(row, now))) return null;
  const last = gate.last ? `最近一次没开成：${age(gate.last.at, now)}，${gate.last.reason}` : null;
  let main: { tone: GateNote['tone']; text: string; title: string } | null = null;
  if (gate.blocker) {
    const text = `未开仓：${gate.blocker}`;
    // 不用处理的拦截（策略本来就会等，或用户自己的设置）不用警示色；没有这个标记时按要处理的显示。
    main = gate.attention === false ? { tone: 'dim', text, title: gate.reached ? `已到入场线，${text}` : text }
      : gate.reached ? { tone: 'bad', text, title: `已到入场线，${text}` } : { tone: 'warn', text, title: text };
  } else if (gate.reached) {
    const text = `已到入场线${finite(gate.expectedNetBps) ? `，预期净利 ${bps(gate.expectedNetBps)} 基点` : ''}，等待确认或下单`;
    main = { tone: 'ok', text, title: text };
  }
  if (!main) return last ? { tone: 'dim', text: last, title: last } : null;
  return { tone: main.tone, text: main.text, title: last ? `${main.title}\n${last}` : main.title };
}
/** 样本超过这么久的行不算机会、不高亮，也不计入「到线被挡」：最后一个样本到过线不代表现在还在线上。 */
export const STALE_SAMPLE_MS = 5 * 60_000;
export const sampleStale = (row: Pick<StateRow, 'sampleAt'>, now: number | null): boolean => now === null || row.sampleAt === null || now - row.sampleAt > STALE_SAMPLE_MS;
/** 到了入场线却被要处理的原因挡住的配对数（样本过期的、不用处理的拦截不计）；没有一行带 gate（旧服务）时为 null，页面不显示。 */
export const blockedAtEntry = (rows: readonly Pick<StateRow, 'gate' | 'sampleAt'>[], now: number | null): number | null =>
  now !== null && rows.some(row => row.gate !== undefined) ? rows.filter(row => row.gate?.reached && row.gate.blocker && row.gate.attention !== false && !sampleStale(row, now)).length : null;
/** 基线为 null 时的说明：后台还在预热，或同时段样本不足。 */
export const baselineMissing = (row: Pick<StateRow, 'baselineWarming'>, simple: boolean): string =>
  row.baselineWarming ? '基线预热中' : simple ? '平时水平统计中' : '样本不足';
/**
 * 总览成本列：total 是显示的数（买卖价差 + 往返手续费；手续费未知或旧服务没给时只有买卖价差），
 * parts 把两项分开写。买卖价差是两腿盘口的往返成本（买 A 价差 − 卖 A 价差），按一档估算时标「估算」。
 */
export function costBreakdown(row: Pick<StateRow, 'cost' | 'feeCost' | 'totalCost' | 'estimated'>): { total: number | null; parts: string; warn: boolean } {
  const spread = finite(row.cost) ? `买卖价差 ${plain(row.cost)}${row.estimated ? '（估算）' : ''}` : null;
  const fee = finite(row.feeCost) ? `手续费 ${plain(row.feeCost)}` : null;
  const total = row.totalCost ?? row.cost;
  if (row.feeCost === undefined) return { total, parts: spread ? `${spread} · 未计手续费` : '缺盘口', warn: false };
  if (!fee) return { total, parts: spread ? `${spread} · 手续费未知` : '缺盘口与手续费', warn: true };
  return { total, parts: spread ? `${spread} + ${fee}` : `缺盘口 · ${fee}`, warn: false };
}/** 排序：缺数的行总在最后；同值按标的代码。 */
export function sortRows(rows: readonly StateRow[], key: SortKey, descending: boolean, now: number | null): StateRow[] {
  const value = (row: StateRow): number | string | null => {
    switch (key) {
      case 'symbol': return row.symbol;
      case 'kind': return row.kind;
      case 'mid': return row.mid;
      case 'z': return finite(row.z) ? Math.abs(row.z) : null;
      case 'gap': return sampleStale(row, now) ? null : signal(row)?.gap ?? null;
      case 'cost': return row.totalCost ?? row.cost;
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
  { key: 'entropyFeeBps', label: 'Entropy 手续费', min: 0, max: 100, unit: '基点', optional: true, hint: '单边每次成交；默认 0.2（往返 0.4，含返佣估算）；留空按目录原始费率' },
  { key: 'maxQuoteAgeSec', label: '报价时效上限', min: 5, max: 600, integer: true, unit: '秒', hint: '收到时较慢一腿的报价已过去的时间，超过不开仓' },
  { key: 'minNetBps', label: '最低预期净利', min: 0, max: 500, unit: '基点', hint: '偏离 − 出场 − 半个往返买卖价差 − 滑点与手续费，低于这个数不开仓' },
  { key: 'maxOpenPositions', label: '最多持仓数', min: 1, max: 100, integer: true, unit: '笔', hint: '实盘持仓（含开仓中、平仓中）合计' },
  { key: 'maxTotalNotionalUsd', label: '名义合计上限', min: 10, max: 10_000_000, unit: '美元' },
  { key: 'dailyLossLimitUsd', label: '当日亏损上限', min: 1, max: 10_000_000, unit: '美元', hint: '按 UTC 日计实盘已平仓净盈亏' },
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
export function settingsBody(settings: Pick<Settings, 'revision'>, change: { symbol?: { symbol: string; params: SymbolParams }; global?: GlobalParams; confirmed?: string[]; combos?: Combo[]; pairs?: CustomPair[]; auto?: string[] }): Record<string, unknown> {
  const body: Record<string, unknown> = { revision: settings.revision };
  if (change.combos) body.combos = COMBO_OPTIONS.filter(combo => change.combos!.includes(combo));
  if (change.pairs) body.pairs = change.pairs;
  if (change.symbol) body.symbols = { [change.symbol.symbol]: change.symbol.params };
  if (change.global) body.global = change.global;
  if (change.confirmed) body.confirmed = [...new Set(change.confirmed)].sort();
  if (change.auto) body.auto = [...new Set(change.auto)].sort();
  return body;
}
export const toggleConfirmed = (confirmed: readonly string[], symbol: string, on: boolean): string[] =>
  on ? [...new Set([...confirmed, symbol])].sort() : confirmed.filter(item => item !== symbol);

// ---- 自动配置 ----
/** 自动配置接管的四项（其余参数总用保存的值）。 */
export const AUTO_FIELDS: readonly (keyof AutoParams)[] = ['entryBps', 'exitBps', 'stopBps', 'maxHoldMinutes'];
/** 总览里勾选：启用并交给自动配置；取消勾选只停用，自动配置的选择留着，下次勾选照旧。只带 enabled，服务端在已保存（没有则默认）的参数上改。 */
export function quickEnableBody(settings: Pick<Settings, 'revision' | 'auto'>, key: string, on: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { revision: settings.revision, symbols: { [key]: { enabled: on } } };
  if (on) body.auto = toggleConfirmed(settings.auto, key, true);
  return body;
}
/** 详情页的自动配置开关：自动配置只认有保存参数的配对，打开时带一份空的改动，服务端沿用已保存的（没有则默认）参数，不覆盖任何字段。 */
export const autoBody = (settings: Pick<Settings, 'revision' | 'auto'>, key: string, on: boolean): Record<string, unknown> =>
  ({ revision: settings.revision, ...(on ? { symbols: { [key]: {} } } : {}), auto: toggleConfirmed(settings.auto, key, on) });
/** 推荐值填进表单：只改自动配置接管的四项。 */
export const autoFormPatch = (params: AutoParams): Partial<SymbolForm> => Object.fromEntries(AUTO_FIELDS.map(key => [key, String(params[key])]));

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
  const rows: ChartRow[] = [];
  for (const point of points) {
    const previous = rows.at(-1);
    if (point.gapBefore && previous) rows.push({ time: (previous.time + point.t) / 2, mid: null, sellA: null, buyA: null, median: null, upper: null, lower: null });
    rows.push({ time: point.t, mid: point.mid, sellA: point.sellA, buyA: point.buyA, median: point.median,
      upper: point.median === null ? null : point.median + entryBps, lower: point.median === null ? null : point.median - entryBps });
  }
  return rows;
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

// ---- 账户资产 ----
export type AccountVenueFilter = KeyVenue | 'all';
export const ACCOUNT_VENUE_FILTERS: readonly { id: AccountVenueFilter; label: string }[] = [
  { id: 'all', label: '全部场所' },
  { id: 'lighter', label: 'Lighter 主网' },
  { id: 'rh', label: 'Lighter RH' },
  { id: 'entropy', label: 'Entropy' },
];

export const filterAccountPositions = (positions: readonly VenuePositionView[], filter: AccountVenueFilter): VenuePositionView[] =>
  filter === 'all' ? [...positions] : positions.filter(item => item.venue === filter);

export const filterAccountTrades = (trades: readonly AccountTrade[], filter: AccountVenueFilter): AccountTrade[] =>
  filter === 'all' ? [...trades] : trades.filter(item => item.venue === filter);

export const filterAccountFunding = (funding: readonly AccountFunding[], filter: AccountVenueFilter): AccountFunding[] =>
  filter === 'all' ? [...funding] : funding.filter(item => item.venue === filter);

export function selectedEquitySeries(
  view: Pick<AccountsView, 'venues' | 'equityCurve' | 'equityComplete'>,
  filter: AccountVenueFilter,
): { points: { t: number; value: number }[]; complete: boolean; currency: string } {
  if (filter === 'all') {
    return {
      points: view.equityCurve.map(item => ({ t: item.t, value: item.equity })),
      complete: view.equityComplete,
      currency: 'USD',
    };
  }
  const venue = view.venues.find(item => item.venue === filter);
  const points = (venue?.equityCurve ?? []).map(item => ({ t: item.t, value: item.equity }));
  return {
    points,
    complete: points.length >= 2,
    currency: venue?.collateralAsset ?? 'USDC',
  };
}

export function selectedVenuePnlCurve(
  view: Pick<AccountsView, 'venues'>,
  filter: AccountVenueFilter,
): { points: { t: number; value: number }[]; title: string; error: string | null; currency: string } | null {
  if (filter === 'all') return null;
  const venue = view.venues.find(item => item.venue === filter);
  if (!venue) return null;
  return {
    points: venue.pnlCurve.map(item => ({ t: item.at, value: item.pnlUsd })),
    title: venue.venue === 'entropy' ? 'Entropy 累计交易净盈亏（含资金费与手续费）' : `${venue.name} 每日交易盈亏`,
    error: venue.pnlError,
    currency: venue.collateralAsset,
  };
}

export const accountPnlTone = (value: number | null | undefined): 'up' | 'down' | '' => tone(value);

// ---- 实盘执行优化与订单遥测 ----
/** 与 src/varlighter/live.ts 的 LIVE_LIMIT_RANGES、LIVE_EXEC_RANGES 一致（页面不引入后端模块的值，web/test/varlighter-form.test.mjs 断言两边相同）。 */
export const LIVE_LIMIT_RANGES = { perTradeUsd: [10, 100_000], maxOpen: [1, 20], dailyLossUsd: [1, 100_000], slippageBps: [1, 300] } as const;
export const LIVE_EXEC_RANGES = {
  openLegASlippageBps: [0, 30], confirmMs: [0, 10_000], notFilledCooldownSec: [5, 3_600], maxLeverage: [1, 5],
  hedgeWaitSec: [0, 30], hedgeRetryMs: [200, 5_000], hedgeAbortBps: [1, 300], hedgeEdgeBps: [0, 100], revertMinNetBps: [-100, 100],
} as const;
/** 开仓先发哪条腿（与 src/varlighter/live.ts 的 LIVE_FIRST_LEGS 一致）。 */
export const LIVE_FIRST_LEG_OPTIONS: readonly { value: LiveExecSettings['firstLeg']; label: string }[] = [
  { value: 'entropy', label: '只有一条 Entropy 腿时先发它' }, { value: 'a', label: '固定先发 A 腿' },
];
type RangeField<K extends string> = { key: K; label: string; min: number; max: number; integer?: boolean; hint: string };
export type LiveLimitsForm = Record<keyof LiveLimits, string>;
export const LIVE_LIMIT_FIELDS: readonly RangeField<keyof LiveLimits>[] = [
  { key: 'perTradeUsd', label: '单笔名义（美元）', min: LIVE_LIMIT_RANGES.perTradeUsd[0], max: LIVE_LIMIT_RANGES.perTradeUsd[1], hint: '10–100000；每笔取它与配对参数里名义金额中较小的一个' },
  { key: 'maxOpen', label: '同时持仓（笔）', min: LIVE_LIMIT_RANGES.maxOpen[0], max: LIVE_LIMIT_RANGES.maxOpen[1], integer: true, hint: '1–20 的整数；到上限后不再开新仓' },
  { key: 'dailyLossUsd', label: '当日亏损上限（美元）', min: LIVE_LIMIT_RANGES.dailyLossUsd[0], max: LIVE_LIMIT_RANGES.dailyLossUsd[1], hint: '1–100000；UTC 日内已实现亏损到这个数就不再开仓' },
  { key: 'slippageBps', label: '第二腿与平仓限价保护（基点）', min: LIVE_LIMIT_RANGES.slippageBps[0], max: LIVE_LIMIT_RANGES.slippageBps[1], hint: '1–300；开仓第二腿与平仓 IOC 限价离一档最多这么远' },
];
type LiveExecNumberKey = keyof typeof LIVE_EXEC_RANGES;
export type LiveExecForm = Record<LiveExecNumberKey, string> & { autoSizeByBalance: boolean; firstLeg: LiveExecSettings['firstLeg'] | undefined };
export const LIVE_EXEC_FIELDS: readonly RangeField<LiveExecNumberKey>[] = [
  { key: 'openLegASlippageBps', label: '开仓第一腿滑点（基点）', min: LIVE_EXEC_RANGES.openLegASlippageBps[0], max: LIVE_EXEC_RANGES.openLegASlippageBps[1], hint: '默认 2（0–30），收紧第一腿限价减少逆向吃单' },
  { key: 'confirmMs', label: '信号持续确认（毫秒）', min: LIVE_EXEC_RANGES.confirmMs[0], max: LIVE_EXEC_RANGES.confirmMs[1], integer: true, hint: '默认 0 不延迟（0–10000 的整数）；设 >0 需信号连续维持该时长才开仓' },
  { key: 'notFilledCooldownSec', label: '第一腿未成冷却（秒）', min: LIVE_EXEC_RANGES.notFilledCooldownSec[0], max: LIVE_EXEC_RANGES.notFilledCooldownSec[1], integer: true, hint: '默认 30 秒（5–3600 的整数），与真实成交冷却分离' },
  { key: 'maxLeverage', label: '保证金倍率上限', min: LIVE_EXEC_RANGES.maxLeverage[0], max: LIVE_EXEC_RANGES.maxLeverage[1], hint: '默认 1（1–5×），>1 按可用余额 × 倍率 × 95% 估算上限；须先在各交易所设好 >= 该倍率杠杆' },
  { key: 'hedgeWaitSec', label: '第二腿等待（秒）', min: LIVE_EXEC_RANGES.hedgeWaitSec[0], max: LIVE_EXEC_RANGES.hedgeWaitSec[1], hint: '默认 3（0–30）；第二腿没补齐时在限价内重试这么久再回补第一腿，0 为立刻回补' },
  { key: 'hedgeRetryMs', label: '第二腿重试间隔（毫秒）', min: LIVE_EXEC_RANGES.hedgeRetryMs[0], max: LIVE_EXEC_RANGES.hedgeRetryMs[1], integer: true, hint: '默认 500（200–5000 的整数）' },
  { key: 'hedgeAbortBps', label: '等待中放弃（基点）', min: LIVE_EXEC_RANGES.hedgeAbortBps[0], max: LIVE_EXEC_RANGES.hedgeAbortBps[1], hint: '默认 10（1–300）；等第二腿期间第一腿回补价不利超过它就立刻回补' },
  { key: 'hedgeEdgeBps', label: '第二腿经济边界（基点）', min: LIVE_EXEC_RANGES.hedgeEdgeBps[0], max: LIVE_EXEC_RANGES.hedgeEdgeBps[1], hint: '默认 5（0–100）；按第一腿实际成交价，对冲后离基线至少还剩这么多时可比限价保护更宽' },
  { key: 'revertMinNetBps', label: '回归平仓保利（基点）', min: LIVE_EXEC_RANGES.revertMinNetBps[0], max: LIVE_EXEC_RANGES.revertMinNetBps[1], hint: '默认 0（-100 到 100）；回归平仓前两次的限价按最坏成交仍保住这么多净利收紧，-100 为关闭' },
];
/** 一个数字输入是否在服务端接受的范围里；不合规时返回带字段名的说明。 */
const numberText = (raw: string): string => raw.trim().replace(/\u2212/g, '-');
function rangeError(field: RangeField<string>, raw: string): string | null {
  const trimmed = numberText(raw), value = Number(trimmed);
  if (!trimmed || !Number.isFinite(value)) return `${field.label}须填数字`;
  if (field.integer && !Number.isInteger(value)) return `${field.label}须为整数`;
  if (value < field.min || value > field.max) return `${field.label}须在 ${field.min} 到 ${field.max} 之间`;
  return null;
}
/** 字段旁的提示：不合规的字段给出范围，合规的不出现在结果里。 */
export function rangeFieldErrors<K extends string>(fields: readonly RangeField<K>[], form: Record<K, string>): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const field of fields) if (rangeError(field, form[field.key]) !== null) out[field.key] = `须为 ${field.min} 到 ${field.max}${field.integer ? ' 的整数' : ' 之间的数'}`;
  return out;
}
export const liveLimitsForm = (limits: LiveLimits): LiveLimitsForm => ({ perTradeUsd: String(limits.perTradeUsd), maxOpen: String(limits.maxOpen), dailyLossUsd: String(limits.dailyLossUsd), slippageBps: String(limits.slippageBps) });
/** 表单 → 实盘限额（与服务端 readLiveSettings 同样的范围；服务端仍会再校验）。 */
export function parseLiveLimits(form: LiveLimitsForm): Parsed<LiveLimits> {
  const out = {} as LiveLimits;
  for (const field of LIVE_LIMIT_FIELDS) {
    const error = rangeError(field, form[field.key]);
    if (error) return { ok: false, error };
    out[field.key] = Number(numberText(form[field.key]));
  }
  return { ok: true, value: out };
}
/**
 * 服务端返回的执行参数里有的数字字段。DEX 价差服务比页面旧时（单独回退）没有后加的字段：
 * 页面不显示也不提交它们，旧服务端会拒绝不认识的键。
 */
export const liveExecFields = (exec: Partial<LiveExecSettings>): readonly RangeField<LiveExecNumberKey>[] => LIVE_EXEC_FIELDS.filter(field => exec[field.key] !== undefined);
export const liveExecForm = (exec: Partial<LiveExecSettings> & Pick<LiveExecSettings, 'autoSizeByBalance'>): LiveExecForm => ({
  ...Object.fromEntries(LIVE_EXEC_FIELDS.map(field => [field.key, exec[field.key] === undefined ? '' : String(exec[field.key])])) as Record<LiveExecNumberKey, string>,
  autoSizeByBalance: exec.autoSizeByBalance,
  firstLeg: exec.firstLeg,
});
/** fields 传 liveExecFields(服务端的执行参数)；不传按全部字段。 */
export function parseLiveExec(form: LiveExecForm, fields: readonly RangeField<LiveExecNumberKey>[] = LIVE_EXEC_FIELDS): Parsed<LiveExecSettings> {
  const out = { autoSizeByBalance: form.autoSizeByBalance, ...(form.firstLeg !== undefined && { firstLeg: form.firstLeg }) } as LiveExecSettings;
  for (const field of fields) {
    const error = rangeError(field, form[field.key]);
    if (error) return { ok: false, error };
    out[field.key] = Number(numberText(form[field.key]));
  }
  return { ok: true, value: out };
}

/** 实盘开关面板的整份表单：实盘配对、限额与执行优化一起保存。 */
export interface LiveSwitchForm { pairs: string[]; limits: LiveLimitsForm; exec: LiveExecForm }
export const liveSwitchForm = (settings: Pick<LiveSettings, 'pairs' | 'limits'>, exec: LiveExecSettings): LiveSwitchForm =>
  ({ pairs: [...settings.pairs], limits: liveLimitsForm(settings.limits), exec: liveExecForm(exec) });
const formValue = (raw: string): number | string => { const trimmed = numberText(raw), value = Number(trimmed); return trimmed && Number.isFinite(value) ? value : trimmed; };
const liveFormKey = (form: LiveSwitchForm): string => JSON.stringify([
  [...new Set(form.pairs)].sort(), LIVE_LIMIT_FIELDS.map(field => formValue(form.limits[field.key])), LIVE_EXEC_FIELDS.map(field => formValue(form.exec[field.key])), form.exec.autoSizeByBalance, form.exec.firstLeg,
]);
/** 两份表单代表的设置是否相同（配对不计顺序，「100」与「100.0」相同）。 */
export const sameLiveForm = (a: LiveSwitchForm, b: LiveSwitchForm): boolean => liveFormKey(a) === liveFormKey(b);
/**
 * 服务端设置变了（别处保存、本次保存成功或刷新）时表单是否改用新值：表单还是上次同步的样子（用户没改过），
 * 或已经和新值一样（保存成功）时跟随；否则保留用户没保存的编辑（LESSONS.md L089），包括保存期间接着改的。
 */
export const followServerForm = (current: LiveSwitchForm, base: LiveSwitchForm, next: LiveSwitchForm): boolean =>
  sameLiveForm(current, base) || sameLiveForm(current, next);
const CONFIRM_SOURCE_LABEL: Record<string, string> = { ws: 'WS', rest: 'REST', sync: '同步', account: '对账' };
export function tradeTelemetrySummary(trade: Pick<LivePosition, 'orders'>): string | null {
  const orders = trade.orders;
  if (!orders?.length) return null;
  const openA = orders.find(item => item.role === 'openA') ?? orders[0]!;
  const src = CONFIRM_SOURCE_LABEL[openA.confirmSource] ?? openA.confirmSource;
  const ms = Math.max(0, Math.round(openA.confirmAt - openA.sentAt));
  const slip = openA.slippageBps === null || openA.avgPrice === null ? '' : ` · 第一腿滑点 ${openA.slippageBps >= 0 ? '+' : ''}${openA.slippageBps.toFixed(1)} bps`;
  return `${src} · ${ms} ms${slip}（共 ${orders.length} 笔单）`;
}

// ---- 实盘持仓估值 ----
export interface MarkCells {
  pnl: string; pnlFoot: string; pnlTone: 'up' | 'down' | '';
  entry: string; entryFoot: string;
  exit: string; exitFoot: string; exitTitle: string;
  stop: string; stopFoot: string; stopWarn: boolean;
  hold: string; holdFoot: string;
}
/**
 * 持仓表的估值各列（基点）：没有 marks（旧服务）或字段为 null 时写「—」。heldMs 是已持有的毫秒数。
 * position 给出方向与状态：入场价差比信号好还是差随方向相反（A 偏贵时卖 A，价差越大越好；A 偏便宜时相反）；不在持有中的（开仓中、平仓中、待处理）服务端不估值。
 */
export function positionMarkCells(mark: LivePositionMark | null | undefined, heldMs: number, position?: Pick<LivePosition, 'direction' | 'state'>): MarkCells {
  if (!mark) return { pnl: '—', pnlFoot: '', pnlTone: '', entry: '—', entryFoot: '', exit: '—', exitFoot: '', exitTitle: '', stop: '—', stopFoot: '', stopWarn: false, hold: duration(heldMs), holdFoot: '' };
  const pnlFoot = [finite(mark.netUsd) ? `净 ${signedUsd(mark.netUsd)}` : '', finite(mark.pnlBps) || finite(mark.netUsd) ? mark.estimated ? '估' : '' : ''].filter(Boolean).join(' · ');
  const edge = finite(mark.signalSpread) && finite(mark.entrySpread) ? (mark.entrySpread - mark.signalSpread) * (position?.direction === 'a_cheap' ? -1 : 1) : null;
  const edgeText = edge === null ? '' : !position ? ` · 差 ${bps(edge)}` : Math.abs(edge) < 0.05 ? ' · 与信号一致' : ` · 比信号${edge > 0 ? '好' : '差'} ${plain(Math.abs(edge))}`;
  const entryFoot = finite(mark.signalSpread) ? `信号 ${plain(mark.signalSpread)}${edgeText}` : '';
  const held = !position || position.state === 'open';
  const exitFoot = !finite(mark.deviation) ? held ? '缺样本或基线' : '不在持有中，不估值' : mark.deviation <= mark.exitBps ? '已到出场线' : `还差 ${plain(mark.deviation - mark.exitBps)}`;
  const room = finite(mark.pnlBps) ? mark.pnlBps + mark.stopBps : null;
  const minutes = finite(heldMs) && heldMs >= 0 ? Math.floor(heldMs / 60_000) : null;
  return {
    pnl: finite(mark.pnlBps) ? bps(mark.pnlBps) : '—', pnlFoot, pnlTone: tone(finite(mark.pnlBps) ? mark.pnlBps : mark.netUsd),
    entry: plain(mark.entrySpread), entryFoot,
    exit: `${plain(mark.deviation)} / ${plain(mark.exitBps)}`, exitFoot, exitTitle: `开仓基线 ${bps(mark.entryBaseline)} · 现在基线 ${bps(mark.baseline)} 基点；到出场线后盘口过宽且浮亏时暂缓回归平仓，止损与超时不受影响`,
    stop: room === null ? '—' : `还差 ${plain(room)}`, stopFoot: `止损线 ${bps(-mark.stopBps)}`, stopWarn: room !== null && room <= mark.stopBps * 0.25,
    hold: minutes === null ? '—' : `${minutes} / ${mark.maxHoldMinutes} 分钟`,
    holdFoot: minutes === null ? '' : minutes >= mark.maxHoldMinutes ? '已到最长持有' : `还剩 ${mark.maxHoldMinutes - minutes} 分钟`,
  };
}

// ---- 实盘成交与结果计数 ----
type ClosedPosition = Pick<LivePosition, 'id' | 'a' | 'b' | 'closedAt' | 'updatedAt' | 'closeReason' | 'singleLeg' | 'orders' | 'note'>;
/** 至少一条腿有开仓成交。 */
export const hasFill = (position: Pick<LivePosition, 'a' | 'b'>): boolean => position.a.qty > 0 || position.b.qty > 0;
const closedTime = (position: Pick<LivePosition, 'closedAt' | 'updatedAt'>) => position.closedAt ?? position.updatedAt;
/** 成交表逐行列出的：trades 里有成交的加上 tradedMore（按编号去重、新的在前、最多 limit 笔）。 */
export function tradedPositions<T extends ClosedPosition>(view: { trades: readonly T[]; tradedMore?: readonly T[] }, limit = 50): T[] {
  const seen = new Set<string>(), list: T[] = [];
  for (const item of [...view.trades.filter(hasFill), ...(view.tradedMore ?? [])]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id); list.push(item);
  }
  return list.sort((x, y) => closedTime(y) - closedTime(x)).slice(0, limit);
}
/** 没有成交就结束的（第一腿没成交等），新的在前。 */
export const untradedPositions = <T extends ClosedPosition>(trades: readonly T[]): T[] => trades.filter(item => !hasFill(item)).sort((x, y) => closedTime(y) - closedTime(x));
/** 按与服务端相同的口径数已结束的持仓：有成交、第一腿没成交（not_filled）、其余没成交的，以及有成交里的单腿。from 给出时只数此后结束的。 */
export function outcomeCounts(trades: readonly ClosedPosition[], from = -Infinity): LiveOutcomeCounts {
  const counts: LiveOutcomeCounts = { traded: 0, notFilled: 0, other: 0, singleLeg: 0, unsent: 0 };
  for (const item of trades) {
    if (closedTime(item) < from) continue;
    if (hasFill(item)) { counts.traded++; if (item.singleLeg) counts.singleLeg++; }
    else if (item.closeReason === 'not_filled') { counts.notFilled++; if (!firstLegSent(item)) counts.unsent = (counts.unsent ?? 0) + 1; }
    else counts.other++;
  }
  return counts;
}
/**
 * 第一腿没成交的记录里第一腿有没有发出去（与 src/varlighter/live-summary.ts 的 firstLegSent 相同）：
 * 逐单记录里有开仓第一腿（角色 openA），或说明写着第一腿没有成交（v0.112.x 没有逐单记录）；其余是发单前放弃的（意图过期、发单前复核没过）。
 */
export const firstLegSent = (position: Pick<LivePosition, 'orders' | 'note'>): boolean =>
  position.orders?.some(order => order.role === 'openA') === true || (position.note ?? '').includes('第一腿没有成交');
/** 今天（UTC）与累计的结果计数：旧服务没有 outcomes 时用 trades（最近 50 笔已结束）估，recent 是估算用的笔数，服务端给出时为 null。 */
export function liveOutcomes(view: Pick<LiveView, 'trades' | 'outcomes' | 'now'>): { today: LiveOutcomeCounts; total: LiveOutcomeCounts; recent: number | null } {
  if (view.outcomes) return { today: view.outcomes.today, total: view.outcomes.total, recent: null };
  return { today: outcomeCounts(view.trades, Math.floor(view.now / 86_400_000) * 86_400_000), total: outcomeCounts(view.trades), recent: view.trades.length };
}
/** 第一腿发出去却没成交的笔数：第一腿没成交的里去掉发单前放弃的（服务端没给 unsent 时全部算发出去了）。 */
export const firstLegMissed = (counts: LiveOutcomeCounts): number => Math.max(0, counts.notFilled - (counts.unsent ?? 0));
export const outcomeText = (counts: LiveOutcomeCounts): string =>
  `有成交 ${counts.traded} · 第一腿未成交 ${firstLegMissed(counts)}${counts.unsent ? ` · 发单前放弃 ${counts.unsent}` : ''} · 其他未成交 ${counts.other} · 单腿 ${counts.singleLeg}`;
/** 第一腿未成交率：第一腿发出去却没成交的占发出去的（有成交 + 发出去没成交）的比例，发单前放弃的不算；都没有时为 null。 */
export const firstLegMissRate = (counts: LiveOutcomeCounts): number | null => { const sent = counts.traded + firstLegMissed(counts); return sent > 0 ? firstLegMissed(counts) / sent : null; };

// ---- 逐单遥测汇总 ----
export const ORDER_ROLES: readonly { role: LiveOrderRole; label: string }[] = [
  { role: 'openA', label: '开仓第一腿' }, { role: 'openB', label: '开仓第二腿' }, { role: 'closeA', label: '平仓 A 腿' }, { role: 'closeB', label: '平仓 B 腿' }, { role: 'flatten', label: '回补' },
];
/** 分位数（线性插值）；没有样本为 null，单个样本就是它本身。 */
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y), at = (sorted.length - 1) * q, low = Math.floor(at), high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}
export interface RoleTelemetry {
  role: LiveOrderRole; label: string; orders: number; filled: number; fillRate: number | null;
  /** 逆向滑点（基点，正值为劣于预期价），null 的不计；samples 是计入的笔数。 */ slipMean: number | null; slipP50: number | null; slipP90: number | null; slipSamples: number;
  /** 发单到确认、信号到发单（毫秒）。 */ confirmP50: number | null; confirmP90: number | null; signalP50: number | null;
  /** 确认来源占比（合计 1），多的在前。 */ sources: { source: string; label: string; share: number }[];
}
/** 按角色汇总有成交持仓的逐单遥测；positions 是带遥测的持仓数，orders 是单数。 */
export function orderTelemetryStats(trades: readonly Pick<LivePosition, 'orders'>[]): { positions: number; orders: number; roles: RoleTelemetry[] } {
  const all = trades.flatMap(trade => trade.orders ?? []);
  const roles: RoleTelemetry[] = [];
  for (const { role, label } of ORDER_ROLES) {
    const orders = all.filter(item => item.role === role);
    if (!orders.length) continue;
    const filled = orders.filter(item => item.filledQty > 0).length;
    // 成交均价缺失（按账户持仓核对出来的成交）时服务端用限价代替成交价，算出的滑点是上限，不是实际滑点，不计入。
    const slips = orders.filter(item => item.avgPrice !== null).map(item => item.slippageBps).filter(finite);
    const confirms = orders.map(item => item.confirmAt - item.sentAt).filter(finite).map(value => Math.max(0, value));
    const signals = orders.map(item => item.signalAt === null ? null : item.sentAt - item.signalAt).filter(finite).map(value => Math.max(0, value));
    const bySource = new Map<string, number>();
    for (const item of orders) bySource.set(item.confirmSource, (bySource.get(item.confirmSource) ?? 0) + 1);
    roles.push({
      role, label, orders: orders.length, filled, fillRate: filled / orders.length,
      slipMean: slips.length ? slips.reduce((sum, value) => sum + value, 0) / slips.length : null, slipP50: quantile(slips, 0.5), slipP90: quantile(slips, 0.9), slipSamples: slips.length,
      confirmP50: quantile(confirms, 0.5), confirmP90: quantile(confirms, 0.9), signalP50: quantile(signals, 0.5),
      sources: [...bySource].sort((x, y) => y[1] - x[1]).map(([source, count]) => ({ source, label: CONFIRM_SOURCE_LABEL[source] ?? source, share: count / orders.length })),
    });
  }
  return { positions: trades.filter(trade => trade.orders?.length).length, orders: all.length, roles };
}
/** 毫秒读数：1 秒以下写毫秒，以上写秒。 */
export const msText = (value: number | null | undefined): string => !finite(value) ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;

// ---- 盈亏分组 ----
export type BreakdownKind = 'pair' | 'day' | 'reason';
/** 分组汇总的一行：配对键与平仓原因换成页面上的名字，胜率没有笔数时为 null。 */
export function breakdownRows(rows: readonly LiveBreakdownRow[] | undefined, kind: BreakdownKind): { key: string; label: string; sub: string; trades: number; winRate: number | null; netUsd: number }[] {
  return (rows ?? []).map(row => {
    const pair = kind === 'pair' ? pairLabel(row.key) : null;
    return { key: row.key, label: pair ? pair.symbol : kind === 'reason' ? reasonLabel(row.key) : row.key, sub: pair?.short ?? '', trades: row.trades, winRate: row.trades > 0 ? row.wins / row.trades : null, netUsd: row.netUsd };
  });
}

export function formatCurrencyAmount(value: number | null | undefined, currency: string, digits = 2): string {
  if (!finite(value)) return '—';
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${value < 0 ? '−' : ''}${text} ${currency}`;
}

export function signedCurrencyAmount(value: number | null | undefined, currency: string, digits = 2): string {
  if (!finite(value)) return '—';
  return `${value > 0 ? '+' : ''}${formatCurrencyAmount(value, currency, digits)}`;
}

export const formatRatePct = (rate: number | null | undefined): string =>
  finite(rate) ? `${rate > 0 ? '+' : ''}${(rate * 100).toFixed(4)}%` : '—';

export const marginModeLabel = (mode: 'cross' | 'isolated' | null | undefined): string =>
  mode === 'cross' ? '全仓' : mode === 'isolated' ? '逐仓' : '—';

const TRADE_DIR_LABELS: Record<string, string> = {
  'Open Long': '开多',
  'Add Long': '加多',
  'Close Long': '平多',
  'Open Short': '开空',
  'Add Short': '加空',
  'Close Short': '平空',
  Buy: '买入',
  Sell: '卖出',
};
export function tradeDirLabel(trade: Pick<AccountTrade, 'side' | 'dir'>): string {
  if (trade.dir) return TRADE_DIR_LABELS[trade.dir] ?? trade.dir;
  return trade.side === 'buy' ? '买入' : '卖出';
}

export function accountHealthBadge(venue: Pick<VenueAccountView, 'configured' | 'at' | 'stale' | 'error'>): { tone: 'ok' | 'warn' | 'bad' | ''; label: string } {
  if (!venue.configured) return { tone: '', label: '未配置' };
  if (venue.error && venue.at === null) return { tone: 'bad', label: '读取失败' };
  if (venue.stale) return { tone: 'warn', label: venue.error ? '读取失败（已过期）' : '读数过期' };
  if (venue.error) return { tone: 'warn', label: '上次刷新失败' };
  return { tone: 'ok', label: '正常' };
}

export function accountActivityFoot(
  data: Pick<AccountsView, 'venues' | 'totals'>,
  filter: AccountVenueFilter,
): string {
  if (filter !== 'all') {
    const venue = data.venues.find(item => item.venue === filter);
    if (!venue || !venue.configured) return '还没有配置该场所账户';
    if (venue.tradesError) return venue.authRequired ? '成交未授权' : '成交读取失败';
    if (venue.historyAt === null) return '成交未拉取';
    const realized = venue.summary.realizedPnlUsd !== null
      ? ` · 已实现 ${signedCurrencyAmount(venue.summary.realizedPnlUsd, venue.collateralAsset)}`
      : '';
    return `成交 ${venue.summary.tradeCount} 笔 · 成交额 ${usd(venue.summary.volumeUsd, 0)}${realized}`;
  }
  const configured = data.venues.filter(item => item.configured);
  if (!configured.length) return '还没有配置实盘场所账户';
  const tradeOk = configured.filter(item => item.historyAt !== null && !item.tradesError);
  const tradePart = tradeOk.length === 0
    ? '成交未拉取'
    : tradeOk.length < configured.length
      ? `已读成交 ${data.totals.tradeCount30d} 笔（${tradeOk.map(item => venueShort(item.venue)).join('、')}）`
      : `成交 ${data.totals.tradeCount30d} 笔`;
  const fundingPartial = data.totals.fundingVenues.length > 0 && data.totals.fundingVenues.length < configured.length
    ? `资金费含 ${data.totals.fundingVenues.map(venueShort).join('、')}`
    : '';
  const realizedPart = data.totals.realizedPnlUsd30d !== null
    ? `已实现 ${signedCurrencyAmount(data.totals.realizedPnlUsd30d, 'USD')}${data.totals.realizedVenues.length < configured.length ? `（${data.totals.realizedVenues.map(venueShort).join('、')}）` : ''}`
    : '';
  return [tradePart, fundingPartial, realizedPart, `策略实盘累计 ${signedUsd(data.totals.liveNetUsd)}`].filter(Boolean).join(' · ');
}

// ---- Entropy 返佣核对 ----
export interface RebateAuditInput {
  notionalUsd: number;
  usdcFeeUsd: number;
  assumedFeeBps: number | null;
  weightedHypePriceUsd: number | null;
  payoutHype?: number | null;
  payoutHypePrice?: number | null;
  payoutUsd?: number | null;
}
export interface RebateAuditResult {
  rebateUsdAtPayout: number;
  rebateUsdAtTrade: number | null;
  rebatePctOfTotalFee: number | null;
  rebatePctOfEntropyHalf: number | null;
  realOneWayBps: number | null;
  realRoundTripBps: number | null;
  deltaOneWayBps: number | null;
}
export function rebateAudit(input: RebateAuditInput): RebateAuditResult | null {
  let rebateUsdAtPayout: number | null = null;
  let rebateUsdAtTrade: number | null = null;
  if (finite(input.payoutHype) && input.payoutHype >= 0 && finite(input.payoutHypePrice) && input.payoutHypePrice > 0) {
    rebateUsdAtPayout = input.payoutHype * input.payoutHypePrice;
    if (finite(input.weightedHypePriceUsd) && input.weightedHypePriceUsd > 0) rebateUsdAtTrade = input.payoutHype * input.weightedHypePriceUsd;
  } else if (finite(input.payoutUsd) && input.payoutUsd >= 0) {
    rebateUsdAtPayout = input.payoutUsd;
  }
  if (rebateUsdAtPayout === null) return null;
  const rebatePctOfTotalFee = finite(input.usdcFeeUsd) && input.usdcFeeUsd > 0 ? (rebateUsdAtPayout / input.usdcFeeUsd) * 100 : null;
  const rebatePctOfEntropyHalf = rebatePctOfTotalFee !== null ? rebatePctOfTotalFee * 2 : null;
  const realOneWayBps = finite(input.notionalUsd) && input.notionalUsd > 0 ? ((input.usdcFeeUsd - rebateUsdAtPayout) / input.notionalUsd) * 10_000 : null;
  const realRoundTripBps = realOneWayBps !== null ? realOneWayBps * 2 : null;
  const deltaOneWayBps = realOneWayBps !== null && finite(input.assumedFeeBps) ? realOneWayBps - input.assumedFeeBps : null;
  return { rebateUsdAtPayout, rebateUsdAtTrade, rebatePctOfTotalFee, rebatePctOfEntropyHalf, realOneWayBps, realRoundTripBps, deltaOneWayBps };
}
