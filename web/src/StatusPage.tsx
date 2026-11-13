import { StatePanel, TableEmpty } from './StateViews.tsx';
import { ago, stamp } from './labels.ts';
import { useLiveResource } from './use-live-resource.ts';
import type { ServiceStatus } from './types.ts';

const REFRESH_MS = 5_000;
const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;
const duration = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes} 分钟` : minutes < 2880 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时`;
};

function Health({ health }: { health: ServiceStatus['health'] }) {
  const { writes } = health;
  const buckets = writes.waitBuckets.map((count, index) => `${index < writes.waitBucketsMs.length ? `<${writes.waitBucketsMs[index]}ms` : `≥${writes.waitBucketsMs.at(-1)}ms`} ${count}`).join(' · ');
  return <div className="panel-body">
    <dl className="facts">
      <dt>运行时长</dt><dd>{duration(health.now - health.startedAt)}（启动于 {stamp(health.startedAt)}）</dd>
      <dt>写者代次</dt><dd className={health.retired ? 'err' : undefined}>{health.generation}{health.retired ? '（已失去写入权，请重启）' : ''}</dd>
      <dt>数据库</dt><dd>结构版本 {health.schemaVersion} · WAL <span className={health.walBytes > health.walLimitBytes ? 'err' : undefined}>{mib(health.walBytes)}</span> / 上限 {mib(health.walLimitBytes)}</dd>
      <dt>写入事务</dt><dd>{writes.transactions} 次 · 锁忙 <span className={writes.busy ? 'err' : undefined}>{writes.busy}</span> 次 · 最长等待 {writes.maxWaitMs.toFixed(1)} ms · 最长持有 {writes.maxHoldMs.toFixed(1)} ms<br /><span className="muted">等待分布：{buckets}</span></dd>
    </dl>
    {health.loops.length ? <div className="table-wrap"><table className="data">
      <thead><tr><th>后台循环</th><th>最近成功</th><th>连续失败</th><th>最近错误</th></tr></thead>
      <tbody>{health.loops.map(loop => <tr key={loop.name}>
        <td>{loop.name}</td><td>{loop.lastOkAt ? `${stamp(loop.lastOkAt)}（${ago(loop.lastOkAt, health.now)}）` : <span className="muted">尚未成功</span>}</td>
        <td className={loop.failures ? 'err num' : 'num'}>{loop.failures}</td>
        <td>{loop.lastError ? <><span className={loop.failures ? 'err' : 'muted'}>{loop.lastError}</span><br /><span className="muted">{stamp(loop.lastErrorAt)}</span></> : '—'}</td>
      </tr>)}</tbody>
    </table></div> : <TableEmpty>没有后台循环</TableEmpty>}
  </div>;
}

function Budget({ budget, idle, now }: { budget: NonNullable<ServiceStatus['budget']>; idle: ServiceStatus['idleWeight']; now: number }) {
  const cooling = budget.coolingUntil !== null && budget.coolingUntil > now;
  return <div className="panel-body"><dl className="facts">
    <dt>本服务用量</dt><dd>近一分钟 {budget.usedLastMinute} / {budget.limitPerMinute}（其中 {budget.adlReserve} 留给 ADL）</dd>
    {idle ? <><dt>空闲用量估算</dt><dd className={idle.needed > idle.available ? 'err' : undefined}>每分钟约 {idle.needed} / 可用 {idle.available}{idle.needed > idle.available ? '（按设置页的检查间隔已超出，超出部分会被限速器拒绝）' : ''}</dd></> : null}
    <dt>出口 IP 本分钟</dt><dd>{budget.ipUsedThisMinute === null ? <span className="muted">本分钟尚无交易所报告</span> : <span className={budget.ipUsedThisMinute >= budget.ipCeiling ? 'err' : undefined}>{budget.ipUsedThisMinute}</span>}
      <span className="muted">（交易所报告，含同一 IP 上其他程序；达到 {budget.ipCeiling} 时暂停普通请求，{budget.ipCeilingAdl} 时连 ADL 也暂停）</span></dd>
    <dt>冷却</dt><dd>{cooling ? <span className="err">冷却至 {stamp(budget.coolingUntil)}{budget.reason ? `：${budget.reason}` : ''}</span> : '无'}</dd>
  </dl></div>;
}

function Streams({ streams, now }: { streams: NonNullable<ServiceStatus['streams']>; now: number }) {
  return streams.length ? <div className="table-wrap"><table className="data">
    <thead><tr><th>账户</th><th>连接</th><th>最近消息</th><th>断开次数</th><th>最近错误</th></tr></thead>
    <tbody>{streams.map((stream, index) => <tr key={index}>
      <td className="mono">{stream.account}</td>
      <td className={stream.connected ? 'ok' : 'err'}>{stream.connected ? '已连接' : '未连接'}{stream.since ? <span className="muted">（{ago(stream.since, now)}起）</span> : null}</td>
      <td>{stream.lastMessageAt ? ago(stream.lastMessageAt, now) : <span className="muted">—</span>}</td>
      <td className="num">{stream.disconnects}</td>
      <td>{stream.lastError ? <>{stream.lastError}<br /><span className="muted">{stamp(stream.lastErrorAt)}</span></> : '—'}</td>
    </tr>)}</tbody>
  </table></div> : <TableEmpty>没有推送连接</TableEmpty>;
}

function Feishu({ feishu }: { feishu: NonNullable<ServiceStatus['feishu']> }) {
  if (!feishu.configured) return <div className="panel-body"><p className="muted">未配置飞书机器人，告警只写入日志。</p></div>;
  return <>
    <div className="panel-body"><dl className="facts">
      <dt>待发送</dt><dd className={feishu.pending ? 'err' : undefined}>{feishu.pending} 条{feishu.retrying ? `，其中 ${feishu.retrying} 条发送失败待重试` : ''}{feishu.nextRetryAt ? `（下次 ${stamp(feishu.nextRetryAt)}）` : ''}</dd>
      <dt>最近成功</dt><dd>{stamp(feishu.lastSentAt)}</dd>
      <dt>最近错误</dt><dd className={feishu.lastError ? 'err' : undefined}>{feishu.lastError ?? '无'}</dd>
    </dl></div>
    {feishu.recent.length ? <div className="table-wrap"><table className="data">
      <thead><tr><th>时间</th><th>消息</th><th>状态</th></tr></thead>
      <tbody>{feishu.recent.map(row => <tr key={row.id}>
        <td>{stamp(row.createdAt)}</td><td className="outbox-text">{row.text}</td>
        <td>{row.sentAt ? <span className="ok">已发送 {stamp(row.sentAt)}</span> : <span className="err">待发送{row.attempts ? `（已失败 ${row.attempts} 次：${row.lastError ?? ''}）` : ''}</span>}</td>
      </tr>)}</tbody>
    </table></div> : <TableEmpty>保留期内没有消息</TableEmpty>}
  </>;
}

/** The service's own health: background loops, the database, the request budget, user streams and the alert outbox. */
export function StatusPage({ onExpired }: { onExpired: () => void }) {
  const { data, status, error } = useLiveResource<ServiceStatus>('/api/status', { intervalMs: REFRESH_MS, onExpired });
  if (!data) return status === 'error' || status === 'offline' ? <StatePanel kind="error" title="读取运行状态失败" detail={error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />;
  const now = data.health.now;
  return <>
    {error ? <p className="status-line err">刷新失败：{error.message}（显示的是 {stamp(now)} 的结果）</p> : null}
    <section className="panel">
      <div className="section-head"><h2>服务健康</h2></div>
      <Health health={data.health} />
    </section>
    {data.budget ? <section className="panel">
      <div className="section-head"><h2>ASTER 请求权重</h2></div>
      <Budget budget={data.budget} idle={data.idleWeight} now={now} />
    </section> : null}
    {data.streams ? <section className="panel">
      <div className="section-head"><h2>账户推送连接</h2></div>
      <p className="panel-note">推送只用来更快拿到 ADL 证据；断开时 ADL 照常按定时读取的成交历史判断，只是慢一些。</p>
      <Streams streams={data.streams} now={now} />
    </section> : null}
    {data.feishu ? <section className="panel">
      <div className="section-head"><h2>飞书告警发件箱</h2></div>
      <Feishu feishu={data.feishu} />
    </section> : null}
    {data.samples ? <p className={data.samples.available ? 'status-line' : 'status-line err'}>余额采样：{data.samples.available ? '正常（每分钟一次，保留 30 天）' : `不可用：${data.samples.error ?? '未知原因'}（不影响划转与 ADL）`}</p> : null}
  </>;
}
