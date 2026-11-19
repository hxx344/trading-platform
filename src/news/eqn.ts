// EQN 方程式新闻（https://eqn.news/api、/api-docs，2026-11-19 读取）的公开接口：免费、无需 API Key、只读。
// 推送 wss://api.eqn.news/public/ws 只发主频道（main）快讯；行情监控类频道（价格异动、OI 价格异动、大幅波动、
// 美股重大行情）不在推送里，只能读 REST。这里只做解析与校验，连接与轮询在 feed.ts。
// 上游内容一律当作不可信文本：长度截断、链接只收 https，页面按纯文本显示。

export const EQN_REST = 'https://api.eqn.news/public/v1';
export const EQN_WS = 'wss://api.eqn.news/public/ws';

/** 快讯页读的频道（推送的就是它）。 */
export const FLASH_CHANNEL = 'main';

/** 行情监控「异动行情」页签读的频道，名称取自 GET /public/v1/channels。 */
export const MOVE_CHANNELS = [
  { key: 'pricechange', name: '价格异动' },
  { key: 'oi', name: 'OI价格异动' },
  { key: 'major', name: '大幅波动' },
  { key: 'tfmoves', name: '美股重大行情' },
] as const;
export type MoveChannel = typeof MOVE_CHANNELS[number]['key'];

export interface NewsItem {
  /** EQN 的快讯编号；推送里还没取到编号时为 null。 */
  no: number | null;
  /** 发布时刻，Unix 毫秒（UTC）。 */
  time: number;
  channels: string[];
  source: string;
  zh: string | null;
  en: string | null;
  coins: string[];
  /** eqn.news 上的快讯页。 */
  url: string | null;
  /** 原公告地址。 */
  sourceUrl: string | null;
  /** 交易所公告的 AI 摘要要点（中文优先）。 */
  points: string[];
  /** AI 信息总览的第一段（中文优先）；检索中或没有时为 null。 */
  overview: string | null;
  /** 推送先到、尚未用 REST 核对的条目。 */
  pushed: boolean;
}

const TEXT_MAX = 2_000, SHORT_MAX = 120, LIST_MAX = 20, POINT_MAX = 8;

const text = (value: unknown, max = TEXT_MAX): string | null => {
  if (typeof value !== 'string') return null;
  // 去掉控制字符，保留换行。
  const clean = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, max) : null;
};
const link = (value: unknown): string | null => {
  const raw = text(value, 1_000);
  if (!raw) return null;
  try { const url = new URL(raw); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
};
const words = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.map(item => text(item, SHORT_MAX)).filter((item): item is string => item !== null))].slice(0, LIST_MAX)
  : [];

/** 快讯页地址末尾的编号（https://eqn.news/main/15970 → 15970）。 */
export function numberFromUrl(url: string | null): number | null {
  // 只认 eqn.news 自己的快讯页（https://eqn.news/main/16010）；原公告地址末尾的数字不是 EQN 编号。
  const parsed = url ? new URL(url) : null;
  const match = parsed && parsed.hostname === 'eqn.news' ? /\/(\d{1,12})\/?$/.exec(parsed.pathname) : null;
  return match ? Number(match[1]) : null;
}

function aiParts(raw: unknown): Pick<NewsItem, 'points' | 'overview'> {
  const ai = raw && typeof raw === 'object' ? raw as { summary?: { points?: unknown }; overview?: { status?: unknown; zh?: { paragraphs?: unknown }; en?: { paragraphs?: unknown } } } : null;
  const points = Array.isArray(ai?.summary?.points) ? ai.summary.points.map(point => {
    const item = point && typeof point === 'object' ? point as { zh?: unknown; en?: unknown } : {};
    return text(item.zh, 600) ?? text(item.en, 600);
  }).filter((item): item is string => item !== null).slice(0, POINT_MAX) : [];
  const first = (paragraphs: unknown) => Array.isArray(paragraphs) && paragraphs[0] && typeof paragraphs[0] === 'object' ? text((paragraphs[0] as { text?: unknown }).text, 1_200) : null;
  const overview = ai?.overview?.status === 'ready' ? first(ai.overview.zh?.paragraphs) ?? first(ai.overview.en?.paragraphs) : null;
  return { points, overview };
}

/** REST 列表里的一条；格式不对的返回 null（跳过，不影响同页其他条目）。 */
export function parseRestItem(raw: unknown): NewsItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const no = item.no, time = typeof item.time === 'string' ? Date.parse(item.time) : NaN;
  if (!Number.isSafeInteger(no) || (no as number) <= 0 || !Number.isFinite(time)) return null;
  const zh = text(item.zh), en = text(item.en);
  if (!zh && !en) return null;
  return { no: no as number, time, channels: words(item.channels), source: text(item.source, SHORT_MAX) ?? '', zh, en, coins: words(item.coins),
    url: link(item.url), sourceUrl: link(item.source_url), ...aiParts(item.ai), pushed: false };
}

/** GET /public/v1/news 的应答：条目（新的在前）。整体格式不对时抛错。 */
export function parseRestPage(raw: unknown): NewsItem[] {
  const items = raw && typeof raw === 'object' ? (raw as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) throw new Error('EQN 快讯应答格式不正确');
  return items.map(parseRestItem).filter((item): item is NewsItem => item !== null);
}

const CJK = /[㐀-鿿]/;

/** 推送的一帧（source_name、news_title、coins_included、url、timestamp 秒）；不是快讯的帧返回 null。 */
export function parsePushFrame(raw: unknown, receivedAt: number): NewsItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const frame = raw as Record<string, unknown>;
  const title = text(frame.news_title);
  if (!title) return null;
  const seconds = frame.timestamp;
  // 时间缺失或明显不对时用收到时刻。
  const time = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 1e9 && seconds * 1_000 < receivedAt + 300_000 ? Math.round(seconds * 1_000) : receivedAt;
  const url = link(frame.url);
  const zh = CJK.test(title) ? title : null;
  return { no: numberFromUrl(url), time, channels: [FLASH_CHANNEL], source: text(frame.source_name, SHORT_MAX) ?? '', zh, en: zh ? null : title,
    coins: words(frame.coins_included), url, sourceUrl: null, points: [], overview: null, pushed: true };
}

/** 新的在前；同一时刻按编号。 */
export const newestFirst = (a: NewsItem, b: NewsItem): number => b.time - a.time || (b.no ?? 0) - (a.no ?? 0);
