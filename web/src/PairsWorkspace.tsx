import { CirclePause, CirclePlay } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api } from './api.ts';
import { BalanceChart } from './BalanceChart.tsx';
import { formatNumber as fmt, formatPercent } from './number-format.ts';
import { PairAccountPositions, PairTotals, positionsOf } from './PairPositions.tsx';
import { PairAdlPanel } from './PairAdlPanel.tsx';
import { AdlHistory, TransferHistory, transferText } from './PairHistory.tsx';
import { PairSettings } from './PairSettings.tsx';
import { RequestIds } from './request-ids.ts';
import { pairHref } from './route.ts';
import { StatePanel } from './StateViews.tsx';
import { ADL_STATUS, BASIS, TRANSFER_STATE, clock, label, seconds } from './labels.ts';
import type { PairView, ServiceState, Side, TransferView } from './types.ts';

// The pair workspace, laid out after the workbench's pairs-workspace.tsx (modules/aster/dashboard, b2fae14): a heading
// with the pair picker, the run status with the four balance figures, then positions and records on the left and ADL
// and margin balance on the right. The workbench's strategy execution, symbol and delete parts have no counterpart here.

// A switch keeps its requestId only while no answer arrived, so a lost response is replayed safely.
const switches = new RequestIds();
const OPEN_STATES = new Set(['prepared', 'sending', 'acknowledged', 'unknown']);

function PairSide({ side, pair }: { side: Side; pair: PairView }) {
  const name = side === 'long' ? 'A' : 'B';
  const balance = pair.balances?.[side] ?? null;
  const old = balance !== null && !pair.balancesFresh;
  return <section className="pair-kpi-side" aria-label={`${name} 账户保证金`} data-balance-side={side}>
    <div className="pair-kpi">
      <div className="pair-kpi-label">{name} · 权益 <span>USD1</span></div>
      <div className="pair-kpi-value">{fmt(balance?.equity)}{old ? <span className="stale-tag">旧</span> : null}</div>
      <div className={old || !balance ? 'pair-kpi-sub amber' : 'pair-kpi-sub'}>
        {!balance ? '等待余额检查' : old ? '余额已过期' : '余额已更新'} · {clock(balance?.receivedAt)}
      </div>
    </div>
    <div className="pair-kpi">
      <div className="pair-kpi-label">{name} · 可用 <span>USD1</span></div>
      <div className="pair-kpi-value">{fmt(balance?.available)}</div>
      <div className="pair-kpi-sub wrap">可划 {fmt(balance?.maxWithdraw)} USD1 · {side === 'long' ? '多侧' : '空侧'} {side === 'long' ? pair.long : pair.short}</div>
    </div>
  </section>;
}

function StatusPanel({ pair, onChanged }: { pair: PairView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  // Once the page shows the switch in a state, a request for that state whose answer was lost has taken effect (or is
  // moot): its id is dropped, so a later click for the same state, after switching back, is a new request and not a replay.
  useEffect(() => { switches.answered(`${pair.id}:${pair.enabled ? 1 : 0}`); }, [pair.id, pair.enabled]);
  const toggle = async (enable: boolean) => {
    setBusy(true);
    try {
      await switches.run(`${pair.id}:${enable ? 1 : 0}`, '', requestId => api(`/api/transfer-pairs/${encodeURIComponent(pair.id)}/${enable ? 'enable' : 'disable'}`, { body: { requestId }, timeoutMs: 60_000 }));
      onChanged();
    } catch (error) { alert(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const cooling = pair.cooldownUntil > Date.now();
  return <section className="panel pair-status-panel" aria-label="配对组运行状态" data-pair-row={pair.id}>
    <div className="section-head">
      <div>
        <h2><span className={`run-indicator ${pair.enabled ? 'mint' : 'muted'}`}><i />{pair.enabled ? '保证金平衡运行中' : '配对已停用'}</span></h2>
        <p className="muted">实盘 · 主账户 {pair.mainAccountId} · {pair.enabled ? '按两侧可用余额差自动划转 USD1，ADL 应急处理运行中' : '不划转，也不检测新的 ADL'}</p>
      </div>
      <div className="account-run-actions">
        <button type="button" className="button primary" data-slot="button" data-pair={pair.id} data-enable="1" disabled={busy || pair.enabled}
          title="启用后按两侧可用余额差自动划转，并开始 ADL 检测" onClick={() => void toggle(true)}><CirclePlay size={16} aria-hidden="true" />启用配对</button>
        <button type="button" className="button secondary" data-slot="button" data-pair={pair.id} data-enable="0" disabled={busy || !pair.enabled}
          title="停止新的划转与新的 ADL 检测；已发出的划转继续核对" onClick={() => void toggle(false)}><CirclePause size={16} aria-hidden="true" />停用配对</button>
      </div>
    </div>
    <div className="pair-kpis margin-only">
      <PairSide side="long" pair={pair} />
      <PairSide side="short" pair={pair} />
    </div>
    <div className="execution-live-state">
      <p className={pair.current ? 'amber' : ''} aria-live="polite">
        {pair.current ? `当前划转：${transferText(pair.current)}` : pair.enabled ? '无未结清划转' : '已停用'}
        {pair.enabled && cooling ? ` · 冷却至 ${clock(pair.cooldownUntil)}` : ''}
      </p>
      {pair.blocked ? <p className="danger">{pair.blocked}</p> : null}
      {pair.note ? <p className={pair.noteIdle ? 'muted' : 'amber'}>{pair.note}</p> : null}
      <p className="muted">
        {pair.enabled ? '停用会停止新的划转与新的 ADL 检测；已发出的划转继续按原编号核对，结果未知的不重发。'
          : '启用前请先在工作台停用并删除同一配对。启用后按两侧可用余额差自动平衡，持仓标的和方向不影响划转。'}
      </p>
    </div>
  </section>;
}

function lastTransfer(recent: TransferView[], pairId: string): TransferView | null {
  return recent.find(item => item.pairId === pairId && !OPEN_STATES.has(item.state)) ?? null;
}

function MarginPanel({ pair, recent }: { pair: PairView; recent: TransferView[] }) {
  const c = pair.config;
  const last = lastTransfer(recent, pair.id);
  const now = Date.now();
  const reserve = Number(c.longReserve) > 0 || Number(c.shortReserve) > 0;
  const checked = pair.balances ? Math.min(pair.balances.long.receivedAt, pair.balances.short.receivedAt) : null;
  return <section className="panel" aria-label="保证金平衡状态" data-margin-pair={pair.id}>
    <div className="section-head">
      <h2>保证金平衡</h2>
      <span className={`small-note ${pair.blocked ? 'amber' : ''}`}>{!pair.enabled ? '已停用' : pair.nextCheckAt ? `下次检查 ${clock(pair.nextCheckAt)}` : '运行中'}</span>
    </div>
    <div className="execution-live-state" aria-live="polite">
      {reserve ? <p>绝对保留：A 多侧 {c.longReserve} USD1 · B 空侧 {c.shortReserve} USD1；各侧转出时与权益比例保留取较大值。</p> : null}
      <p>{pair.blocked ?? (pair.note && !pair.noteIdle ? pair.note : pair.enabled ? '等待平衡检查' : '配对已停用，不划转')}</p>
      {pair.current ? <p className="amber">
        {label(TRANSFER_STATE, pair.current.state)}：{transferText(pair.current)}。
        {pair.current.state === 'unknown' ? '原请求不重发；到期后核对两侧流水自动结算。' : pair.current.state === 'acknowledged' ? '继续读取两侧余额，刷新完成前不重新划转。' : '等待交易所回执，不重新划转。'}
      </p> : null}
    </div>
    <dl className="saved-settings">
      <div>
        <dt>最后划转</dt>
        <dd>{last ? <>{transferText(last)}<small>{last.basis ? `${label(BASIS, last.basis)} · ` : ''}{clock(last.settledAt ?? last.ackAt ?? last.preparedAt)}</small></> : '最近记录里没有已结清的划转'}</dd>
      </div>
      <div>
        <dt>最近余额读取</dt>
        <dd>{clock(checked)}<small>{seconds(c.checkIntervalMs)} 秒检查 · {seconds(c.cooldownMs)} 秒冷却{pair.cooldownUntil > now ? ` · 剩余 ${Math.ceil((pair.cooldownUntil - now) / 1000)} 秒` : ''}</small></dd>
      </div>
      <div>
        <dt>触发可用余额差额 / 单次划转范围</dt>
        <dd>{c.threshold} / {c.minTransfer}–{c.maxTransfer} USD1</dd>
      </div>
      <div>
        <dt>转出侧现金保留</dt>
        <dd>正权益 × {formatPercent(c.bufferRatio)}<small>按交易所可划额度平衡 USD1 可用余额，与持仓标的无关</small></dd>
      </div>
    </dl>
  </section>;
}

/** What needs an operator on a pair. The workspace shows one pair at a time, so the others' problems are listed above
 * it: an ADL incident, a shared sub-account, a blocked or unknown transfer, or two sides out of balance. */
function attentionOf(state: ServiceState, pair: PairView): string[] {
  const adl = state.adl.pairs.find(item => item.pairId === pair.id);
  const totals = positionsOf(state.positions, pair.id)?.totals ?? [];
  return [
    adl?.incident ? `ADL ${label(ADL_STATUS, adl.incident.status)}` : null,
    adl?.shared ? '子账户共用，ADL 不自动处理' : null,
    pair.blocked ? '划转受阻' : null,
    pair.current?.state === 'unknown' ? '划转结果未知' : null,
    totals.some(row => row.balanced === false) ? '多空偏差超过 0.5%' : null,
  ].filter((item): item is string => item !== null);
}

/** A disclosure whose content mounts when it opens: the records unmount again on closing, so they are not polled while
 * hidden; `keep` leaves the content mounted after the first opening (the settings keep what was typed). */
function Disclosure({ summary, hint, children, detailsRef, className, keep = false }: { summary: string; hint?: string; children: ReactNode; detailsRef?: RefObject<HTMLDetailsElement | null>; className?: string; keep?: boolean }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return <details ref={detailsRef} className={`disclosure panel${className ? ` ${className}` : ''}`} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setOpened(true); }}>
    <summary>{summary}{hint ? <span className="disclosure-hint">{hint}</span> : null}</summary>
    {open || (keep && opened) ? children : null}
  </details>;
}

export function PairsWorkspace({ state, pairId, stale, onChanged, onExpired }: { state: ServiceState; pairId: string | null; stale: boolean; onChanged: () => void; onExpired: () => void }) {
  const { pairs, corruptPairs, recent } = state.transfers;
  const id = pairId ?? pairs[0]?.id ?? null;
  const pair = pairs.find(item => item.id === id) ?? null;
  const adl = state.adl.pairs.find(item => item.pairId === id) ?? null;
  const positions = id ? positionsOf(state.positions, id) : null;
  const settings = useRef<HTMLDetailsElement | null>(null);
  const attention = new Map(pairs.map(item => [item.id, attentionOf(state, item)]));
  const others = pairs.filter(item => item.id !== id && attention.get(item.id)!.length);
  const pick = useCallback((next: string) => { location.hash = pairHref(next); }, []);
  const openSettings = useCallback(() => {
    const details = settings.current;
    if (!details) return;
    details.open = true;
    // The form mounts after the toggle event is handled; two frames let that render land before focusing.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      details.querySelector('.pair-adl-settings')?.scrollIntoView({ block: 'nearest' });
      details.querySelector<HTMLInputElement>('[data-adl-notional]')?.focus({ preventScroll: true });
    }));
  }, []);
  return <div className="feature-stack pair-workspace">
    <div className="pair-workspace-heading">
      <div>
        <h2>两子账户配对{pair ? ` · ${pair.id}` : ''}</h2>
        <p className="muted">两子账户保证金余额平衡 · ADL 应急处理</p>
      </div>
      {pairs.length ? <div className="account-controls">
        <select data-slot="select-trigger" aria-label="选择配对组" value={id ?? ''} onChange={event => pick(event.target.value)}>
          {pair ? null : <option value={id ?? ''}>{id}（不存在）</option>}
          {pairs.map(item => <option key={item.id} value={item.id}>{item.id} · {item.enabled ? '运行中' : '已停用'}{attention.get(item.id)!.length ? ' · 需处理' : ''}</option>)}
        </select>
      </div> : null}
    </div>
    {corruptPairs.length ? <p className="message message-error" role="alert">配对记录损坏，未列出也不会划转，需人工处置：{corruptPairs.join('，')}</p> : null}
    {others.length ? <p className="message message-error" role="alert" data-pairs-attention>
      其他配对需要处理：{others.map((item, index) => <span key={item.id}>{index ? '；' : ''}<a href={pairHref(item.id)}>{item.id}</a>（{attention.get(item.id)!.join('、')}）</span>)}
    </p> : null}
    {stale ? <p className="message" role="status">页面数据未能刷新，下面的数字停留在上次读取，不代表当前。</p> : null}
    {!pairs.length ? <StatePanel kind="empty" title="还没有配对" detail={<>在「<a href="#/settings">设置</a>」页从工作台导入配对后，这里显示每个配对的余额、持仓与 ADL 处理。</>} />
      : !pair || !id ? <StatePanel kind="empty" title="没有这个配对" detail="它可能已被删除；从右上角选择一个配对。" /> : <>
        <StatusPanel pair={pair} onChanged={onChanged} />
        <div className="pair-layout">
          <div className="pair-main">
            <PairAccountPositions side="long" view={positions?.long ?? null} refreshMs={state.positions.refreshMs} maxAgeMs={state.positions.maxAgeMs} stale={stale} />
            <PairAccountPositions side="short" view={positions?.short ?? null} refreshMs={state.positions.refreshMs} maxAgeMs={state.positions.maxAgeMs} stale={stale} />
            <PairTotals pair={positions} />
            {!state.positions.available ? <p className="small-note amber">持仓读取不可用</p> : null}
            <section className="panel" aria-label="两侧可用余额走势">
              <div className="section-head"><h2>两侧可用余额走势</h2><span className="small-note">每分钟采样，保留 30 天</span></div>
              <BalanceChart key={id} pairId={id} onExpired={onExpired} />
            </section>
            <div className="pair-discs">
              <Disclosure key={`transfers:${id}`} summary="划转记录" hint="结算依据 · 流水核对"><TransferHistory pairId={id} onExpired={onExpired} /></Disclosure>
              <Disclosure key={`adl:${id}`} summary="ADL 事件记录" hint="进度 · 减仓批次"><AdlHistory pairId={id} onExpired={onExpired} /></Disclosure>
              <Disclosure key={`settings:${id}`} detailsRef={settings} className="settings-panel pair-config" keep summary="配对设置" hint="ADL · 保证金平衡">
                <PairSettings pair={pair} adl={adl} stale={stale} onChanged={onChanged} />
              </Disclosure>
            </div>
          </div>
          <div className="pair-aside">
            <PairAdlPanel pair={adl} onSettings={openSettings} onChanged={onChanged} />
            <MarginPanel pair={pair} recent={recent} />
          </div>
        </div>
      </>}
  </div>;
}
