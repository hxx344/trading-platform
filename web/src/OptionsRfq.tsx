import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import {
  money, quantityText, quoteFingerprint, quoteSecondsLeft, RFQ_PATH, rfqCreateBody, rfqCreateProblem, rfqExecuteBody, rfqOpen, rfqStrategyLabel, signedMoney, startRefused, utcTime,
} from './options-form.ts';
import type { RfqAccepted, RfqQuote, RfqStatus, RfqView, StrategyMode } from './options-types.ts';
import { RequestIds } from './request-ids.ts';
import { useLiveResource } from './use-live-resource.ts';

// 组合询价 (G2c) follows the workbench Greeks page's RFQ tab (modules/greeks/app/static/index.html and app.js renderRfq,
// 2f0593d): status, create and cancel, the RFQ's id, type, expiry and quote count, then each market maker's quote
// against the chain with the estimated fee, and a confirmation bound to the quote's contents. The server keeps one RFQ,
// checks a quote again before sending it, and turns a fill into an opening tracked like the desk's (src/options/rfq.ts).

const OPEN_MS = 2_000;
const IDLE_MS = 5_000;
const READ_TIMEOUT_MS = 10_000;
// An execute reads the quote and the market again and records the margin baseline before it sends (each call up to 25 s on
// the server), so the page waits longer than for the desk's writes before calling the outcome unknown.
const WRITE_TIMEOUT_MS = 90_000;
const CREATE_CONFIRM = (label: string, quantity: string) => `向 Bybit 做市商发起主网询价：${label} · 每腿 ${quantity} BTC。\n询价本身不成交，执行某个报价才会整组成交。确认发起？`;
const CANCEL_CONFIRM = '取消询价后所有报价失效；已提交执行的报价不能撤回。确认取消？';
const UNKNOWN_CREATE = '询价创建结果未知：服务可能已经记下这笔询价并会向交易所核对，状态以本页为准；不要换参数重发。';
const UNKNOWN_EXECUTE = '执行结果未知：报价可能已提交。不要换报价重试；再点确认会向服务核对同一报价。';
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const signed = (value: number | null, digits = 4): string => value === null ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
const diffClass = (value: number | null): string => value === null ? '' : value >= 0 ? 'rfq-diff-positive' : 'rfq-diff-negative';
const sideText = (side: 'Buy' | 'Sell'): string => side === 'Sell' ? '卖出' : '买入';
const SENT_TEXT: Partial<Record<RfqStatus, string>> = { Filled: '已成交', PendingFill: '等待成交', ExecutionUnknown: '执行结果待核对' };

interface Selected { rfqId: string; quote: RfqQuote; fingerprint: string }

function QuoteCard({ quote, view, offset, disabled, onExecute }: { quote: RfqQuote; view: RfqView; offset: number; disabled: string | null; onExecute: (quote: RfqQuote) => void }) {
  const rfq = view.rfq!;
  const left = quoteSecondsLeft(quote, Date.now() + offset);
  const reason = disabled ?? quote.problem;
  const fee = `预估费率 ${(rfq.feeContext.feeRate * 100).toFixed(3)}% · 单腿上限 ${(rfq.feeContext.feeCapPct * 100).toFixed(0)}%`;
  return <div className="rfq-quote">
    <div><strong>{quote.deskCode || '做市商'} · {quote.covered}/{quote.total} 腿</strong><span>{quote.status || '--'} · 到期 {utcTime(quote.expiresAt).slice(6)} UTC · 剩 {left} 秒</span></div>
    <div className="rfq-quote-values">
      <span>报价净额 {signedMoney(quote.netUsd)}</span>
      <span className={diffClass(quote.diffUsd)}>链净额差 {signed(quote.diffUsd)}</span>
      <span className="rfq-fee">预估手续费 {money(quote.feeUsd)} <small>{fee}</small></span>
      <button className="button ghost rfq-execute" type="button" disabled={reason !== null} title={reason ?? undefined} onClick={() => onExecute(quote)}>执行报价</button>
    </div>
    {reason ? <p className="execution-caveat">{reason}</p> : null}
    <div className="rfq-compare-title">本次询价 {quote.total} 腿成交方向（卖出对比 Bid1，买入对比 Ask1；差额为正表示报价优于盘口）</div>
    <div className="rfq-leg-compare">{quote.legs.map(leg => <div className="rfq-leg-row" key={leg.symbol}>
      <strong>{leg.symbol}</strong><span>{sideText(leg.side)} {leg.price === null ? '未报价' : leg.price.toFixed(4)} × {quantityText(leg.qty)}</span><span>链 {leg.chain === null ? '--' : leg.chain.toFixed(4)}</span><b className={diffClass(leg.diff)}>差额 {signed(leg.diff)}</b>
    </div>)}</div>
  </div>;
}

function ExecuteDialog({ selected, view, offset, changed, blocked, error, sending, onClose, onSubmit }: {
  selected: Selected | null; view: RfqView | null; offset: number; changed: boolean; blocked: string | null; error: string | null; sending: boolean; onClose: () => void; onSubmit: (selected: Selected) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // The confirmation belongs to the contents it was given for: a new quote, or the same quote re-priced, is unconfirmed at once.
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmed = selected !== null && confirmedFor === selected.fingerprint;
  const [, setTick] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (selected && !element.open) element.showModal();
    if (!selected && element.open) element.close();
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    const timer = setInterval(() => setTick(value => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [selected]);
  const quote = selected?.quote;
  const left = quote ? quoteSecondsLeft(quote, Date.now() + offset) : 0;
  const expired = left < 2 || blocked !== null;
  const rfq = view?.rfq ?? null;
  const net = quote?.netUsd ?? null, fee = quote?.feeUsd ?? null;
  return <dialog ref={dialog} className="trade-dialog" aria-labelledby="rfqConfirmTitle" onCancel={event => { event.preventDefault(); onClose(); }}>
    {selected && quote ? <>
      <div className="dialog-head"><div><div className="kicker">确认执行报价</div><h2 id="rfqConfirmTitle">核对整组报价</h2></div><button className="link-button" type="button" onClick={onClose}>关闭</button></div>
      <p className="plan-environment">主网实盘 · {rfq ? rfqStrategyLabel(rfq.mode) : '--'} · 做市商 {quote.deskCode || '--'}</p>
      <p className="plan-expiry" role="timer" aria-live="off">{blocked ?? (left < 2 ? '报价即将过期或已过期，请关闭后选择新的报价' : `报价 ${left} 秒后过期`)}</p>
      <div id="rfqConfirmSummary">{quote.legs.map(leg => <div key={leg.symbol}>{leg.symbol} · {sideText(leg.side)} {quantityText(leg.qty)} BTC @ {leg.price === null ? '未报价' : leg.price.toFixed(4)}（链 {leg.chain === null ? '--' : leg.chain.toFixed(4)}）</div>)}</div>
      <div className="plan-amounts"><div><span>报价净额（未扣费）</span><strong>{signedMoney(net)}</strong></div><div><span>预估手续费</span><strong>{money(fee)}</strong></div><div><span>报价净额（含费）</span><strong>{signedMoney(net !== null && fee !== null ? net - fee : null)}</strong></div></div>
      <p className="loss" role="status">{error ?? (changed ? '报价内容已更新，请重新核对后再确认。' : '')}</p>
      <p className="execution-caveat">{rfq?.mode === 'short_strangle' ? '无保护腿，亏损无上限。' : ''}确认后提交本次报价，整组一次成交；服务会按报价价格再核一次风险上限与到期日。取消询价不能撤回已提交的执行。</p>
      <label className="confirm"><input type="checkbox" checked={confirmed} disabled={expired} onChange={event => setConfirmedFor(event.target.checked ? selected.fingerprint : null)} /><span>我确认以上合约、方向、数量、整组报价和风险。</span></label>
      <button className="button primary" type="button" disabled={!confirmed || sending || expired} data-busy={sending ? '' : undefined} onClick={() => onSubmit(selected)}>{sending ? '提交中…' : '确认并执行报价'}</button>
    </> : null}
  </dialog>;
}

export function RfqPane({ strategy, quantity, onExpired, onChanged }: { strategy: StrategyMode; quantity: string | null; onExpired: () => void; onChanged: () => void }) {
  const ids = useRef(new RequestIds());
  const openRef = useRef(false);
  const read = useLiveResource<RfqView>(RFQ_PATH, { intervalMs: openRef.current ? OPEN_MS : IDLE_MS, timeoutMs: READ_TIMEOUT_MS, onExpired });
  const view = read.data;
  openRef.current = view ? !view.finished : false;
  const rfq = view?.rfq ?? null;
  // The server clock against this browser's, so a quote's seconds left do not depend on the browser clock.
  const offset = view && read.receivedAt ? view.now - read.receivedAt : 0;
  const [creating, setCreating] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [changed, setChanged] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  // Keep the open confirmation on the quote as the server now shows it; a sent or vanished quote closes it.
  useEffect(() => {
    // While an execute is in flight its own answer decides; the server records the choice before it sends.
    if (!selected || !view || sending) return;
    if (view.rfq?.rfqId !== selected.rfqId) { setSelected(null); return; }
    if (view.rfq.selectedQuoteId !== null) {
      setSelected(null); setDialogError(null);
      if (view.rfq.selectedQuoteId === selected.quote.quoteId) setNotice({ tone: 'info', text: `报价已提交（${SENT_TEXT[view.rfq.status] ?? view.statusName ?? view.rfq.status}），成交后按开仓组合跟踪，进度见本页与“组合执行”。` });
      return;
    }
    const current = view.quotes.find(quote => quote.quoteId === selected.quote.quoteId);
    if (!current) { setSelected(null); setNotice({ tone: 'error', text: '所选报价已撤回或过期，请重新选择。' }); return; }
    const fingerprint = quoteFingerprint(selected.rfqId, current);
    if (fingerprint !== selected.fingerprint) { setSelected({ rfqId: selected.rfqId, quote: current, fingerprint }); setChanged(true); }
    else if (current !== selected.quote) setSelected({ ...selected, quote: current });
  }, [view, selected, sending]);
  // A status change replaces the last action's notice: the panel then says what happened.
  const statusKey = rfq ? `${rfq.linkId}|${rfq.status}` : '';
  const lastKey = useRef(statusKey);
  useEffect(() => { if (lastKey.current !== statusKey) { lastKey.current = statusKey; setNotice(null); } }, [statusKey]);

  const createProblem = rfqCreateProblem(view, quantity) ?? (creating ? '提交中' : null);
  const open = rfqOpen(rfq);
  const executeBlocked = !open ? '询价已不在可执行状态' : sending || canceling ? '另一项操作进行中' : null;

  async function create() {
    if (quantity === null || !confirm(CREATE_CONFIRM(rfqStrategyLabel(strategy), quantity))) return;
    setCreating(true); setNotice(null);
    try {
      // The RFQ shown now is part of the input: after it is gone, the same choice is a new request, not a replay of the old one.
      const accepted = await ids.current.run('rfq-create', `${quantity}|${strategy}|${rfq?.linkId ?? ''}`, requestId => api<RfqAccepted>(RFQ_PATH, { body: { ...rfqCreateBody(quantity, strategy), requestId }, timeoutMs: WRITE_TIMEOUT_MS }), startRefused);
      setNotice(accepted.status === 'Active' ? { tone: 'info', text: '询价已发出，等待做市商报价。' }
        : accepted.status === 'CreationUnknown' ? { tone: 'error', text: accepted.error ?? '询价创建结果待核对，状态以本页为准。' }
        : { tone: 'error', text: `询价未生效（${accepted.status}）${accepted.error ? `：${accepted.error}` : ''}` });
    } catch (error) {
      setNotice({ tone: 'error', text: startRefused(error) ? `服务拒绝：${errorText(error)}` : `${UNKNOWN_CREATE}（${errorText(error)}）` });
      if (error instanceof ApiError && error.status === 401) onExpired();
    } finally { setCreating(false); void read.refresh(); onChanged(); }
  }
  async function cancel() {
    if (!rfq?.rfqId || !confirm(CANCEL_CONFIRM)) return;
    setCanceling(true); setNotice(null);
    try {
      const answer = await api<RfqAccepted>(`${RFQ_PATH}/cancel`, { body: { rfqId: rfq.rfqId }, timeoutMs: WRITE_TIMEOUT_MS });
      setNotice(answer.status === 'Active' ? { tone: 'error', text: answer.error ?? '取消未生效' } : { tone: 'info', text: '取消已提交，等待交易所确认。' });
    } catch (error) {
      setNotice({ tone: 'error', text: `取消请求未确认：${errorText(error)}；页面会继续核对状态` });
      if (error instanceof ApiError && error.status === 401) onExpired();
    } finally { setCanceling(false); void read.refresh(); onChanged(); }
  }
  async function execute(choice: Selected) {
    setSending(true); setDialogError(null);
    try {
      const answer = await api<RfqAccepted>(`${RFQ_PATH}/execute`, { body: rfqExecuteBody(choice.rfqId, choice.quote.quoteId), timeoutMs: WRITE_TIMEOUT_MS });
      setSelected(null);
      if (answer.status === 'Active') setNotice({ tone: 'error', text: `报价未成交：${answer.error ?? '交易所未接受'}；可以选择其它报价。` });
      else setNotice({ tone: answer.status === 'ExecutionUnknown' ? 'error' : 'info', text: `报价已提交（${SENT_TEXT[answer.status] ?? answer.status}），成交后按开仓组合跟踪。` });
    } catch (error) {
      setDialogError(startRefused(error) ? `服务拒绝：${errorText(error)}` : `${UNKNOWN_EXECUTE}（${errorText(error)}）`);
      if (error instanceof ApiError && error.status === 401) onExpired();
    } finally { setSending(false); void read.refresh(); onChanged(); }
  }

  const status = view ? view.statusName ?? '未创建' : read.error ? '读取失败' : '同步中';
  const live = rfq !== null && !view?.finished;
  const shown = rfq !== null && rfq.rfqId !== null && !(view?.finished && rfq.status !== 'Filled') ? rfq : null;
  // After the end: a creation that never took effect says why; a chosen quote that did not fill says so; a fill tracked
  // from the RFQ's structure (or not taken over) keeps its call for a person.
  const ended = live || rfq === null ? null
    : rfq.status === 'Filled' ? rfq.error
    : rfq.selectedQuoteId !== null ? `选中的报价没有成交（${view?.statusName ?? rfq.status}）`
    : rfq.status === 'Failed' && rfq.error ? `上一笔询价未生效：${rfq.error}` : null;
  const errors = [read.error ? `刷新失败：${read.error.message}` : null, view?.readError ?? null, live ? rfq?.error ?? null : ended].filter((text): text is string => text !== null);
  const current = selected ? view?.quotes.find(quote => quote.quoteId === selected.quote.quoteId) ?? null : null;
  const dialogBlocked = !selected || sending ? null : !rfqOpen(rfq) ? '询价已不在可执行状态，请关闭' : current?.problem ?? null;
  return <div className="tab-pane">
    <section className="panel rfq-panel" aria-label="组合询价">
      <div className="panel-h"><h2>组合询价<span className="heading-detail">RFQ</span></h2><span className="source-tag">{status}</span></div>
      <div className="panel-b">
        {notice ? <p className={`orders-notice${notice.tone === 'error' ? ' loss' : ''}`} role="status">{notice.text}</p> : null}
        <div className="rfq-controls">
          <p>{live && rfq ? `${rfqStrategyLabel(rfq.mode)} · 每腿 ${quantityText(rfq.legs[0]?.qty ?? '0')} BTC · 发给 ${rfq.counterparties.length} 家做市商` : `按执行台当前选择询价：${rfqStrategyLabel(strategy)} · 每腿 ${quantity ?? '--'} BTC`}
            <span>{createProblem && !live ? createProblem : '整组一次成交；执行前服务按报价价格再核风险上限与到期日，成交后按开仓组合跟踪。'}</span></p>
          <button className="button ghost" type="button" disabled={createProblem !== null} title={createProblem ?? undefined} onClick={() => void create()}>{creating ? '创建中…' : '创建 RFQ ↗'}</button>
          <button className="button close-button" type="button" disabled={!open || canceling || sending} onClick={() => void cancel()}>{canceling ? '取消中…' : '取消询价'}</button>
        </div>
        {errors.map(text => <p key={text} className="loss" role="status">{text}</p>)}
        <div className="rfq-meta">
          <span>询价 ID <b>{shown?.rfqId ?? '--'}</b></span><span>类型 <b>{shown ? rfqStrategyLabel(shown.mode) : '--'}</b></span>
          <span>有效期 <b>{shown?.expiresAt ? `${utcTime(shown.expiresAt).slice(6)} UTC` : '--'}</b></span><span>报价数 <b>{live ? view?.quotes.length ?? 0 : 0}</b></span>
          {shown?.selectedDesk ? <span>已选做市商 <b>{shown.selectedDesk}</b></span> : null}
        </div>
        {live && view?.quotes.length ? <div className="rfq-quotes">{view.quotes.map(quote => <QuoteCard key={quote.quoteId} quote={quote} view={view} offset={offset} disabled={executeBlocked}
          onExecute={choice => { if (!rfq?.rfqId) return; setChanged(false); setDialogError(null); setSelected({ rfqId: rfq.rfqId, quote: choice, fingerprint: quoteFingerprint(rfq.rfqId, choice) }); }} />)}</div>
          : <div className="rfq-quotes empty">{live ? rfq?.status === 'Active' ? '暂无报价' : view?.statusName ?? '--' : rfq?.status === 'Filled' ? '上一笔询价已成交，见“组合执行”与“持仓”' : '暂无活动 RFQ'}</div>}
      </div>
    </section>
    <ExecuteDialog selected={selected} view={view} offset={offset} changed={changed} blocked={dialogBlocked} error={dialogError} sending={sending}
      onClose={() => { if (!sending) { setSelected(null); setDialogError(null); } }} onSubmit={choice => void execute(choice)} />
  </div>;
}
