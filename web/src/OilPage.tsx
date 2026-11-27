import { ArrowRightLeft, ChevronDown, Clock3, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { useDialogGuard } from './AppDialog.tsx';
import { clock, label, stamp } from './labels.ts';
import { ACTIVE_STATUSES, CONFIRM_ACKNOWLEDGE, CONFIRM_NOT_CREATED, CONFIRM_RELEASE, DEFAULT_FORM, LEAD_TYPES, OIL_VENUES, VENUE_LABEL, describeFourLeg, describeIntent, draftFourLegs, fourLegFormToIntent, HEDGE_TYPES, allowedOrderTypes, hedgeVenueFor, leadTypeAllowed, draftLegs, formToIntent, jobActions, type OilForm, type OilFourLegIntent, type OilIntent, type OilLeadType, type OilSymbol, type OilVenue } from './oil-form.ts';
import { bookTitle, crossPairs, operationStatus, type OilBook, type OilConfirmResult, type OilJob, type OilMarket, type OilPositionAccount, type OilPreview, type OilPreviewLeg, type OilState } from './oil-types.ts';
import { groupJobs, groupStatus, isFourLegPreview, type FourLegConfirmResult, type FourLegPreview, type GroupState } from './four-leg.ts';
import { RequestIds } from './request-ids.ts';
import { acceptedFourLegText, acceptedJobText, confirmRefused, errorText, executeOrderConfirm, leaveOrderPreview, LEAVE_UNANSWERED_CONFIRM, statusOf } from './order-confirm.ts';
import { StatePanel } from './StateViews.tsx';
import { OilPnl } from './OilPnl.tsx';
import { OilRules } from './OilRules.tsx';
import { useLiveResource, type LiveResource } from './use-live-resource.ts';
import './trading.css';

// The oil page, laid out as the workbench trading page (OilTradingPage / TradingSpread / TradingExecution, styles copied in
// trading.css): the live spread, the oil positions, then one execution panel with the caps, the jobs, the preview and the
// order form. Every read goes through useLiveResource (paused in the background, the last result kept and marked stale on
// a failure); every write keeps its request id until an answer arrives.
export const OIL_STATE_PATH = '/api/oil/state';
export const OIL_READ_TIMEOUT_MS = 10_000;
export const MARKET_MS = 3_000, ACTIVE_MS = 2_000, IDLE_MS = 5_000;

export const JOB_STATUS: Record<string, string> = { accepted: '已受理', running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', attention: '需人工处理' };
/** The workbench badge colours: running blue, completed green, waiting for a person amber. */
const JOB_BADGE: Record<string, string> = { accepted: 'running', running: 'running', completed: 'completed', failed: 'attention', attention: 'attention' };
const TRACKING_STATUS: Record<string, string> = {
  accepted: '已受理，正在发送首腿。', running: '执行中：首腿成交后对冲腿跟上。', completed: '已完成，两腿成交见下表。',
  failed: '执行失败，原因见下方；已成交部分保留。', stopped: '已停止，已成交部分保留。', attention: '需要人工处理，请按下方说明核对交易所。',
};
/** A hynix rebalance sends one order and nothing follows it. */
const REBALANCE_TRACKING: Record<string, string> = { ...TRACKING_STATUS, accepted: '已受理，正在发送调平委托。', running: '执行中：调平委托已发送，等待成交结果。', completed: '已完成，成交见下表。' };
const isRebalance = (job: Pick<OilJob, 'preset'>): boolean => job.preset === 'rebalance';
export const ORDER_TYPE: Record<string, string> = { market: '市价', chase: '追价策略', 'local-chase': '本地追价', limit: '限价' };
export const ACCOUNT_MODE: Record<string, string> = { standard: '普通 U 本位', 'portfolio-margin': '组合保证金', unified: '统一账户', cross: '全仓', isolated: '逐仓' };
const SYMBOLS: readonly OilSymbol[] = ['BZUSDT', 'CLUSDT'];
export { statusOf, confirmRefused, errorText };
const short = (symbol: string): string => symbol.replace('USDT', '');
/** Hynix legs are named as the workbench names them: ADR and the ordinary share. */
const HYNIX_CONTRACT: Record<string, string> = { SKHYUSDT: 'ADR', SKHYNIXUSDT: '正股' };
export const venueName = (venue: string): string => label(VENUE_LABEL, venue);
/** Whether the leg's order buys: opening a long or closing a short. */
export const buys = (action: 'open' | 'close', side: string): boolean => (action === 'open') === (side === 'long');
/** 开多 / 开空 / 平多 / 平空, as the workbench names a leg's operation. */
export const operation = (action: string, side: string): string => `${action === 'open' ? '开' : '平'}${side === 'long' ? '多' : '空'}`;

/** The same staleness rule as the overview: a failed or paused read, or a result older than two refreshes and a timeout. */
export function staleness(live: Pick<LiveResource<unknown>, 'data' | 'status' | 'error' | 'receivedAt'>, refreshMs: number): { stale: boolean; text: string | null } {
  const { data, status, error, receivedAt } = live;
  const old = receivedAt !== null && Date.now() - receivedAt > 2 * refreshMs + OIL_READ_TIMEOUT_MS;
  const stale = data !== null && (status === 'error' || status === 'offline' || status === 'paused' || (status === 'loading' && (error !== null || old)));
  if (!stale) return { stale, text: null };
  const at = clock(receivedAt);
  return { stale, text: status === 'paused' ? `页面在后台，已暂停刷新（停留在 ${at}）` : status === 'offline' ? `网络离线（停留在 ${at}）` : error ? `刷新失败：${error.message}（停留在 ${at}）` : `正在刷新，下方仍是 ${at} 的结果` };
}

export const LEAVE_UNANSWERED = LEAVE_UNANSWERED_CONFIRM;
type ReadState = 'live' | 'stale' | 'loading' | 'error';
const READ_STATE: Record<ReadState, string> = { live: '实时', stale: '已过期', loading: '读取中', error: '读取失败' };
function ReadStatus({ state }: { state: ReadState }) { return <span className={`trading-status ${state}`}><i aria-hidden="true" />{READ_STATE[state]}</span>; }

/** The sync line under a panel heading: how often it refreshes, or why the shown result is old. */
export function SyncLine({ stale, text, every, at }: { stale: boolean; text: string | null; every: string; at: number | null }) {
  return <div className={`execution-sync${stale ? ' stale' : ''}`} role={stale ? 'status' : undefined}><Clock3 size={14} aria-hidden="true" />
    <span>{text ?? (at === null ? '正在读取…' : `前台${every}更新。最近取得：${clock(at)}（北京时间）`)}</span></div>;
}

/** The workbench segmented choice: one pressed button per option. */
export function Choice<T extends string>({ label: name, value, options, onChange, id }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; id?: string }) {
  return <div className="execution-choice"><span aria-hidden="true">{name}</span><div className="execution-segmented" role="group" aria-label={name} id={id}>
    {options.map(([key, text]) => <button key={key} type="button" aria-pressed={value === key} data-value={key} onClick={() => { if (value !== key) onChange(key); }}>{text}</button>)}
  </div></div>;
}

function MarketPanel({ live }: { live: LiveResource<OilMarket> }) {
  const market = live.data;
  const { stale, text } = staleness(live, MARKET_MS);
  const failed = !market && (live.status === 'error' || live.status === 'offline');
  // A book older than two reads and a timeout no longer stands for the market.
  const limit = market ? 2 * market.readEveryMs + market.timeoutMs : 0;
  const old = (at: number | null): boolean => !market || at === null || market.now - at > limit;
  const book = (venue: string, symbol: string): OilBook | undefined => market?.books.find(row => row.venue === venue && row.symbol === symbol);
  const quote = (row: OilBook | undefined): ReactNode => {
    if (!row) return '—';
    const broken = row.failedAt !== null && (row.receivedAt === null || row.failedAt > row.receivedAt);
    if (broken && row.bid === null) return <span className="spread-error">读取失败：{row.error ?? '未知原因'}</span>;
    const late = broken || old(row.receivedAt);
    return <span className={late ? 'spread-stale' : undefined} title={bookTitle(clock(row.receivedAt), row.source, late)}>{row.bid ?? '—'} / {row.ask ?? '—'}{late ? <small>{broken ? `读取失败：${row.error ?? '未知原因'}` : `已过期 · ${clock(row.receivedAt)}`}</small> : null}</span>;
  };
  const spread = (label: string, value: string | null, at: number | null): ReactNode => <td data-label={label} className={value !== null && old(at) ? 'spread-stale' : undefined}>{value ?? '—'}{value !== null && old(at) ? <small>过期</small> : null}</td>;
  return <section className="trading-panel spread-panel" id="oilMarket" aria-labelledby="oil-market-title">
    <header className="trading-panel-heading"><div><h2 id="oil-market-title">原油实时价差</h2><p>同所 BZ − CL · 单位 USDT/桶 · 卖出价差 = BZ 买一 − CL 卖一，买入价差 = BZ 卖一 − CL 买一</p></div>
      <button className="button secondary" type="button" onClick={() => void live.refresh()}><RefreshCw size={15} aria-hidden="true" />刷新行情</button></header>
    <SyncLine stale={stale || failed} text={failed ? `行情读取失败：${live.error?.message ?? '网络离线'}` : text} every={`每 ${Math.round((market?.readEveryMs ?? MARKET_MS) / 1000)} 秒`} at={market?.readAt ?? null} />
    {market ? <>
      <div className="spread-markets oil-spread-markets"><div className="execution-table-wrap"><table className="execution-progress-table spread-table" id="oilSpreads">
        <caption>布伦特 / WTI · 同所价差 BZ − CL</caption>
        <thead><tr><th scope="col">交易所</th><th scope="col">BZ 买一 / 卖一</th><th scope="col">CL 买一 / 卖一</th><th scope="col">卖出价差<small>BZ 买一 − CL 卖一</small></th><th scope="col">买入价差<small>BZ 卖一 − CL 买一</small></th></tr></thead>
        <tbody>{market.sameExchange.map(row => <tr key={row.venue}>
          <th scope="row">{venueName(row.venue)}</th>
          <td data-label="BZ 买一 / 卖一">{quote(book(row.venue, 'BZUSDT'))}</td><td data-label="CL 买一 / 卖一">{quote(book(row.venue, 'CLUSDT'))}</td>
          {spread('卖出价差', row.sell, row.receivedAt)}{spread('买入价差', row.buy, row.receivedAt)}
        </tr>)}</tbody>
      </table></div></div>
      {market.crossExchange.length ? <details className="spread-cross"><summary>跨所价差 · {crossPairs(market.crossExchange).map(pair => `${venueName(pair.first)} 与 ${venueName(pair.second)}`).join('、')} 同一合约</summary>
        {crossPairs(market.crossExchange).map(pair => {
          const [a, b] = [venueName(pair.first), venueName(pair.second)];
          return <div key={`${pair.first}:${pair.second}`} className="spread-markets oil-spread-markets"><div className="execution-table-wrap"><table className="execution-progress-table spread-table" id={`oilCross-${pair.first}-${pair.second}`}>
            <thead><tr><th scope="col">合约</th><th scope="col">{a} 买一 / 卖一</th><th scope="col">{b} 买一 / 卖一</th><th scope="col">{a} 买一 − {b} 卖一</th><th scope="col">{b} 买一 − {a} 卖一</th></tr></thead>
            <tbody>{pair.rows.map(row => <tr key={row.symbol}>
              <th scope="row">{short(row.symbol)}</th>
              <td data-label={`${a} 买一 / 卖一`}>{quote(book(pair.first, row.symbol))}</td><td data-label={`${b} 买一 / 卖一`}>{quote(book(pair.second, row.symbol))}</td>
              {spread(`${a} 买一 − ${b} 卖一`, row.firstOverSecond, row.receivedAt)}{spread(`${b} 买一 − ${a} 卖一`, row.secondOverFirst, row.receivedAt)}
            </tr>)}</tbody>
          </table></div></div>;
        })}
      </details> : null}
    </> : failed ? null : <p className="trading-footnote">正在读取盘口…</p>}
  </section>;
}

/** Which contracts a positions panel lists and how it names them: oil by default, hynix from its page. */
/** note: one more line under the heading, e.g. what else the amounts include. */
export interface PositionsKind { name: string; symbols: readonly string[]; contract: (symbol: string) => string; id: string; note?: string }
// The gold-oil page trades CL / BZ on the same accounts (docs/goldoil.md 2): the amounts here are the accounts' whole positions.
const OIL_POSITIONS: PositionsKind = { name: '原油', symbols: SYMBOLS, contract: short, id: 'oilPositions', note: 'CL / BZ 为账户合计，含金油任务的油腿' };

export function PositionsPanel({ state, stale, kind = OIL_POSITIONS }: { state: Pick<OilState, 'positions'>; stale: boolean; kind?: PositionsKind }) {
  const view = state.positions;
  const readState = (account: OilPositionAccount): ReadState => {
    if (account.failedAt !== null && (account.receivedAt === null || account.failedAt > account.receivedAt)) return 'error';
    if (account.receivedAt === null) return 'loading';
    return stale ? 'stale' : 'live';
  };
  const amount = (side: Record<string, string> | null, symbol: string): string | null => side ? side[symbol] ?? '0' : null;
  const cell = (value: string | null, side: 'long' | 'short'): ReactNode => value === null ? '—' : Number(value) ? <span className={`trading-side ${side}`}>{value}</span> : <span className="trading-muted">0</span>;
  return <section className="trading-panel trading-overview" id={kind.id} aria-labelledby={`${kind.id}-title`}>
    <header className="trading-panel-heading"><div><h2 id={`${kind.id}-title`}>{kind.name}持仓</h2><p>执行账户的 {kind.symbols.map(kind.contract).join(' / ')} 合约数量与{kind.name}挂单 · 每 {Math.round(view.readEveryMs / 1000)} 秒读取{kind.note ? ` · ${kind.note}` : ''}</p></div></header>
    {view.accounts.length ? <div className="trading-position-scroll"><table className="trading-position-table" aria-label={`${kind.name}持仓`}>
      <thead><tr><th scope="col">合约 / 账户</th><th scope="col">多头<small>合约数量</small></th><th scope="col">空头<small>合约数量</small></th><th scope="col">{kind.name}挂单</th><th scope="col">读取时间<small>北京时间</small></th></tr></thead>
      <tbody>{view.accounts.flatMap(account => kind.symbols.map((symbol, index) => {
        const read = readState(account);
        return <tr key={`${account.venue}:${symbol}`} className={index === 0 ? 'trading-leg-start' : ''}>
          <th scope="row" className="trading-leg-name"><strong>{venueName(account.venue)} {kind.contract(symbol)}</strong><span>{account.accountId} · {label(ACCOUNT_MODE, account.accountMode)}</span>{index === 0 ? <ReadStatus state={read} /> : null}</th>
          <td data-label="多头">{cell(amount(account.long, symbol), 'long')}</td>
          <td data-label="空头">{cell(amount(account.short, symbol), 'short')}</td>
          <td data-label={`${kind.name}挂单`}>{index === 0 ? account.openOrders ?? '—' : ''}</td>
          <td data-label="读取时间">{index === 0 ? read === 'error' ? <span className="trading-warning">读取失败：{account.error ?? '未知原因'}{account.receivedAt ? `（显示 ${clock(account.receivedAt)} 的结果）` : ''}</span> : clock(account.receivedAt) : ''}</td>
        </tr>;
      }))}</tbody>
    </table></div> : <p className="trading-footnote">没有配置{kind.name}执行账户。</p>}
    {stale ? <p className="trading-footnote trading-warning">执行状态未能刷新，显示的是上次读取的结果。</p> : null}
  </section>;
}

function PreviewCard({ preview, busy, unknown, onConfirm, onEdit }: { preview: OilPreview; busy: boolean; unknown: boolean; onConfirm: () => void; onEdit: () => void }) {
  const action = preview.intent.action === 'open' ? '开仓' : '平仓';
  const accounts = [...new Map(preview.legs.map(leg => [`${leg.venue}:${leg.accountId}`, leg])).values()];
  const expired = Date.now() > preview.expiresAt;
  return <section className="execution-review" id="oilPreview" aria-labelledby="oil-review-title" tabIndex={-1}>
    <div className="execution-review-title"><div><h3 id="oil-review-title">确认{describeIntent(preview.intent as OilIntent)}</h3><p>预览有效至 {clock(preview.expiresAt)}（北京时间）</p></div><span className="execution-badge attention">实盘下单</span></div>
    <div className="execution-review-accounts">{accounts.map(leg => <p key={`${leg.venue}:${leg.accountId}`}><strong>{venueName(leg.venue)}</strong> {label(ACCOUNT_MODE, leg.accountMode)} · 账户 {leg.accountId}</p>)}</div>
    <dl className="execution-review-settings">
      <div><dt>每腿桶数</dt><dd>{preview.barrels ?? '—'} 桶</dd></div>
      <div><dt>估算名义金额</dt><dd>{preview.notional} USDT</dd></div>
      <div><dt>价格保护</dt><dd>{preview.intent.maxSlippageBps ? `${preview.intent.maxSlippageBps} 基点` : '执行器默认值'}</dd></div>
      <div><dt>最长执行</dt><dd>{Math.round(preview.intent.timeoutMs / 1000)} 秒</dd></div>
      {preview.batches?.length ? <div><dt>分批</dt><dd>{preview.batches.length} 批 · 间隔 {Math.round((preview.intent.batches?.intervalMs ?? 0) / 1000)} 秒<small>首腿每批 {preview.batches.join(' / ')}</small></dd></div> : null}
    </dl>
    <div className="execution-review-legs execution-table-wrap"><table className="execution-progress-table execution-review-table">
      <thead><tr><th scope="col">交易腿</th><th scope="col">数量<small>合约数量</small></th><th scope="col">下单方式</th><th scope="col">价格保护界限<small>USDT</small></th><th scope="col">买一 / 卖一<small>盘口时间</small></th></tr></thead>
      <tbody>{preview.legs.map(leg => <tr key={leg.index}>
        <th scope="row"><strong>{venueName(leg.venue)} {short(leg.symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(preview.intent.action, leg.side)}{leg.reduceOnly ? ' · 只减仓' : ''}</span></th>
        <td data-label="数量"><strong>{leg.quantity}</strong><small>每张 {leg.instrument.contractSize} 桶</small></td>
        <td data-label="下单方式">{leg.index === 0 ? '首腿' : '对冲腿'} · {label(ORDER_TYPE, leg.orderType)}{leg.chaseTimeoutMs ? <small>超过 {leg.chaseTimeoutMs / 1000} 秒剩余转市价</small> : null}</td>
        <td data-label="价格保护界限">{leg.orderType === 'local-chase' && leg.limitPrice ? <>{leg.limitPrice}<small>自填追价界限</small></> : leg.priceBound ?? '—'}{leg.chaseCeiling ? <small>挂单上限 {leg.chaseCeiling}</small> : null}</td>
        <td data-label="买一 / 卖一">{leg.quote.bid} / {leg.quote.ask}<small>{clock(leg.quote.receivedAt)}</small></td>
      </tr>)}</tbody>
    </table></div>
    <p className="execution-help">首腿按所选方式下单：市价时以价格保护界限为 IOC 限价，超出界限的部分不成交；追价时界限是最高追价（卖出时为最低），本地追价自填界限时以自填为准。对冲腿在首腿成交后跟上：市价时不受界限约束，它的界限只在首腿发出前核对一次；本地追价时只挂单且不越过界限，超过对冲追价时限后剩余按市价补齐。同一账户请勿同时在工作台下原油单或开启原油自动规则。</p>
    {preview.notes.length ? <ul className="execution-review-notes">{preview.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
    {/* An unanswered confirm is checked by clicking confirm again with the same request id: the executor answers it by that id whether or not the preview has expired since. */}
    {unknown ? <p className="execution-warning">上次确认没有收到应答，可能已受理：请先再点“确认并实盘{action}”核对（沿用同一请求编号，不会重复下单）。</p>
      : expired ? <p className="execution-warning" role="status">预览已过期，确认会被执行器拒绝；请返回修改参数后重新预览。</p> : null}
    <div className="execution-actions">
      <button className="button primary" type="button" id="oilConfirmBtn" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={16} aria-hidden="true" />}确认并实盘{action}</button>
      <button className="button secondary" type="button" disabled={busy} onClick={onEdit}>返回修改参数</button>
    </div>
  </section>;
}

/** The intent fields a four-leg preview card reads, oil or hynix. */
interface FourLegIntentView { action: 'open' | 'close'; timeoutMs: number; maxSlippageBps?: number; batches?: { count: number; intervalMs: number } }

/**
 * The four-leg confirmation: one card listing all four legs, laid out as the workbench's four-leg preview
 * (project-aggregation 7745181 src/TradingExecution.tsx, one table row per leg); each venue's pair is one job.
 */
export function FourLegPreviewCard({ preview, title, size, legName, quantityNote, idPrefix, busy, unknown, onConfirm, onEdit }: {
  preview: FourLegPreview<FourLegIntentView>; title: string; size: readonly [string, string]; legName: (symbol: string) => string; quantityNote: (leg: OilPreviewLeg) => string;
  idPrefix: string; busy: boolean; unknown: boolean; onConfirm: () => void; onEdit: () => void;
}) {
  const action = preview.intent.action === 'open' ? '开仓' : '平仓';
  const legs = preview.parts.flatMap(part => part.legs);
  const accounts = [...new Map(legs.map(leg => [`${leg.venue}:${leg.accountId}`, leg])).values()];
  const expired = Date.now() > preview.expiresAt;
  const batched = preview.parts.filter(part => part.batches?.length);
  return <section className="execution-review" id={`${idPrefix}Preview`} data-four-leg-preview aria-labelledby={`${idPrefix}-review-title`} tabIndex={-1}>
    <div className="execution-review-title"><div><h3 id={`${idPrefix}-review-title`}>确认{title}</h3><p>预览有效至 {clock(preview.expiresAt)}（北京时间）</p></div><span className="execution-badge attention">实盘下单</span></div>
    <div className="execution-review-accounts">{accounts.map(leg => <p key={`${leg.venue}:${leg.accountId}`}><strong>{venueName(leg.venue)}</strong> {label(ACCOUNT_MODE, leg.accountMode)} · 账户 {leg.accountId}</p>)}</div>
    <dl className="execution-review-settings">
      <div><dt>{size[0]}</dt><dd>{size[1]}</dd></div>
      <div><dt>估算名义金额</dt><dd>{preview.notional} USDT<small>四腿合计</small></dd></div>
      <div><dt>价格保护</dt><dd>{preview.intent.maxSlippageBps ? `${preview.intent.maxSlippageBps} 基点` : '执行器默认值'}</dd></div>
      <div><dt>最长执行</dt><dd>{Math.round(preview.intent.timeoutMs / 1000)} 秒</dd></div>
      {batched.length ? <div><dt>分批</dt><dd>间隔 {Math.round((preview.intent.batches?.intervalMs ?? 0) / 1000)} 秒{batched.map(part => <small key={part.legs[0]!.venue}>{venueName(part.legs[0]!.venue)} {part.batches!.length} 批，首腿每批 {part.batches!.join(' / ')}</small>)}</dd></div> : null}
    </dl>
    <div className="execution-review-legs execution-table-wrap"><table className="execution-progress-table execution-review-table">
      <thead><tr><th scope="col">交易腿</th><th scope="col">数量<small>合约数量</small></th><th scope="col">下单方式</th><th scope="col">价格保护界限<small>USDT</small></th><th scope="col">买一 / 卖一<small>盘口时间</small></th></tr></thead>
      <tbody>{legs.map(leg => <tr key={`${leg.venue}:${leg.index}`}>
        <th scope="row"><strong>{venueName(leg.venue)} {legName(leg.symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(preview.intent.action, leg.side)}{leg.reduceOnly ? ' · 只减仓' : ''}</span></th>
        <td data-label="数量"><strong>{leg.quantity}</strong><small>{quantityNote(leg)}</small></td>
        <td data-label="下单方式">{leg.index === 0 ? '首腿' : '对冲腿'} · {label(ORDER_TYPE, leg.orderType)}{leg.chaseTimeoutMs ? <small>超过 {leg.chaseTimeoutMs / 1000} 秒剩余转市价</small> : null}</td>
        <td data-label="价格保护界限">{leg.priceBound ?? '—'}{leg.chaseCeiling ? <small>挂单上限 {leg.chaseCeiling}</small> : null}</td>
        <td data-label="买一 / 卖一">{leg.quote.bid} / {leg.quote.ask}<small>{clock(leg.quote.receivedAt)}</small></td>
      </tr>)}</tbody>
    </table></div>
    <p className="execution-help">每个交易所的两腿是一个同所任务，两个任务一起确认、一起占用四个合约；首腿按所选方式下单，对冲腿在首腿成交后按市价跟上。任一所任务失败、停止或需人工处理时，另一所不再发送新的首腿并撤销首腿挂单，已成交部分照常对冲；不会回平已成交的仓位。</p>
    {preview.notes.length ? <ul className="execution-review-notes">{preview.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
    {unknown ? <p className="execution-warning">上次确认没有收到应答，可能已受理：请先再点“确认并实盘{action}”核对（沿用同一请求编号，不会重复下单）。</p>
      : expired ? <p className="execution-warning" role="status">预览已过期，确认会被执行器拒绝；请返回修改参数后重新预览。</p> : null}
    <div className="execution-actions">
      <button className="button primary" type="button" id={`${idPrefix}ConfirmBtn`} disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={16} aria-hidden="true" />}确认并实盘{action}</button>
      <button className="button secondary" type="button" disabled={busy} onClick={onEdit}>返回修改参数</button>
    </div>
  </section>;
}

/** The venue pairs a four-leg form offers, in the service's venue order (the workbench's 跨所组合 list). */
export const venuePairs = (venues: readonly OilVenue[]): (readonly [string, string])[] =>
  venues.flatMap((first, index) => venues.slice(index + 1).map(second => [`${first},${second}`, `${VENUE_LABEL[first]} + ${VENUE_LABEL[second]}`] as const));

/** The four legs' inputs: each venue's lead takes its own order type, its hedge follows at market. */
export function FourLegInputs({ legs, action, leadTypes, onLeadType, legName, idPrefix, hedgeNote }: {
  legs: readonly { venue: OilVenue; symbol?: string; side: string }[]; action: 'open' | 'close'; leadTypes: readonly [OilLeadType, OilLeadType];
  onLeadType: (venue: 0 | 1, type: OilLeadType) => void; legName: (symbol: string) => string; idPrefix: string; hedgeNote: string;
}) {
  return <div className="execution-leg-inputs">{legs.map((leg, index) => {
    const venue = index < 2 ? 0 : 1, lead = index % 2 === 0, type = leadTypes[venue];
    return <section key={index} className="execution-leg-input" aria-label={`${VENUE_LABEL[leg.venue]} ${lead ? '首腿' : '对冲腿'} ${legName(leg.symbol ?? '')} 交易参数`}>
      <header><strong>{VENUE_LABEL[leg.venue]} {legName(leg.symbol ?? '')}</strong><span className={`execution-side ${leg.side}`}>{operation(action, leg.side)}</span><small className="oil-leg-role">{lead ? '首腿' : '对冲腿'}</small></header>
      {lead ? <Choice label="下单方式" id={`${idPrefix}LeadType${venue}`} value={type} options={LEAD_TYPES[leg.venue]} onChange={next => onLeadType(venue, next)} /> : null}
      <p className="execution-help execution-market-note">{!lead ? hedgeNote
        : type === 'chase' ? 'Bybit 原生追价策略，按本方一档追价，直到成交或达到最长执行时间。'
        : type === 'local-chase' ? `只挂单挂在${buys(action, leg.side) ? '买一' : '卖一'}，盘口变化后撤单重挂，${buys(action, leg.side) ? '最高' : '最低'}追到价格保护界限；不吃单，到最长执行时间未成交的部分撤销。`
        : '市价：按对手盘吃单成交，受价格保护界限约束。'}</p>
    </section>;
  })}</div>;
}

const GROUP_BADGE: Record<GroupState, string> = { completed: 'completed', running: 'running', incomplete: 'attention', unbalanced: 'attention', unlisted: '' };

/** A four-leg group in the job list: its overall status, then the two venues' jobs as their own cards. */
function FourLegGroup({ jobs, card }: { jobs: OilJob[]; card: (job: OilJob) => ReactNode }) {
  const overall = groupStatus(jobs);
  const first = jobs[0]!;
  const venues = jobs.map(job => venueName(job.legs[0]?.venue ?? '')).join(' + ');
  const title = `四腿组合 · ${venues} ${first.action === 'open' ? '开仓' : '平仓'}`;
  return <section className="execution-job-group" data-four-leg={first.group?.id} aria-label={`${title} ${overall.text}`}>
    <header><h3>{title} <span className={`execution-badge ${GROUP_BADGE[overall.status]}`}>{overall.text}</span></h3>
      <p>组 {first.group?.id.slice(0, 8)} · 停止一所的任务时另一所只停首腿、撤首腿挂单；一所未完成或成交明显少于计划时另一所同样只停首腿，已成交部分照常对冲。</p></header>
    {overall.details.length ? <ul className={`execution-job-group-notes${GROUP_BADGE[overall.status] === 'attention' ? ' warning' : ''}`} role={GROUP_BADGE[overall.status] === 'attention' ? 'alert' : undefined}>{overall.details.map(text => <li key={text}>{text}</li>)}</ul> : null}
    {jobs.map(card)}
  </section>;
}

/** The hedge leg's note in a two-leg form: market, or a post-only chase that goes to market once its time is up (docs/oil.md 13). */
export const hedgeNote = (type: 'market' | 'local-chase', seconds: string, buy: boolean, amount: string): string => type === 'local-chase'
  ? `首腿成交后只挂单挂在${buy ? '买一' : '卖一'}${amount}跟上，盘口变化后撤单重挂，${buy ? '最高' : '最低'}追到价格保护界限；同一缺口超过 ${seconds.trim() || '?'} 秒未补齐时撤单，剩余按市价补齐。对冲挂单期间首腿暂停改价、不发下一批。`
  : `首腿成交后按市价${amount}跟上；首腿挂单期间的成交也会随时跟上。`;

/** A native chase on either lead: the form then sends no batches (four legs: either venue's lead). */
export const chased = (form: { preset: string; leadOrderType: OilLeadType; peerLeadOrderType: OilLeadType }): boolean => form.leadOrderType === 'chase' || (form.preset === 'four-leg' && form.peerLeadOrderType === 'chase');

function OrderForm({ state, onAccepted }: { state: OilState; onAccepted: (job: OilJob) => void }) {
  const venues = useMemo(() => OIL_VENUES.filter(venue => state.accounts.some(account => account.venue === venue)), [state.accounts]);
  const [form, setForm] = useState<OilForm>(() => ({ ...DEFAULT_FORM, venue: venues[0] ?? 'binance', hedgeVenue: hedgeVenueFor(venues, venues[0] ?? 'binance', DEFAULT_FORM.hedgeVenue) ?? DEFAULT_FORM.hedgeVenue }));
  const [preview, setPreview] = useState<OilPreview | FourLegPreview<OilFourLegIntent> | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The preview whose confirm got no answer: it may have been accepted, so leaving it needs a warning.
  const [unanswered, setUnanswered] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  // Set when picking the hedge venue as the lead swapped the two: with two venues the hedge choice is not shown, so say it.
  const [swapNote, setSwapNote] = useState<string | null>(null);
  const dialog = useDialogGuard();
  const ids = useRef(new RequestIds());
  const reviewRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Bumped on every form change: a preview answered for an older form is dropped, never shown beside the new one.
  const formVersion = useRef(0);
  const changed = (): void => { formVersion.current++; setPreview(null); };
  const cross = venues.length >= 2;
  // A venue that is no longer configured, or cross venue without two venues, falls back to what is possible.
  useEffect(() => {
    // Each forced change also takes back an order type the new venue does not offer, as set() does.
    if (venues.length && !venues.includes(form.venue)) { setForm(current => allowedOrderTypes({ ...current, venue: venues[0]! })); changed(); }
    if (!cross && form.preset !== 'same-exchange') { setForm(current => allowedOrderTypes({ ...current, preset: 'same-exchange' })); changed(); }
    const hedge = hedgeVenueFor(venues, form.venue, form.hedgeVenue);
    if (hedge && hedge !== form.hedgeVenue) { setForm(current => allowedOrderTypes({ ...current, hedgeVenue: hedge })); changed(); }
  }, [venues, cross, form.venue, form.hedgeVenue, form.preset]);
  // A new preview takes the focus, so the confirmation is what the keyboard and the screen reader reach first.
  useEffect(() => { if (preview) reviewRef.current?.querySelector<HTMLElement>('.execution-review')?.focus(); }, [preview]);
  const set = <K extends keyof OilForm>(key: K, value: OilForm[K]) => {
    if (key === 'venue' || key === 'hedgeVenue' || key === 'preset') setSwapNote(key === 'venue' && form.preset === 'cross-exchange' && value === form.hedgeVenue && value !== form.venue ? `首腿与对冲腿交易所已对调：对冲腿已改为 ${VENUE_LABEL[form.venue]}` : null);
    setForm(current => {
      const next = { ...current, [key]: value };
      // Picking the hedge venue as the lead swaps the two, so a cross-venue pair stays on two venues.
      if (key === 'venue' && next.venue === current.hedgeVenue) next.hedgeVenue = current.venue;
      // Four legs: the pair is listed in venue order (venuePairs).
      if (key === 'preset' && value === 'four-leg' && OIL_VENUES.indexOf(next.venue) > OIL_VENUES.indexOf(next.hedgeVenue)) [next.venue, next.hedgeVenue] = [next.hedgeVenue, next.venue];
      // Each venue chases its own way (Bybit strategy, Binance and OKX local chase, the hedge only on Binance and OKX):
      // an order type the new venue does not offer goes back to market.
      Object.assign(next, allowedOrderTypes(next));
      // The four-leg direction names the first venue's spread, so it is picked afresh whenever the preset changes.
      if (key === 'preset') next.fourSpread = '';
      // A native chase is never batched; its batch fields are hidden, so they must not keep a stale count.
      if (chased(next)) { next.batchCount = '1'; next.batchIntervalSeconds = '0'; }
      return next;
    });
    changed();
  };
  const setPair = (pair: string): void => {
    const [venue, hedgeVenue] = pair.split(',') as [OilVenue, OilVenue];
    // Another first venue turns the same direction into the opposite trade: the direction is picked again.
    setForm(current => allowedOrderTypes({ ...current, venue, hedgeVenue, fourSpread: current.venue === venue && current.hedgeVenue === hedgeVenue ? current.fourSpread : '' }));
    changed();
  };
  const four = form.preset === 'four-leg';
  const action = form.action === 'open' ? '开仓' : '平仓';
  const legs = draftLegs(form);

  async function runPreview(): Promise<void> {
    const built = four ? fourLegFormToIntent(form) : formToIntent(form);
    if ('error' in built) { setMessage({ tone: 'err', text: built.error }); setPreview(null); return; }
    setBusy(true); setMessage({ tone: 'muted', text: '预览中…' }); setPreview(null);
    const asked = formVersion.current;
    const stale = (): boolean => asked !== formVersion.current && (setMessage({ tone: 'muted', text: '表单在预览期间改过，请重新预览' }), true);
    try {
      const result = built.intent.preset === 'four-leg' ? await api<FourLegPreview<OilFourLegIntent>>('/api/four-leg/preview', { body: built.intent })
        : await api<OilPreview>('/api/preview', { body: built.intent });
      if (!stale()) { setPreview(result); setMessage(null); }
    } catch (error) { if (!stale()) setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); }
  }

  const setConfirmBusy = (next: boolean): void => { busyRef.current = next; if (next || dialog.isAlive()) setBusy(next); };
  const previewIdOf = (): string | undefined => previewRef.current?.id;

  async function runConfirm(current: OilPreview | FourLegPreview<OilFourLegIntent>): Promise<void> {
    if (isFourLegPreview<OilFourLegIntent>(current)) {
      await executeOrderConfirm({
        previewId: current.id,
        confirmText: `实盘执行：${describeFourLeg(current.intent)}，每腿 ${current.barrels ?? '?'} 桶，名义金额约 ${current.notional} USDT（四腿合计），${Math.round(current.intent.timeoutMs / 1000)} 秒内完成。确定发送到交易所？`,
        confirmTitle: '确认四腿实盘执行',
        dialog, ids: ids.current, isBusy: () => busyRef.current, setBusy: setConfirmBusy, currentPreviewId: previewIdOf,
        send: requestId => api<FourLegConfirmResult>('/api/four-leg/confirm', { body: { previewId: current.id, requestId, confirmLive: true } }),
        formatAccepted: acceptedFourLegText,
        onAccepted: result => onAccepted(result.jobs[0]!),
        clearPreview: () => setPreview(null), setUnanswered, setMessage,
      });
      return;
    }
    await executeOrderConfirm({
      previewId: current.id,
      confirmText: `实盘执行：${describeIntent(current.intent as OilIntent)}，每腿 ${current.barrels ?? '?'} 桶，名义金额约 ${current.notional} USDT，${Math.round(current.intent.timeoutMs / 1000)} 秒内完成。确定发送到交易所？`,
      confirmTitle: '确认实盘执行',
      dialog, ids: ids.current, isBusy: () => busyRef.current, setBusy: setConfirmBusy, currentPreviewId: previewIdOf,
      send: requestId => api<OilConfirmResult>('/api/confirm', { body: { previewId: current.id, requestId, confirmLive: true } }),
      formatAccepted: result => acceptedJobText(result, label(JOB_STATUS, result?.job?.status ?? '')),
      onAccepted: result => onAccepted(result.job),
      clearPreview: () => setPreview(null), setUnanswered, setMessage,
    });
  }

  async function leave(): Promise<void> {
    await leaveOrderPreview({
      dialog, isBusy: () => busyRef.current, currentPreviewId: previewIdOf, unansweredId: unanswered,
      onClear: () => { changed(); setMessage(null); setUnanswered(null); },
    });
  }

  if (!venues.length) return <p className="execution-message warning" role="status">没有配置原油执行账户，不能下单。</p>;
  const messageView = message ? <p id="oilOrderMsg" className={message.tone === 'err' ? 'execution-warning' : message.tone === 'ok' ? 'oil-ok' : undefined} role="status">{message.text}</p> : null;
  return <>
    <div ref={reviewRef}>{preview ? isFourLegPreview<OilFourLegIntent>(preview)
      ? <FourLegPreviewCard preview={preview} title={describeFourLeg(preview.intent)} size={['每腿桶数', `${preview.barrels ?? '—'} 桶`]} legName={short} quantityNote={leg => `每张 ${leg.instrument.contractSize} 桶`} idPrefix="oil" busy={busy} unknown={unanswered === preview.id} onConfirm={() => void runConfirm(preview)} onEdit={() => void leave()} />
      : <PreviewCard preview={preview} busy={busy} unknown={unanswered === preview.id} onConfirm={() => void runConfirm(preview)} onEdit={() => void leave()} /> : null}</div>
    <form className="execution-builder" id="oilOrder" aria-label="原油组合交易参数" onSubmit={event => { event.preventDefault(); void runPreview(); }}>
      {preview && messageView ? <div className="oil-review-message">{messageView}</div> : null}
      <fieldset disabled={busy || !!preview}>
        <legend className="visually-hidden">选择组合并填写交易参数</legend>
        <div className="execution-presets oil-presets" role="group" aria-label="交易预设">
          <button type="button" aria-pressed={form.preset === 'same-exchange'} data-oil-preset="same-exchange" onClick={() => { if (form.preset !== 'same-exchange') set('preset', 'same-exchange'); }}>同所价差<small>单所 · BZ 对 CL · 两腿同一账户</small></button>
          <button type="button" aria-pressed={four} data-oil-preset="four-leg" disabled={!cross} onClick={() => { if (!four) set('preset', 'four-leg'); }}>四腿组合<small>{cross ? `${venues.length === 2 ? `${VENUE_LABEL[venues[0]!]} 与 ${VENUE_LABEL[venues[1]!]}` : '任选两所'} · BZ 对 CL` : '需配置两个交易所的执行账户'}</small></button>
          <button type="button" aria-pressed={form.preset === 'cross-exchange'} data-oil-preset="cross-exchange" disabled={!cross} onClick={() => { if (form.preset !== 'cross-exchange') set('preset', 'cross-exchange'); }}>跨所同合约<small>{cross ? `${venues.length === 2 ? `${VENUE_LABEL[venues[0]!]} 对 ${VENUE_LABEL[venues[1]!]}` : '任选两所'} · 同一合约` : '需配置两个交易所的执行账户'}</small></button>
        </div>
        <div className="execution-row">
          <Choice label="交易动作" id="oilAction" value={form.action} options={[['open', '开仓'], ['close', '平仓']]} onChange={next => set('action', next)} />
          {four ? <Choice label="跨所组合" id="oilVenuePair" value={`${form.venue},${form.hedgeVenue}`} options={venuePairs(venues)} onChange={setPair} />
            : <Choice label={form.preset === 'same-exchange' ? '交易所' : '首腿交易所'} id="oilVenue" value={form.venue} options={venues.map(venue => [venue, VENUE_LABEL[venue]] as const)} onChange={next => set('venue', next)} />}
          {form.preset === 'cross-exchange' && venues.length > 2
            ? <Choice label="对冲腿交易所" id="oilHedgeVenue" value={form.hedgeVenue} options={venues.filter(venue => venue !== form.venue).map(venue => [venue, VENUE_LABEL[venue]] as const)} onChange={next => set('hedgeVenue', next)} /> : null}
          {form.preset !== 'cross-exchange'
            ? <Choice label="首腿合约" id="oilLeadSymbol" value={form.leadSymbol} options={[['CLUSDT', 'CL 先下'], ['BZUSDT', 'BZ 先下']]} onChange={next => set('leadSymbol', next)} />
            : <Choice label="合约" id="oilSymbol" value={form.symbol} options={[['BZUSDT', 'BZ 布伦特'], ['CLUSDT', 'CL WTI']]} onChange={next => set('symbol', next)} />}
        </div>
        {swapNote && form.preset === 'cross-exchange' ? <p className="trading-footnote" id="oilHedgeSwap" role="status">{swapNote}</p> : null}
        <div className="execution-choice execution-direction"><span aria-hidden="true">{form.action === 'open' ? '开仓方向' : '待平仓方向'}</span>
          <div className="execution-direction-options" role="group" aria-label={form.action === 'open' ? '开仓方向' : '待平仓方向'}>
            {(['long', 'short'] as const).map(side => {
              if (four) {
                const pressed = form.fourSpread === side, shown = draftFourLegs(form, side);
                const ordered = [shown.slice(0, 2), shown.slice(2)].flatMap(pair => [...pair].sort((a, b) => Number(b.symbol === 'BZUSDT') - Number(a.symbol === 'BZUSDT')));
                return <button key={side} type="button" aria-pressed={pressed} data-oil-direction={side} onClick={() => { if (!pressed) set('fourSpread', side); }}>
                  <span className="oil-direction-name">{VENUE_LABEL[form.venue]} {side === 'long' ? '做多' : '做空'}价差 · {VENUE_LABEL[form.hedgeVenue]} {side === 'long' ? '做空' : '做多'}价差</span>
                  {ordered.map(leg => <span key={`${leg.venue}:${leg.symbol}`} className={`execution-leg-chip ${leg.side}`}>{VENUE_LABEL[leg.venue]} {short(leg.symbol ?? '')} <b>{leg.side === 'long' ? '多' : '空'}</b></span>)}
                </button>;
              }
              const same = form.preset === 'same-exchange';
              const pressed = same ? form.spread === side : form.leadSide === side;
              const shown = draftLegs(same ? { ...form, spread: side } : { ...form, leadSide: side });
              // Same venue: BZ first, as the spread reads (BZ − CL); cross venue: the first leg first.
              const ordered = same ? [...shown].sort((a, b) => Number(b.symbol === 'BZUSDT') - Number(a.symbol === 'BZUSDT')) : shown;
              return <button key={side} type="button" aria-pressed={pressed} data-oil-direction={side} onClick={() => { if (!pressed) set(same ? 'spread' : 'leadSide', side); }}>
                {same ? <span className="oil-direction-name">{side === 'long' ? '做多价差' : '做空价差'}</span> : null}
                {ordered.map(leg => <span key={`${leg.venue}:${leg.symbol ?? form.symbol}`} className={`execution-leg-chip ${leg.side}`}>{VENUE_LABEL[leg.venue]} {short(leg.symbol ?? form.symbol)} <b>{leg.side === 'long' ? '多' : '空'}</b></span>)}
              </button>;
            })}
          </div></div>
        <div className="execution-row execution-sizing">
          <label className="execution-amount">每腿桶数<span className="execution-input-unit"><input id="oilBarrels" type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={form.barrels} placeholder="例如 10" onChange={event => set('barrels', event.target.value)} /><span aria-hidden="true">桶</span></span></label>
          <p className="execution-help">{four ? '四腿' : '两腿'}桶数相同，按各合约每张桶数换算成合约数量；不足一个数量步长的部分由预览指出，实际各腿数量以预览为准。</p>
        </div>
        {four && !form.fourSpread ? <p className="execution-choose-direction" id="oilChooseDirection">先选择方向，再设置各腿下单方式。</p>
        : four ? <FourLegInputs legs={draftFourLegs(form, form.fourSpread || 'long')} action={form.action} leadTypes={[form.leadOrderType, form.peerLeadOrderType]} onLeadType={(venue, next) => set(venue === 0 ? 'leadOrderType' : 'peerLeadOrderType', next)} legName={short} idPrefix="oil" hedgeNote="本所首腿成交后按市价跟上相同桶数；首腿挂单期间的成交也会随时跟上。" />
        : <div className="execution-leg-inputs">{legs.map((leg, index) => {
          const symbol = leg.symbol ?? form.symbol;
          return <section key={index} className="execution-leg-input" aria-label={`${index === 0 ? '首腿' : '对冲腿'} ${VENUE_LABEL[leg.venue]} ${short(symbol)} 交易参数`}>
            <header><strong>{VENUE_LABEL[leg.venue]} {short(symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(form.action, leg.side)}</span><small className="oil-leg-role">{index === 0 ? '首腿' : '对冲腿'}</small></header>
            {index === 0 ? <Choice label="下单方式" id="oilLeadType" value={form.leadOrderType} options={LEAD_TYPES[form.venue]} onChange={next => set('leadOrderType', next)} /> : null}
            {index === 1 ? <Choice label="下单方式" id="oilHedgeType" value={form.hedgeOrderType} options={HEDGE_TYPES[leg.venue]} onChange={next => set('hedgeOrderType', next)} /> : null}
            {index === 1 && form.hedgeOrderType === 'local-chase' ? <label className="execution-amount">对冲追价时限 · 秒<input id="oilHedgeChaseSeconds" type="text" inputMode="numeric" autoComplete="off" maxLength={3} value={form.hedgeChaseSeconds} onChange={event => set('hedgeChaseSeconds', event.target.value)} /></label> : null}
            {index === 0 && form.leadOrderType === 'local-chase' ? <label className="execution-amount">追价界限 · USDT（选填）<input id="oilChaseLimit" type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={form.chaseLimit} placeholder="留空用价格保护界限" onChange={event => set('chaseLimit', event.target.value)} /></label> : null}
            <p className="execution-help execution-market-note">{index === 1 ? hedgeNote(form.hedgeOrderType, form.hedgeChaseSeconds, buys(form.action, leg.side), '按相同桶数')
              : form.leadOrderType === 'chase' ? 'Bybit 原生追价策略，按本方一档追价，直到成交或达到最长执行时间。'
              : form.leadOrderType === 'local-chase' ? `只挂单挂在${buys(form.action, leg.side) ? '买一' : '卖一'}，盘口变化后撤单重挂，${buys(form.action, leg.side) ? '最高' : '最低'}追到界限；不吃单，到最长执行时间未成交的部分撤销。`
              : '市价：按对手盘吃单成交，受价格保护界限约束。'}</p>
          </section>;
        })}</div>}
        <details className="execution-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
          <summary><span><strong>执行参数</strong><small>最长 {form.timeoutSeconds || '?'} 秒 · 价格保护 {form.slippageBps ? `${form.slippageBps} 基点` : '默认'}{Number(form.batchCount) > 1 ? ` · 分 ${form.batchCount} 批` : ''}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="execution-settings">
            <label>最长执行 · 秒<input id="oilTimeout" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={form.timeoutSeconds} onChange={event => set('timeoutSeconds', event.target.value)} /></label>
            <label>价格保护 · 基点（选填）<input id="oilSlippage" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={form.slippageBps} placeholder="留空用默认值" onChange={event => set('slippageBps', event.target.value)} /></label>
            {!chased(form) ? <>
              <label>分批 · 批数<input id="oilBatchCount" type="text" inputMode="numeric" autoComplete="off" maxLength={2} value={form.batchCount} onChange={event => set('batchCount', event.target.value)} /></label>
              <label>批次间隔 · 秒<input id="oilBatchInterval" type="text" inputMode="numeric" autoComplete="off" maxLength={3} value={form.batchIntervalSeconds} disabled={Number(form.batchCount) <= 1} onChange={event => set('batchIntervalSeconds', event.target.value)} /></label>
            </> : null}
          </div>
          <p className="execution-help">到最长执行时间仍未完成时，停止发送并撤销余单，已成交部分保留。分批时每批首腿成交并对冲后，等满间隔再发下一批；批次间隔合计须短于最长执行时间。价格保护按预览盘口计算界限：首腿超出界限的部分不成交；对冲腿市价成交时界限只在首腿发出前核对，本地追价时挂单不越过界限，超过对冲追价时限后剩余按市价补齐。</p>
        </details>
        <div className="execution-builder-footer">
          {preview ? <p>正在确认上方预览；返回修改参数后可重新填写。</p> : messageView ?? <p>预览会重新读取盘口、交易规则与持仓，不会下单。</p>}
          <button className="button primary" type="submit" id="oilPreviewBtn" disabled={four && !form.fourSpread}>{busy && !preview ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={16} aria-hidden="true" />}预览{action}组合</button>
        </div>
      </fieldset>
    </form>
  </>;
}

function strategyText(leg: OilJob['legs'][number]): string {
  const op = leg.operation;
  if (!op || op.kind !== 'strategy') return '';
  return ` · 策略编号 ${op.remoteId ?? '未知'}${op.adoptedAt ? '（人工认领）' : ''}${op.releasedAt ? '（已强制释放）' : ''}`;
}

type ActionKind = 'stop' | 'acknowledge' | 'adopt' | 'notcreated' | 'release';

function JobCard({ job, busy, strategyId, onStrategyId, onAction }: { job: OilJob; busy: boolean; strategyId: string; onStrategyId: (value: string) => void; onAction: (job: OilJob, kind: ActionKind) => void }) {
  const actions = jobActions(job);
  // Hynix and gold-oil legs are sized in contract quantities; oil in barrels.
  const hynix = job.market === 'hynix', goldoil = job.market === 'goldoil', byQuantity = hynix || goldoil;
  const rebalance = isRebalance(job);
  const title = rebalance ? `${venueName(job.legs[0]?.venue ?? '')} 调平 · ${job.rebalance?.method === 'add' ? '加仓' : '减仓'}`
    : `${job.preset === 'same-exchange' ? `${venueName(job.legs[0]?.venue ?? '')} 同所${hynix ? '溢价' : goldoil ? '金油比' : '价差'}` : '跨所同合约'}${job.action === 'open' ? '开仓' : '平仓'}`;
  const role = (index: number): string => rebalance ? '调平腿' : index === 0 ? '首腿' : '对冲腿';
  const legName = (symbol: string): string => hynix ? HYNIX_CONTRACT[symbol] ?? short(symbol) : short(symbol);
  const strategyLeg = job.legs.find(leg => leg.operation?.kind === 'strategy');
  return <article className={`execution-job ${job.status}`} data-oil-job={job.id} aria-label={`${title} ${label(JOB_STATUS, job.status)}`}>
    <header><div>
      <h3>{title} <span className={`execution-badge ${JOB_BADGE[job.status] ?? ''}`}>{label(JOB_STATUS, job.status)}</span>{job.stopRequested ? <span className="execution-badge">已请求停止</span> : null}{job.holdNewSends ? <span className="execution-badge">恢复中，不再发送新委托</span> : null}{job.peerHalt ? <span className="execution-badge" title={job.peerHalt}>四腿联动停止</span> : null}</h3>
      <p>任务 {job.id.slice(0, 8)} · 创建 {stamp(job.createdAt)} · 最迟 {clock(job.deadlineAt)}（北京时间）{job.batches ? ` · 分 ${job.batches.count} 批，${job.batches.current ? `第 ${job.batches.current} 批` : '未开始'}` : ''}</p>
    </div>{actions.stop ? <button className="button secondary execution-stop" type="button" data-oil-stop={job.id} disabled={busy} onClick={() => onAction(job, 'stop')}><Square size={14} aria-hidden="true" />停止并撤销余单</button> : null}</header>
    {job.reason ? <p className="execution-job-reason" role={job.status === 'attention' ? 'alert' : undefined}>{job.reason}</p> : null}
    <div className="execution-table-wrap"><table className="execution-progress-table">
      <thead><tr><th scope="col">交易腿</th><th scope="col">已成交 / 计划<small>{byQuantity ? '合约数量' : '桶'}</small></th><th scope="col">成交均价<small>USDT</small></th><th scope="col">当前委托 / 策略</th><th scope="col">价格保护界限<small>USDT</small></th></tr></thead>
      <tbody>{job.legs.map((leg, index) => <tr key={index}>
        <th scope="row"><strong>{venueName(leg.venue)} {legName(leg.symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(job.action, leg.side)}</span></th>
        <td data-label="已成交 / 计划">{byQuantity
          ? <span><strong>{leg.filledQuantity}</strong> / {leg.plannedQuantity}<small>{leg.symbol}{leg.attempts > 1 ? ` · ${leg.attempts} 笔` : ''}</small></span>
          : <span><strong>{leg.filledBarrels}</strong> / {leg.plannedBarrels} 桶<small>合约 {leg.filledQuantity} / {leg.plannedQuantity}{leg.attempts > 1 ? ` · ${leg.attempts} 笔` : ''}</small></span>}</td>
        <td data-label="成交均价">{leg.averagePrice ?? '—'}</td>
        <td data-label="当前委托 / 策略"><span className={leg.operation?.state === 'unknown' ? 'execution-warning' : undefined}>{operationStatus(leg.operation)}</span>
          <small>{role(index)} · {label(ORDER_TYPE, leg.orderType)}
            {leg.orderType === 'local-chase' && leg.operation?.limitPrice ? ` · 委托价 ${leg.operation.limitPrice}` : ''}
            {index === 1 && leg.orderType === 'local-chase' && leg.operation?.limitPrice === null ? ' · 剩余已转市价' : ''}
            {' · 账户 '}{leg.accountId}{strategyText(leg)}</small>{leg.operation?.note ? <small>{leg.operation.note}</small> : null}</td>
        <td data-label="价格保护界限">{leg.orderType === 'local-chase' && leg.limitPrice ? <>{leg.limitPrice}<small>自填追价界限</small></> : leg.priceBound ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>
    {actions.strategy ? <div className="execution-reconcile" role="group" aria-label="追价策略核对">
      <strong>{strategyLeg ? `${venueName(strategyLeg.venue)} ${legName(strategyLeg.symbol)} · ` : ''}追价策略创建结果未知</strong>
      <p>请在 Bybit 核对该账户、合约、方向与数量：找到对应策略就填入编号认领；确认没有创建就点「确认未创建」；无法核对时可强制释放，但策略可能已在交易所成交。</p>
      <label>交易所显示的策略编号<input type="text" data-oil-strategy={job.id} autoComplete="off" spellCheck={false} maxLength={100} value={strategyId} disabled={busy} onChange={event => onStrategyId(event.target.value)} /></label>
      <div className="execution-actions">
        <button type="button" className="button secondary" data-oil-adopt={job.id} disabled={busy} onClick={() => onAction(job, 'adopt')}>认领策略</button>
        <button type="button" className="button secondary" data-oil-notcreated={job.id} disabled={busy} onClick={() => onAction(job, 'notcreated')}>确认未创建</button>
        <button type="button" className="button secondary oil-danger" data-oil-release={job.id} disabled={busy} onClick={() => onAction(job, 'release')}>强制释放（策略可能已成交）</button>
      </div>
    </div> : null}
    {actions.acknowledge ? <div className="execution-reconcile" role="group" aria-label="人工处理">
      <strong>需要人工处理</strong>
      <p>{rebalance ? '请在交易所核对海力士 ADR 与正股的持仓与挂单，处理完后释放合约；释放前这两个合约不能再下单。' : '请在交易所核对两腿敞口与挂单，处理完后释放合约；释放前这两个合约不能再下单。'}</p>
      <div className="execution-actions"><button type="button" className="button secondary" data-oil-ack={job.id} disabled={busy} onClick={() => onAction(job, 'acknowledge')}>已人工处理，释放合约</button></div>
    </div> : null}
    <footer><span>{job.locked ? rebalance ? '合约锁占用中：ADR 与正股合约暂不能再下单。' : '合约锁占用中：这两个合约暂不能再下单。' : '合约锁已释放。'}{job.acknowledgedAt ? `已人工处理 ${stamp(job.acknowledgedAt)}。` : ''}</span><span>停止只撤销余单，已成交仓位保留。</span></footer>
    <details className="execution-events"><summary>执行记录与编号（{job.events.length}）</summary><p>任务编号：{job.id} · 最迟结束：{stamp(job.deadlineAt)}（北京时间）</p>
      <ul>{job.events.map((event, index) => {
        const note = ['reason', 'message', 'note'].map(key => event[key]).find(value => typeof value === 'string') as string | undefined;
        return <li key={index}><time>{clock(event.at)}</time><span>{event.type}{note ? `：${note}` : ''}</span></li>;
      })}</ul></details>
  </article>;
}

/** Whether a job still asks for something: it runs, or it waits for a person (strategy reconcile, acknowledgement). */
const needsWatch = (job: OilJob): boolean => { const actions = jobActions(job); return ACTIVE_STATUSES.includes(job.status) || actions.strategy || actions.acknowledge; };

export function JobsSection({ jobs, stale, tracked, onUntrack, onChanged }: { jobs: OilJob[]; stale: boolean; tracked: string | null; onUntrack: () => void; onChanged: () => void }) {
  const dialog = useDialogGuard();
  const ids = useRef(new RequestIds());
  const trackingRef = useRef<HTMLElement>(null);
  const [strategyIds, setStrategyIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [message, setMessage] = useState<{ jobId: string; tone: 'ok' | 'err'; text: string } | null>(null);
  // A four-leg group stays together wherever it is listed: tracked, still needing watch while either job does, or past.
  const entries = groupJobs(jobs);
  const trackedEntry = entries.find(entry => entry.jobs.some(job => job.id === tracked)) ?? null;
  const trackedJob = trackedEntry?.jobs.find(job => job.id === tracked) ?? null;
  const active = entries.filter(entry => entry !== trackedEntry && entry.jobs.some(needsWatch));
  const past = entries.filter(entry => entry !== trackedEntry && !entry.jobs.some(needsWatch));
  // A newly accepted job is brought into view once, as the workbench does after a confirmation.
  const shown = !!trackedJob;
  useEffect(() => { if (shown) trackingRef.current?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [tracked, shown]);

  async function act(job: OilJob, kind: ActionKind): Promise<void> {
    if (busyRef.current !== null) return;
    const path = `/api/jobs/${job.id}/`;
    const strategyId = (strategyIds[job.id] ?? '').trim();
    if (kind === 'adopt' && !strategyId) { setMessage({ jobId: job.id, tone: 'err', text: `任务 ${job.id.slice(0, 8)}：请先填写交易所显示的策略编号` }); return; }
    if (kind === 'notcreated' && !await dialog.confirm(CONFIRM_NOT_CREATED, { title: '确认未创建', confirmLabel: '确认', tone: 'danger' })) return;
    if (kind === 'release' && !await dialog.confirm(CONFIRM_RELEASE, { title: '强制释放策略', confirmLabel: '强制释放', tone: 'danger' })) return;
    if (kind === 'acknowledge' && !await dialog.confirm(CONFIRM_ACKNOWLEDGE, { title: '确认已人工处理', confirmLabel: '确认', tone: 'danger' })) return;
    if (!dialog.isAlive() || busyRef.current !== null) return;
    const latest = jobsRef.current.find(entry => entry.id === job.id);
    if (!latest) return;
    const latestActions = jobActions(latest);
    if ((kind === 'notcreated' || kind === 'release') && !latestActions.strategy) return;
    if (kind === 'acknowledge' && !latestActions.acknowledge) return;
    busyRef.current = job.id; setBusy(job.id);
    try {
      const send = (requestId: string) => kind === 'stop' ? api(`${path}stop`, { body: { requestId } })
        : kind === 'acknowledge' ? api(`${path}acknowledge`, { body: { requestId } })
        : kind === 'adopt' ? api(`${path}adopt-strategy`, { body: { requestId, strategyId } })
        : kind === 'notcreated' ? api(`${path}confirm-not-created`, { body: { requestId } })
        : api(`${path}release-strategy`, { body: { requestId, acknowledgeRisk: true } });
      await ids.current.run(`${job.id}:${kind}`, kind === 'adopt' ? strategyId : '', send);
      if (!dialog.isAlive()) return;
      if (kind === 'adopt') setStrategyIds(currentIds => { const next = { ...currentIds }; delete next[job.id]; return next; });
      setMessage({ jobId: job.id, tone: 'ok', text: `任务 ${job.id.slice(0, 8)}：${kind === 'stop' ? '已请求停止' : kind === 'adopt' ? '已认领策略' : kind === 'notcreated' ? '已确认未创建' : kind === 'release' ? '已强制释放' : '已释放合约'}` });
      onChanged();
    } catch (error) {
      if (dialog.isAlive()) setMessage({ jobId: job.id, tone: 'err', text: `任务 ${job.id.slice(0, 8)}：${statusOf(error) === undefined ? `${errorText(error)}（结果未知，可再次点击，沿用同一请求编号）` : errorText(error)}` });
    } finally { busyRef.current = null; if (dialog.isAlive()) setBusy(null); }
  }

  const view = (entry: (typeof entries)[number]) => entry.group ? <FourLegGroup key={entry.group} jobs={entry.jobs} card={card} /> : card(entry.jobs[0]);
  const trackingText = (): string => {
    if (!trackedEntry || !trackedJob) return '';
    if (!trackedEntry.group) return (isRebalance(trackedJob) ? REBALANCE_TRACKING : TRACKING_STATUS)[trackedJob.status] ?? label(JOB_STATUS, trackedJob.status);
    const overall = groupStatus(trackedEntry.jobs);
    return overall.status === 'running' ? '执行中：两个交易所各自先发首腿，首腿成交后本所对冲腿按市价跟上。'
      : overall.status === 'completed' ? '已完成，四腿成交见下表。' : '四腿不完整，原因见下方；已成交部分保留，请到交易所核对两所敞口。';
  };
  const trackingWarning = !!trackedEntry && (trackedEntry.group ? groupStatus(trackedEntry.jobs).status === 'incomplete' : trackedJob?.status === 'attention' || trackedJob?.status === 'failed');
  const card = (job: OilJob) => <JobCard key={job.id} job={job} busy={busy === job.id} strategyId={strategyIds[job.id] ?? ''} onStrategyId={value => setStrategyIds(currentIds => ({ ...currentIds, [job.id]: value }))} onAction={(target, kind) => void act(target, kind)} />;
  return <>
    {message ? <p className={`execution-message${message.tone === 'err' ? ' warning' : ''}`} id="oilJobMsg" role="status">{message.text}</p> : null}
    {trackedJob ? <section ref={trackingRef} className="execution-jobs execution-tracking" id="oilTracking" aria-label="成交进度与结果">
      <div className="oil-tracking-heading"><h3>成交进度与结果</h3><button type="button" className="button secondary" data-oil-untrack onClick={onUntrack}>收起</button></div>
      <p className={`execution-tracking-status${stale || trackingWarning ? ' warning' : ''}`} role="status">{stale ? '进度暂未更新，以下保留上次读取的结果；恢复后继续核对。' : trackingText()}</p>
      {view(trackedEntry!)}
    </section> : null}
    {active.length ? <section className="execution-jobs" id="oilActiveJobs" aria-labelledby="oil-active-title"><h3 id="oil-active-title">执行进度</h3>{active.map(view)}</section> : null}
    {past.length ? <details className="execution-history" id="oilHistory"><summary>已结束的任务（最近 {past.length} 个）</summary><div>{past.map(view)}</div></details> : null}
  </>;
}

export function OilPage({ onExpired }: { onExpired: () => void }) {
  const [tracked, setTracked] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const state = useLiveResource<OilState>(OIL_STATE_PATH, { intervalMs: active ? ACTIVE_MS : IDLE_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const market = useLiveResource<OilMarket>('/api/oil/market', { intervalMs: MARKET_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const jobs = state.data?.jobs;
  useEffect(() => { setActive(!!jobs?.some(job => ACTIVE_STATUSES.includes(job.status))); }, [jobs]);
  const refreshMs = active ? ACTIVE_MS : IDLE_MS;
  const { stale, text } = staleness(state, refreshMs);
  const missing = state.error && statusOf(state.error) === 404;
  if (missing) return <StatePanel kind="empty" title="本服务没有配置原油执行" detail="在 config.json 写入 oil（或在「设置」页「从工作台导入」勾选原油执行账户）后重启服务。" />;
  return <div className="trading-page oil-page">
    <header className="wb-heading"><div><h1>原油双腿交易</h1><p>BZ / CL 实时价差、持仓与组合执行</p></div></header>
    <div className="trading-trade-top">
      <MarketPanel live={market} />
      {state.data ? <PositionsPanel state={state.data} stale={stale} /> : null}
    </div>
    {!state.data ? (state.status === 'error' || state.status === 'offline'
      ? <StatePanel kind="error" title="读取原油状态失败" detail={state.error?.message ?? '网络离线'} />
      : <StatePanel kind="loading" title="加载中…" />)
      : <section className="trading-panel execution-panel" aria-labelledby="oil-execution-title">
        <header className="trading-panel-heading"><div><h2 id="oil-execution-title">原油组合交易</h2><p>同所 BZ − CL 价差 · 跨所同一合约 · 首腿市价或追价，成交后对冲腿市价或本地追价跟上</p></div>
          <button className="button secondary" type="button" onClick={() => void state.refresh()}><RefreshCw size={15} aria-hidden="true" />刷新执行状态</button></header>
        <SyncLine stale={stale} text={text} every={`每 ${refreshMs / 1000} 秒`} at={state.receivedAt} />
        <JobsSection jobs={state.data.jobs} stale={stale} tracked={tracked} onUntrack={() => setTracked(null)} onChanged={() => { void state.refresh(); }} />
        <OrderForm state={state.data} onAccepted={job => { setTracked(job.id); setActive(true); void state.refresh(); }} />
      </section>}
    {state.data ? <OilRules onExpired={onExpired} /> : null}
    {state.data ? <OilPnl onExpired={onExpired} /> : null}
  </div>;
}
