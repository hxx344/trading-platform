import { ArrowRightLeft, ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { useDialogGuard } from './AppDialog.tsx';
import { clock, label } from './labels.ts';
import { ACTIVE_STATUSES, type OilSymbol, type OilVenue } from './oil-form.ts';
import { DEFAULT_GOLDOIL_FORM, GOLDOIL_LABEL, GOLDOIL_SYMBOLS, LEG_FIELDS, LEAD_TYPES, OIL_VENUES, VENUE_LABEL, HEDGE_TYPES, allowedOrderTypes, hedgeVenueFor, closeQuantities, describeGoldOilIntent, draftGoldOilLegs, goldOilFormToIntent, type GoldOilForm, type GoldOilHeld, type GoldOilIntent, type GoldOilSymbol } from './goldoil-form.ts';
import { bookTitle, crossPairs, type CrossRow, type OilBook, type OilConfirmResult, type OilJob, type OilPreview, type OilState } from './oil-types.ts';
import { ACCOUNT_MODE, ACTIVE_MS, Choice, IDLE_MS, JOB_STATUS, JobsSection, LEAVE_UNANSWERED, MARKET_MS, OIL_READ_TIMEOUT_MS, ORDER_TYPE, PositionsPanel, SyncLine, buys, confirmRefused, errorText, hedgeNote, operation, staleness, statusOf, venueName, chased, type PositionsKind } from './OilPage.tsx';
import { RequestIds } from './request-ids.ts';
import { StatePanel } from './StateViews.tsx';
import { useLiveResource, type LiveResource } from './use-live-resource.ts';
import './trading.css';

// The gold-oil page (docs/goldoil.md), laid out as the hynix page (HynixPage.tsx) without its balance panel, four legs and
// rules: the ratio and books, the gold-oil positions, then one execution panel with the jobs, the preview and the order
// form. Execution accounts, locks and the executor are oil's; no new styles, all from trading.css.
export const GOLDOIL_STATE_PATH = '/api/goldoil/state';

interface GoldOilMarket {
  now: number; readAt: number | null; readEveryMs: number; timeoutMs: number;
  books: OilBook[];
  /** One row per venue and oil contract: ratio = gold mid ÷ oil mid; sell = gold bid ÷ oil ask; buy = gold ask ÷ oil bid. */
  sameExchange: { venue: string; oilSymbol: OilSymbol; ratio: string | null; sell: string | null; buy: string | null; receivedAt: number | null }[];
  /** XAUUSDT only. */
  crossExchange: CrossRow[];
}
type GoldOilPreview = Omit<OilPreview, 'intent'> & { intent: GoldOilIntent };
/** The oil state with what the gold-oil jobs hold, netted over all of them, per venue (closeQuantities caps by it). */
type GoldOilState = OilState & { goldoilHeld: GoldOilHeld[] };

const name = (symbol: string): string => GOLDOIL_LABEL[symbol as GoldOilSymbol] ?? symbol;
const POSITIONS: PositionsKind = { name: '金油', symbols: GOLDOIL_SYMBOLS, contract: name, id: 'goldoilPositions' };
const ratioText = (value: string | null): string | null => value === null ? null : Number(value).toFixed(3);

function MarketPanel({ live }: { live: LiveResource<GoldOilMarket> }) {
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
  return <section className="trading-panel spread-panel" id="goldoilMarket" aria-labelledby="goldoil-market-title">
    <header className="trading-panel-heading"><div><h2 id="goldoil-market-title">金油比实时行情</h2><p>同所黄金对原油 · 金油比 = XAU ÷ 油价 · 卖出按 XAU 买一 ÷ 油卖一，买入按 XAU 卖一 ÷ 油买一</p></div>
      <button className="button secondary" type="button" onClick={() => void live.refresh()}><RefreshCw size={15} aria-hidden="true" />刷新行情</button></header>
    <SyncLine stale={stale || failed} text={failed ? `行情读取失败：${live.error?.message ?? '网络离线'}` : text} every={`每 ${Math.round((market?.readEveryMs ?? MARKET_MS) / 1000)} 秒`} at={market?.readAt ?? null} />
    {market ? <>
      <div className="spread-markets oil-spread-markets"><div className="execution-table-wrap"><table className="execution-progress-table spread-table" id="goldoilRatios">
        <caption>黄金 / 原油 · 同所金油比</caption>
        <thead><tr><th scope="col">交易所 · 油品</th><th scope="col">XAU 买一 / 卖一</th><th scope="col">油 买一 / 卖一</th><th scope="col">金油比<small>中间价</small></th><th scope="col">卖出比值<small>空 XAU · 多油</small></th><th scope="col">买入比值<small>多 XAU · 空油</small></th></tr></thead>
        <tbody>{market.sameExchange.map(row => <tr key={`${row.venue}:${row.oilSymbol}`}>
          <th scope="row">{venueName(row.venue)} · {name(row.oilSymbol)}</th>
          <td data-label="XAU 买一 / 卖一">{quote(book(row.venue, 'XAUUSDT'))}</td><td data-label={`${name(row.oilSymbol)} 买一 / 卖一`}>{quote(book(row.venue, row.oilSymbol))}</td>
          {cell('金油比', ratioText(row.ratio), row.receivedAt)}{cell('卖出比值', ratioText(row.sell), row.receivedAt)}{cell('买入比值', ratioText(row.buy), row.receivedAt)}
        </tr>)}</tbody>
      </table></div></div>
      {market.crossExchange.length ? <details className="spread-cross"><summary>跨所价差 · {crossPairs(market.crossExchange).map(pair => `${venueName(pair.first)} 与 ${venueName(pair.second)}`).join('、')} XAU（USDT）</summary>
        {crossPairs(market.crossExchange).map(pair => {
          const [a, b] = [venueName(pair.first), venueName(pair.second)];
          return <div key={`${pair.first}:${pair.second}`} className="spread-markets oil-spread-markets"><div className="execution-table-wrap"><table className="execution-progress-table spread-table" id={`goldoilCross-${pair.first}-${pair.second}`}>
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

function PreviewCard({ preview, busy, unknown, onConfirm, onEdit }: { preview: GoldOilPreview; busy: boolean; unknown: boolean; onConfirm: () => void; onEdit: () => void }) {
  const action = preview.intent.action === 'open' ? '开仓' : '平仓';
  const accounts = [...new Map(preview.legs.map(leg => [`${leg.venue}:${leg.accountId}`, leg])).values()];
  const expired = Date.now() > preview.expiresAt;
  const perLeg = preview.intent.legs[0].notional;
  return <section className="execution-review" id="goldoilPreview" aria-labelledby="goldoil-review-title" tabIndex={-1}>
    <div className="execution-review-title"><div><h3 id="goldoil-review-title">确认{describeGoldOilIntent(preview.intent)}</h3><p>预览有效至 {clock(preview.expiresAt)}（北京时间）</p></div><span className="execution-badge attention">实盘下单</span></div>
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
    <p className="execution-help">首腿按所选方式下单：市价时以价格保护界限为 IOC 限价；追价时界限是最高追价（卖出时为最低）。对冲腿在首腿成交后按市价或本地追价跟上，数量按两腿计划比例（对冲腿计划 × 首腿成交 ÷ 首腿计划，向下取整到步长）。油腿与原油页共用同一合约的持仓与合约锁。</p>
    {preview.notes.length ? <ul className="execution-review-notes">{preview.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
    {unknown ? <p className="execution-warning">上次确认没有收到应答，可能已受理：请先再点“确认并实盘{action}”核对（沿用同一请求编号，不会重复下单）。</p>
      : expired ? <p className="execution-warning" role="status">预览已过期，确认会被执行器拒绝；请返回修改参数后重新预览。</p> : null}
    <div className="execution-actions">
      <button className="button primary" type="button" id="goldoilConfirmBtn" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={16} aria-hidden="true" />}确认并实盘{action}</button>
      <button className="button secondary" type="button" disabled={busy} onClick={onEdit}>返回修改参数</button>
    </div>
  </section>;
}

function OrderForm({ state, onAccepted }: { state: GoldOilState; onAccepted: (job: OilJob) => void }) {
  const venues = useMemo(() => OIL_VENUES.filter(venue => state.accounts.some(account => account.venue === venue)), [state.accounts]);
  const [form, setForm] = useState<GoldOilForm>(() => ({ ...DEFAULT_GOLDOIL_FORM, venue: venues[0] ?? 'binance', hedgeVenue: hedgeVenueFor(venues, venues[0] ?? 'binance', DEFAULT_GOLDOIL_FORM.hedgeVenue) ?? DEFAULT_GOLDOIL_FORM.hedgeVenue }));
  const [preview, setPreview] = useState<GoldOilPreview | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [unanswered, setUnanswered] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  // Set when picking the hedge venue as the lead swapped the two: with two venues the hedge choice is not shown, so say it.
  const [swapNote, setSwapNote] = useState<string | null>(null);
  const ids = useRef(new RequestIds());
  const dialog = useDialogGuard();
  const busyRef = useRef(false);
  busyRef.current = busy;
  const previewRef = useRef(preview);
  previewRef.current = preview;
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
  const update = (patch: Partial<GoldOilForm>) => {
    if ('venue' in patch || 'hedgeVenue' in patch || 'preset' in patch) setSwapNote(patch.venue !== undefined && form.preset === 'cross-exchange' && patch.venue === form.hedgeVenue && patch.venue !== form.venue ? `首腿与对冲腿交易所已对调：对冲腿已改为 ${VENUE_LABEL[form.venue]}` : null);
    setForm(current => {
      const next = { ...current, ...patch };
      // Picking the hedge venue as the lead swaps the two, so a cross-venue pair stays on two venues.
      if (patch.venue !== undefined && patch.hedgeVenue === undefined && patch.venue === current.hedgeVenue) next.hedgeVenue = current.venue;
      // Each venue chases its own way, the hedge only on Binance and OKX: an order type the venue now does not offer goes back to market.
      Object.assign(next, allowedOrderTypes(next));
      // Opening is by equal notional only; closing defaults to the quantities held.
      if (patch.action && patch.action !== current.action) next.sizing = patch.action === 'open' ? 'notional' : 'quantity';
      // A native chase is never batched; its batch fields are hidden, so they must not keep a stale count.
      if (chased(next)) { next.batchCount = '1'; next.batchIntervalSeconds = '0'; }
      // Quantities belong to the legs they were typed for: a change of contract, venue, side or action clears them, so a
      // number never moves onto another contract.
      if (LEG_FIELDS.some(key => key in patch && patch[key] !== current[key])) { next.leadQuantity = ''; next.hedgeQuantity = ''; }
      return next;
    });
    changed();
  };
  const set = <K extends keyof GoldOilForm>(key: K, value: GoldOilForm[K]) => update({ [key]: value } as Partial<GoldOilForm>);
  const action = form.action === 'open' ? '开仓' : '平仓';
  const legs = draftGoldOilLegs(form);

  function fillHeld(): void {
    const held = closeQuantities(form, state.positions.accounts, state.goldoilHeld);
    if ('error' in held) { setMessage({ tone: 'err', text: held.error }); return; }
    const { left, ...quantities } = held;
    update(quantities);
    setMessage({ tone: 'muted', text: `已按持仓填入：首腿 ${held.leadQuantity || '未填'}、对冲腿 ${held.hedgeQuantity || '未填'}（持仓 ${clock(state.positions.readAt)} 读取，不超过金油任务累计持有）${left.length ? `；${left.join('；')}` : ''}；预览前请核对` });
  }

  async function runPreview(): Promise<void> {
    const built = goldOilFormToIntent(form);
    if ('error' in built) { setMessage({ tone: 'err', text: built.error }); setPreview(null); return; }
    setBusy(true); setMessage({ tone: 'muted', text: '预览中…' }); setPreview(null);
    const asked = formVersion.current;
    const stale = (): boolean => asked !== formVersion.current && (setMessage({ tone: 'muted', text: '表单在预览期间改过，请重新预览' }), true);
    try {
      const result = await api<GoldOilPreview>('/api/preview', { body: built.intent });
      if (!stale()) { setPreview(result); setMessage(null); }
    } catch (error) { if (!stale()) setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); }
  }

  async function runConfirm(current: GoldOilPreview): Promise<void> {
    if (busyRef.current) return;
    const sizes = current.legs.map(leg => `${name(leg.symbol)} ${leg.quantity}`).join('、');
    const text = `实盘执行：${describeGoldOilIntent(current.intent)}，${sizes}，名义金额约 ${current.notional} USDT，${Math.round(current.intent.timeoutMs / 1000)} 秒内完成。确定发送到交易所？`;
    if (!await dialog.confirm(text, { title: '确认实盘执行', confirmLabel: '确定发送', tone: 'danger' })) return;
    if (!dialog.isAlive() || busyRef.current || previewRef.current?.id !== current.id) return;
    busyRef.current = true; setBusy(true); setMessage({ tone: 'muted', text: '发送中…' });
    try {
      const result = await ids.current.run('confirm', current.id, requestId => api<OilConfirmResult>('/api/confirm', { body: { previewId: current.id, requestId, confirmLive: true } }), confirmRefused);
      if (!dialog.isAlive()) return;
      setPreview(null); setUnanswered(null);
      setMessage({ tone: 'ok', text: `${result.duplicate ? '该请求已受理过' : '已受理'}：任务 ${result.job.id.slice(0, 8)}（${label(JOB_STATUS, result.job.status)}），进度见上方「成交进度与结果」` });
      onAccepted(result.job);
    } catch (error) {
      if (!dialog.isAlive()) return;
      const unknown = !confirmRefused(error);
      setUnanswered(unknown ? current.id : null);
      setMessage({ tone: 'err', text: unknown ? `${errorText(error)}（结果未知，可再次点击确认，沿用同一请求编号）` : errorText(error) });
    } finally { busyRef.current = false; if (dialog.isAlive()) setBusy(false); }
  }

  async function leave(): Promise<void> {
    if (busyRef.current) return;
    const currentPreview = previewRef.current;
    if (currentPreview && unanswered === currentPreview.id) {
      if (!await dialog.confirm(LEAVE_UNANSWERED, { title: '离开确认', confirmLabel: '确定返回', tone: 'danger' })) return;
      if (!dialog.isAlive() || busyRef.current || previewRef.current?.id !== currentPreview.id) return;
    }
    changed(); setMessage(null); setUnanswered(null);
  }

  if (!venues.length) return <p className="execution-message warning" role="status">没有配置执行账户，不能下单。</p>;
  const messageView = message ? <p id="goldoilOrderMsg" className={message.tone === 'err' ? 'execution-warning' : message.tone === 'ok' ? 'oil-ok' : undefined} role="status">{message.text}</p> : null;
  const same = form.preset === 'same-exchange', crossed = form.preset === 'cross-exchange';
  const oilName = name(form.oilSymbol);
  return <>
    <div ref={reviewRef}>{preview ? <PreviewCard preview={preview} busy={busy} unknown={unanswered === preview.id} onConfirm={() => void runConfirm(preview)} onEdit={() => void leave()} /> : null}</div>
    <form className="execution-builder" id="goldoilOrder" aria-label="金油组合交易参数" onSubmit={event => { event.preventDefault(); void runPreview(); }}>
      {preview && messageView ? <div className="oil-review-message">{messageView}</div> : null}
      <fieldset disabled={busy || !!preview}>
        <legend className="visually-hidden">选择组合并填写交易参数</legend>
        <div className="execution-presets oil-presets" role="group" aria-label="交易预设">
          <button type="button" aria-pressed={same} data-goldoil-preset="same-exchange" onClick={() => { if (!same) set('preset', 'same-exchange'); }}>同所金油比<small>单所 · XAU 对 CL 或 BZ · 两腿同一账户</small></button>
          <button type="button" aria-pressed={crossed} data-goldoil-preset="cross-exchange" disabled={!cross} onClick={() => { if (!crossed) set('preset', 'cross-exchange'); }}>跨所 XAU<small>{cross ? `${venues.length === 2 ? `${VENUE_LABEL[venues[0]!]} 对 ${VENUE_LABEL[venues[1]!]}` : '任选两所'} · XAUUSDT` : '需配置两个交易所的执行账户'}</small></button>
        </div>
        <div className="execution-row">
          <Choice label="交易动作" id="goldoilAction" value={form.action} options={[['open', '开仓'], ['close', '平仓']]} onChange={next => set('action', next)} />
          <Choice label={same ? '交易所' : '首腿交易所'} id="goldoilVenue" value={form.venue} options={venues.map(venue => [venue, VENUE_LABEL[venue]] as const)} onChange={next => set('venue', next)} />
          {crossed && venues.length > 2
            ? <Choice label="对冲腿交易所" id="goldoilHedgeVenue" value={form.hedgeVenue} options={venues.filter(venue => venue !== form.venue).map(venue => [venue, VENUE_LABEL[venue]] as const)} onChange={next => set('hedgeVenue', next)} /> : null}
          {same ? <>
            <Choice label="油品" id="goldoilOilSymbol" value={form.oilSymbol} options={[['CLUSDT', 'CL（WTI）'], ['BZUSDT', 'BZ（布伦特）']]} onChange={next => set('oilSymbol', next)} />
            <Choice label="首腿合约" id="goldoilLead" value={form.lead} options={[['gold', 'XAU 先下'], ['oil', `${oilName} 先下`]]} onChange={next => set('lead', next)} />
          </> : null}
        </div>
        {same && form.lead === 'oil' ? <p className="trading-footnote" id="goldoilLeadNote">油腿在前时，XAU 对冲按比例向下取整，最多留一个 XAU 步长未对冲（Bybit 0.01 XAU、Binance 0.001 XAU）；建议 XAU 作首腿。</p> : null}
        {swapNote && crossed ? <p className="trading-footnote" id="goldoilHedgeSwap" role="status">{swapNote}</p> : null}
        <div className="execution-choice execution-direction"><span aria-hidden="true">{form.action === 'open' ? '开仓方向' : '待平仓方向'}</span>
          <div className="execution-direction-options" role="group" aria-label={form.action === 'open' ? '开仓方向' : '待平仓方向'}>
            {(['long', 'short'] as const).map(side => {
              const pressed = same ? form.ratio === side : form.leadSide === side;
              const shown = draftGoldOilLegs(same ? { ...form, ratio: side } : { ...form, leadSide: side });
              // Same venue: gold first, as the ratio reads; cross venue: the first leg first.
              const ordered = same ? [...shown].sort((a, b) => Number(b.symbol === 'XAUUSDT') - Number(a.symbol === 'XAUUSDT')) : shown;
              return <button key={side} type="button" aria-pressed={pressed} data-goldoil-direction={side} onClick={() => { if (!pressed) set(same ? 'ratio' : 'leadSide', side); }}>
                {same ? <span className="oil-direction-name">{side === 'long' ? '做多金油比' : '做空金油比'}</span> : null}
                {ordered.map(leg => <span key={`${leg.venue}:${leg.symbol ?? 'XAUUSDT'}`} className={`execution-leg-chip ${leg.side}`}>{VENUE_LABEL[leg.venue]} {name(leg.symbol ?? 'XAUUSDT')} <b>{leg.side === 'long' ? '多' : '空'}</b></span>)}
              </button>;
            })}
          </div></div>
        <div className="execution-row execution-sizing">
          {form.action === 'close' ? <Choice label="数量方式" id="goldoilSizing" value={form.sizing} options={[['notional', '等金额'], ['quantity', '按数量']]} onChange={next => set('sizing', next)} /> : null}
          {form.sizing === 'notional'
            ? <label className="execution-amount">每腿名义金额<span className="execution-input-unit"><input id="goldoilNotional" type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={form.notional} placeholder="例如 1000" onChange={event => set('notional', event.target.value)} /><span aria-hidden="true">USDT</span></span></label>
            : form.action === 'close' ? <button type="button" className="button secondary" id="goldoilFillHeld" onClick={fillHeld}>按当前持仓填入</button> : null}
          <p className="execution-help">{form.sizing === 'notional' ? '每腿按预览盘口中间价折算相同 USDT 名义金额，向下取整到下单步长；实际各腿数量以预览为准。' : '两腿各填合约数量，可以不等（按实际持仓）；对冲腿按两腿数量比例跟上首腿成交。按持仓填入取账户持仓与金油任务累计持有的较小值，账户另有的仓位（如原油页开的油腿）不填入。改动交易所、合约、方向或动作后数量会清空，需重新填写。'}</p>
        </div>
        <div className="execution-leg-inputs">{legs.map((leg, index) => {
          const symbol = leg.symbol ?? 'XAUUSDT';
          return <section key={index} className="execution-leg-input" aria-label={`${index === 0 ? '首腿' : '对冲腿'} ${VENUE_LABEL[leg.venue]} ${name(symbol)} 交易参数`}>
            <header><strong>{VENUE_LABEL[leg.venue]} {name(symbol)}</strong><span className={`execution-side ${leg.side}`}>{operation(form.action, leg.side)}</span><small className="oil-leg-role">{index === 0 ? '首腿' : '对冲腿'}</small></header>
            {form.sizing === 'quantity' ? <label className="execution-amount">合约数量<input id={index === 0 ? 'goldoilLeadQuantity' : 'goldoilHedgeQuantity'} type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={index === 0 ? form.leadQuantity : form.hedgeQuantity} placeholder={symbol} onChange={event => set(index === 0 ? 'leadQuantity' : 'hedgeQuantity', event.target.value)} /></label> : null}
            {index === 0 ? <Choice label="下单方式" id="goldoilLeadType" value={form.leadOrderType} options={LEAD_TYPES[form.venue]} onChange={next => set('leadOrderType', next)} /> : null}
            {index === 1 ? <Choice label="下单方式" id="goldoilHedgeType" value={form.hedgeOrderType} options={HEDGE_TYPES[leg.venue]} onChange={next => set('hedgeOrderType', next)} /> : null}
            {index === 1 && form.hedgeOrderType === 'local-chase' ? <label className="execution-amount">对冲追价时限 · 秒<input id="goldoilHedgeChaseSeconds" type="text" inputMode="numeric" autoComplete="off" maxLength={3} value={form.hedgeChaseSeconds} onChange={event => set('hedgeChaseSeconds', event.target.value)} /></label> : null}
            {index === 0 && form.leadOrderType === 'local-chase' ? <label className="execution-amount">追价界限 · USDT（选填）<input id="goldoilChaseLimit" type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={form.chaseLimit} placeholder="留空用价格保护界限" onChange={event => set('chaseLimit', event.target.value)} /></label> : null}
            <p className="execution-help execution-market-note">{index === 1 ? hedgeNote(form.hedgeOrderType, form.hedgeChaseSeconds, buys(form.action, leg.side), '按两腿计划比例')
              : form.leadOrderType === 'chase' ? 'Bybit 原生追价策略，按本方一档追价，直到成交或达到最长执行时间。'
              : form.leadOrderType === 'local-chase' ? `只挂单挂在${buys(form.action, leg.side) ? '买一' : '卖一'}，盘口变化后撤单重挂，${buys(form.action, leg.side) ? '最高' : '最低'}追到界限；不吃单，到最长执行时间未成交的部分撤销。`
              : '市价：按对手盘吃单成交，受价格保护界限约束。'}</p>
          </section>;
        })}</div>
        <details className="execution-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
          <summary><span><strong>执行参数</strong><small>最长 {form.timeoutSeconds || '?'} 秒 · 价格保护 {form.slippageBps ? `${form.slippageBps} 基点` : '默认'}{Number(form.batchCount) > 1 ? ` · 分 ${form.batchCount} 批` : ''}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="execution-settings">
            <label>最长执行 · 秒<input id="goldoilTimeout" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={form.timeoutSeconds} onChange={event => set('timeoutSeconds', event.target.value)} /></label>
            <label>价格保护 · 基点（选填）<input id="goldoilSlippage" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={form.slippageBps} placeholder="留空用默认值" onChange={event => set('slippageBps', event.target.value)} /></label>
            {!chased(form) ? <>
              <label>分批 · 批数<input id="goldoilBatchCount" type="text" inputMode="numeric" autoComplete="off" maxLength={2} value={form.batchCount} onChange={event => set('batchCount', event.target.value)} /></label>
              <label>批次间隔 · 秒<input id="goldoilBatchInterval" type="text" inputMode="numeric" autoComplete="off" maxLength={3} value={form.batchIntervalSeconds} disabled={Number(form.batchCount) <= 1} onChange={event => set('batchIntervalSeconds', event.target.value)} /></label>
            </> : null}
          </div>
          <p className="execution-help">到最长执行时间仍未完成时，停止发送并撤销余单，已成交部分保留。分批时首腿按数量步长均分，每批对冲腿按两腿计划比例跟上，首腿成交并对冲后等满间隔再发下一批；批次间隔合计须短于最长执行时间，任何一批两腿低于最小数量或最小名义金额时预览拒绝。价格保护按预览盘口计算界限：首腿超出界限的部分不成交；对冲腿市价成交时界限只在首腿发出前核对，本地追价时挂单不越过界限，超过对冲追价时限后剩余按市价补齐。</p>
        </details>
        <div className="execution-builder-footer">
          {preview ? <p>正在确认上方预览；返回修改参数后可重新填写。</p> : messageView ?? <p>预览会重新读取盘口、交易规则与持仓，不会下单。</p>}
          <button className="button primary" type="submit" id="goldoilPreviewBtn">{busy && !preview ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={16} aria-hidden="true" />}预览{action}组合</button>
        </div>
      </fieldset>
    </form>
  </>;
}

export function GoldOilPage({ onExpired }: { onExpired: () => void }) {
  const [tracked, setTracked] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const state = useLiveResource<GoldOilState>(GOLDOIL_STATE_PATH, { intervalMs: active ? ACTIVE_MS : IDLE_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const market = useLiveResource<GoldOilMarket>('/api/goldoil/market', { intervalMs: MARKET_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const jobs = state.data?.jobs;
  useEffect(() => { setActive(!!jobs?.some(job => ACTIVE_STATUSES.includes(job.status))); }, [jobs]);
  const refreshMs = active ? ACTIVE_MS : IDLE_MS;
  const { stale, text } = staleness(state, refreshMs);
  const accepted = (job: OilJob): void => { setTracked(job.id); setActive(true); void state.refresh(); };
  if (state.error && statusOf(state.error) === 404) return <StatePanel kind="empty" title="本服务没有配置金油执行" detail="金油与原油共用执行账户：在「设置」页「从工作台导入」勾选原油执行账户（或在 config.json 写入 oil）后重启服务。" />;
  return <div className="trading-page oil-page">
    <header className="wb-heading"><div><h1>金油双腿交易</h1><p>XAU 与原油实时比价、持仓与组合执行</p></div></header>
    <div className="trading-trade-top">
      <MarketPanel live={market} />
      {state.data ? <PositionsPanel state={state.data} stale={stale} kind={POSITIONS} /> : null}
    </div>
    {!state.data ? (state.status === 'error' || state.status === 'offline'
      ? <StatePanel kind="error" title="读取金油状态失败" detail={state.error?.message ?? '网络离线'} />
      : <StatePanel kind="loading" title="加载中…" />)
      : <section className="trading-panel execution-panel" aria-labelledby="goldoil-execution-title">
        <header className="trading-panel-heading"><div><h2 id="goldoil-execution-title">金油组合交易</h2><p>同所 XAU 对 CL 或 BZ 等金额 · 跨所 XAU · 首腿市价或追价，成交后对冲腿按比例市价或本地追价跟上</p></div>
          <button className="button secondary" type="button" onClick={() => void state.refresh()}><RefreshCw size={15} aria-hidden="true" />刷新执行状态</button></header>
        <SyncLine stale={stale} text={text} every={`每 ${refreshMs / 1000} 秒`} at={state.receivedAt} />
        <JobsSection jobs={state.data.jobs} stale={stale} tracked={tracked} onUntrack={() => setTracked(null)} onChanged={() => { void state.refresh(); }} />
        <OrderForm state={state.data} onAccepted={accepted} />
      </section>}
  </div>;
}
