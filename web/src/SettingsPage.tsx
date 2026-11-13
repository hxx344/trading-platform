import { useState } from 'react';
import { api } from './api.ts';
import { ImportPanel } from './ImportPanel.tsx';
import { stamp } from './labels.ts';
import { useLiveResource } from './use-live-resource.ts';
import type { ServiceStatus, SummaryStatus } from './types.ts';

// Service-wide settings. Each pair's transfer and ADL settings are in the pair workspace's「配对设置」.

// Shared with the status page, so the same read options.
const STATUS_REFRESH_MS = 5_000;

function Weight({ weight }: { weight: ServiceStatus['idleWeight'] | undefined }) {
  return <section className="panel" aria-label="请求权重">
    <div className="section-head"><h2>请求权重</h2><span className="small-note">ASTER 每分钟请求上限</span></div>
    <div className="execution-live-state">
      {!weight ? <p className="muted">读取中…</p> : <p className={weight.needed > weight.available ? 'amber' : undefined} data-idle-weight>
        按当前检查间隔，配对空闲时每分钟约需请求权重 {weight.needed}，可用 {weight.available}（每分钟上限 {weight.limitPerMinute} 减去 ADL 预留 {weight.adlReserve}）。
        {weight.needed > weight.available ? '已超出：超出部分的请求会被限速器拒绝，请在配对设置里调大检查间隔。' : '改短检查间隔时，超出可用额度会被拒绝并给出能用的最短间隔。'}
      </p>}
      <p className="muted">每个配对的划转与 ADL 设置在「配对组」页下方的「配对设置」里修改。</p>
    </div>
  </section>;
}

type Message = { tone: 'ok' | 'err'; text: string } | null;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The scheduled summary card's interval (kept over config.json once saved here) and a card on demand. */
function SummarySettings({ summary, refresh }: { summary: SummaryStatus | undefined; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  if (!summary) return null;
  const value = draft ?? String(summary.intervalMinutes);
  const run = async (path: string, body: unknown, done: (status: SummaryStatus) => string, saved: boolean) => {
    setBusy(true); setMessage(null);
    try {
      const status = await api<SummaryStatus>(path, { body });
      if (saved) setDraft(null);
      setMessage({ tone: 'ok', text: done(status) });
    } catch (error) { setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); void refresh(); }
  };
  const save = () => {
    const minutes = Number(value.trim());
    if (!/^\d{1,4}$/.test(value.trim()) || minutes > 1440) { setMessage({ tone: 'err', text: '间隔须为 0–1440 的整数分钟（0 关闭）' }); return; }
    void run('/api/summary/interval', { intervalMinutes: minutes }, status => status.enabled ? `已保存：每 ${status.intervalMinutes} 分钟一张，下一张约 ${stamp(status.nextDueAt)}` : status.intervalMinutes === 0 ? '已保存：定时运行摘要已关闭' : `已保存：每 ${status.intervalMinutes} 分钟；未配置飞书机器人，暂不发送`, true);
  };
  const robot = summary.robot === 'scheduled' ? '定时机器人' : summary.robot === 'event' ? '告警机器人' : null;
  return <section className="panel" aria-label="飞书定时运行摘要">
    <div className="section-head"><h2>飞书定时运行摘要</h2><span className="small-note">{robot ? `发往${robot}` : '未配置飞书机器人'}</span></div>
    <div className="execution-live-state"><form className="pair-settings-form form-stack" data-summary-form onSubmit={event => { event.preventDefault(); if (!busy) save(); }}>
      <fieldset className="settings-form-grid">
        <legend>发送间隔</legend>
        <label htmlFor="summary-interval">
          间隔 <span>分钟</span>
          <input id="summary-interval" data-slot="input" type="text" inputMode="numeric" value={value} disabled={busy} data-summary-interval
            onChange={event => { setDraft(event.target.value); setMessage(null); }} />
          <small>1–1440 分钟，0 关闭；{summary.fromPage ? '当前为页面设置' : `当前沿用 config.json（${summary.configIntervalMinutes} 分钟）`}，保存后以页面为准</small>
        </label>
        <p className="muted">保存后下一张在一个间隔之后发出；「立即发送一张」在几秒内发出（服务刚启动约 2 分钟内会等持仓与余额读到再发），之后按间隔继续。</p>
      </fieldset>
      {message?.tone === 'err' ? <p className="message message-error" role="alert" data-summary-message>{message.text}</p> : null}
      <div className="form-actions">
        <button type="submit" className="button primary" data-slot="button" data-summary-save disabled={busy || draft === null}>保存间隔</button>
        <button type="button" className="button secondary" data-slot="button" data-summary-send disabled={busy || !summary.enabled}
          title={summary.enabled ? undefined : '未配置机器人或已关闭'} onClick={() => void run('/api/summary/send', {}, status => `已排队，约 ${stamp(status.nextDueAt)} 发出；结果见「运行状态」或「日志」`, false)}>立即发送一张</button>
        {draft !== null ? <button type="button" className="button secondary" data-slot="button" disabled={busy} onClick={() => { setDraft(null); setMessage(null); }}>撤销修改</button> : null}
        {message?.tone === 'ok' ? <span className="mint" role="status" data-summary-message>{message.text}</span> : null}
      </div>
    </form></div>
  </section>;
}

export function SettingsPage({ onChanged, onExpired }: { onChanged: () => void; onExpired: () => void }) {
  const { data, refresh } = useLiveResource<ServiceStatus>('/api/status', { intervalMs: STATUS_REFRESH_MS, onExpired });
  return <div className="feature-stack">
    <ImportPanel onImported={onChanged} />
    <SummarySettings summary={data?.summary} refresh={refresh} />
    <Weight weight={data?.idleWeight} />
  </div>;
}
