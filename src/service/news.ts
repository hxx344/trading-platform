// EQN 快讯在服务里的接线（docs/news.md）：后台循环开着时连推送、按需轮询，停服时关掉；页面读 /api/news 与 /api/news/moves。
import { createNewsFeed, type FlashView, type MovesView, type NewsFeed, type NewsOptions } from '../news/feed.ts';

/** 后台循环开始前 feed 为 null，接口答 503。 */
export interface NewsHolder { feed: NewsFeed | null }

export interface NewsViews { flash(): FlashView | null; moves(): MovesView | null }

export function newsViews(holder: NewsHolder): NewsViews {
  return { flash: () => holder.feed?.flash() ?? null, moves: () => holder.feed?.moves() ?? null };
}

export async function newsLoop(holder: NewsHolder, options: NewsOptions, context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void> {
  if (context.stopped()) return;
  holder.feed = createNewsFeed(options);
  try { while (!context.stopped()) await context.pause(60_000); }
  finally { holder.feed.close(); }
}
