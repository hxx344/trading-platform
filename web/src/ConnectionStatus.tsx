// 改编自 project-aggregation 工作台 src/ConnectionStatus.tsx（提交 52337a9）：往返耗时取自共用的 /api/host 读取（每 3 秒，
// 页面隐藏时暂停），详情里加交易服务自己的连线（行情服务、控制面、ASTER 用户推送、永续行情、副服务器心跳）。
import { useStatusDetails } from './use-status-details.ts';
import { Activity } from 'lucide-react';
import { useLiveResource } from './use-live-resource.ts';
import { HOST_PATH, HOST_REFRESH_MS, HOST_TIMEOUT_MS, QUALITY_LABELS, connectionQuality, readHost, servicesTone, type HostView } from './host-status.ts';
import { clock } from './labels.ts';

const STATE_CLASS = { ok: 'connection-good', warn: 'connection-slow', down: 'connection-unreachable', unknown: '' } as const;

export function ConnectionStatus({ onExpired }: { onExpired: () => void }) {
  const details = useStatusDetails();
  const { data, status, receivedAt } = useLiveResource<HostView>(HOST_PATH, { intervalMs: HOST_REFRESH_MS, timeoutMs: HOST_TIMEOUT_MS, read: readHost, onExpired });
  const quality = connectionQuality(status, data?.latencyMs ?? null);
  const links = data?.connections ?? [];
  const tone = servicesTone(links);
  const label = QUALITY_LABELS[quality];
  const linkSummary = tone === 'alert' ? '，有连线断开' : tone === 'warn' ? '，有连线异常' : '';
  return <details name="shell-status" ref={details} className={`connection-status connection-${quality}${tone ? ` links-${tone}` : ''}`}>
    <summary aria-label={`本机到服务器：${label}${data && quality !== 'unreachable' ? `，${data.latencyMs} 毫秒` : ''}${linkSummary}`}>
      <Activity size={15} aria-hidden="true" /><span className="connection-label">本机 → 服务器</span>
      <span role="status">{label}</span>{data && quality !== 'unreachable' && quality !== 'offline' ? <span className="connection-latency">{data.latencyMs} ms</span> : null}
      {tone ? <span className={`connection-links ${tone}`} aria-hidden="true">!</span> : null}
    </summary>
    <div className="connection-details">
      <strong>本机 → 交易服务器</strong>
      <p>当前浏览器到服务器的 HTTP 往返耗时，包含网络传输和服务响应时间。</p>
      {quality === 'unreachable' ? <p className="connection-problem">本次读取失败或超过 5 秒未响应，将自动重试。</p> : quality === 'offline' ? <p className="connection-problem">浏览器报告本机离线，网络恢复后自动重测。</p> : null}
      <p>良好 ≤150 ms · 一般 ≤500 ms · 较慢 &gt;500 ms</p>
      {links.length ? <>
        <strong className="connection-section">服务连线</strong>
        <ul className="connection-links-list">
          {links.map(item => <li key={item.id}><span className={STATE_CLASS[item.state]}>{item.label}</span>：{item.detail}</li>)}
        </ul>
      </> : null}
      <p>前台每 3 秒检测，后台暂停；返回页面时重新检测。</p>
      {receivedAt !== null ? <small>最近检测 {clock(receivedAt)}</small> : null}
    </div>
  </details>;
}
