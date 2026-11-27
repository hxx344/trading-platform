import { useDeferredValue, useState } from 'react';
import { NewsList } from './NewsList.tsx';
import { StatePanel, TableEmpty } from './StateViews.tsx';
import { clock } from './labels.ts';
import { NEWS_PATH, NEWS_READ_TIMEOUT_MS, connectionText, matchesQuery, parseFlash, restProblem, type FlashView } from './news.ts';
import { useLiveResource } from './use-live-resource.ts';

// 快讯页（#/news，docs/news.md）：EQN 主频道快讯。服务端常驻推送连接，页面每 2 秒读一次服务端内存，推送到达后
// 最迟 2 秒出现在页面上。工作台没有对应页面，按日志页的面板、筛选与提示拼。

const REFRESH_MS = 2_000;

export function NewsPage({ onExpired }: { onExpired: () => void }) {
  const live = useLiveResource<FlashView>(NEWS_PATH, { intervalMs: REFRESH_MS, timeoutMs: NEWS_READ_TIMEOUT_MS, parse: parseFlash, onExpired });
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const { data, status, error, receivedAt } = live;
  const now = receivedAt ?? Date.now();
  const connection = data ? connectionText(data, now) : null;
  const shown = data ? data.items.filter(item => matchesQuery(item, deferred)) : [];
  const problem = data ? restProblem(data) : null;
  return <section className="panel" aria-label="EQN 快讯" data-news>
    <div className="section-head">
      <h1>EQN 快讯</h1>
      {connection ? <span className={`connection ${connection.tone === 'ok' ? 'mint' : connection.tone === 'warn' ? 'amber' : ''}`} data-news-connection={data!.connection.state}><i />{connection.text}</span> : null}
    </div>
    <p className="panel-note">eqn.news 方程式新闻主频道：上新、公告与要闻。内容由程序抓取和翻译，AI 摘要由 AI 生成，仅供参考，不构成投资建议。这里显示最近 100 条，服务重启后补回最新 50 条。</p>
    {error && data ? <p className="panel-note err">刷新失败：{error.message}（停留在 {clock(receivedAt)}）</p> : null}
    {problem ? <p className="panel-note err">{problem}</p> : null}
    {!data
      ? status === 'error' || status === 'offline' ? <StatePanel kind="error" title="读取快讯失败" detail={error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />
      : <>
        <div className="news-toolbar">
          <input type="search" data-slot="input" value={query} onChange={event => setQuery(event.target.value)} placeholder="币种或关键词，如 BTC 上线" aria-label="筛选快讯" />
          {query ? <button type="button" className="button secondary" data-slot="button" onClick={() => setQuery('')}>清除</button> : null}
          <span className="muted">{query ? `${shown.length} / ${data.items.length} 条` : `${data.items.length} 条`}</span>
        </div>
        {shown.length ? <NewsList items={shown} now={now} onCoin={setQuery} />
          : <TableEmpty>{data.items.length ? '没有符合筛选的快讯' : data.rest.at === null ? '正在读取最新快讯…' : '暂无快讯'}</TableEmpty>}
      </>}
  </section>;
}
