// Anthropic、原油、海力士详情的「关联交易」面板（A-5），照工作台 modules/monitor/app/related-positions.tsx 与 app/cycle-evidence.tsx
// （提交 7745181）：持仓逐笔、本轮已平仓（cycle）与逐笔核对证据、同一交易所两腿的价差与组合盈亏。与工作台的差异：
// - 持仓从本服务 /api/asset/positions 读（use-live-resource.ts，每 60 秒；有腿的本轮统计还在读时每 25 秒，
//   沿用工作台 POSITIONS_REFRESH_MS / POSITIONS_FOLLOW_UP_MS），代替经 iframe 桥接向工作台宿主要数据；
//   宿主相关的状态（独立打开、连接中、未登录工作台、宿主不支持）去掉，换成「本服务没有配置资产账本」；
// - 「在交易中心查看」按钮换成指向本服务持仓页（#/positions）的链接；
// - 只有 panel 版式（工作台永续页用的 strip 版式本服务没有）；ANT 合计不做（原因见 monitor-related.ts），Anthropic 只列逐腿持仓并注明；
// - 当前价差取自同页「多交易所对比」各交易所的读数（MonitorExchanges.tsx onSpreads，原油价差、海力士溢价率），与工作台宿主
//   的 oilSpreads / hynixSpreads 相同；对比表还没读到的交易所显示 —；
// - 面板放在详情页右侧栏（DetailLayout，照工作台 monitor-hub.tsx 的 .monitor-detail 两栏）；工作台侧栏里的告警摘要
//   （monitor-detail-side.tsx）本服务没有，告警设置仍在主栏。
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronDown, Link2 } from 'lucide-react';
import { ApiError } from './api.ts';
import { useLiveResource } from './use-live-resource.ts';
import { readFailure } from './live-resource.ts';
import { RELATED_SYMBOLS, pairedMarket, positionItems, relatedSpreadPairs, type RelatedMarket, type RealizedStatus, type RelatedItem, type SpreadPair, type UnpairedReason, type VenueSpreads } from './monitor-related.ts';
import type { FillMarket } from '../../src/asset/fills-types.ts';
import type { CycleEvidence, HubPositions } from '../../src/asset/positions-types.ts';

export const RELATED_PATH = '/api/asset/positions';
export const POSITIONS_TIMEOUT_MS = 20_000, POSITIONS_REFRESH_MS = 60_000, POSITIONS_FOLLOW_UP_MS = 25_000;
const unpairedText = (market: FillMarket): Record<UnpairedReason, string> => ({ 'same-side': market === 'hynix' ? 'ADR 与正股同向' : 'CL 与 BZ 同向', multiple: '同一交易所有多笔同币种持仓', 'missing-leg': '缺少另一条腿' });
const totalsFoot = '平仓价差用两腿本轮平仓均价按同一公式计算。组合盈亏为两腿相加：未实现取当前持仓，已实现取各腿本轮（自仓位从零开仓起）已平仓部分，总盈亏 = 未实现 + 已实现净额；币种不同不合并。';
const pairFoot: Record<FillMarket, string> = {
  oil: `价差 = BZ − CL（USDT/桶），仅在同一交易所 CL 与 BZ 各一笔且方向相反时计算；当前价差取本页交易所报价。${totalsFoot}`,
  hynix: `价差 = ADR ÷（正股 ÷ 10）− 1，10 份 ADR 对 1 股正股；仅在同一交易所 ADR 与正股各一笔且方向相反时计算；当前价差取本页交易所报价，无报价的交易所显示 —。${totalsFoot}`,
};

const ANT_TOTALS_NOTE = '这里按交易所逐腿列出 ANT 持仓及盈亏。';

const beijing = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const beijingDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const clock = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? beijing.format(new Date(value)) : '—';
const dateClock = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? beijingDate.format(new Date(value)) : '—';
const finite = (value: string | null) => { if (value === null || value.trim() === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; };
const tone = (value: number | null) => value === null || value === 0 ? '' : value > 0 ? 'positive' : 'negative';
const sign = (value: number) => value > 0 ? '+' : value < 0 ? '−' : '';
const signedText = (suffix: string) => (value: number | null) => value === null ? '—' : `${sign(Number(value.toFixed(3)))}${Math.abs(value).toFixed(3)}${suffix}`;
/** Oil spreads are USDT per barrel; Hynix spreads are an ADR premium in percent. */
const spreadFormats = { oil: { level: signedText(''), change: signedText(' USDT/桶') }, hynix: { level: signedText('%'), change: signedText(' 百分点') } } as const;
const moneyFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Sign and tone follow the rounded text, so a tiny loss never shows as "−0.00" in red. */
const money = (value: number | null, currency: string | null) => {
  if (value === null) return { text: '—', tone: '' };
  const digits = moneyFormat.format(Math.abs(value)), shown = /[1-9]/.test(digits) ? value : 0;
  return { text: `${sign(shown)}${digits}${currency ? ` ${currency}` : ''}`, tone: tone(shown) };
};
const MoneyCell = ({ label, value, currency, title, children }: { label: string; value: number | null; currency: string | null; title?: string; children?: ReactNode }) => {
  const view = money(value, currency);
  return <div><dt title={title}>{label}</dt><dd className={view.tone}>{view.text}{children}</dd></div>;
};
const priceLarge = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }), priceSmall = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });
const priceText = (value: string | null) => { const number = finite(value); return number === null ? value ?? '—' : (Math.abs(number) >= 1 ? priceLarge : priceSmall).format(number); };

function CycleEvidenceView({ evidence }: { evidence: CycleEvidence }) {
  const [page, setPage] = useState(0), size = 20;
  const lastPage = Math.max(0, Math.ceil(evidence.rows.length / size) - 1), current = Math.min(page, lastPage);
  return <details className="related-cycle-note">
    <summary>本轮纳入记录与核对明细（{evidence.totalRows} 条）</summary>
    <p>覆盖 {evidence.coverageStart} — {evidence.coverageEnd} · {evidence.openingFound ? '已找到本轮开仓' : '未找到起点，覆盖不完整'}</p>
    <p>金额是实际纳入汇总的原币分项；排除记录与缺项保持未知。翻仓数量与手续费只含本轮份额。</p>
    <ol start={current * size + 1}>{evidence.rows.slice(current * size, (current + 1) * size).map((row, index) => <li key={`${row.kind}:${row.id}:${index}`}>
      <strong>{row.kind === 'fill' ? '成交' : row.kind === 'funding' ? '资金费' : '结算'} {row.id}</strong> · {row.time} · {row.status === 'included' ? '纳入' : row.status === 'partial' ? '部分纳入' : '排除'}
      {row.kind === 'fill' ? <p>{row.side === 'buy' ? '买入' : row.side === 'sell' ? '卖出' : '买卖方向未知'} · 数量 {row.quantity ?? '—'} @ {row.price ?? '—'} · 本轮平仓量 {row.closingQuantity ?? '未知/未纳入'} · 已实现 {row.realizedPnl ?? '未纳入'} {row.currency ?? ''} · 手续费 {row.fee ?? '未知/未纳入'} {row.feeCurrency ?? ''}{row.fraction ? ` · 本轮比例 ${row.fraction}` : ''}</p> : <p>金额 {row.amount ?? '未纳入'} {row.currency ?? ''}</p>}
      {row.reason ? <p>{row.reason}</p> : null}
    </li>)}</ol>
    {lastPage > 0 ? <div><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button> {current + 1} / {lastPage + 1} <button type="button" disabled={current === lastPage} onClick={() => setPage(current + 1)}>下一页</button></div> : null}
    {evidence.truncated ? <p>当前响应附带 {evidence.rows.length} / {evidence.totalRows} 条证据（受单仓或全局明细预算限制）；汇总使用全部已读取记录，当前明细不足以独立复算全部净额。</p> : null}
  </details>;
}

function CycleSummary({ item }: { item: RelatedItem }) {
  const cycle = item.cycle;
  if (!cycle) return null;
  if (cycle.status === 'loading') return <p className="related-cycle-note">本轮平仓统计中…</p>;
  if (cycle.status === 'unavailable') return <p className="related-cycle-note">本轮平仓：{cycle.note ?? '暂不可用'}</p>;
  const amount = (label: string, value: string | null) => <MoneyCell label={label} value={finite(value)} currency={cycle.currency} />;
  return <div className="related-cycle" data-cycle-status={cycle.status}>
    <div className="related-cycle-head"><span>本轮已平仓</span><span>{cycle.since ? `${dateClock(cycle.since)} 开仓 · ` : ''}{clock(cycle.updatedAt)} 统计{cycle.status === 'partial' ? '（不完整）' : ''}</span></div>
    <dl>
      <div><dt>平仓数量</dt><dd>{cycle.closedQuantity === null ? '—' : `${cycle.closedQuantity} ${item.quantityUnit}`}</dd></div>
      <div><dt>平仓均价</dt><dd>{priceText(cycle.closePrice)}</dd></div>
      {amount('已实现盈亏', cycle.realizedPnl)}{amount('手续费', cycle.fees)}{amount('资金费', cycle.funding)}{amount('净额', cycle.net)}
    </dl>
    {cycle.note ? <p className="related-cycle-note">{cycle.note}</p> : null}
    {cycle.evidence ? <CycleEvidenceView key={`${item.key}:${cycle.since}:${cycle.updatedAt}`} evidence={cycle.evidence} /> : <p className="related-cycle-note">当前响应未附带本轮逐笔核对证据（来源未保留或已达到明细预算）。</p>}
  </div>;
}

const realizedNote: Partial<Record<RealizedStatus, string>> = {
  loading: '已实现部分统计中…',
  unavailable: '已实现部分暂不可用：至少一条腿的本轮平仓统计不可用',
  'mixed-currency': '两腿已实现结算币种不同，不合并',
};
function PairDetail({ pair, market }: { pair: Extract<SpreadPair, { status: 'paired' }>; market: FillMarket }) {
  const totals = pair.totals, format = spreadFormats[market];
  const changeTone = pair.change === null || Number(pair.change.toFixed(3)) === 0 ? '' : (pair.change < 0) === pair.narrowingFavors ? 'positive' : 'negative';
  const totalsNote = realizedNote[totals.realizedStatus] ?? (totals.unrealized === null && totals.unrealizedCurrency === null ? '两腿未实现盈亏币种不同，不合并' : '');
  return <>
    <dl>
      <div><dt>开仓价差</dt><dd className={tone(pair.opening)}>{format.level(pair.opening)}</dd></div>
      <div><dt>当前价差</dt><dd className={tone(pair.current)}>{format.level(pair.current)}{pair.current !== null && pair.currentStale ? <span className="detail-stale-tag">旧</span> : null}</dd></div>
      <div><dt>平仓价差</dt><dd className={tone(pair.closing)}>{format.level(pair.closing)}</dd></div>
      <div><dt title="当前价差 − 开仓价差；绿色表示对本组合有利">价差变化</dt><dd className={changeTone}>{format.change(pair.change)}</dd></div>
    </dl>
    <div className="related-pair-totals" data-pair-totals={totals.realizedStatus}>
      <div className="related-cycle-head"><span>组合盈亏</span>{totals.realizedStatus === 'partial' ? <span>已实现不完整</span> : null}</div>
      <dl>
        <MoneyCell label="未实现盈亏" value={totals.unrealized} currency={totals.unrealizedCurrency}>{totals.unrealized !== null && totals.unrealizedStale ? <span className="detail-stale-tag">旧</span> : null}</MoneyCell>
        <MoneyCell label="已实现盈亏" value={totals.realized} currency={totals.realizedCurrency} />
        <MoneyCell label="手续费" value={totals.fees} currency={totals.realizedCurrency} />
        <MoneyCell label="资金费" value={totals.funding} currency={totals.realizedCurrency} />
        <MoneyCell label="已实现净额" value={totals.net} currency={totals.realizedCurrency} title="已实现盈亏 + 手续费 + 资金费" />
        <MoneyCell label="总盈亏" value={totals.total} currency={totals.unrealizedCurrency} title="未实现盈亏 + 已实现净额" />
      </dl>
      {totalsNote ? <p className="related-cycle-note">{totalsNote}</p> : null}
    </div>
  </>;
}

function PositionRows({ items }: { items: RelatedItem[] }) {
  return <ul className="related-positions-list">{items.map(item => <li key={item.key} data-stale={item.stale}>
    <div className="related-position-head"><span className="related-position-source">{item.source} · {item.exchange}</span>{item.stale ? <span className="detail-stale-tag" title={item.updatedAt ? `数据时间 ${clock(item.updatedAt)} 北京时间` : '数据时间未知'}>旧</span> : null}</div>
    <div className="related-position-main"><strong>{item.symbol}</strong><span className={item.side === 'long' ? 'positive' : 'negative'}>{item.side === 'long' ? '多' : '空'}</span><span>{item.quantity} {item.quantityUnit}</span></div>
    <dl><MoneyCell label="未实现盈亏" value={finite(item.unrealizedPnl)} currency={item.pnlCurrency} /><div><dt>入场价</dt><dd>{priceText(item.entryPrice)}</dd></div></dl>
    <CycleSummary item={item} />
  </li>)}</ul>;
}

/** The detail page's two columns (the workbench hub's .monitor-detail): the market's panel and, on the right, `side`. */
export function DetailLayout({ side, children }: { side: ReactNode; children: ReactNode }) {
  return <div className="monitor-detail"><div className="monitor-detail-main">{children}</div><aside className="monitor-detail-side">{side}</aside></div>;
}

export function RelatedPositions({ market, spreads, symbols, extra, onExpired }: { market: RelatedMarket | "perpetual"; symbols?: string[]; extra?: ReactNode; spreads?: VenueSpreads; onExpired: () => void }) {
  const [stripOpen, setStripOpen] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const live = useLiveResource<HubPositions>(RELATED_PATH, { intervalMs: followUp ? POSITIONS_FOLLOW_UP_MS : POSITIONS_REFRESH_MS, timeoutMs: POSITIONS_TIMEOUT_MS, onExpired });
  const missing = live.error instanceof ApiError && live.error.status === 404;
  const failed = readFailure(live) !== null;
  const snapshot = live.data ? { generatedAt: live.data.generatedAt, ...positionItems(live.data, market === 'perpetual' ? symbols ?? [] : RELATED_SYMBOLS[market], Date.now()) } : null;
  const shown = snapshot?.items ?? [];
  // A leg whose current-round statistics are still being read is read again sooner (the workbench's positionsFollowUp).
  const loadingCycle = shown.some(item => item.cycle?.status === 'loading');
  useEffect(() => { setFollowUp(failed || loadingCycle); }, [failed, loadingCycle]);
  const incomplete = snapshot?.incomplete === true;
  const sourcesIncomplete = snapshot?.sourcesIncomplete === true;
  const range = snapshot?.truncated ? `仅显示前 ${snapshot.itemLimit} 条（${sourcesIncomplete ? '已读取部分中共' : '共'} ${snapshot.matchedCount} 条匹配）` : '';
  const pairMarket = market !== 'perpetual' && pairedMarket(market) ? market : null;
  const pairs = pairMarket ? relatedSpreadPairs(pairMarket, shown, spreads, incomplete) : [];
  const status = missing ? 'missing' : snapshot ? (failed ? 'retained' : 'ok') : failed ? 'unavailable' : 'loading';
  const message = status === 'missing' ? '本服务没有配置资产账本，在「设置」页从工作台导入后显示关联持仓'
    : status === 'loading' ? '加载中…'
    : status === 'unavailable' ? `持仓不可用：${live.error?.message ?? '网络离线'}，稍后自动重试`
    : incomplete && !shown.length ? '部分数据源不可用'
    : !shown.length ? '无关联持仓' : '';
  const partial = sourcesIncomplete && shown.length > 0;
  const keptAt = status === 'retained' && snapshot ? `保留 ${clock(snapshot.generatedAt)} 的持仓数据` : '';
  const body = <>
    {message ? <p className={status === 'unavailable' || status === 'missing' || incomplete ? 'detail-side-error' : 'detail-side-empty'}>{message}</p> : null}
    {partial ? <p className="detail-side-error">部分数据源不可用，列表可能不完整</p> : null}
    {range ? <p className="detail-side-error">{range}</p> : null}
    {pairMarket && incomplete && shown.length ? <p className="detail-side-note">持仓列表不完整，暂不确认配对</p> : null}
    {keptAt ? <p className="detail-side-note">{keptAt}</p> : null}
    {market === 'anthropic' && shown.length ? <p className="detail-side-note">{ANT_TOTALS_NOTE}</p> : null}
    {pairMarket && pairs.length ? <ul className="related-spread-pairs">{pairs.map(pair => <li key={pair.key} data-pair-status={pair.status}><span>{pair.label}</span>{pair.status === 'paired' ? <PairDetail pair={pair} market={pairMarket} /> : <p className="related-unpaired">无法配对 · {unpairedText(pairMarket)[pair.reason]}</p>}</li>)}</ul> : null}
    {shown.length ? <PositionRows items={shown} /> : null}
    {pairMarket && pairs.length ? <p className="detail-side-foot">{pairFoot[pairMarket]}</p> : null}
  </>;
  const positionsLink = status !== 'missing' ? <div className="related-positions-actions"><a className="detail-side-action" href="#/positions">在持仓页查看<ArrowUpRight size={13} aria-hidden="true" /></a></div> : null;
  if (market === 'perpetual') return <section className="related-positions related-positions-strip" data-related-positions={market} data-status={status}>
    <div className="related-strip-bar"><button type="button" className="related-strip-toggle" aria-expanded={stripOpen} onClick={() => setStripOpen(value => !value)}>
      <Link2 size={14} /><strong>关联交易</strong><span>{message || keptAt || range || `${shown.length} 笔关联持仓 · ${clock(snapshot?.generatedAt ?? null)}`}</span><ChevronDown size={13} /></button>{extra}{positionsLink}</div>
    {stripOpen && <div className="related-strip-body">{body}</div>}
  </section>;
  return <section className="detail-side-panel related-positions related-positions-panel" data-related-positions={market} data-status={status}>
    <div className="detail-side-heading"><h2><Link2 size={15} aria-hidden="true" />关联交易</h2>{status === 'ok' && snapshot ? <span className="detail-side-meta">{clock(snapshot.generatedAt)}</span> : null}</div>
    {body}{positionsLink}
  </section>;
}
