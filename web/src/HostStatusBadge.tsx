// 改编自 project-aggregation 工作台 src/HostStatusBadge.tsx（提交 52337a9）：读取换成共用的 /api/host 订阅（每 3 秒，
// 页面隐藏时暂停），详情里加本服务进程的内存与事件循环延迟，「查看详情」改为打开运行状态页。
import { useRef } from 'react';
import { Server } from 'lucide-react';
import { useLiveResource } from './use-live-resource.ts';
import { HOST_PATH, HOST_REFRESH_MS, HOST_TIMEOUT_MS, formatBytes, formatUptime, hostLevel, hostWorst, pct, readHost, type HostView } from './host-status.ts';
import { clock } from './labels.ts';

export function HostStatusBadge({ onExpired }: { onExpired: () => void }) {
  const { data: status, status: readState } = useLiveResource<HostView>(HOST_PATH, { intervalMs: HOST_REFRESH_MS, timeoutMs: HOST_TIMEOUT_MS, read: readHost, onExpired });
  const details = useRef<HTMLDetailsElement>(null);
  const failed = readState === 'error';
  const { cpu, memory, disk, worst } = hostWorst(status);
  const tone = failed && !status ? 'alert' : hostLevel(worst);
  const label = status ? `服务器负载：CPU ${pct(cpu)}，内存 ${pct(memory)}，磁盘 ${pct(disk)}${failed ? '，最近一次读取失败' : ''}` : failed ? '服务器负载：读取失败' : '服务器负载：读取中';
  const loop = status?.process.loopDelayMs;
  return <details ref={details} className={`connection-status host-status ${tone}`}>
    <summary aria-label={label}>
      <Server size={15} aria-hidden="true" />
      {status ? <>
        <span className={`host-metric ${hostLevel(cpu)}`}><span className="host-key">CPU</span>{pct(cpu)}</span>
        <span className={`host-metric ${hostLevel(memory)}`}><span className="host-key">内存</span>{pct(memory)}</span>
        <span className={`host-metric ${hostLevel(disk)}`}><span className="host-key">磁盘</span>{pct(disk)}</span>
        <span className={`host-worst ${tone}`}>{pct(worst)}</span>
      </> : <span>{failed ? '读取失败' : '读取中'}</span>}
    </summary>
    <div className="connection-details">
      <strong>服务器状态</strong>
      {status ? <>
        <p>CPU {pct(cpu)} · {status.cpu.cores} 核 · 负载 {status.cpu.loadAverage.map(value => value.toFixed(2)).join(' / ')}</p>
        <p>内存 {formatBytes(status.memory.usedBytes)} / {formatBytes(status.memory.totalBytes)}，可用 {formatBytes(status.memory.availableBytes)}{status.memory.swap && status.memory.swap.totalBytes > 0 ? `；交换区已用 ${pct(status.memory.swap.usedPercent)}` : ''}</p>
        {status.disks.map(item => <p key={item.id}>{item.label}：{item.error ? item.error : `剩余 ${formatBytes(item.availableBytes)} / ${formatBytes(item.totalBytes)}（已用 ${pct(item.usedPercent)}）`}</p>)}
        <p>交易服务进程：内存 {formatBytes(status.process.rssBytes)}{loop ? ` · 事件循环延迟 平均 ${loop.mean} ms，p99 ${loop.p99} ms，最大 ${loop.max} ms` : ''} · 已运行 {formatUptime(status.process.uptimeSeconds)}</p>
        <p>服务器已运行 {formatUptime(status.uptimeSeconds)}</p>
      </> : null}
      {failed ? <p className="connection-problem">最近一次读取失败，{status ? '显示的是上次读到的数据，' : ''}将自动重试。</p> : null}
      <p>占用 ≥75% 显示黄色，≥90% 显示红色；前台每 3 秒更新，后台暂停。</p>
      <a className="host-open" href="#/status" onClick={() => { if (details.current) details.current.open = false; }}>查看运行状态</a>
      {status ? <small>读取于 {clock(status.generatedAt)}</small> : null}
    </div>
  </details>;
}
