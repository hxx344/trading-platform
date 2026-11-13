import { ImportPanel } from './ImportPanel.tsx';
import { useLiveResource } from './use-live-resource.ts';
import type { ServiceStatus } from './types.ts';

// Service-wide settings. Each pair's transfer and ADL settings are in the pair workspace's「配对设置」.

// Shared with the status page, so the same read options.
const STATUS_REFRESH_MS = 5_000;

function Weight({ onExpired }: { onExpired: () => void }) {
  const { data } = useLiveResource<ServiceStatus>('/api/status', { intervalMs: STATUS_REFRESH_MS, onExpired });
  const weight = data?.idleWeight;
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

export function SettingsPage({ onChanged, onExpired }: { onChanged: () => void; onExpired: () => void }) {
  return <div className="feature-stack">
    <ImportPanel onImported={onChanged} />
    <Weight onExpired={onExpired} />
  </div>;
}
