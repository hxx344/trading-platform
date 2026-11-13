// Formatting and wording of the asset pages, copied from project_aggregation modules/asset/app (0014655): money, stamp,
// badge, the fx labels, the history sources and the account detail notes from dashboard.tsx; the summary, monthly hint
// and axis labels from asset-trend.tsx; items() from daily-changes.tsx; the evidence and audit lines from
// cash-flows-panel.tsx. Kept free of the DOM so the server-side tests can import it.
import type { Asset, Balance, FxStatus, Period } from '../../src/asset/types.ts';
import type { DailyChange } from '../../src/asset/daily-changes.ts';
import type { CashFlowEvidence, CashFlowRecord } from '../../src/asset/cash-flows.ts';
import { MIN_MONTHLY_SPAN_DAYS, formatReturnRate, type MonthlyPerformance } from '../../src/asset/performance-metrics.ts';
import { isExchangeMode, type TrendPoint } from '../../src/asset/views.ts';

/** The command that fills asset.sqlite outside the page's import; README describes the arguments. */
export const IMPORT_COMMAND = 'node src/asset/import.ts --from <工作台数据目录>/modules/asset/ledger.sqlite --owner <工作台用户名> --data-dir <本服务数据目录>';

export const money = (n: number, d = 2): string => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
/** asset-trend.tsx, daily-changes.tsx and withdrawals-panel.tsx format with zh-CN; null is an unknown value. */
export const zhMoney = (n: number | null): string => n === null ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const signed = (n: number): string => (n > 0 ? '+' : '') + zhMoney(n);
export const stamp = (s: string | null | undefined): string => s ? new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚未同步';
/** The import time with its year: an imported ledger may be read long after. */
export const fullStamp = (s: string | null | undefined): string => s ? new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const dayTick = (time: number): string => new Date(time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' });
export const amountTick = (value: number): string => Math.abs(value) >= 1000 ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + 'k' : String(value);

export function badge(a: Asset, now: number): string {
  if (a.mode !== 'manual' && a.status.includes('同步') && !a.error && now - new Date(a.updatedAt).getTime() > 300000) return '数据已过期 · 保留旧值';
  if (a.mode === 'market' && !a.error && now - new Date(a.updatedAt).getTime() > 900000) return '行情已过期 · 保留旧值';
  return a.status;
}
export const statusTone = (a: Asset, label: string): string => a.mode === 'manual' ? '' : a.error || label.includes('旧值') || label.includes('待') ? 'amber' : 'live';
/** Rows the current table greys out: a failed read or a value kept from an earlier one. */
export const staleRow = (a: Asset, label: string): boolean => !!a.error || label.includes('旧值');

export function quantityText(a: Asset, current: boolean): string {
  if (current && isExchangeMode(a.mode)) return a.mode === 'binance' ? '钱包资产估值' : a.mode === 'okx' || a.mode === 'gate' ? '账户资产估值' : a.mode === 'hyperliquid' || a.mode === 'rh-lighter' ? '账户总值' : '账户权益';
  return a.quantity === null ? '—' : money(a.quantity, a.quantity % 1 ? 4 : 0);
}
export const priceText = (a: Asset, current: boolean): string => current && isExchangeMode(a.mode) ? '—' : a.price === null ? '—' : money(a.price, a.price < 1 ? 6 : 2);

export type FxView = { stale: boolean; source: string; state: string; when: string };
export function fxView(status: FxStatus, now: number): FxView {
  const stale = !!status.error || !status.fetchedAt || now - Date.parse(status.fetchedAt) > 300000;
  const source = status.source === 'manual' ? '手动备用' : status.source === 'saved' ? '原表 / 已保存值' : status.source === 'Frankfurter' ? 'Frankfurter / ECB（日度参考）' : 'Coinbase';
  const state = status.error ? '更新失败 · 保留旧值' : stale ? '待更新' : status.source === 'manual' ? '临时手动' : '自动更新';
  return { stale, source, state, when: status.rateDate ? '报价日期 ' + status.rateDate : '获取时间 ' + stamp(status.fetchedAt) };
}

export function periodSource(p: Period): string {
  return p.archived ? '导入前示例记录' : p.future ? '原表预填' : p.id.startsWith('daily-') ? (p.missingValues ? '当日快照 · 部分估值' : p.partial ? '当日快照 · 含旧值' : '当日最后更新') : '原表 ' + p.id + (p.missingValues ? ' · 部分估值' : '');
}
export const periodKind = (p: Period): string => p.archived ? '导入前示例记录' : p.future ? '原表预填记录' : p.id.startsWith('daily-') ? '当日最近一次已保存数据' : '原表 ' + p.id;
export const periodFxTitle = (p: Period): string => p.fxStatus ? (p.fxStatus.source === 'Frankfurter' ? 'Frankfurter / ECB · 报价日 ' + p.fxStatus.rateDate : p.fxStatus.source + ' · ' + stamp(p.fxStatus.fetchedAt)) : '原记录汇率';

type Mode = Asset['mode'];
const wallet = (mode: Mode) => mode === 'hyperliquid' || mode === 'rh-lighter';
export const detailTitle = (mode: Mode): string => mode === 'binance' ? '钱包资产明细' : mode === 'okx' || mode === 'gate' ? '账户资产估值明细' : wallet(mode) ? '账户总值明细' : '账户明细';
export const detailSubtitle = (a: Asset): string => (a.mode === 'variational' || a.mode === 'gate' || a.mode === 'hyperliquid' ? '估值时间 ' : a.mode === 'rh-lighter' ? '获取时间 ' : '最近同步 ') + stamp(a.updatedAt) + ' · '
  + (a.mode === 'binance' ? '钱包资产估值 / USD' : a.mode === 'okx' || a.mode === 'gate' ? '账户资产估值 / USD' : wallet(a.mode) ? '账户总值 / USD' : '美元净权益');
export const detailHeads = (mode: Mode): [string, string] => [
  mode === 'binance' || mode === 'okx' || mode === 'gate' ? '账户 / 估值单位' : '账户 / 币种',
  mode === 'binance' ? '折合余额 / USDT' : mode === 'gate' ? '折合金额' : mode === 'okx' ? '折合金额 / USD' : mode === 'variational' ? '净权益 / USDC' : '数量',
];
/** One balance line: wallet notes carry no coin, and wallet tokens without a price are listed unvalued. */
export function detailLine(mode: Mode, b: Balance): { coin: string | null; quantity: string; value: string } {
  const note = wallet(mode) && b.coin === '—', unvalued = wallet(mode) && !note && b.price === 0 && b.quantity !== 0;
  return { coin: note ? null : b.coin, quantity: note ? '—' : money(b.quantity, 6), value: note ? '—' : unvalued ? '未估值' : money(b.value) };
}
const DETAIL_NOTES: Partial<Record<Mode, string>> = {
  'rh-lighter': '总额为该 L1 地址下全部账户的 total_asset_value 之和（抵押 USDG 加未实现盈亏，保证金资产按交易所折扣计入），USDG 按 1:1 计为美元，未单独读取 USDG/USD 报价。现货代币余额、挂单锁定和公共池份额不在该值内，只列数量、显示未估值，不计入总额。获取时间为读取请求的发起时间；同一地址的资产与持仓共用一次读取，最多缓存 30 秒。',
  hyperliquid: '总额采用 Hyperliquid 官方账户总值（覆盖现货、全部永续 DEX（含 io / xyz 等市场及未实现盈亏）、金库存款与质押 HYPE），按 USDC/USD 汇率换算美元。分项仅供核对，不再相加：统一账户与组合保证金模式下永续与现货共用余额，只列现货余额；其他模式分列各 DEX 永续权益与现货余额。非 USDC 代币按 Hyperliquid 现货中价折算，无报价的显示未估值；分项读取失败时只更新总额并标注。估值时间取账户值时间与汇率时间中较早者。',
  variational: '按 Omni 返回的 USDC 净权益与 USDC/USD 报价换算美元估值。净权益已包含未实现盈亏，不再累加保证金、盈亏或持仓名义价值；资产来源未提供时刻；估值时间取账户获取时间与汇率时间中较早者。',
  gate: '总额采用 Gate 返回的账户总资产 USDT 估值，再按 USDT/USD 汇率换算；分项显示原币种折合金额与美元价值，不代表实际持币量，旧记录以行内币种为准。范围以接口返回为准，不额外累加余额、保证金或未实现盈亏，不自动汇总子账户。Gate 数据最多缓存 1 分钟；估值时间取账户获取时间与汇率时间中较早者，汇率未提供源时间时采用获取时间。',
  okx: '总额直接采用 OKX 返回的账户总资产美元估值；分项是各账户的折合金额，不代表实际 USD 持仓，分项与总额可能存在舍入差异。不额外累加保证金、未实现盈亏或持仓名义价值，不自动汇总子账户。',
  binance: '按 Binance 返回的各钱包折合 USDT 余额汇总，再按 USDT/USD 汇率换算；折合余额不是实际 USDT 持仓。不额外累加现货、合约或持仓名义价值，未实现盈亏是否包含以接口返回为准。',
};
export const detailNote = (mode: Mode): string => DETAIL_NOTES[mode] ?? '账户合计采用交易所净权益。币种行仅供核对，不将保证金和持仓名义价值再次计入。';

export type ChangeLine = { key: string; label: string; change: number; detail: string };
export type ChangeItem = ChangeLine & { sub: ChangeLine[] };
export function dailyItems(day: DailyChange): ChangeItem[] {
  return [
    ...day.sources.map(source => ({ key: 'row:' + source.id, label: source.project + (source.kind ? ' · ' + source.kind : ''), change: source.change,
      detail: source.previous === null && source.current === null ? '估值缺失' : `${zhMoney(source.previous)} → ${zhMoney(source.current)}`,
      sub: source.details.map(detail => ({ key: detail.label, label: detail.label, change: detail.change, detail: `${zhMoney(detail.previous)} → ${zhMoney(detail.current)}` })) })),
    ...(day.withdrawnChange ? [{ key: 'withdrawn', label: '出金（加回）', change: day.withdrawnChange, detail: '累计出金变化', sub: [] }] : []),
    ...(day.unattributed ? [{ key: 'unattributed', label: day.partial ? '未归因变化' : '原表合计差异', change: day.unattributed, detail: day.partial ? '部分数据无法归因，包含已知金额范围变化' : '原表总额与行估值之和的差额变化', sub: [] }] : []),
  ].sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

/** The trend panel's headline: the change between the first and last point, unless either misses values. */
export function trendSummary(trend: readonly TrendPoint[]): { first: TrendPoint | undefined; last: TrendPoint | undefined; change: number | null; incomplete: string } {
  const first = trend[0], last = trend.at(-1);
  const change = first && last && !first.missingValues && !last.missingValues ? last.adjusted - first.adjusted : null;
  const incomplete = [first && { label: '起点', point: first }, last !== first && last && { label: '终点', point: last }]
    .flatMap(item => item && item.point.missingValues ? [`${item.label} ${item.point.date} 有 ${item.point.missingValues} 项估值缺失`] : []).join('，');
  return { first, last, change, incomplete };
}

export function monthlyHint(month: MonthlyPerformance | null): string {
  return !month ? '上个自然月没有快照'
    : month.snapshotCount < 2 || month.daysSpan < MIN_MONTHLY_SPAN_DAYS ? `需要两个不同日期，首末快照间隔至少 ${MIN_MONTHLY_SPAN_DAYS} 天`
    : month.returnRate === null ? '首末快照估值须完整，起始调整后资产须大于 0，变化率需为有效数值'
    : `当月 ${formatReturnRate(month.returnRate)} · ${month.startDate} — ${month.endDate} · ${month.daysSpan} 天`;
}

export const CASH_FLOW_PAGE = 20;
export const evidenceStatus = (row: CashFlowEvidence): string => row.status === 'paired' ? '已配对，净贡献 0' : row.status === 'pending' ? '待配对' : `外部资金流 USD ${row.usdValue ?? '未知'}`;
export const auditLine = (item: CashFlowRecord): string => `v${item.revision} · ${item.recordedAt} · ${item.date} · ${item.account} · ${item.amount} ${item.currency} · ${item.kind} · ${item.transferId ?? '无配对编号'} · USD 汇率 ${item.usdRate ?? '未知'} / ${item.rateAt ?? '无时间'} · ${item.reference} · ${item.reason}${item.void ? ' · 已作废' : ''}`;
