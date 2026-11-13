import { ArrowRightLeft, ChevronDown, Clock3, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { clock, label, stamp } from './labels.ts';
import { ACTIVE_STATUSES, CONFIRM_ACKNOWLEDGE, CONFIRM_NOT_CREATED, CONFIRM_RELEASE, DEFAULT_FORM, VENUE_LABEL, describeIntent, draftLegs, formToIntent, jobActions, type OilForm, type OilIntent, type OilSymbol, type OilVenue } from './oil-form.ts';
import type { OilBook, OilConfirmResult, OilJob, OilMarket, OilPositionAccount, OilPreview, OilState } from './oil-types.ts';
import { RequestIds } from './request-ids.ts';
import { Callout, StatePanel } from './StateViews.tsx';
import { useLiveResource, type LiveResource } from './use-live-resource.ts';
import './trading.css';

// The oil page, laid out as the workbench trading page (OilTradingPage / TradingSpread / TradingExecution, styles copied in
// trading.css): the live spread, the oil positions, then one execution panel with the caps, the jobs, the preview and the
// order form. Every read goes through useLiveResource (paused in the background, the last result kept and marked stale on
// a failure); every write keeps its request id until an answer arrives.
export const OIL_STATE_PATH = '/api/oil/state';
export const OIL_READ_TIMEOUT_MS = 10_000;
const MARKET_MS = 3_000, ACTIVE_MS = 2_000, IDLE_MS = 5_000;

const JOB_STATUS: Record<string, string> = { accepted: '已受理', running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', attention: '需人工处理' };
/** The workbench badge colours: running blue, completed green, waiting for a person amber. */
const JOB_BADGE: Record<string, string> = { accepted: 'running', running: 'running', completed: 'completed', failed: 'attention', attention: 'attention' };
const TRACKING_STATUS: Record<string, string> = {
  accepted: '已受理，正在发送首腿。', running: '执行中：首腿成交后对冲腿按市价跟上。', completed: '已完成，两腿成交见下表。',
  failed: '执行失败，原因见下方；已成交部分保留。', stopped: '已停止，已成交部分保留。', attention: '需要人工处理，请按下方说明核对交易所。',
};
const OP_STATE: Record<string, string> = { prepared: '已落盘', sending: '发送中', open: '交易所挂单中', unknown: '结果未知，核对中', rejected: '被拒绝', 'not-sent': '未发送', 'not-created': '确认未创建', filled: '已成交', canceled: '已撤销', confirmed: '已确认' };
const STRATEGY_STATUS: Record<string, string> = { working: '运行中', paused: '已暂停', terminal: '已结束' };
const ORDER_TYPE: Record<string, string> = { market: '市价', chase: '追价策略', limit: '限价' };
const ACCOUNT_MODE: Record<string, string> = { standard: '普通 U 本位', 'portfolio-margin': '组合保证金', unified: '统一账户' };
const SYMBOLS: readonly OilSymbol[] = ['BZUSDT', 'CLUSDT'];
const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};
// Only the confirm's own refusal (a bad body, an invalid preview, a lock or a cap) proves the request id was never accepted.
// A refusal given before the executor looks the id up (401, 403, 421, 5xx) or a reused id leaves the first request's result unknown.
const confirmRefused = (error: unknown): boolean => {
  const status = statusOf(error);
  return (status === 400 || status === 409) && (error as { code?: unknown } | null)?.code !== 'request_reused';
};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const short = (symbol: string): string => symbol.replace('USDT', '');
const venueName = (venue: string): string => label(VENUE_LABEL, venue);
/** 开多 / 开空 / 平多 / 平空, as the workbench names a leg's operation. */
const operation = (action: string, side: string): string => `${action === 'open' ? '开' : '平'}${side === 'long' ? '多' : '空'}`;

/** The same staleness rule as the overview: a failed or paused read, or a result older than two refreshes and a timeout. */
function staleness(live: Pick<LiveResource<unknown>, 'data' | 'status' | 'error' | 'receivedAt'>, refreshMs: number): { stale: boolean; text: string | null } {
  const { data, status, error, receivedAt } = live;
  const old = receivedAt !== null && Date.now() - receivedAt > 2 * refreshMs + OIL_READ_TIMEOUT_MS;
  const stale = data !== null && (status === 'error' || status === 'offline' || status === 'paused' || (status === 'loading' && (error !== null || old)));
  if (!stale) return { stale, text: null };
  const at = clock(receivedAt);
  return { stale, text: status === 'paused' ? `页面在后台，已暂停刷新（停留在 ${at}）` : status === 'offline' ? `网络离线（停留在 ${at}）` : error ? `刷新失败：${error.message}（停留在 ${at}）` : `正在刷新，下方仍是 ${at} 的结果` };
}

const LEAVE_UNANSWERED = '上次确认没有收到应答，可能已经受理并下单。返回修改后会放弃核对，再次预览确认会是新的请求，可能重复下单。确定返回？';
type ReadState = 'live' | 'stale' | 'loading' | 'error';
const READ_STATE: Record<ReadState, string> = { live: '实时', stale: '已过期', loading: '读取中', error: '读取失败' };
function ReadStatus({ state }: { state: ReadState }) { return <span className={`trading-status ${state}`}><i aria-hidden="true" />{READ_STATE[state]}</span>; }

/** The sync line under a panel heading: how often it refreshes, or why the shown result is old. */
function SyncLine({ stale, text, every, at }: { stale: boolean; text: string | null; every: string; at: number | null }) {
  return <div className={`execution-sync${stale ? ' stale' : ''}`} role={stale ? 'status' : undefined}><Clock3 size={14} aria-hidden="true" />
    <span>{text ?? (at === null ? '正在读取…' : `前台${every}更新。最近取得：${clock(at)}（北京时间）`)}</span></div>;
}

/** The workbench segmented choice: one pressed button per option. */
function Choice<T extends string>({ label: name, value, options, onChange, id }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; id?: string }) {
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
    return <span className={late ? 'spread-stale' : undefined} title={`盘口时间 ${clock(row.receivedAt)}${late ? '（已过期）' : ''}`}>{row.bid ?? '—'} / {row.ask ?? '—'}{late ? <small>{broken ? `读取失败：${row.error ?? '未知原因'}` : `已过期 · ${clock(row.receivedAt)}`}</small> : null}</span>;
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
      {market.crossExchange.length ? <details className="spread-cross"><summary>跨所价差 · Binance 与 Bybit 同一合约</summary>
        <div className="spread-markets oil-spread-markets"><div className="execution-table-wrap"><table className="execution-progress-table spread-table" id="oilCross">
          <thead><tr><th scope="col">合约</th><th scope="col">Binance 买一 / 卖一</th><th scope="col">Bybit 买一 / 卖一</th><th scope="col">Binance 买一 − Bybit 卖一</th><th scope="col">Bybit 买一 − Binance 卖一</th></tr></thead>
          <tbody>{market.crossExchange.map(row => <tr key={row.symbol}>
            <th scope="row">{short(row.symbol)}</th>
            <td data-label="Binance 买一 / 卖一">{quote(book('binance', row.symbol))}</td><td data-label="Bybit 买一 / 卖一">{quote(book('bybit', row.symbol))}</td>
            {spread('Binance 买一 − Bybit 卖一', row.binanceOverBybit, row.receivedAt)}{spread('Bybit 买一 − Binance 卖一', row.bybitOverBinance, row.receivedAt)}
          </tr>)}</tbody>
        </table></div></div>
      </details> : null}
    </> : failed ? null : <p className="trading-footnote">正在读取盘口…</p>}
  </section>;
}

function PositionsPanel({ state, stale }: { state: OilState; stale: boolean }) {
  const view = state.positions;
  const readState = (account: OilPositionAccount): ReadState => {
    if (account.failedAt !== null && (account.receivedAt === null || account.failedAt > account.receivedAt)) return 'error';
    if (account.receivedAt === null) return 'loading';
    return stale ? 'stale' : 'live';
  };
  const amount = (side: Record<string, string> | null, symbol: string): string | null => side ? side[symbol] ?? '0' : null;
  const cell = (value: string | null, side: 'long' | 'short'): ReactNode => value === null ? '—' : Number(value) ? <span className={`trading-side ${side}`}>{value}</span> : <span className="trading-muted">0</span>;
  return <section className="trading-panel trading-overview" id="oilPositions" aria-labelledby="oil-positions-title">
    <header className="trading-panel-heading"><div><h2 id="oil-positions-title">原油持仓</h2><p>执行账户的 BZ / CL 合约数量与原油挂单 · 每 {Math.round(view.readEveryMs / 1000)} 秒读取</p></div></header>
    {view.accounts.length ? <div className="trading-position-scroll"><table className="trading-position-table" aria-label="原油持仓">
      <thead><tr><th scope="col">合约 / 账户</th><th scope="col">多头<small>合约数量</small></th><th scope="col">空头<small>合约数量</small></th><th scope="col">原油挂单</th><th scope="col">读取时间<small>北京时间</small></th></tr></thead>
      <tbody>{view.accounts.flatMap(account => SYMBOLS.map((symbol, index) => {
        const read = readState(account);
        return <tr key={`${account.venue}:${symbol}`} className={index === 0 ? 'trading-leg-start' : ''}>
          <th scope="row" className="trading-leg-name"><strong>{venueName(account.venue)} {short(symbol)}</strong><span>{account.accountId} · {label(ACCOUNT_MODE, account.accountMode)}</span>{index === 0 ? <ReadStatus state={read} /> : null}</th>
          <td data-label="多头">{cell(amount(account.long, symbol), 'long')}</td>
          <td data-label="空头">{cell(amount(account.short, symbol), 'short')}</td>
          <td data-label="原油挂单">{index === 0 ? account.openOrders ?? '—' : ''}</td>
          <td data-label="读取时间">{index === 0 ? read === 'error' ? <span className="trading-warning">读取失败：{account.error ?? '未知原因'}{account.receivedAt ? `（显示 ${clock(account.receivedAt)} 的结果）` : ''}</span> : clock(account.receivedAt) : ''}</td>
        </tr>;
      }))}</tbody>
    </table></div> : <p className="trading-footnote">没有配置原油执行账户。</p>}
    {stale ? <p className="trading-footnote trading-warning">执行状态未能刷新，显示的是上次读取的结果。</p> : null}
  </section>;
}

function Limits({ limits }: { limits: OilState['notionalLimits'] }) {
  if (!limits) return null;
  return <dl className="execution-review-settings oil-limits" id="oilLimits">
    <div><dt>单笔名义上限</dt><dd>{limits.perJob} USDT</dd></div>
    <div><dt>24 小时开仓已用</dt><dd>{limits.openUsed} / {limits.openPer24h} USDT</dd></div>
    <div><dt>最早释放</dt><dd>{limits.nextReleaseAt ? stamp(limits.nextReleaseAt) : '窗口内没有开仓'}</dd></div>
    <div><dt>平仓</dt><dd>不计入 24 小时开仓额度</dd></div>
  </dl>;
}

function PreviewCard({ preview, limits, busy, unknown, onConfirm, onEdit }: { preview: OilPreview; limits: OilState['notionalLimits']; busy: boolean; unknown: boolean; onConfirm: () => void; onEdit: () => void }) {
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
    </dl>
    <div className="execution-review-legs execution-table-wrap"><table className="execution-progress-table execution-review-table">
      <thead><tr><th scope="col">交易腿</th><th scope="col">数量<small>合约数量</small></th><th scope="col">下单方式</th><th scope="col">价格保护界限<small>USDT</small></th><th scope="col">买一 / 卖一<small>盘口时间</small></th></tr></thead>
      <tbody>{preview.legs.map(leg => <tr key={leg.index}>
        <th scope="row"><strong>{venueName(leg.venue)} {short(leg.symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(preview.intent.action, leg.side)}{leg.reduceOnly ? ' · 只减仓' : ''}</span></th>
        <td data-label="数量"><strong>{leg.quantity}</strong><small>每张 {leg.instrument.contractSize} 桶</small></td>
        <td data-label="下单方式">{leg.index === 0 ? '首腿' : '对冲腿'} · {label(ORDER_TYPE, leg.orderType)}</td>
        <td data-label="价格保护界限">{leg.priceBound ?? '—'}</td>
        <td data-label="买一 / 卖一">{leg.quote.bid} / {leg.quote.ask}<small>{clock(leg.quote.receivedAt)}</small></td>
      </tr>)}</tbody>
    </table></div>
    <p className="execution-help">首腿按所选方式下单：市价时以价格保护界限为 IOC 限价，超出界限的部分不成交；追价时界限是最高追价（卖出时为最低）。对冲腿在首腿成交后按市价跟上，不受界限约束，它的界限只在首腿发出前核对一次。{limits ? `单笔上限 ${limits.perJob} USDT；${preview.intent.action === 'open' ? `24 小时开仓已用 ${limits.openUsed} / ${limits.openPer24h} USDT。` : '平仓不计入 24 小时开仓额度。'}` : ''}</p>
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

function OrderForm({ state, onAccepted }: { state: OilState; onAccepted: (job: OilJob) => void }) {
  const venues = useMemo(() => state.accounts.map(account => account.venue).filter((venue): venue is OilVenue => venue === 'binance' || venue === 'bybit'), [state.accounts]);
  const [form, setForm] = useState<OilForm>(() => ({ ...DEFAULT_FORM, venue: venues[0] ?? 'binance' }));
  const [preview, setPreview] = useState<OilPreview | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The preview whose confirm got no answer: it may have been accepted, so leaving it needs a warning.
  const [unanswered, setUnanswered] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const ids = useRef(new RequestIds());
  const reviewRef = useRef<HTMLDivElement>(null);
  // Bumped on every form change: a preview answered for an older form is dropped, never shown beside the new one.
  const formVersion = useRef(0);
  const changed = (): void => { formVersion.current++; setPreview(null); };
  const cross = venues.length === 2;
  // A venue that is no longer configured, or cross venue without both venues, falls back to what is possible.
  useEffect(() => {
    if (venues.length && !venues.includes(form.venue)) { setForm(current => ({ ...current, venue: venues[0]! })); changed(); }
    if (!cross && form.preset === 'cross-exchange') { setForm(current => ({ ...current, preset: 'same-exchange' })); changed(); }
  }, [venues, cross, form.venue, form.preset]);
  // A new preview takes the focus, so the confirmation is what the keyboard and the screen reader reach first.
  useEffect(() => { if (preview) reviewRef.current?.querySelector<HTMLElement>('.execution-review')?.focus(); }, [preview]);
  const set = <K extends keyof OilForm>(key: K, value: OilForm[K]) => {
    setForm(current => {
      const next = { ...current, [key]: value };
      // Chase is Bybit's alone: moving the lead to Binance takes the market order back.
      if (next.venue !== 'bybit') next.leadOrderType = 'market';
      return next;
    });
    changed();
  };
  const action = form.action === 'open' ? '开仓' : '平仓';
  const legs = draftLegs(form);

  async function runPreview(): Promise<void> {
    const built = formToIntent(form);
    if ('error' in built) { setMessage({ tone: 'err', text: built.error }); setPreview(null); return; }
    setBusy(true); setMessage({ tone: 'muted', text: '预览中…' }); setPreview(null);
    const asked = formVersion.current;
    const stale = (): boolean => asked !== formVersion.current && (setMessage({ tone: 'muted', text: '表单在预览期间改过，请重新预览' }), true);
    try {
      const result = await api<OilPreview>('/api/preview', { body: built.intent });
      if (!stale()) { setPreview(result); setMessage(null); }
    } catch (error) { if (!stale()) setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); }
  }

  async function runConfirm(current: OilPreview): Promise<void> {
    const text = `实盘执行：${describeIntent(current.intent as OilIntent)}，每腿 ${current.barrels ?? '?'} 桶，名义金额约 ${current.notional} USDT，${Math.round(current.intent.timeoutMs / 1000)} 秒内完成。确定发送到交易所？`;
    if (!confirm(text)) return;
    setBusy(true); setMessage({ tone: 'muted', text: '发送中…' });
    try {
      const result = await ids.current.run('confirm', current.id, requestId => api<OilConfirmResult>('/api/confirm', { body: { previewId: current.id, requestId, confirmLive: true } }), confirmRefused);
      setPreview(null); setUnanswered(null);
      setMessage({ tone: 'ok', text: `${result.duplicate ? '该请求已受理过' : '已受理'}：任务 ${result.job.id.slice(0, 8)}（${label(JOB_STATUS, result.job.status)}），进度见上方「成交进度与结果」` });
      onAccepted(result.job);
    } catch (error) {
      // Without an answer the job may have been accepted: the retry reuses the request id, so it cannot run twice.
      // Only the confirm's own refusal settles it; anything else (no answer, 401, 5xx, a reused id) keeps the result unknown and the id for the retry.
      const unknown = !confirmRefused(error);
      setUnanswered(unknown ? current.id : null);
      setMessage({ tone: 'err', text: unknown ? `${errorText(error)}（结果未知，可再次点击确认，沿用同一请求编号）` : errorText(error) });
    } finally { setBusy(false); }
  }

  function leave(): void {
    if (preview && unanswered === preview.id && !confirm(LEAVE_UNANSWERED)) return;
    changed(); setMessage(null); setUnanswered(null);
  }

  if (!venues.length) return <p className="execution-message warning" role="status">没有配置原油执行账户，不能下单。</p>;
  const messageView = message ? <p id="oilOrderMsg" className={message.tone === 'err' ? 'execution-warning' : message.tone === 'ok' ? 'oil-ok' : undefined} role="status">{message.text}</p> : null;
  return <>
    <div ref={reviewRef}>{preview ? <PreviewCard preview={preview} limits={state.notionalLimits} busy={busy} unknown={unanswered === preview.id} onConfirm={() => void runConfirm(preview)} onEdit={leave} /> : null}</div>
    <form className="execution-builder" id="oilOrder" aria-label="原油组合交易参数" onSubmit={event => { event.preventDefault(); void runPreview(); }}>
      {preview && messageView ? <div className="oil-review-message">{messageView}</div> : null}
      <fieldset disabled={busy || !!preview}>
        <legend className="visually-hidden">选择组合并填写交易参数</legend>
        <div className="execution-presets oil-presets" role="group" aria-label="交易预设">
          <button type="button" aria-pressed={form.preset === 'same-exchange'} data-oil-preset="same-exchange" onClick={() => { if (form.preset !== 'same-exchange') set('preset', 'same-exchange'); }}>同所价差<small>单所 · BZ 对 CL · 两腿同一账户</small></button>
          <button type="button" aria-pressed={form.preset === 'cross-exchange'} data-oil-preset="cross-exchange" disabled={!cross} onClick={() => { if (form.preset !== 'cross-exchange') set('preset', 'cross-exchange'); }}>跨所同合约<small>{cross ? 'Binance 对 Bybit · 同一合约' : '需同时配置 Binance 与 Bybit 执行账户'}</small></button>
        </div>
        <div className="execution-row">
          <Choice label="交易动作" id="oilAction" value={form.action} options={[['open', '开仓'], ['close', '平仓']]} onChange={next => set('action', next)} />
          <Choice label={form.preset === 'same-exchange' ? '交易所' : '首腿交易所'} id="oilVenue" value={form.venue} options={venues.map(venue => [venue, VENUE_LABEL[venue]] as const)} onChange={next => set('venue', next)} />
          {form.preset === 'same-exchange'
            ? <Choice label="首腿合约" id="oilLeadSymbol" value={form.leadSymbol} options={[['CLUSDT', 'CL 先下'], ['BZUSDT', 'BZ 先下']]} onChange={next => set('leadSymbol', next)} />
            : <Choice label="合约" id="oilSymbol" value={form.symbol} options={[['BZUSDT', 'BZ 布伦特'], ['CLUSDT', 'CL WTI']]} onChange={next => set('symbol', next)} />}
        </div>
        <div className="execution-choice execution-direction"><span aria-hidden="true">{form.action === 'open' ? '开仓方向' : '待平仓方向'}</span>
          <div className="execution-direction-options" role="group" aria-label={form.action === 'open' ? '开仓方向' : '待平仓方向'}>
            {(['long', 'short'] as const).map(side => {
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
          <p className="execution-help">两腿桶数相同，按各合约每张桶数换算成合约数量；不足一个数量步长的部分由预览指出，实际各腿数量以预览为准。</p>
        </div>
        <div className="execution-leg-inputs">{legs.map((leg, index) => {
          const symbol = leg.symbol ?? form.symbol;
          return <section key={index} className="execution-leg-input" aria-label={`${index === 0 ? '首腿' : '对冲腿'} ${VENUE_LABEL[leg.venue]} ${short(symbol)} 交易参数`}>
            <header><strong>{VENUE_LABEL[leg.venue]} {short(symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(form.action, leg.side)}</span><small className="oil-leg-role">{index === 0 ? '首腿' : '对冲腿'}</small></header>
            {index === 0 && form.venue === 'bybit' ? <Choice label="下单方式" id="oilLeadType" value={form.leadOrderType} options={[['market', '市价'], ['chase', '追价策略']]} onChange={next => set('leadOrderType', next)} /> : null}
            <p className="execution-help execution-market-note">{index === 1 ? '首腿成交后按市价跟上相同桶数。'
              : form.leadOrderType === 'chase' ? 'Bybit 原生追价策略，按本方一档追价，直到成交或达到最长执行时间。'
              : form.venue === 'bybit' ? '市价：按对手盘吃单成交，受价格保护界限约束。' : '市价：按对手盘吃单成交，受价格保护界限约束；追价策略仅 Bybit 提供。'}</p>
          </section>;
        })}</div>
        <details className="execution-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
          <summary><span><strong>执行参数</strong><small>最长 {form.timeoutSeconds || '?'} 秒 · 价格保护 {form.slippageBps ? `${form.slippageBps} 基点` : '默认'}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="execution-settings">
            <label>最长执行 · 秒<input id="oilTimeout" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={form.timeoutSeconds} onChange={event => set('timeoutSeconds', event.target.value)} /></label>
            <label>价格保护 · 基点（选填）<input id="oilSlippage" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={form.slippageBps} placeholder="留空用默认值" onChange={event => set('slippageBps', event.target.value)} /></label>
          </div>
          <p className="execution-help">到最长执行时间仍未完成时，停止发送并撤销余单，已成交部分保留。价格保护按预览盘口计算界限：首腿超出界限的部分不成交；对冲腿按市价成交，界限只在首腿发出前核对。</p>
        </details>
        <div className="execution-builder-footer">
          {preview ? <p>正在确认上方预览；返回修改参数后可重新填写。</p> : messageView ?? <p>预览会重新读取盘口、交易规则与持仓，不会下单。</p>}
          <button className="button primary" type="submit" id="oilPreviewBtn">{busy && !preview ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={16} aria-hidden="true" />}预览{action}组合</button>
        </div>
      </fieldset>
    </form>
  </>;
}

function strategyText(leg: OilJob['legs'][number]): string {
  const op = leg.operation;
  if (!op || op.kind !== 'strategy') return '';
  return `追价策略 ${op.remoteId ?? '编号未知'}${op.strategyStatus ? ` ${label(STRATEGY_STATUS, op.strategyStatus)}` : ''}${op.strategyStatus === 'terminal' && op.childrenSettled === false ? '（子单未结清）' : ''}${op.adoptedAt ? '（人工认领）' : ''}${op.releasedAt ? '（已强制释放）' : ''}`;
}

type ActionKind = 'stop' | 'acknowledge' | 'adopt' | 'notcreated' | 'release';

function JobCard({ job, busy, strategyId, onStrategyId, onAction }: { job: OilJob; busy: boolean; strategyId: string; onStrategyId: (value: string) => void; onAction: (job: OilJob, kind: ActionKind) => void }) {
  const actions = jobActions(job);
  const kind = job.preset === 'same-exchange' ? `${venueName(job.legs[0]?.venue ?? '')} 同所价差` : '跨所同合约';
  const strategyLeg = job.legs.find(leg => leg.operation?.kind === 'strategy');
  return <article className={`execution-job ${job.status}`} data-oil-job={job.id} aria-label={`${kind}${job.action === 'open' ? '开仓' : '平仓'} ${label(JOB_STATUS, job.status)}`}>
    <header><div>
      <h3>{kind}{job.action === 'open' ? '开仓' : '平仓'} <span className={`execution-badge ${JOB_BADGE[job.status] ?? ''}`}>{label(JOB_STATUS, job.status)}</span>{job.stopRequested ? <span className="execution-badge">已请求停止</span> : null}{job.holdNewSends ? <span className="execution-badge">恢复中，不再发送新委托</span> : null}</h3>
      <p>任务 {job.id.slice(0, 8)} · 创建 {stamp(job.createdAt)} · 最迟 {clock(job.deadlineAt)}（北京时间）</p>
    </div>{actions.stop ? <button className="button secondary execution-stop" type="button" data-oil-stop={job.id} disabled={busy} onClick={() => onAction(job, 'stop')}><Square size={14} aria-hidden="true" />停止并撤销余单</button> : null}</header>
    {job.reason ? <p className="execution-job-reason" role={job.status === 'attention' ? 'alert' : undefined}>{job.reason}</p> : null}
    <div className="execution-table-wrap"><table className="execution-progress-table">
      <thead><tr><th scope="col">交易腿</th><th scope="col">已成交 / 计划<small>桶</small></th><th scope="col">成交均价<small>USDT</small></th><th scope="col">当前委托 / 策略</th><th scope="col">价格保护界限<small>USDT</small></th></tr></thead>
      <tbody>{job.legs.map((leg, index) => <tr key={index}>
        <th scope="row"><strong>{venueName(leg.venue)} {short(leg.symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(job.action, leg.side)}</span></th>
        <td data-label="已成交 / 计划"><span><strong>{leg.filledBarrels}</strong> / {leg.plannedBarrels} 桶<small>合约 {leg.filledQuantity} / {leg.plannedQuantity}{leg.attempts > 1 ? ` · ${leg.attempts} 笔` : ''}</small></span></td>
        <td data-label="成交均价">{leg.averagePrice ?? '—'}</td>
        <td data-label="当前委托 / 策略"><span className={leg.operation?.state === 'unknown' ? 'execution-warning' : undefined}>{leg.operation ? label(OP_STATE, leg.operation.state) : '未发送'}</span>
          <small>{index === 0 ? '首腿' : '对冲腿'} · {label(ORDER_TYPE, leg.orderType)} · 账户 {leg.accountId}{strategyText(leg) ? ` · ${strategyText(leg)}` : ''}</small>{leg.operation?.note ? <small>{leg.operation.note}</small> : null}</td>
        <td data-label="价格保护界限">{leg.priceBound ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>
    {actions.strategy ? <div className="execution-reconcile" role="group" aria-label="追价策略核对">
      <strong>{strategyLeg ? `${venueName(strategyLeg.venue)} ${short(strategyLeg.symbol)} · ` : ''}追价策略创建结果未知</strong>
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
      <p>请在交易所核对两腿敞口与挂单，处理完后释放合约；释放前这两个合约不能再下单。</p>
      <div className="execution-actions"><button type="button" className="button secondary" data-oil-ack={job.id} disabled={busy} onClick={() => onAction(job, 'acknowledge')}>已人工处理，释放合约</button></div>
    </div> : null}
    <footer><span>{job.locked ? '合约锁占用中：这两个合约暂不能再下单。' : '合约锁已释放。'}{job.acknowledgedAt ? `已人工处理 ${stamp(job.acknowledgedAt)}。` : ''}</span><span>停止只撤销余单，已成交仓位保留。</span></footer>
    <details className="execution-events"><summary>执行记录与编号（{job.events.length}）</summary><p>任务编号：{job.id} · 最迟结束：{stamp(job.deadlineAt)}（北京时间）</p>
      <ul>{job.events.map((event, index) => {
        const note = ['reason', 'message', 'note'].map(key => event[key]).find(value => typeof value === 'string') as string | undefined;
        return <li key={index}><time>{clock(event.at)}</time><span>{event.type}{note ? `：${note}` : ''}</span></li>;
      })}</ul></details>
  </article>;
}

/** Whether a job still asks for something: it runs, or it waits for a person (strategy reconcile, acknowledgement). */
const needsWatch = (job: OilJob): boolean => { const actions = jobActions(job); return ACTIVE_STATUSES.includes(job.status) || actions.strategy || actions.acknowledge; };

function JobsSection({ jobs, stale, tracked, onUntrack, onChanged }: { jobs: OilJob[]; stale: boolean; tracked: string | null; onUntrack: () => void; onChanged: () => void }) {
  const ids = useRef(new RequestIds());
  const trackingRef = useRef<HTMLElement>(null);
  const [strategyIds, setStrategyIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ jobId: string; tone: 'ok' | 'err'; text: string } | null>(null);
  const trackedJob = jobs.find(job => job.id === tracked) ?? null;
  const active = jobs.filter(job => job.id !== tracked && needsWatch(job));
  const past = jobs.filter(job => job.id !== tracked && !needsWatch(job));
  // A newly accepted job is brought into view once, as the workbench does after a confirmation.
  const shown = !!trackedJob;
  useEffect(() => { if (shown) trackingRef.current?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [tracked, shown]);

  async function act(job: OilJob, kind: ActionKind): Promise<void> {
    const path = `/api/jobs/${job.id}/`;
    const strategyId = (strategyIds[job.id] ?? '').trim();
    if (kind === 'adopt' && !strategyId) { setMessage({ jobId: job.id, tone: 'err', text: `任务 ${job.id.slice(0, 8)}：请先填写交易所显示的策略编号` }); return; }
    if (kind === 'notcreated' && !confirm(CONFIRM_NOT_CREATED)) return;
    if (kind === 'release' && !confirm(CONFIRM_RELEASE)) return;
    if (kind === 'acknowledge' && !confirm(CONFIRM_ACKNOWLEDGE)) return;
    setBusy(job.id);
    try {
      const send = (requestId: string) => kind === 'stop' ? api(`${path}stop`, { body: { requestId } })
        : kind === 'acknowledge' ? api(`${path}acknowledge`, { body: { requestId } })
        : kind === 'adopt' ? api(`${path}adopt-strategy`, { body: { requestId, strategyId } })
        : kind === 'notcreated' ? api(`${path}confirm-not-created`, { body: { requestId } })
        : api(`${path}release-strategy`, { body: { requestId, acknowledgeRisk: true } });
      await ids.current.run(`${job.id}:${kind}`, kind === 'adopt' ? strategyId : '', send);
      if (kind === 'adopt') setStrategyIds(currentIds => { const next = { ...currentIds }; delete next[job.id]; return next; });
      setMessage({ jobId: job.id, tone: 'ok', text: `任务 ${job.id.slice(0, 8)}：${kind === 'stop' ? '已请求停止' : kind === 'adopt' ? '已认领策略' : kind === 'notcreated' ? '已确认未创建' : kind === 'release' ? '已强制释放' : '已释放合约'}` });
      onChanged();
    } catch (error) {
      setMessage({ jobId: job.id, tone: 'err', text: `任务 ${job.id.slice(0, 8)}：${statusOf(error) === undefined ? `${errorText(error)}（结果未知，可再次点击，沿用同一请求编号）` : errorText(error)}` });
    } finally { setBusy(null); }
  }

  const card = (job: OilJob) => <JobCard key={job.id} job={job} busy={busy === job.id} strategyId={strategyIds[job.id] ?? ''} onStrategyId={value => setStrategyIds(currentIds => ({ ...currentIds, [job.id]: value }))} onAction={(target, kind) => void act(target, kind)} />;
  return <>
    {message ? <p className={`execution-message${message.tone === 'err' ? ' warning' : ''}`} id="oilJobMsg" role="status">{message.text}</p> : null}
    {trackedJob ? <section ref={trackingRef} className="execution-jobs execution-tracking" id="oilTracking" aria-label="成交进度与结果">
      <div className="oil-tracking-heading"><h3>成交进度与结果</h3><button type="button" className="button secondary" data-oil-untrack onClick={onUntrack}>收起</button></div>
      <p className={`execution-tracking-status${stale || trackedJob.status === 'attention' || trackedJob.status === 'failed' ? ' warning' : ''}`} role="status">{stale ? '进度暂未更新，以下保留上次读取的结果；恢复后继续核对。' : TRACKING_STATUS[trackedJob.status] ?? label(JOB_STATUS, trackedJob.status)}</p>
      {card(trackedJob)}
    </section> : null}
    {active.length ? <section className="execution-jobs" id="oilActiveJobs" aria-labelledby="oil-active-title"><h3 id="oil-active-title">执行进度</h3>{active.map(card)}</section> : null}
    {past.length ? <details className="execution-history" id="oilHistory"><summary>已结束的任务（最近 {past.length} 个）</summary><div>{past.map(card)}</div></details> : null}
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
  if (missing) return <StatePanel kind="empty" title="本服务没有配置原油执行" detail="在 config.json 写入 oil（或在总览「从工作台导入」勾选原油执行账户）后重启服务。" />;
  return <div className="trading-page oil-page">
    <Callout tone="error" role="status">实盘：确认执行会在真实 Binance / Bybit 账户下单。首腿成交后对冲腿按市价跟上；任务受单笔与 24 小时开仓名义金额上限约束。同一账户请勿同时在工作台下原油单或开启原油自动规则。</Callout>
    <div className="trading-trade-top">
      <MarketPanel live={market} />
      {state.data ? <PositionsPanel state={state.data} stale={stale} /> : null}
    </div>
    {!state.data ? (state.status === 'error' || state.status === 'offline'
      ? <StatePanel kind="error" title="读取原油状态失败" detail={state.error?.message ?? '网络离线'} />
      : <StatePanel kind="loading" title="加载中…" />)
      : <section className="trading-panel execution-panel" aria-labelledby="oil-execution-title">
        <header className="trading-panel-heading"><div><h2 id="oil-execution-title">原油组合交易</h2><p>同所 BZ − CL 价差 · 跨所同一合约 · 首腿市价或 Bybit 追价策略，成交后对冲腿市价跟上</p></div>
          <button className="button secondary" type="button" onClick={() => void state.refresh()}><RefreshCw size={15} aria-hidden="true" />刷新执行状态</button></header>
        <SyncLine stale={stale} text={text} every={`每 ${refreshMs / 1000} 秒`} at={state.receivedAt} />
        <Limits limits={state.data.notionalLimits} />
        <JobsSection jobs={state.data.jobs} stale={stale} tracked={tracked} onUntrack={() => setTracked(null)} onChanged={() => { void state.refresh(); }} />
        <OrderForm state={state.data} onAccepted={job => { setTracked(job.id); setActive(true); void state.refresh(); }} />
      </section>}
  </div>;
}
