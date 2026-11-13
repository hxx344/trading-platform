import { Activity, Fuel, ListChecks, Scale, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { clock, label, stamp } from './labels.ts';
import { ACTIVE_STATUSES, CONFIRM_ACKNOWLEDGE, CONFIRM_NOT_CREATED, CONFIRM_RELEASE, DEFAULT_FORM, SIDE_LABEL, SYMBOL_LABEL, VENUE_LABEL, describeIntent, formToIntent, jobActions, type OilForm, type OilIntent, type OilSymbol, type OilVenue } from './oil-form.ts';
import type { OilConfirmResult, OilJob, OilMarket, OilPreview, OilState } from './oil-types.ts';
import { RequestIds } from './request-ids.ts';
import { Callout, StatePanel, TableEmpty } from './StateViews.tsx';
import { useLiveResource, type LiveResource } from './use-live-resource.ts';

// The oil page: books and spreads of the configured venues, positions, the notional caps, the order form with its
// preview and live confirmation, and the jobs. Every read goes through useLiveResource (paused in the background, the
// last result kept and marked stale on a failure); every write keeps its request id until an answer arrives.
export const OIL_STATE_PATH = '/api/oil/state';
export const OIL_READ_TIMEOUT_MS = 10_000;
const MARKET_MS = 3_000, ACTIVE_MS = 2_000, IDLE_MS = 5_000;

const JOB_STATUS: Record<string, string> = { accepted: '已受理', running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', attention: '需人工处理' };
const OP_STATE: Record<string, string> = { prepared: '已落盘', sending: '发送中', open: '交易所挂单中', unknown: '结果未知，核对中', rejected: '被拒绝', 'not-sent': '未发送', 'not-created': '确认未创建', filled: '已成交', canceled: '已撤销', confirmed: '已确认' };
const STRATEGY_STATUS: Record<string, string> = { working: '运行中', paused: '已暂停', terminal: '已结束' };
const ORDER_TYPE: Record<string, string> = { market: '市价', chase: '追价策略', limit: '限价' };
const SIDE: Record<string, string> = { long: '多', short: '空', buy: '买', sell: '卖' };
const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const short = (symbol: string): string => symbol.replace('USDT', '');

/** The same staleness rule as the overview: a failed or paused read, or a result older than two refreshes and a timeout. */
function staleness(live: Pick<LiveResource<unknown>, 'data' | 'status' | 'error' | 'receivedAt'>, refreshMs: number): { stale: boolean; text: string | null } {
  const { data, status, error, receivedAt } = live;
  const old = receivedAt !== null && Date.now() - receivedAt > 2 * refreshMs + OIL_READ_TIMEOUT_MS;
  const stale = data !== null && (status === 'error' || status === 'offline' || status === 'paused' || (status === 'loading' && (error !== null || old)));
  if (!stale) return { stale, text: null };
  const at = clock(receivedAt);
  return { stale, text: status === 'paused' ? `页面在后台，已暂停刷新（停留在 ${at}）` : status === 'offline' ? `网络离线（停留在 ${at}）` : error ? `刷新失败：${error.message}（停留在 ${at}）` : `正在刷新，下方仍是 ${at} 的结果` };
}

function Panel({ icon, title, note, children, id }: { icon: ReactNode; title: string; note?: ReactNode; children: ReactNode; id?: string }) {
  return <section className="panel" id={id}>
    <div className="panel-heading"><h2>{icon}{title}</h2>{note ? <span className="muted">{note}</span> : null}</div>
    {children}
  </section>;
}

function MarketPanel({ live }: { live: LiveResource<OilMarket> }) {
  const market = live.data;
  const { text } = staleness(live, MARKET_MS);
  if (!market) return <Panel icon={<Activity size={16} aria-hidden="true" />} title="价差与盘口"><p className="panel-note">{live.status === 'error' || live.status === 'offline' ? `读取失败：${live.error?.message ?? '网络离线'}` : '加载中…'}</p></Panel>;
  // A book older than two reads and a timeout no longer stands for the market.
  const limit = 2 * market.readEveryMs + market.timeoutMs;
  const old = (at: number | null) => at === null || market.now - at > limit;
  const spread = (value: string | null, at: number | null) => value === null ? <span className="muted">—</span> : <>{value}{old(at) ? <span className="err">（过期）</span> : null}</>;
  return <Panel id="oilMarket" icon={<Activity size={16} aria-hidden="true" />} title="价差与盘口" note={`读取于 ${clock(market.readAt)}，每 ${Math.round(market.readEveryMs / 1000)} 秒`}>
    {text ? <p className="panel-note err" role="status">{text}</p> : null}
    <div className="table-wrap"><table className="data" id="oilSpreads">
      <thead><tr><th>同所价差（BZ − CL）</th><th>卖出价差：BZ 买一 − CL 卖一</th><th>买入价差：BZ 卖一 − CL 买一</th><th>盘口时间</th></tr></thead>
      <tbody>{market.sameExchange.map(row => <tr key={row.venue}>
        <td>{label(VENUE_LABEL, row.venue)}</td><td className="num">{spread(row.sell, row.receivedAt)}</td><td className="num">{spread(row.buy, row.receivedAt)}</td><td>{clock(row.receivedAt)}</td>
      </tr>)}</tbody>
    </table></div>
    {market.crossExchange.length ? <div className="table-wrap"><table className="data" id="oilCross">
      <thead><tr><th>跨所价差</th><th>Binance 买一 − Bybit 卖一</th><th>Bybit 买一 − Binance 卖一</th><th>盘口时间</th></tr></thead>
      <tbody>{market.crossExchange.map(row => <tr key={row.symbol}>
        <td>{label(SYMBOL_LABEL, row.symbol)}</td><td className="num">{spread(row.binanceOverBybit, row.receivedAt)}</td><td className="num">{spread(row.bybitOverBinance, row.receivedAt)}</td><td>{clock(row.receivedAt)}</td>
      </tr>)}</tbody>
    </table></div> : null}
    <div className="table-wrap"><table className="data" id="oilBooks">
      <thead><tr><th>交易所</th><th>合约</th><th>买一</th><th>卖一</th><th>盘口时间</th><th>状态</th></tr></thead>
      <tbody>{market.books.map(book => {
        const failed = book.failedAt !== null && (book.receivedAt === null || book.failedAt > book.receivedAt);
        return <tr key={`${book.venue}:${book.symbol}`}>
          <td>{label(VENUE_LABEL, book.venue)}</td><td>{short(book.symbol)}</td><td className="num">{book.bid ?? '—'}</td><td className="num">{book.ask ?? '—'}</td><td>{clock(book.receivedAt)}</td>
          <td className={failed || old(book.receivedAt) ? 'err' : 'ok'}>{failed ? `读取失败：${book.error ?? '未知原因'}` : old(book.receivedAt) ? '过期' : '最新'}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </Panel>;
}

function PositionsPanel({ state, stale }: { state: OilState; stale: boolean }) {
  const view = state.positions;
  const cell = (side: Record<string, string> | null, symbol: string) => side ? side[symbol] ?? '0' : '—';
  return <Panel id="oilPositions" icon={<Scale size={16} aria-hidden="true" />} title="原油持仓" note={`读取于 ${clock(view.readAt)}，每 ${Math.round(view.readEveryMs / 1000)} 秒`}>
    {stale ? <p className="panel-note err">下方是上次读取的结果</p> : null}
    {view.accounts.length ? <div className="table-wrap"><table className="data">
      <thead><tr><th>交易所</th><th>账户</th><th>多 BZ</th><th>空 BZ</th><th>多 CL</th><th>空 CL</th><th>原油挂单</th><th>状态</th></tr></thead>
      <tbody>{view.accounts.map(account => {
        const failed = account.failedAt !== null && (account.receivedAt === null || account.failedAt > account.receivedAt);
        return <tr key={account.venue}>
          <td>{label(VENUE_LABEL, account.venue)}</td><td className="mono">{account.accountId}<br /><span className="muted">{account.accountMode}</span></td>
          <td className="num">{cell(account.long, 'BZUSDT')}</td><td className="num">{cell(account.short, 'BZUSDT')}</td>
          <td className="num">{cell(account.long, 'CLUSDT')}</td><td className="num">{cell(account.short, 'CLUSDT')}</td>
          <td className="num">{account.openOrders ?? '—'}</td>
          <td className={failed ? 'err' : 'muted'}>{failed ? `读取失败：${account.error ?? '未知原因'}${account.receivedAt ? `（显示 ${clock(account.receivedAt)} 的结果）` : ''}` : account.receivedAt ? clock(account.receivedAt) : '尚未读取'}</td>
        </tr>;
      })}</tbody>
    </table></div> : <TableEmpty>没有配置原油执行账户</TableEmpty>}
  </Panel>;
}

function LimitsBar({ limits }: { limits: OilState['notionalLimits'] }) {
  if (!limits) return null;
  return <section className="panel" id="oilLimits"><div className="panel-body oil-limits">
    <span>单笔上限 <b className="mono">{limits.perJob}</b> USDT</span>
    <span className="oil-meter">24 小时开仓 <b className="mono">{limits.openUsed}</b> / <span className="mono">{limits.openPer24h}</span> USDT
      <meter min={0} max={Number(limits.openPer24h) || 1} value={Number(limits.openUsed) || 0} aria-label="24 小时开仓已用" /></span>
    <span className="muted">最早释放：{limits.nextReleaseAt ? stamp(limits.nextReleaseAt) : '—（窗口内没有开仓）'}</span>
  </div></section>;
}

function Field({ text, children }: { text: string; children: ReactNode }) {
  return <label className="oil-field"><span>{text}</span>{children}</label>;
}

function PreviewCard({ preview, limits }: { preview: OilPreview; limits: OilState['notionalLimits'] }) {
  return <div className="oil-preview" id="oilPreview">
    <h3>{describeIntent(preview.intent)}</h3>
    <div className="table-wrap"><table className="data">
      <thead><tr><th>腿</th><th>交易所 / 合约</th><th>方向</th><th>数量</th><th>桶数</th><th>下单方式</th><th>价格保护界限</th><th>预览盘口</th><th>账户</th></tr></thead>
      <tbody>{preview.legs.map(leg => <tr key={leg.index}>
        <td>{leg.index === 0 ? '首腿' : '对冲腿'}</td>
        <td>{label(VENUE_LABEL, leg.venue)} {short(leg.symbol)}</td>
        <td>{SIDE[leg.side] ?? leg.side}（{SIDE[leg.orderSide] ?? leg.orderSide}{leg.reduceOnly ? '，只减仓' : ''}）</td>
        <td className="num">{leg.quantity}</td>
        <td className="num">{preview.barrels ?? '—'}<br /><span className="muted">每张 {leg.instrument.contractSize} 桶</span></td>
        <td>{label(ORDER_TYPE, leg.orderType)}</td>
        <td className="num">{leg.priceBound ?? '—'}</td>
        <td className="num">{leg.quote.bid} / {leg.quote.ask}</td>
        <td className="mono">{leg.accountId}</td>
      </tr>)}</tbody>
    </table></div>
    <dl className="facts">
      <dt>名义金额</dt><dd><b className="mono">{preview.notional}</b> USDT{limits ? `（单笔上限 ${limits.perJob}；${preview.intent.action === 'open' ? `24 小时开仓已用 ${limits.openUsed} / ${limits.openPer24h}` : '平仓不计入 24 小时开仓'}）` : ''}</dd>
      <dt>价格保护</dt><dd>{preview.intent.maxSlippageBps ? `${preview.intent.maxSlippageBps} 基点` : '执行器默认值'}，界限见上表</dd>
      <dt>最长执行</dt><dd>{Math.round(preview.intent.timeoutMs / 1000)} 秒</dd>
      <dt>预览有效至</dt><dd>{clock(preview.expiresAt)}</dd>
    </dl>
    {preview.notes.length ? <ul className="oil-notes">{preview.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
  </div>;
}

function OrderPanel({ state, onAccepted }: { state: OilState; onAccepted: (job: OilJob) => void }) {
  const venues = useMemo(() => state.accounts.map(account => account.venue).filter((venue): venue is OilVenue => venue === 'binance' || venue === 'bybit'), [state.accounts]);
  const [form, setForm] = useState<OilForm>(() => ({ ...DEFAULT_FORM, venue: venues[0] ?? 'binance' }));
  const [preview, setPreview] = useState<OilPreview | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = useRef(new RequestIds());
  // Bumped on every form change: a preview answered for an older form is dropped, never shown beside the new one.
  const formVersion = useRef(0);
  const changed = (): void => { formVersion.current++; setPreview(null); };
  const cross = venues.length === 2;
  // A venue that is no longer configured, or cross venue without both venues, falls back to what is possible.
  useEffect(() => {
    if (venues.length && !venues.includes(form.venue)) { setForm(current => ({ ...current, venue: venues[0]! })); changed(); }
    if (!cross && form.preset === 'cross-exchange') { setForm(current => ({ ...current, preset: 'same-exchange' })); changed(); }
  }, [venues, cross, form.venue, form.preset]);
  const set = <K extends keyof OilForm>(key: K, value: OilForm[K]) => {
    setForm(current => {
      const next = { ...current, [key]: value };
      // Chase is Bybit's alone: moving the lead to Binance takes the market order back.
      if (next.venue !== 'bybit') next.leadOrderType = 'market';
      return next;
    });
    changed();
  };
  const leadVenue = form.venue, hedgeVenue: OilVenue = form.venue === 'binance' ? 'bybit' : 'binance';

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
      const result = await ids.current.run('confirm', current.id, requestId => api<OilConfirmResult>('/api/confirm', { body: { previewId: current.id, requestId, confirmLive: true } }));
      setPreview(null);
      setMessage({ tone: 'ok', text: `${result.duplicate ? '该请求已受理过' : '已受理'}：任务 ${result.job.id.slice(0, 8)}（${label(JOB_STATUS, result.job.status)}），进度见下方任务列表` });
      onAccepted(result.job);
    } catch (error) {
      // Without an answer the job may have been accepted: the retry reuses the request id, so it cannot run twice.
      setMessage({ tone: 'err', text: statusOf(error) === undefined ? `${errorText(error)}（结果未知，可再次点击确认，沿用同一请求编号）` : errorText(error) });
    } finally { setBusy(false); }
  }

  if (!venues.length) return null;
  return <Panel id="oilOrder" icon={<Send size={16} aria-hidden="true" />} title="下单">
    <div className="panel-body">
      <div className="oil-form">
        <Field text="预设">
          <select id="oilPreset" value={form.preset} onChange={event => set('preset', event.target.value as OilForm['preset'])}>
            <option value="same-exchange">同所 BZ − CL 价差</option>
            <option value="cross-exchange" disabled={!cross}>跨所同一合约{cross ? '' : '（需配置两个交易所）'}</option>
          </select>
        </Field>
        <Field text={form.preset === 'same-exchange' ? '交易所' : '首腿交易所'}>
          <select id="oilVenue" value={form.venue} onChange={event => set('venue', event.target.value as OilVenue)}>
            {venues.map(venue => <option key={venue} value={venue}>{VENUE_LABEL[venue]}</option>)}
          </select>
        </Field>
        <Field text="开平">
          <select id="oilAction" value={form.action} onChange={event => set('action', event.target.value as OilForm['action'])}>
            <option value="open">开仓</option><option value="close">平仓</option>
          </select>
        </Field>
        {form.preset === 'same-exchange' ? <>
          <Field text="方向">
            <select id="oilSpread" value={form.spread} onChange={event => set('spread', event.target.value as OilForm['spread'])}>
              <option value="long">做多价差（多 BZ / 空 CL）</option><option value="short">做空价差（空 BZ / 多 CL）</option>
            </select>
          </Field>
          <Field text="首腿合约">
            <select id="oilLeadSymbol" value={form.leadSymbol} onChange={event => set('leadSymbol', event.target.value as OilSymbol)}>
              <option value="CLUSDT">CL 先下</option><option value="BZUSDT">BZ 先下</option>
            </select>
          </Field>
        </> : <>
          <Field text="合约">
            <select id="oilSymbol" value={form.symbol} onChange={event => set('symbol', event.target.value as OilSymbol)}>
              <option value="BZUSDT">{SYMBOL_LABEL.BZUSDT}</option><option value="CLUSDT">{SYMBOL_LABEL.CLUSDT}</option>
            </select>
          </Field>
          <Field text={`首腿方向（${VENUE_LABEL[leadVenue]}）`}>
            <select id="oilLeadSide" value={form.leadSide} onChange={event => set('leadSide', event.target.value as OilForm['leadSide'])}>
              <option value="long">多</option><option value="short">空</option>
            </select>
          </Field>
          <p className="muted oil-hint">对冲腿：{VENUE_LABEL[hedgeVenue]} {SIDE_LABEL[form.leadSide === 'long' ? 'short' : 'long']}，市价</p>
        </>}
        <Field text="每腿桶数">
          <input id="oilBarrels" inputMode="decimal" autoComplete="off" value={form.barrels} placeholder="例如 10" onChange={event => set('barrels', event.target.value)} />
        </Field>
        <Field text="首腿下单方式">
          <select id="oilLeadType" value={form.leadOrderType} onChange={event => set('leadOrderType', event.target.value as OilForm['leadOrderType'])}>
            <option value="market">市价</option><option value="chase" disabled={form.venue !== 'bybit'}>追价策略（仅 Bybit）</option>
          </select>
        </Field>
        <Field text="最长执行（秒）">
          <input id="oilTimeout" inputMode="numeric" autoComplete="off" value={form.timeoutSeconds} onChange={event => set('timeoutSeconds', event.target.value)} />
        </Field>
        <Field text="价格保护（基点）">
          <input id="oilSlippage" inputMode="numeric" autoComplete="off" value={form.slippageBps} placeholder="留空用默认值" onChange={event => set('slippageBps', event.target.value)} />
        </Field>
      </div>
      <div className="toolbar">
        <button type="button" id="oilPreviewBtn" className="button secondary" disabled={busy} onClick={() => void runPreview()}>预览</button>
        {preview ? <button type="button" id="oilConfirmBtn" className="button primary" disabled={busy} onClick={() => void runConfirm(preview)}>确认执行（实盘）</button> : null}
        {message ? <span id="oilOrderMsg" className={message.tone} role="status">{message.text}</span> : null}
      </div>
      {preview ? <PreviewCard preview={preview} limits={state.notionalLimits} /> : null}
    </div>
  </Panel>;
}

function legProgress(job: OilJob): string {
  return job.legs.map(leg => `${short(leg.symbol)} ${leg.filledBarrels}/${leg.plannedBarrels}`).join('，') + ' 桶';
}

function strategyText(leg: OilJob['legs'][number]): string {
  const op = leg.operation;
  if (!op || op.kind !== 'strategy') return '';
  return ` · 追价策略 ${op.remoteId ?? '编号未知'}${op.strategyStatus ? ` ${label(STRATEGY_STATUS, op.strategyStatus)}` : ''}${op.strategyStatus === 'terminal' && op.childrenSettled === false ? '（子单未结清）' : ''}${op.adoptedAt ? '（人工认领）' : ''}${op.releasedAt ? '（已强制释放）' : ''}`;
}

type ActionKind = 'stop' | 'acknowledge' | 'adopt' | 'notcreated' | 'release';

function JobActions({ job, busy, strategyId, onStrategyId, onAction }: { job: OilJob; busy: boolean; strategyId: string; onStrategyId: (value: string) => void; onAction: (job: OilJob, kind: ActionKind) => void }) {
  const actions = jobActions(job);
  if (!actions.stop && !actions.strategy && !actions.acknowledge) return null;
  return <div className="oil-actions">
    {actions.stop ? <button type="button" className="button secondary" data-oil-stop={job.id} disabled={busy} onClick={() => onAction(job, 'stop')}>停止</button> : null}
    {actions.strategy ? <>
      <input className="oil-strategy" data-oil-strategy={job.id} placeholder="交易所显示的策略编号" autoComplete="off" value={strategyId} onChange={event => onStrategyId(event.target.value)} />
      <button type="button" className="button secondary" data-oil-adopt={job.id} disabled={busy} onClick={() => onAction(job, 'adopt')}>认领策略</button>
      <button type="button" className="button secondary" data-oil-notcreated={job.id} disabled={busy} onClick={() => onAction(job, 'notcreated')}>确认未创建</button>
      <button type="button" className="button secondary" data-oil-release={job.id} disabled={busy} onClick={() => onAction(job, 'release')}>强制释放（策略可能已成交）</button>
    </> : null}
    {actions.acknowledge ? <button type="button" className="button secondary" data-oil-ack={job.id} disabled={busy} onClick={() => onAction(job, 'acknowledge')}>已人工处理，释放合约</button> : null}
  </div>;
}

function JobDetail({ job, actions }: { job: OilJob; actions: ReactNode }) {
  return <div className="oil-detail" id="oilJobDetail">
    <h3>任务 {job.id.slice(0, 8)} · {label(JOB_STATUS, job.status)}{job.stopRequested ? '（已请求停止）' : ''}{job.holdNewSends ? '（恢复中，不再发送新委托）' : ''}</h3>
    <dl className="facts">
      <dt>编号</dt><dd className="mono">{job.id}</dd>
      <dt>类型</dt><dd>{job.preset === 'same-exchange' ? '同所价差' : '跨所同合约'} · {job.action === 'open' ? '开仓' : '平仓'}</dd>
      <dt>时间</dt><dd>创建 {stamp(job.createdAt)}，最迟 {clock(job.deadlineAt)}{job.acknowledgedAt ? `，已人工处理 ${stamp(job.acknowledgedAt)}` : ''}</dd>
      {job.reason ? <><dt>原因</dt><dd className={job.status === 'completed' ? '' : 'err'}>{job.reason}</dd></> : null}
      <dt>合约锁</dt><dd>{job.locked ? '占用中（这两个合约暂不能再下单）' : '已释放'}</dd>
    </dl>
    <div className="table-wrap"><table className="data">
      <thead><tr><th>腿</th><th>交易所 / 合约</th><th>方向</th><th>下单方式</th><th>计划</th><th>成交</th><th>均价</th><th>界限</th><th>委托</th></tr></thead>
      <tbody>{job.legs.map((leg, index) => <tr key={index}>
        <td>{index === 0 ? '首腿' : '对冲腿'}</td>
        <td>{label(VENUE_LABEL, leg.venue)} {short(leg.symbol)}<br /><span className="muted mono">{leg.accountId}</span></td>
        <td>{SIDE[leg.side] ?? leg.side}（{SIDE[leg.orderSide] ?? leg.orderSide}）</td>
        <td>{label(ORDER_TYPE, leg.orderType)}</td>
        <td className="num">{leg.plannedQuantity}<br /><span className="muted">{leg.plannedBarrels} 桶</span></td>
        <td className="num">{leg.filledQuantity}<br /><span className="muted">{leg.filledBarrels} 桶{leg.attempts > 1 ? `，${leg.attempts} 笔` : ''}</span></td>
        <td className="num">{leg.averagePrice ?? '—'}</td>
        <td className="num">{leg.priceBound ?? '—'}</td>
        <td>{leg.operation ? `${label(OP_STATE, leg.operation.state)}${strategyText(leg)}` : '未发送'}{leg.operation?.note ? <><br /><span className="muted">{leg.operation.note}</span></> : null}</td>
      </tr>)}</tbody>
    </table></div>
    {actions}
    {job.events.length ? <details><summary className="muted">事件（{job.events.length}）</summary><ul className="oil-events">{job.events.map((event, index) => {
      const note = ['reason', 'message', 'note'].map(key => event[key]).find(value => typeof value === 'string') as string | undefined;
      return <li key={index}><span className="mono">{clock(event.at)}</span> {event.type}{note ? `：${note}` : ''}</li>;
    })}</ul></details> : null}
  </div>;
}

function JobsPanel({ state, stale, selected, onSelect, onChanged }: { state: OilState; stale: boolean; selected: string | null; onSelect: (id: string | null) => void; onChanged: () => void }) {
  const ids = useRef(new RequestIds());
  const [strategyIds, setStrategyIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ jobId: string; tone: 'ok' | 'err'; text: string } | null>(null);
  const jobs = state.jobs;
  const current = jobs.find(job => job.id === selected) ?? null;

  async function act(job: OilJob, kind: ActionKind): Promise<void> {
    const path = `/api/jobs/${job.id}/`;
    const strategyId = (strategyIds[job.id] ?? '').trim();
    if (kind === 'adopt' && !strategyId) { setMessage({ jobId: job.id, tone: 'err', text: '请先填写交易所显示的策略编号' }); return; }
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
      setMessage({ jobId: job.id, tone: 'ok', text: kind === 'stop' ? '已请求停止' : kind === 'adopt' ? '已认领策略' : kind === 'notcreated' ? '已确认未创建' : kind === 'release' ? '已强制释放' : '已释放合约' });
      onChanged();
    } catch (error) {
      setMessage({ jobId: job.id, tone: 'err', text: statusOf(error) === undefined ? `${errorText(error)}（结果未知，可再次点击，沿用同一请求编号）` : errorText(error) });
    } finally { setBusy(null); }
  }

  const actionsFor = (job: OilJob) => <>
    <JobActions job={job} busy={busy === job.id} strategyId={strategyIds[job.id] ?? ''} onStrategyId={value => setStrategyIds(currentIds => ({ ...currentIds, [job.id]: value }))} onAction={(target, kind) => void act(target, kind)} />
    {message && message.jobId === job.id ? <p className={message.tone} role="status">{message.text}</p> : null}
  </>;

  return <Panel id="oilJobs" icon={<ListChecks size={16} aria-hidden="true" />} title="任务" note={`最近 ${jobs.length} 个`}>
    {stale ? <p className="panel-note err">下方是上次读取的结果</p> : null}
    {jobs.length ? <div className="table-wrap"><table className="data" id="oilJobTable">
      <thead><tr><th>任务</th><th>类型</th><th>状态</th><th>进度</th><th>原因</th><th></th></tr></thead>
      <tbody>{jobs.map(job => <tr key={job.id} className={job.id === selected ? 'selected' : undefined}>
        <td className="mono">{job.id.slice(0, 8)}<br /><span className="muted">{clock(job.createdAt)}</span></td>
        <td>{job.preset === 'same-exchange' ? `同所 ${label(VENUE_LABEL, job.legs[0]?.venue)}` : '跨所'} · {job.action === 'open' ? '开仓' : '平仓'}</td>
        <td className={job.status === 'attention' || job.status === 'failed' ? 'err' : job.status === 'completed' ? 'ok' : ''}>{label(JOB_STATUS, job.status)}{job.stopRequested ? '（已请求停止）' : ''}</td>
        <td className="num">{legProgress(job)}</td>
        <td>{job.reason ?? ''}</td>
        <td><button type="button" className="button secondary" data-oil-job={job.id} onClick={() => onSelect(job.id === selected ? null : job.id)}>{job.id === selected ? '收起' : '详情'}</button></td>
      </tr>)}</tbody>
    </table></div> : <TableEmpty>还没有任务</TableEmpty>}
    {current ? <div className="panel-body"><JobDetail job={current} actions={actionsFor(current)} /></div> : null}
  </Panel>;
}

export function OilPage({ onExpired }: { onExpired: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const state = useLiveResource<OilState>(OIL_STATE_PATH, { intervalMs: active ? ACTIVE_MS : IDLE_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const market = useLiveResource<OilMarket>('/api/oil/market', { intervalMs: MARKET_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const jobs = state.data?.jobs;
  useEffect(() => { setActive(!!jobs?.some(job => ACTIVE_STATUSES.includes(job.status))); }, [jobs]);
  const { stale, text } = staleness(state, active ? ACTIVE_MS : IDLE_MS);
  const missing = state.error && statusOf(state.error) === 404;
  if (missing) return <StatePanel kind="empty" title="本服务没有配置原油执行" detail="在 config.json 写入 oil（或在总览「从工作台导入」勾选原油执行账户）后重启服务。" />;
  return <>
    <Callout tone="error" role="status">实盘：确认执行会在真实 Binance / Bybit 账户下单。首腿成交后对冲腿按市价跟上；任务受单笔与 24 小时开仓名义金额上限约束。同一账户请勿同时在工作台下原油单或开启原油自动规则。</Callout>
    {text ? <p className="status-line err" role="status">{text}</p> : null}
    <MarketPanel live={market} />
    {!state.data ? (state.status === 'error' || state.status === 'offline'
      ? <StatePanel kind="error" title="读取原油状态失败" detail={state.error?.message ?? '网络离线'} />
      : <StatePanel kind="loading" title="加载中…" />) : <>
      <LimitsBar limits={state.data.notionalLimits} />
      <PositionsPanel state={state.data} stale={stale} />
      <OrderPanel state={state.data} onAccepted={job => { setSelected(job.id); setActive(true); void state.refresh(); }} />
      <JobsPanel state={state.data} stale={stale} selected={selected} onSelect={setSelected} onChanged={() => { void state.refresh(); }} />
    </>}
    <p className="muted"><Fuel size={12} aria-hidden="true" /> 价差单位 USDT/桶；持仓为合约数量。</p>
  </>;
}
