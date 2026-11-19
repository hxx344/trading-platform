// EQN 快讯与异动行情（docs/news.md）的页面数据：应答校验、筛选与状态文案。不依赖 DOM，服务端测试可直接引用。
// 上游内容由服务端截断并只保留 https 链接；这里再校验一次，页面只当纯文本显示。

export const NEWS_PATH = '/api/news';
export const MOVES_PATH = '/api/news/moves';
export const NEWS_READ_TIMEOUT_MS = 10_000;

export type NewsItem = {
  no: number | null; time: number; channels: string[]; source: string; zh: string | null; en: string | null; coins: string[];
  url: string | null; sourceUrl: string | null; points: string[]; overview: string | null; pushed: boolean;
};
export type ConnectionState = 'connecting' | 'open' | 'retrying' | 'closed';
export type FlashView = {
  connection: { state: ConnectionState; since: number; lastPushAt: number | null; closeCode: number | null; reconnects: number };
  rest: { at: number | null; error: string | null };
  items: NewsItem[];
};
export type MoveChannelView = { key: string; name: string; at: number | null; error: string | null };
export type MovesView = { channels: MoveChannelView[]; loading: boolean; items: NewsItem[] };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const optText = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const optTime = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const https = (value: unknown): string | null => typeof value === 'string' && value.startsWith('https://') ? value : null;

function parseItem(raw: unknown): NewsItem | null {
  if (!isObject(raw) || optTime(raw.time) === null) return null;
  const zh = optText(raw.zh), en = optText(raw.en);
  if (!zh && !en) return null;
  return {
    no: typeof raw.no === 'number' && Number.isSafeInteger(raw.no) ? raw.no : null, time: raw.time as number, channels: strings(raw.channels),
    source: optText(raw.source) ?? '', zh, en, coins: strings(raw.coins), url: https(raw.url), sourceUrl: https(raw.sourceUrl),
    points: strings(raw.points), overview: optText(raw.overview), pushed: raw.pushed === true,
  };
}
const items = (raw: unknown): NewsItem[] => {
  if (!Array.isArray(raw)) throw new Error('快讯应答格式不正确');
  return raw.map(parseItem).filter((item): item is NewsItem => item !== null);
};

const STATES: readonly ConnectionState[] = ['connecting', 'open', 'retrying', 'closed'];
export function parseFlash(raw: unknown): FlashView {
  if (!isObject(raw) || !isObject(raw.connection) || !isObject(raw.rest)) throw new Error('快讯应答格式不正确');
  const { connection, rest } = raw;
  const state = STATES.find(item => item === connection.state);
  if (!state || optTime(connection.since) === null) throw new Error('快讯应答格式不正确');
  return {
    connection: { state, since: connection.since as number, lastPushAt: optTime(connection.lastPushAt), closeCode: optTime(connection.closeCode), reconnects: optTime(connection.reconnects) ?? 0 },
    rest: { at: optTime(rest.at), error: optText(rest.error) },
    items: items(raw.items),
  };
}

export function parseMoves(raw: unknown): MovesView {
  if (!isObject(raw) || !Array.isArray(raw.channels)) throw new Error('异动行情应答格式不正确');
  const channels = raw.channels.filter(isObject).map(channel => ({ key: String(channel.key ?? ''), name: String(channel.name ?? ''), at: optTime(channel.at), error: optText(channel.error) })).filter(channel => channel.key && channel.name);
  return { channels, loading: raw.loading === true, items: items(raw.items) };
}

/** 标题：中文优先。 */
export const headline = (item: NewsItem): string => item.zh ?? item.en ?? '';

/**
 * 关键词筛选：空格分隔的每个词都要命中。全是字母数字的词先按币种精确匹配（BTC 不会命中 BTCDOM），
 * 不是币种时再在标题、英文、来源里找（不分大小写）。
 */
export function matchesQuery(item: NewsItem, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const coins = new Set(item.coins.map(coin => coin.toLowerCase()));
  const text = [item.zh, item.en, item.source].filter(Boolean).join('\n').toLowerCase();
  return words.every(word => coins.has(word) || text.includes(word));
}

export const inChannel = (item: NewsItem, channel: string): boolean => channel === 'all' || item.channels.includes(channel);

/** 一条异动属于哪个频道（按页签顺序取第一个）。 */
export function channelName(item: NewsItem, channels: readonly MoveChannelView[]): string {
  return channels.find(channel => item.channels.includes(channel.key))?.name ?? item.channels[0] ?? '';
}

const pad = (value: number) => String(value).padStart(2, '0');
/** 今天的只显示时分秒，更早的带月日；按浏览器本地时区。 */
export function newsTime(at: number, now = Date.now()): string {
  const date = new Date(at), today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock.slice(0, 5)}`;
}

const span = (ms: number): string => ms < 90_000 ? `${Math.max(1, Math.round(ms / 1_000))} 秒` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 3_600_000)} 小时`;

/** 推送连接的一句话状态与语气。 */
export function connectionText(view: FlashView, now = Date.now()): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  const { connection } = view;
  switch (connection.state) {
    case 'open': return { text: `推送已连接 ${span(now - connection.since)}`, tone: 'ok' };
    case 'connecting': return { text: '正在连接推送', tone: 'muted' };
    case 'retrying': return { text: `推送断开 ${span(now - connection.since)}，自动重连中${connection.closeCode !== null ? `（关闭码 ${connection.closeCode}）` : ''}，期间每分钟用 REST 补读`, tone: 'warn' };
    default: return { text: '推送已停止（服务正在停止）', tone: 'warn' };
  }
}

/** 最近一次 REST 读取的说明；没有出错时为 null。 */
export function restProblem(view: FlashView): string | null {
  return view.rest.error ? `补读失败：${view.rest.error}${view.rest.at ? '（显示的是此前读到的内容）' : ''}` : null;
}

/** 异动频道里读取失败的说明，多个频道合成一句。 */
export function movesProblem(view: MovesView): string | null {
  const failed = view.channels.filter(channel => channel.error);
  return failed.length ? `${failed.map(channel => channel.name).join('、')}读取失败：${failed[0]!.error}` : null;
}
