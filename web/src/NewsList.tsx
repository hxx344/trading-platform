import { stamp } from './labels.ts';
import { headline, newsTime, type NewsItem } from './news.ts';

// 快讯页与行情监控「异动行情」页签共用的列表（docs/news.md）。工作台没有快讯页面，按日志页的面板与筛选拼，
// 列表样式在 styles.css《本服务》的快讯一节，只用两处页面都有的令牌。上游文本全部按纯文本显示，链接只有 https。

export function NewsList({ items, now, tag, onCoin }: {
  items: readonly NewsItem[]; now: number;
  /** 每条前面的频道标签（异动行情用）；不给就不显示。 */
  tag?: (item: NewsItem) => string;
  /** 点币种按它筛选。 */
  onCoin?: (coin: string) => void;
}) {
  return <ol className="news-list">
    {items.map(item => <li key={item.no ?? `${item.time}:${headline(item)}`} className="news-item" data-news-item={item.no ?? ''} data-pushed={item.pushed || undefined}>
      <time className="news-time" dateTime={new Date(item.time).toISOString()} title={stamp(item.time)}>{newsTime(item.time, now)}</time>
      <div className="news-body">
        <p className="news-title">{headline(item)}</p>
        {item.zh && item.en && item.en !== item.zh ? <p className="news-en">{item.en}</p> : null}
        {item.points.length ? <ul className="news-points" aria-label="AI 摘要">{item.points.map((point, index) => <li key={index}>{point}</li>)}</ul> : null}
        {item.overview ? <details className="news-overview"><summary>AI 信息总览</summary><p>{item.overview}</p></details> : null}
        <div className="news-meta">
          {tag ? <span className="news-tag">{tag(item)}</span> : null}
          {item.source ? <span>{item.source}</span> : null}
          {item.coins.map(coin => onCoin
            ? <button key={coin} type="button" className="news-coin" aria-label={`只看 ${coin}`} onClick={() => onCoin(coin)}>{coin}</button>
            : <span key={coin} className="news-coin">{coin}</span>)}
          {item.pushed ? <span className="news-tag" title="推送先到，稍后用 REST 核对并补全">推送</span> : null}
          {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">原文</a> : null}
          {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">EQN</a> : null}
        </div>
      </div>
    </li>)}
  </ol>;
}
