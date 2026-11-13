import { useState } from 'react';
import { More } from './PairHistory.tsx';
import { StatePanel, TableEmpty } from './StateViews.tsx';
import { stamp } from './labels.ts';
import { isUnreadable, usePagedHistory, type HistoryRow } from './paged-history.ts';
import type { LogLine } from './types.ts';

// The service's log lines (what systemd's journal has for this service), read from /api/logs. The workbench has no log
// page; this one is put together from the status page's parts: panel, segmented buttons, data table, paged history.

const PAGE = 100, REFRESH_MS = 5_000;
const FILTERS = [['all', '全部'], ['problems', '告警与问题']] as const;
type Filter = typeof FILTERS[number][0];
const LEVEL: Record<LogLine['level'], { text: string; className: string }> = {
  alert: { text: '告警', className: 'amber' }, problem: { text: '问题', className: 'err' }, info: { text: '信息', className: 'muted' },
};
const lineAt = (row: HistoryRow<LogLine>) => (isUnreadable(row) ? 0 : row.at);

export function LogsPage({ onExpired }: { onExpired: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const { live, rows, more, loadMore, loading, error } = usePagedHistory<LogLine>(filter === 'all' ? '/api/logs' : '/api/logs/problems', { limit: PAGE, intervalMs: REFRESH_MS, at: lineAt, onExpired });
  // Lines are numbered in the order written; newest first, also when two share a millisecond.
  const sorted = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
  return <section className="panel" aria-label="服务日志" data-logs>
    <div className="section-head">
      <h2>服务日志</h2>
      <div className="account-controls" role="group" aria-label="筛选">
        {FILTERS.map(([key, text]) => <button key={key} type="button" className={`button ${key === filter ? 'primary' : 'secondary'}`} data-slot="button" aria-pressed={key === filter} data-log-filter={key} onClick={() => setFilter(key)}>{text}</button>)}
      </div>
    </div>
    <p className="panel-note">与服务器上 <code>journalctl -u trading-platform</code> 的内容相同，保留 14 天、最多 5 万行；最新一页每 5 秒刷新，更早的按需读取。</p>
    {live.error && (live.data || rows.length) ? <p className="panel-note err">刷新失败：{live.error.message}（显示的是上次结果）</p> : null}
    {!live.data && !rows.length
      ? live.status === 'error' || live.status === 'offline' ? <StatePanel kind="error" title="读取日志失败" detail={live.error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />
      : sorted.length ? <div className="table-wrap"><table className="data log-table">
        <thead><tr><th>时间</th><th>级别</th><th>内容</th></tr></thead>
        <tbody>{sorted.map(row => isUnreadable(row) ? null : <tr key={row.id} data-log-level={row.level}>
          <td className="num">{stamp(row.at)}</td>
          <td className={LEVEL[row.level].className}>{LEVEL[row.level].text}</td>
          <td className="log-text">{row.text}</td>
        </tr>)}</tbody>
      </table></div> : <TableEmpty>{filter === 'all' ? '保留期内没有日志' : '保留期内没有告警与问题'}</TableEmpty>}
    <More more={more} loading={loading} error={error} onMore={() => void loadMore()} />
  </section>;
}
