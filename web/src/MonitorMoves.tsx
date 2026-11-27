import { useDeferredValue, useState } from 'react';
import { NewsList } from './NewsList.tsx';
import { StatePanel } from './StateViews.tsx';
import { clock } from './labels.ts';
import { MOVES_PATH, NEWS_READ_TIMEOUT_MS, channelName, inChannel, matchesQuery, movesProblem, parseMoves, type MovesView } from './news.ts';
import { useLiveResource } from './use-live-resource.ts';

// 行情监控的「异动行情」页签（docs/news.md）：EQN 的价格异动、OI 价格异动、大幅波动、美股重大行情四个频道。
// 这些频道不在推送里，服务端只在有页面读取时每 15 秒用 REST 轮询，页面每 5 秒读服务端内存。
// 版式沿用本页「近期观察」的表格面板与分段按钮。

const REFRESH_MS = 5_000;

export function MovesPanel({ onExpired }: { onExpired: () => void }) {
  const live = useLiveResource<MovesView>(MOVES_PATH, { intervalMs: REFRESH_MS, timeoutMs: NEWS_READ_TIMEOUT_MS, parse: parseMoves, onExpired });
  const [channel, setChannel] = useState('all');
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const { data, status, error, receivedAt } = live;
  if (!data) return status === 'error' || status === 'offline' ? <StatePanel kind="error" title="读取异动行情失败" detail={error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />;
  const shown = data.items.filter(item => inChannel(item, channel) && matchesQuery(item, deferred));
  const problem = movesProblem(data);
  const now = receivedAt ?? Date.now();
  return <div className="moves-desk" data-moves>
    {error ? <p className="notice error" role="alert">刷新失败：{error.message}（停留在 {clock(receivedAt)}）</p> : null}
    {problem ? <p className="notice error" role="alert">{problem}</p> : null}
    <section className="table-panel">
      <div className="section-heading"><h1>异动行情</h1><span>EQN 监控频道 · 每 15 秒更新</span></div>
      <div className="moves-toolbar">
        <div className="segmented" role="group" aria-label="选择异动频道">
          {[{ key: 'all', name: '全部' }, ...data.channels].map(item => <button key={item.key} type="button" className={item.key === channel ? 'active' : ''} aria-pressed={item.key === channel} onClick={() => setChannel(item.key)}>{item.name}</button>)}
        </div>
        <input type="search" data-slot="input" value={query} onChange={event => setQuery(event.target.value)} placeholder="币种或关键词" aria-label="筛选异动" />
      </div>
      {shown.length ? <NewsList items={shown} now={now} tag={item => channelName(item, data.channels)} onCoin={setQuery} />
        : <p className="empty-table">{data.loading ? '正在读取异动行情…' : data.items.length ? '没有符合筛选的异动' : '暂无异动'}</p>}
      <p className="moves-note">内容由 eqn.news 程序监测自动生成，不是本服务的报价；以交易所实时行情为准，不构成投资建议。</p>
    </section>
  </div>;
}
