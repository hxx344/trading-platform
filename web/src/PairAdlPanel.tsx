import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Batches, Progress, sideName } from './PairHistory.tsx';
import { RequestIds } from './request-ids.ts';
import { ADL_STATUS, DIRECTION, clock, label, seconds, stamp } from './labels.ts';
import type { AdlIncident, AdlPairView } from './types.ts';

// The pair's ADL emergency handling, laid out after the workbench's pair-adl-panel.tsx (modules/aster/dashboard,
// b2fae14): a heading with the settings button, three summary cells, the explanation, then the current incident.

// A restart keeps its request id until an answer arrives.
const requests = new RequestIds();

function Incident({ incident, onChanged }: { incident: AdlIncident; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  // A restart that took effect (the incident left halted, or its restart count moved) ends the pending request: halting
  // again later needs a new request, not a replay of the first one.
  useEffect(() => { if (incident.status !== 'halted') requests.answered(`restart:${incident.id}`); }, [incident.id, incident.status]);
  const restart = async () => {
    if (!confirm('重新开始自动减仓：重置处理时限与批次计数，重新核对现场后继续分批市价减仓。确定？')) return;
    setBusy(true);
    try {
      await requests.run(`restart:${incident.id}`, String(incident.restarts), requestId => api(`/api/adl/incidents/${encodeURIComponent(incident.id)}/restart`, { body: { requestId } }));
      onChanged();
    } catch (error) { alert(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="pair-adl-incident" data-adl-incident={incident.id}>
    <p>
      <strong>{incident.symbols.join('、') || '合约待确认'}</strong> · {label(ADL_STATUS, incident.status)} · 本轮 {incident.batchesSinceRestart} 批次 · 开始于 {stamp(incident.createdAt)}
    </p>
    <p className="muted">
      事件 {incident.id.slice(0, 8)} · 处理时长 {seconds(incident.activeMs)} 秒{incident.restarts ? ` · 已重新开始 ${incident.restarts} 次` : ''}{incident.watchUntil ? ` · 观察至 ${clock(incident.watchUntil)}` : ''}
    </p>
    {incident.reason ? <p className="amber">{incident.reason}</p> : null}
    {incident.residuals.length ? <p>残差：{incident.residuals.map(item => `${item.symbol} 多出${label(DIRECTION, item.direction)}仓 ${item.quantity}`).join('、')}</p> : null}
    {incident.status === 'halted' ? <>
      <p className="amber">自动减仓已停止，仍会核实现场；可按受阻原因处理后重新开始（所有安全检查照常）。</p>
      <div className="form-actions">
        <button type="button" className="button primary" data-slot="button" data-adl-restart={incident.id} disabled={busy} onClick={restart}>重新开始自动减仓</button>
      </div>
    </> : null}
    <p className="muted">ADL 证据</p>
    {incident.evidence.length ? incident.evidence.map((item, index) => <p key={index}>
      {sideName(item.side)} {item.symbol} {item.positionSide || ''} ADL 成交 {item.filledQuantity}{item.conflict ? <> <span className="danger">{item.conflict}</span></> : null}
    </p>) : <p>—</p>}
    <p className="muted">各合约进度</p>
    <Progress incident={incident} />
    <Batches incident={incident} />
  </div>;
}

function scanText(pair: AdlPairView): { text: string; note: string | null } {
  if (!pair.scans) return { text: '尚未开始', note: null };
  const covered = (['long', 'short'] as const).map(side => pair.scans![side].coveredUntil);
  const pending = pair.scans.long.pendingWindows + pair.scans.short.pendingWindows;
  const note = [pair.scans.long.note, pair.scans.short.note].filter(Boolean).join('；') || null;
  // Both sides have to be covered: the earlier one is how far the whole pair is checked.
  const until = covered.every(Boolean) ? Math.min(...covered as number[]) : null;
  return { text: `${until ? stamp(until) : '—'}${pending ? ` · 待查 ${pending} 段` : ''}`, note };
}

export function PairAdlPanel({ pair, onSettings, onChanged }: { pair: AdlPairView | null; onSettings: () => void; onChanged: () => void }) {
  const incident = pair?.incident ?? null;
  const scan = pair ? scanText(pair) : null;
  const status = !pair ? '配对启用后开始检测' : incident ? label(ADL_STATUS, incident.status) : pair.shared ?? '检测中，没有进行中的 ADL 事件';
  const attention = Boolean(incident || pair?.shared || scan?.note);
  return <section className="panel pair-adl-panel" aria-label="ADL 应急处理" data-adl-pair-panel={pair?.pairId}>
    <div className="section-head">
      <div>
        <h2>ADL 应急处理</h2>
        <p className={attention ? 'amber' : 'muted'} aria-live="polite">{status}</p>
      </div>
      <div className="account-controls">
        <button type="button" className="button secondary" data-slot="button" onClick={onSettings}>ADL 设置</button>
      </div>
    </div>
    {pair ? <div className="pair-adl-summary" data-adl-config={pair.pairId}>
      <div><span className="muted">已保存配置</span><strong>自动减仓{pair.config.autoReduce ? '开启' : '关闭'}</strong></div>
      <div><span className="muted">单批名义金额上限</span><strong>{pair.config.batchNotional} USDT</strong></div>
      <div><span className="muted">ADL 历史已查至</span><strong>{scan!.text}</strong></div>
    </div> : null}
    <p className="muted">
      交易所自动减仓后，两侧多空总量偏差超过较大一侧的 0.5% 时，按只减仓市价单分批减少多出的一侧，直到两侧相等后自动结束；偏差在 0.5% 内不减仓、直接完成。结果未知的减仓单不重发，有界核对后按新现场继续。
    </p>
    {pair?.shared && incident ? <p className="danger">{pair.shared}</p> : null}
    {pair && !pair.config.autoReduce ? <p className="amber">自动减仓已关闭：仍检测 ADL 并告警，等待手工处理，不下单。</p> : null}
    {scan?.note ? <p className="amber">历史扫描：{scan.note}</p> : null}
    {incident ? <Incident incident={incident} onChanged={onChanged} /> : <p className="muted">没有进行中的 ADL 事件；结束的事件见「ADL 事件记录」。</p>}
  </section>;
}
