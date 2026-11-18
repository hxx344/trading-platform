import { ArrowRightLeft, ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { clock, label } from './labels.ts';
import { ACTIVE_STATUSES, type OilVenue } from './oil-form.ts';
import { DEFAULT_HYNIX_FORM, HYNIX_LABEL, LEG_FIELDS, HYNIX_SYMBOLS, LEAD_TYPES, OIL_VENUES, VENUE_LABEL, HEDGE_TYPES, allowedOrderTypes, hedgeVenueFor, closeQuantities, describeHynixFourLeg, describeHynixIntent, draftHynixFourLegs, draftHynixLegs, hynixFormToIntent, hynixFourLegFormToIntent, type HynixForm, type HynixFourLegIntent, type HynixIntent, type HynixSymbol } from './hynix-form.ts';
import { isFourLegPreview, type FourLegConfirmResult, type FourLegPreview } from './four-leg.ts';
import { bookTitle, crossPairs, type CrossRow, type HynixState, type OilBook, type OilConfirmResult, type OilJob, type OilPreview, type OilState } from './oil-types.ts';
import { BalancePanel } from './HynixBalance.tsx';
import { readBalance } from './hynix-balance.ts';
import { ACCOUNT_MODE, ACTIVE_MS, Choice, IDLE_MS, JOB_STATUS, JobsSection, LEAVE_UNANSWERED, MARKET_MS, OIL_READ_TIMEOUT_MS, ORDER_TYPE, PositionsPanel, SyncLine, buys, confirmRefused, errorText, hedgeNote, operation, staleness, statusOf, venueName, FourLegInputs, FourLegPreviewCard, chased, venuePairs, type PositionsKind } from './OilPage.tsx';
import { OilRules } from './OilRules.tsx';
import { RequestIds } from './request-ids.ts';
import { StatePanel } from './StateViews.tsx';
import { useLiveResource, type LiveResource } from './use-live-resource.ts';
import './trading.css';

// The SK hynix page (docs/hynix.md), laid out as the workbench trading page's hynix market (TradingSpread /
// TradingExecution, workbench origin/main 7745181; styles are the ones trading.css already copied for oil): the premium
// and books, the hynix positions, the two legs' notional balance with its rebalance (HynixBalance.tsx), then one execution
// panel with the jobs, the preview and the order form. Execution accounts, locks and the executor are oil's.
export const HYNIX_STATE_PATH = '/api/hynix/state';

interface HynixMarket {
  now: number; readAt: number | null; readEveryMs: number; timeoutMs: number;
  books: OilBook[];
  /** Percent: premium from both midpoints; sell = ADR bid × 10 ÷ ordinary ask − 1; buy = ADR ask × 10 ÷ ordinary bid − 1. */
  sameExchange: { venue: string; premium: string | null; sell: string | null; buy: string | null; receivedAt: number | null }[];
  crossExchange: CrossRow[];
}
type HynixPreview = Omit<OilPreview, 'intent'> & { intent: HynixIntent };

const POSITIONS: PositionsKind = { name: '海力士', symbols: HYNIX_SYMBOLS, contract: symbol => HYNIX_LABEL[symbol as HynixSymbol] ?? symbol, id: 'hynixPositions' };
const name = (symbol: string): string => HYNIX_LABEL[symbol as HynixSymbol] ?? symbol;
const percent = (value: string | null): string | null => value === null ? null : `${Number(value).toFixed(2)}%`;

function MarketPanel({ live }: { live: LiveResource<HynixMarket> }) {
  const market = live.data;
  const { stale, text } = staleness(live, MARKET_MS);
  const failed = !market && (live.status === 'error' || live.status === 'offline');
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
  const cell = (heading: string, value: string | null, at: number | null): ReactNode => <td data-label={heading} className={value !== null && old(at) ? 'spread-stale' : undefined}>{value ?? '—'}{value !== null && old(at) ? <small>过期</small> : null}</td>;
  return <section className="trading-panel spread-panel" id="hynixMarket" aria-labelledby="hynix-market-title">
    <header className="trading-panel-heading"><div><h2 id="hynix-market-title">海力士实时溢价</h2><p>同所 ADR 对正股 · 1 股正股 = 10 份 ADR · 溢价率 = ADR × 10 ÷ 正股 − 1 · 卖出按 ADR 买一 ÷ 正股卖一，买入按 ADR 卖一 ÷ 正股买一</p></div>
      <button className="button secondary" type="button" onClick={() => void live.refresh()}><RefreshCw size={15} aria-hidden="true" />刷新行情</button></header>
    <SyncLine stale={stale || failed} text={failed ? `行情读取失败：${live.error?.message ?? '网络离线'}` : text} every={`每 ${Math.round((market?.readEveryMs ?? MARKET_MS) / 1000)} 秒`} at={market?.readAt ?? null} />
    {market ? <>
      <div className="spread-markets oil-spread-markets"><div className="execution-table-wrap"><table className="execution-progress-table spread-table" id="hynixSpreads">
        <caption>SK 海力士 · 同所 ADR 溢价</caption>
        <thead><tr><th scope="col">交易所</th><th scope="col">ADR 买一 / 卖一</th><th scope="col">正股 买一 / 卖一</th><th scope="col">溢价率<small>中间价</small></th><th scope="col">卖出溢价<small>空 ADR · 多正股</small></th><th scope="col">买入溢价<small>多 ADR · 空正股</small></th></tr></thead>
        <tbody>{market.sameExchange.map(row => <tr key={row.venue}>
          <th scope="row">{venueName(row.venue)}</th>
          <td data-label="ADR 买一 / 卖一">{quote(book(row.venue, 'SKHYUSDT'))}</td><td data-label="正股 买一 / 卖一">{quote(book(row.venue, 'SKHYNIXUSDT'))}</td>
          {cell('溢价率', percent(row.premium), row.receivedAt)}{cell('卖出溢价', percent(row.sell), row.receivedAt)}{cell('买入溢价', percent(row.buy), row.receivedAt)}
        </tr>)}</tbody>
      </table></div></div>
      {market.crossExchange.length ? <details className="spread-cross"><summary>跨所价差 · {crossPairs(market.crossExchange).map(pair => `${venueName(pair.first)} 与 ${venueName(pair.second)}`).join('、')} 同一合约（USDT）</summary>
        {crossPairs(market.crossExchange).map(pair => {
          const [a, b] = [venueName(pair.first), venueName(pair.second)];
          return <div key={`${pair.first}:${pair.second}`} className="spread-markets oil-spread-markets"><div className="execution-table-wrap"><table className="execution-progress-table spread-table" id={`hynixCross-${pair.first}-${pair.second}`}>
            <thead><tr><th scope="col">合约</th><th scope="col">{a} 买一 / 卖一</th><th scope="col">{b} 买一 / 卖一</th><th scope="col">{a} 买一 − {b} 卖一</th><th scope="col">{b} 买一 − {a} 卖一</th></tr></thead>
            <tbody>{pair.rows.map(row => <tr key={row.symbol}>
              <th scope="row">{name(row.symbol)}</th>
              <td data-label={`${a} 买一 / 卖一`}>{quote(book(pair.first, row.symbol))}</td><td data-label={`${b} 买一 / 卖一`}>{quote(book(pair.second, row.symbol))}</td>
              {cell(`${a} 买一 − ${b} 卖一`, row.firstOverSecond, row.receivedAt)}{cell(`${b} 买一 − ${a} 卖一`, row.secondOverFirst, row.receivedAt)}
            </tr>)}</tbody>
          </table></div></div>;
        })}
      </details> : null}
    </> : failed ? null : <p className="trading-footnote">正在读取盘口…</p>}
  </section>;
}

function PreviewCard({ preview, busy, unknown, onConfirm, onEdit }: { preview: HynixPreview; busy: boolean; unknown: boolean; onConfirm: () => void; onEdit: () => void }) {
  const action = preview.intent.action === 'open' ? '开仓' : '平仓';
  const accounts = [...new Map(preview.legs.map(leg => [`${leg.venue}:${leg.accountId}`, leg])).values()];
  const expired = Date.now() > preview.expiresAt;
  const perLeg = preview.intent.legs[0].notional;
  return <section className="execution-review" id="hynixPreview" aria-labelledby="hynix-review-title" tabIndex={-1}>
    <div className="execution-review-title"><div><h3 id="hynix-review-title">确认{describeHynixIntent(preview.intent)}</h3><p>预览有效至 {clock(preview.expiresAt)}（北京时间）</p></div><span className="execution-badge attention">实盘下单</span></div>
    <div className="execution-review-accounts">{accounts.map(leg => <p key={`${leg.venue}:${leg.accountId}`}><strong>{venueName(leg.venue)}</strong> {label(ACCOUNT_MODE, leg.accountMode)} · 账户 {leg.accountId}</p>)}</div>
    <dl className="execution-review-settings">
      <div><dt>每腿下单方式</dt><dd>{perLeg ? `等金额 ${perLeg} USDT` : '按各腿数量'}</dd></div>
      <div><dt>估算名义金额</dt><dd>{preview.notional} USDT</dd></div>
      <div><dt>价格保护</dt><dd>{preview.intent.maxSlippageBps ? `${preview.intent.maxSlippageBps} 基点` : '执行器默认值'}</dd></div>
      <div><dt>最长执行</dt><dd>{Math.round(preview.intent.timeoutMs / 1000)} 秒</dd></div>
      {preview.batches?.length ? <div><dt>分批</dt><dd>{preview.batches.length} 批 · 间隔 {Math.round((preview.intent.batches?.intervalMs ?? 0) / 1000)} 秒<small>首腿每批 {preview.batches.join(' / ')}，对冲腿每批按计划比例</small></dd></div> : null}
    </dl>
    <div className="execution-review-legs execution-table-wrap"><table className="execution-progress-table execution-review-table">
      <thead><tr><th scope="col">交易腿</th><th scope="col">数量<small>合约数量</small></th><th scope="col">下单方式</th><th scope="col">价格保护界限<small>USDT</small></th><th scope="col">买一 / 卖一<small>盘口时间</small></th></tr></thead>
      <tbody>{preview.legs.map(leg => <tr key={leg.index}>
        <th scope="row"><strong>{venueName(leg.venue)} {name(leg.symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(preview.intent.action, leg.side)}{leg.reduceOnly ? ' · 只减仓' : ''}</span></th>
        <td data-label="数量"><strong>{leg.quantity}</strong><small>{leg.symbol} · 步长 {leg.instrument.quantityStep}</small></td>
        <td data-label="下单方式">{leg.index === 0 ? '首腿' : '对冲腿'} · {label(ORDER_TYPE, leg.orderType)}{leg.chaseTimeoutMs ? <small>超过 {leg.chaseTimeoutMs / 1000} 秒剩余转市价</small> : null}</td>
        <td data-label="价格保护界限">{leg.orderType === 'local-chase' && leg.limitPrice ? <>{leg.limitPrice}<small>自填追价界限</small></> : leg.priceBound ?? '—'}{leg.chaseCeiling ? <small>挂单上限 {leg.chaseCeiling}</small> : null}</td>
        <td data-label="买一 / 卖一">{leg.quote.bid} / {leg.quote.ask}<small>{clock(leg.quote.receivedAt)}</small></td>
      </tr>)}</tbody>
    </table></div>
    <p className="execution-help">首腿按所选方式下单：市价时以价格保护界限为 IOC 限价；追价时界限是最高追价（卖出时为最低）。对冲腿在首腿成交后按市价或本地追价跟上，数量按两腿计划比例（对冲腿计划 × 首腿成交 ÷ 首腿计划，向下取整到步长）。同一账户请勿同时在工作台下海力士单。</p>
    {preview.notes.length ? <ul className="execution-review-notes">{preview.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
    {unknown ? <p className="execution-warning">上次确认没有收到应答，可能已受理：请先再点“确认并实盘{action}”核对（沿用同一请求编号，不会重复下单）。</p>
      : expired ? <p className="execution-warning" role="status">预览已过期，确认会被执行器拒绝；请返回修改参数后重新预览。</p> : null}
    <div className="execution-actions">
      <button className="button primary" type="button" id="hynixConfirmBtn" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={16} aria-hidden="true" />}确认并实盘{action}</button>
      <button className="button secondary" type="button" disabled={busy} onClick={onEdit}>返回修改参数</button>
    </div>
  </section>;
}

function OrderForm({ state, onAccepted }: { state: OilState; onAccepted: (job: OilJob) => void }) {
  const venues = useMemo(() => OIL_VENUES.filter(venue => state.accounts.some(account => account.venue === venue)), [state.accounts]);
  const [form, setForm] = useState<HynixForm>(() => ({ ...DEFAULT_HYNIX_FORM, venue: venues[0] ?? 'binance', hedgeVenue: hedgeVenueFor(venues, venues[0] ?? 'binance', DEFAULT_HYNIX_FORM.hedgeVenue) ?? DEFAULT_HYNIX_FORM.hedgeVenue }));
  const [preview, setPreview] = useState<HynixPreview | FourLegPreview<HynixFourLegIntent> | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [unanswered, setUnanswered] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  // Set when picking the hedge venue as the lead swapped the two: with two venues the hedge choice is not shown, so say it.
  const [swapNote, setSwapNote] = useState<string | null>(null);
  const ids = useRef(new RequestIds());
  const reviewRef = useRef<HTMLDivElement>(null);
  const formVersion = useRef(0);
  const changed = (): void => { formVersion.current++; setPreview(null); };
  const cross = venues.length >= 2;
  useEffect(() => {
    // Through update(), so a venue or preset forced by an account change also clears the per-leg quantities.
    if (venues.length && !venues.includes(form.venue)) update({ venue: venues[0]! });
    if (!cross && form.preset !== 'same-exchange') update({ preset: 'same-exchange' });
    const hedge = hedgeVenueFor(venues, form.venue, form.hedgeVenue);
    if (hedge && hedge !== form.hedgeVenue) update({ hedgeVenue: hedge });
  }, [venues, cross, form.venue, form.hedgeVenue, form.preset]);
  useEffect(() => { if (preview) reviewRef.current?.querySelector<HTMLElement>('.execution-review')?.focus(); }, [preview]);
  const update = (patch: Partial<HynixForm>) => {
    if ('venue' in patch || 'hedgeVenue' in patch || 'preset' in patch) setSwapNote(patch.venue !== undefined && form.preset === 'cross-exchange' && patch.venue === form.hedgeVenue && patch.venue !== form.venue ? `首腿与对冲腿交易所已对调：对冲腿已改为 ${VENUE_LABEL[form.venue]}` : null);
    setForm(current => {
      const next = { ...current, ...patch };
      // Picking the hedge venue as the lead swaps the two, so a cross-venue pair stays on two venues.
      if (patch.venue !== undefined && patch.hedgeVenue === undefined && patch.venue === current.hedgeVenue) next.hedgeVenue = current.venue;
      // Four legs: the pair is listed in venue order (venuePairs), and every leg takes the same notional, opening or closing.
      if (patch.preset === 'four-leg' && OIL_VENUES.indexOf(next.venue) > OIL_VENUES.indexOf(next.hedgeVenue)) [next.venue, next.hedgeVenue] = [next.hedgeVenue, next.venue];
      // Each venue chases its own way, the hedge only on Binance and OKX: an order type the venue now does not offer goes back to market.
      Object.assign(next, allowedOrderTypes(next));
      // The four-leg direction names the first venue's premium: another preset or venue pair has it picked again.
      if (next.preset !== current.preset || next.venue !== current.venue || next.hedgeVenue !== current.hedgeVenue) next.fourPremium = '';
      // Opening is by equal notional only; closing defaults to the quantities held.
      if (patch.action && patch.action !== current.action) next.sizing = patch.action === 'open' ? 'notional' : 'quantity';
      if (next.preset === 'four-leg') next.sizing = 'notional';
      // A native chase is never batched; its batch fields are hidden, so they must not keep a stale count.
      if (chased(next)) { next.batchCount = '1'; next.batchIntervalSeconds = '0'; }
      // Quantities belong to the legs they were typed for: a change of contract, venue, side or action clears them, so a
      // number never moves onto another contract.
      if (LEG_FIELDS.some(key => key in patch && patch[key] !== current[key])) { next.leadQuantity = ''; next.hedgeQuantity = ''; }
      return next;
    });
    changed();
  };
  const set = <K extends keyof HynixForm>(key: K, value: HynixForm[K]) => update({ [key]: value } as Partial<HynixForm>);
  const action = form.action === 'open' ? '开仓' : '平仓';
  const legs = draftHynixLegs(form);
  const four = form.preset === 'four-leg';

  function fillHeld(): void {
    const held = closeQuantities(form, state.positions.accounts);
    if ('error' in held) { setMessage({ tone: 'err', text: held.error }); return; }
    update(held); setMessage({ tone: 'muted', text: `已按持仓填入：首腿 ${held.leadQuantity}、对冲腿 ${held.hedgeQuantity}（持仓 ${clock(state.positions.readAt)} 读取，预览前请核对）` });
  }

  async function runPreview(): Promise<void> {
    const built = four ? hynixFourLegFormToIntent(form) : hynixFormToIntent(form);
    if ('error' in built) { setMessage({ tone: 'err', text: built.error }); setPreview(null); return; }
    setBusy(true); setMessage({ tone: 'muted', text: '预览中…' }); setPreview(null);
    const asked = formVersion.current;
    const stale = (): boolean => asked !== formVersion.current && (setMessage({ tone: 'muted', text: '表单在预览期间改过，请重新预览' }), true);
    try {
      const result = built.intent.preset === 'four-leg' ? await api<FourLegPreview<HynixFourLegIntent>>('/api/four-leg/preview', { body: built.intent })
        : await api<HynixPreview>('/api/preview', { body: built.intent });
      if (!stale()) { setPreview(result); setMessage(null); }
    } catch (error) { if (!stale()) setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); }
  }

  async function runConfirm(current: HynixPreview | FourLegPreview<HynixFourLegIntent>): Promise<void> {
    if (isFourLegPreview<HynixFourLegIntent>(current)) { await runFourLegConfirm(current); return; }
    const sizes = current.legs.map(leg => `${name(leg.symbol)} ${leg.quantity}`).join('、');
    const text = `实盘执行：${describeHynixIntent(current.intent)}，${sizes}，名义金额约 ${current.notional} USDT，${Math.round(current.intent.timeoutMs / 1000)} 秒内完成。确定发送到交易所？`;
    if (!confirm(text)) return;
    setBusy(true); setMessage({ tone: 'muted', text: '发送中…' });
    try {
      const result = await ids.current.run('confirm', current.id, requestId => api<OilConfirmResult>('/api/confirm', { body: { previewId: current.id, requestId, confirmLive: true } }), confirmRefused);
      setPreview(null); setUnanswered(null);
      setMessage({ tone: 'ok', text: `${result.duplicate ? '该请求已受理过' : '已受理'}：任务 ${result.job.id.slice(0, 8)}（${label(JOB_STATUS, result.job.status)}），进度见上方「成交进度与结果」` });
      onAccepted(result.job);
    } catch (error) {
      const unknown = !confirmRefused(error);
      setUnanswered(unknown ? current.id : null);
      setMessage({ tone: 'err', text: unknown ? `${errorText(error)}（结果未知，可再次点击确认，沿用同一请求编号）` : errorText(error) });
    } finally { setBusy(false); }
  }

  /** The four-leg confirm: one request creates both jobs, retried with the same request id while its answer is unknown. */
  async function runFourLegConfirm(current: FourLegPreview<HynixFourLegIntent>): Promise<void> {
    const text = `实盘执行：${describeHynixFourLeg(current.intent)}，每腿 ${current.intent.legs[0].notional ?? '?'} USDT，名义金额约 ${current.notional} USDT（四腿合计），${Math.round(current.intent.timeoutMs / 1000)} 秒内完成。确定发送到交易所？`;
    if (!confirm(text)) return;
    setBusy(true); setMessage({ tone: 'muted', text: '发送中…' });
    try {
      const result = await ids.current.run('confirm', current.id, requestId => api<FourLegConfirmResult>('/api/four-leg/confirm', { body: { previewId: current.id, requestId, confirmLive: true } }), confirmRefused);
      setPreview(null); setUnanswered(null);
      setMessage({ tone: 'ok', text: `${result.duplicate ? '该请求已受理过' : '已受理'}：四腿组 ${result.group.slice(0, 8)}，任务 ${result.jobs.map(job => job.id.slice(0, 8)).join('、')}，进度见上方「成交进度与结果」` });
      onAccepted(result.jobs[0]!);
    } catch (error) {
      const unknown = !confirmRefused(error);
      setUnanswered(unknown ? current.id : null);
      setMessage({ tone: 'err', text: unknown ? `${errorText(error)}（结果未知，可再次点击确认，沿用同一请求编号）` : errorText(error) });
    } finally { setBusy(false); }
  }

  function leave(): void {
    if (preview && unanswered === preview.id && !confirm(LEAVE_UNANSWERED)) return;
    changed(); setMessage(null); setUnanswered(null);
  }

  if (!venues.length) return <p className="execution-message warning" role="status">没有配置执行账户，不能下单。</p>;
  const messageView = message ? <p id="hynixOrderMsg" className={message.tone === 'err' ? 'execution-warning' : message.tone === 'ok' ? 'oil-ok' : undefined} role="status">{message.text}</p> : null;
  const same = form.preset === 'same-exchange', crossed = form.preset === 'cross-exchange';
  return <>
    <div ref={reviewRef}>{preview ? isFourLegPreview<HynixFourLegIntent>(preview)
      ? <FourLegPreviewCard preview={preview} title={describeHynixFourLeg(preview.intent)} size={['每腿下单方式', `等金额 ${preview.intent.legs[0].notional ?? '—'} USDT`]} legName={name} quantityNote={leg => `${leg.symbol} · 步长 ${leg.instrument.quantityStep}`} idPrefix="hynix" busy={busy} unknown={unanswered === preview.id} onConfirm={() => void runConfirm(preview)} onEdit={leave} />
      : <PreviewCard preview={preview} busy={busy} unknown={unanswered === preview.id} onConfirm={() => void runConfirm(preview)} onEdit={leave} /> : null}</div>
    <form className="execution-builder" id="hynixOrder" aria-label="海力士组合交易参数" onSubmit={event => { event.preventDefault(); void runPreview(); }}>
      {preview && messageView ? <div className="oil-review-message">{messageView}</div> : null}
      <fieldset disabled={busy || !!preview}>
        <legend className="visually-hidden">选择组合并填写交易参数</legend>
        <div className="execution-presets oil-presets" role="group" aria-label="交易预设">
          <button type="button" aria-pressed={same} data-hynix-preset="same-exchange" onClick={() => { if (!same) set('preset', 'same-exchange'); }}>同所溢价<small>单所 · ADR 对正股 · 两腿同一账户</small></button>
          <button type="button" aria-pressed={four} data-hynix-preset="four-leg" disabled={!cross} onClick={() => { if (!four) set('preset', 'four-leg'); }}>四腿组合<small>{cross ? `${venues.length === 2 ? `${VENUE_LABEL[venues[0]!]} 与 ${VENUE_LABEL[venues[1]!]}` : '任选两所'} · ADR 对正股` : '需配置两个交易所的执行账户'}</small></button>
          <button type="button" aria-pressed={crossed} data-hynix-preset="cross-exchange" disabled={!cross} onClick={() => { if (!crossed) set('preset', 'cross-exchange'); }}>跨所同合约<small>{cross ? `${venues.length === 2 ? `${VENUE_LABEL[venues[0]!]} 对 ${VENUE_LABEL[venues[1]!]}` : '任选两所'} · 同一合约` : '需配置两个交易所的执行账户'}</small></button>
        </div>
        <div className="execution-row">
          <Choice label="交易动作" id="hynixAction" value={form.action} options={[['open', '开仓'], ['close', '平仓']]} onChange={next => set('action', next)} />
          {four ? <Choice label="跨所组合" id="hynixVenuePair" value={`${form.venue},${form.hedgeVenue}`} options={venuePairs(venues)} onChange={pair => { const [venue, hedgeVenue] = pair.split(',') as [OilVenue, OilVenue]; update({ venue, hedgeVenue }); }} />
            : <Choice label={same ? '交易所' : '首腿交易所'} id="hynixVenue" value={form.venue} options={venues.map(venue => [venue, VENUE_LABEL[venue]] as const)} onChange={next => set('venue', next)} />}
          {crossed && venues.length > 2
            ? <Choice label="对冲腿交易所" id="hynixHedgeVenue" value={form.hedgeVenue} options={venues.filter(venue => venue !== form.venue).map(venue => [venue, VENUE_LABEL[venue]] as const)} onChange={next => set('hedgeVenue', next)} /> : null}
          {!crossed
            ? <Choice label="首腿合约" id="hynixLeadSymbol" value={form.leadSymbol} options={[['SKHYUSDT', 'ADR 先下'], ['SKHYNIXUSDT', '正股先下']]} onChange={next => set('leadSymbol', next)} />
            : <Choice label="合约" id="hynixSymbol" value={form.symbol} options={[['SKHYUSDT', 'ADR'], ['SKHYNIXUSDT', '正股']]} onChange={next => set('symbol', next)} />}
        </div>
        {swapNote && crossed ? <p className="trading-footnote" id="hynixHedgeSwap" role="status">{swapNote}</p> : null}
        <div className="execution-choice execution-direction"><span aria-hidden="true">{form.action === 'open' ? '开仓方向' : '待平仓方向'}</span>
          <div className="execution-direction-options" role="group" aria-label={form.action === 'open' ? '开仓方向' : '待平仓方向'}>
            {(['short', 'long'] as const).map(side => {
              if (four) {
                const pressed = form.fourPremium === side, shown = draftHynixFourLegs(form, side);
                const ordered = [shown.slice(0, 2), shown.slice(2)].flatMap(pair => [...pair].sort((a, b) => Number(b.symbol === 'SKHYUSDT') - Number(a.symbol === 'SKHYUSDT')));
                return <button key={side} type="button" aria-pressed={pressed} data-hynix-direction={side} onClick={() => { if (!pressed) set('fourPremium', side); }}>
                  <span className="oil-direction-name">{VENUE_LABEL[form.venue]} {side === 'long' ? '做多' : '做空'}溢价 · {VENUE_LABEL[form.hedgeVenue]} {side === 'long' ? '做空' : '做多'}溢价</span>
                  {ordered.map(leg => <span key={`${leg.venue}:${leg.symbol}`} className={`execution-leg-chip ${leg.side}`}>{VENUE_LABEL[leg.venue]} {name(leg.symbol ?? '')} <b>{leg.side === 'long' ? '多' : '空'}</b></span>)}
                </button>;
              }
              const pressed = same ? form.premium === side : form.leadSide === side;
              const shown = draftHynixLegs(same ? { ...form, premium: side } : { ...form, leadSide: side });
              // Same venue: the ADR first, as the premium reads; cross venue: the first leg first.
              const ordered = same ? [...shown].sort((a, b) => Number(b.symbol === 'SKHYUSDT') - Number(a.symbol === 'SKHYUSDT')) : shown;
              return <button key={side} type="button" aria-pressed={pressed} data-hynix-direction={side} onClick={() => { if (!pressed) set(same ? 'premium' : 'leadSide', side); }}>
                {same ? <span className="oil-direction-name">{side === 'long' ? '做多溢价' : '做空溢价'}</span> : null}
                {ordered.map(leg => <span key={`${leg.venue}:${leg.symbol ?? form.symbol}`} className={`execution-leg-chip ${leg.side}`}>{VENUE_LABEL[leg.venue]} {name(leg.symbol ?? form.symbol)} <b>{leg.side === 'long' ? '多' : '空'}</b></span>)}
              </button>;
            })}
          </div></div>
        <div className="execution-row execution-sizing">
          {form.action === 'close' && !four ? <Choice label="数量方式" id="hynixSizing" value={form.sizing} options={[['notional', '等金额'], ['quantity', '按数量']]} onChange={next => set('sizing', next)} /> : null}
          {form.sizing === 'notional'
            ? <label className="execution-amount">每腿名义金额<span className="execution-input-unit"><input id="hynixNotional" type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={form.notional} placeholder="例如 1000" onChange={event => set('notional', event.target.value)} /><span aria-hidden="true">USDT</span></span></label>
            : form.action === 'close' ? <button type="button" className="button secondary" id="hynixFillHeld" onClick={fillHeld}>按当前持仓填入</button> : null}
          <p className="execution-help">{form.sizing === 'notional' ? '每腿按预览盘口中间价折算相同 USDT 名义金额，向下取整到下单步长；10 份 ADR 约对应 1 股正股。实际各腿数量以预览为准。' : '两腿各填合约数量，可以不等（按实际持仓）；对冲腿按两腿数量比例跟上首腿成交。改动交易所、合约、方向或动作后数量会清空，需重新填写。'}</p>
        </div>
        {four && !form.fourPremium ? <p className="execution-choose-direction" id="hynixChooseDirection">先选择方向，再设置各腿下单方式。</p>
        : four ? <FourLegInputs legs={draftHynixFourLegs(form, form.fourPremium || 'short')} action={form.action} leadTypes={[form.leadOrderType, form.peerLeadOrderType]} onLeadType={(venue, next) => set(venue === 0 ? 'leadOrderType' : 'peerLeadOrderType', next)} legName={name} idPrefix="hynix" hedgeNote="本所首腿成交后按市价跟上，数量按两腿计划比例；首腿挂单期间的成交也会随时跟上。" />
        : <div className="execution-leg-inputs">{legs.map((leg, index) => {
          const symbol = leg.symbol ?? form.symbol;
          return <section key={index} className="execution-leg-input" aria-label={`${index === 0 ? '首腿' : '对冲腿'} ${VENUE_LABEL[leg.venue]} ${name(symbol)} 交易参数`}>
            <header><strong>{VENUE_LABEL[leg.venue]} {name(symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(form.action, leg.side)}</span><small className="oil-leg-role">{index === 0 ? '首腿' : '对冲腿'}</small></header>
            {form.sizing === 'quantity' ? <label className="execution-amount">合约数量<input id={index === 0 ? 'hynixLeadQuantity' : 'hynixHedgeQuantity'} type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={index === 0 ? form.leadQuantity : form.hedgeQuantity} placeholder={symbol} onChange={event => set(index === 0 ? 'leadQuantity' : 'hedgeQuantity', event.target.value)} /></label> : null}
            {index === 0 ? <Choice label="下单方式" id="hynixLeadType" value={form.leadOrderType} options={LEAD_TYPES[form.venue]} onChange={next => set('leadOrderType', next)} /> : null}
            {index === 1 ? <Choice label="下单方式" id="hynixHedgeType" value={form.hedgeOrderType} options={HEDGE_TYPES[leg.venue]} onChange={next => set('hedgeOrderType', next)} /> : null}
            {index === 1 && form.hedgeOrderType === 'local-chase' ? <label className="execution-amount">对冲追价时限 · 秒<input id="hynixHedgeChaseSeconds" type="text" inputMode="numeric" autoComplete="off" maxLength={3} value={form.hedgeChaseSeconds} onChange={event => set('hedgeChaseSeconds', event.target.value)} /></label> : null}
            {index === 0 && form.leadOrderType === 'local-chase' ? <label className="execution-amount">追价界限 · USDT（选填）<input id="hynixChaseLimit" type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={form.chaseLimit} placeholder="留空用价格保护界限" onChange={event => set('chaseLimit', event.target.value)} /></label> : null}
            <p className="execution-help execution-market-note">{index === 1 ? hedgeNote(form.hedgeOrderType, form.hedgeChaseSeconds, buys(form.action, leg.side), '按两腿计划比例')
              : form.leadOrderType === 'chase' ? 'Bybit 原生追价策略，按本方一档追价，直到成交或达到最长执行时间。'
              : form.leadOrderType === 'local-chase' ? `只挂单挂在${buys(form.action, leg.side) ? '买一' : '卖一'}，盘口变化后撤单重挂，${buys(form.action, leg.side) ? '最高' : '最低'}追到界限；不吃单，到最长执行时间未成交的部分撤销。`
              : '市价：按对手盘吃单成交，受价格保护界限约束。'}</p>
          </section>;
        })}</div>}
        <details className="execution-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
          <summary><span><strong>执行参数</strong><small>最长 {form.timeoutSeconds || '?'} 秒 · 价格保护 {form.slippageBps ? `${form.slippageBps} 基点` : '默认'}{Number(form.batchCount) > 1 ? ` · 分 ${form.batchCount} 批` : ''}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="execution-settings">
            <label>最长执行 · 秒<input id="hynixTimeout" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={form.timeoutSeconds} onChange={event => set('timeoutSeconds', event.target.value)} /></label>
            <label>价格保护 · 基点（选填）<input id="hynixSlippage" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={form.slippageBps} placeholder="留空用默认值" onChange={event => set('slippageBps', event.target.value)} /></label>
            {!chased(form) ? <>
              <label>分批 · 批数<input id="hynixBatchCount" type="text" inputMode="numeric" autoComplete="off" maxLength={2} value={form.batchCount} onChange={event => set('batchCount', event.target.value)} /></label>
              <label>批次间隔 · 秒<input id="hynixBatchInterval" type="text" inputMode="numeric" autoComplete="off" maxLength={3} value={form.batchIntervalSeconds} disabled={Number(form.batchCount) <= 1} onChange={event => set('batchIntervalSeconds', event.target.value)} /></label>
            </> : null}
          </div>
          <p className="execution-help">到最长执行时间仍未完成时，停止发送并撤销余单，已成交部分保留。分批时首腿按数量步长均分，每批对冲腿按两腿计划比例跟上，首腿成交并对冲后等满间隔再发下一批；批次间隔合计须短于最长执行时间，任何一批两腿低于最小数量或最小名义金额时预览拒绝。价格保护按预览盘口计算界限：首腿超出界限的部分不成交；对冲腿市价成交时界限只在首腿发出前核对，本地追价时挂单不越过界限，超过对冲追价时限后剩余按市价补齐。</p>
        </details>
        <div className="execution-builder-footer">
          {preview ? <p>正在确认上方预览；返回修改参数后可重新填写。</p> : messageView ?? <p>预览会重新读取盘口、交易规则与持仓，不会下单。</p>}
          <button className="button primary" type="submit" id="hynixPreviewBtn" disabled={four && !form.fourPremium}>{busy && !preview ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={16} aria-hidden="true" />}预览{action}组合</button>
        </div>
      </fieldset>
    </form>
  </>;
}

export function HynixPage({ onExpired }: { onExpired: () => void }) {
  const [tracked, setTracked] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const state = useLiveResource<HynixState>(HYNIX_STATE_PATH, { intervalMs: active ? ACTIVE_MS : IDLE_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const market = useLiveResource<HynixMarket>('/api/hynix/market', { intervalMs: MARKET_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const jobs = state.data?.jobs;
  useEffect(() => { setActive(!!jobs?.some(job => ACTIVE_STATUSES.includes(job.status))); }, [jobs]);
  const refreshMs = active ? ACTIVE_MS : IDLE_MS;
  const { stale, text } = staleness(state, refreshMs);
  const rawBalance = state.data?.balance;
  const balance = useMemo(() => readBalance(rawBalance), [rawBalance]);
  const accepted = (job: OilJob): void => { setTracked(job.id); setActive(true); void state.refresh(); };
  if (state.error && statusOf(state.error) === 404) return <StatePanel kind="empty" title="本服务没有配置海力士执行" detail="海力士与原油共用执行账户：在「设置」页「从工作台导入」勾选原油执行账户（或在 config.json 写入 oil）后重启服务。" />;
  return <div className="trading-page oil-page hynix-page">
    <div className="trading-trade-top">
      <MarketPanel live={market} />
      {state.data ? <PositionsPanel state={state.data} stale={stale} kind={POSITIONS} /> : null}
    </div>
    {state.data && balance ? <BalancePanel balance={balance} stale={stale} receivedAt={state.receivedAt} onSaved={() => { void state.refresh(); }} onAccepted={accepted} /> : null}
    {!state.data ? (state.status === 'error' || state.status === 'offline'
      ? <StatePanel kind="error" title="读取海力士状态失败" detail={state.error?.message ?? '网络离线'} />
      : <StatePanel kind="loading" title="加载中…" />)
      : <section className="trading-panel execution-panel" aria-labelledby="hynix-execution-title">
        <header className="trading-panel-heading"><div><h2 id="hynix-execution-title">海力士组合交易</h2><p>同所 ADR 对正股等金额 · 跨所同一合约 · 首腿市价或追价，成交后对冲腿按比例市价或本地追价跟上</p></div>
          <button className="button secondary" type="button" onClick={() => void state.refresh()}><RefreshCw size={15} aria-hidden="true" />刷新执行状态</button></header>
        <SyncLine stale={stale} text={text} every={`每 ${refreshMs / 1000} 秒`} at={state.receivedAt} />
        <JobsSection jobs={state.data.jobs} stale={stale} tracked={tracked} onUntrack={() => setTracked(null)} onChanged={() => { void state.refresh(); }} />
        <OrderForm state={state.data} onAccepted={accepted} />
      </section>}
    {state.data ? <OilRules market="hynix" onExpired={onExpired} /> : null}
  </div>;
}
