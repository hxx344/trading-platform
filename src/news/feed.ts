// EQN 快讯与异动行情的读取（docs/news.md）。全部在内存里，重启后由 REST 补回最新一页。
//
// 快讯（主频道）：常驻一条推送连接（wss://api.eqn.news/public/ws）。按文档每 30 秒发纯文本 ping，服务端回 pong；
// 75 秒内什么都没收到就当连接已死重连。断开后按 1、2、4…30 秒退避并加抖动，1008（过快）、1013（满载）至少等 15 秒，
// 1012（服务重启）等 1–5 秒。推送没有回放：每次连上都用 REST 补最新一页；收到推送后先显示，2 秒与 15 秒后各用 REST
// 核对一次，换成带中英文、币种和 AI 摘要的完整记录。推送断开期间每分钟用 REST 读一次，连着时每 5 分钟兜底一次。
//
// 异动行情（价格异动、OI 价格异动、大幅波动、美股重大行情）：推送里没有，只能读 REST。只在最近 90 秒内有页面读取时
// 每 15 秒轮询一次（4 个频道依次各一个请求），没人看就停。
//
// 限流（文档）：所有公开接口合计每 10 秒 30 次，REST 每秒 10 次。这里最多每 15 秒 4 次加快讯的少量补读；429 时按
// Retry-After（5–120 秒）暂停全部 REST。
import { EQN_REST, EQN_WS, FLASH_CHANNEL, MOVE_CHANNELS, newestFirst, parsePushFrame, parseRestPage, type MoveChannel, type NewsItem } from './eqn.ts';

export interface NewsSocket {
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: (event: { code?: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface NewsOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  connect?: (url: string) => NewsSocket;
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
}

export type ConnectionState = 'connecting' | 'open' | 'retrying' | 'closed';

export interface FlashView {
  connection: { state: ConnectionState; since: number; lastPushAt: number | null; closeCode: number | null; reconnects: number };
  rest: { at: number | null; error: string | null };
  items: NewsItem[];
}

export interface MovesView {
  channels: { key: MoveChannel; name: string; at: number | null; error: string | null }[];
  /** 还没有任何频道读到过（刚开始轮询）。 */
  loading: boolean;
  items: NewsItem[];
}

export interface NewsFeed { flash(): FlashView; moves(): MovesView; close(): void }

export const PING_MS = 30_000;
export const SILENT_MS = 75_000;
export const OPEN_TIMEOUT_MS = 10_000;
export const RETRY_MAX_MS = 30_000;
export const STABLE_MS = 30_000;
export const PUSH_CHECK_MS = [2_000, 15_000] as const;
export const FLASH_POLL_DOWN_MS = 60_000;
export const FLASH_POLL_UP_MS = 300_000;
export const MOVES_POLL_MS = 15_000;
export const MOVES_INTEREST_MS = 90_000;
const REST_TIMEOUT_MS = 8_000;
const BODY_MAX = 2_000_000, FRAME_MAX = 64 * 1024;
const KEEP = 200, FLASH_VIEW = 100, MOVES_VIEW = 200, TITLE_MATCH_MS = 10 * 60_000;

const key = (item: NewsItem) => item.no !== null ? `n${item.no}` : `p${item.time}:${item.zh ?? item.en}`;

/** 按编号合并，旧的推送条目被同编号的 REST 记录替换；只留最新的 KEEP 条。 */
function merge(into: Map<string, NewsItem>, items: readonly NewsItem[]): void {
  for (const item of items) {
    const existing = into.get(key(item));
    // 推送条目不覆盖已核对的完整记录。
    if (existing && !existing.pushed && item.pushed) continue;
    into.set(key(item), item);
  }
  if (into.size <= KEEP) return;
  const kept = [...into.values()].sort(newestFirst).slice(0, KEEP);
  into.clear();
  for (const item of kept) into.set(key(item), item);
}

const failure = (error: unknown) => error instanceof Error && /[一-鿿]/.test(error.message) ? error.message : 'EQN 快讯接口暂不可用';

export function createNewsFeed({ fetchImpl = fetch, connect = url => new WebSocket(url) as unknown as NewsSocket, now = Date.now, random = Math.random, log = line => process.stderr.write(`${line}\n`) }: NewsOptions = {}): NewsFeed {
  const stopped = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, run: () => void) => {
    if (stopped.signal.aborted) return undefined;
    const timer = setTimeout(() => { timers.delete(timer); if (!stopped.signal.aborted) run(); }, ms);
    timers.add(timer);
    return timer;
  };
  const cancel = (timer: ReturnType<typeof setTimeout> | undefined) => { if (timer) { clearTimeout(timer); timers.delete(timer); } };

  // ---- REST ----
  let cooldownUntil = 0;
  async function readPage(channel: string, limit: number): Promise<NewsItem[]> {
    const wait = cooldownUntil - now();
    if (wait > 0) throw new Error(`EQN 接口限流，${Math.ceil(wait / 1_000)} 秒后重试`);
    const response = await fetchImpl(`${EQN_REST}/news?channel=${encodeURIComponent(channel)}&limit=${limit}`, { headers: { accept: 'application/json' }, signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(REST_TIMEOUT_MS)]) });
    if (response.status === 429) {
      // 没有 Retry-After 或不是秒数（HTTP 日期）时按 10 秒。
      const header = response.headers.get('retry-after'), retry = header === null || header.trim() === '' ? NaN : Number(header);
      cooldownUntil = now() + Math.min(120, Math.max(5, Number.isFinite(retry) ? retry : 10)) * 1_000;
      throw new Error('EQN 接口限流（429），稍后重试');
    }
    if (!response.ok) throw new Error(`EQN 快讯接口返回 ${response.status}`);
    // 先按 content-length 拒掉大应答；没有这个头时读完再按字符数比较（读取受 8 秒超时约束）。
    if (Number(response.headers.get('content-length')) > BODY_MAX) { await response.body?.cancel().catch(() => {}); throw new Error('EQN 快讯应答过大'); }
    const body = await response.text();
    if (body.length > BODY_MAX) throw new Error('EQN 快讯应答过大');
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new Error('EQN 快讯应答不是 JSON'); }
    return parseRestPage(parsed);
  }

  // ---- 快讯 ----
  const flashItems = new Map<string, NewsItem>();
  const flashRest = { at: null as number | null, error: null as string | null };
  let flashReading: Promise<void> | null = null, flashAgain = false, flashPoll: ReturnType<typeof setTimeout> | undefined, flashPollAt = 0;
  function refreshFlash(): Promise<void> {
    // 读取中再要求一次：本次完成后再读一次，不并发。
    if (flashReading) { flashAgain = true; return flashReading; }
    flashReading = (async () => {
      try {
        const items = await readPage(FLASH_CHANNEL, flashRest.at === null ? 50 : 20);
        reconcile(items);
        flashRest.at = now(); flashRest.error = null;
      } catch (error) {
        if (stopped.signal.aborted) return;
        flashRest.error = failure(error);
      } finally {
        flashReading = null;
        if (flashAgain && !stopped.signal.aborted) { flashAgain = false; void refreshFlash(); }
        scheduleFlashPoll(true);
      }
    })();
    return flashReading;
  }
  /**
   * REST 记录到了：替换同编号的推送条目；推送条目的标题对上一条时间相近（前后 10 分钟）的 REST 记录也去掉
   * （编号缺失或对不上时）。同一模板的旧快讯时间相差远，不会顶掉新推送。
   */
  function reconcile(items: readonly NewsItem[]): void {
    const titles = new Map<string, number[]>();
    for (const item of items) for (const title of [item.zh, item.en]) if (title !== null) (titles.get(title) ?? titles.set(title, []).get(title)!).push(item.time);
    for (const [id, item] of flashItems) {
      if (!item.pushed) continue;
      const times = titles.get((item.zh ?? item.en)!);
      if (times?.some(time => Math.abs(time - item.time) <= TITLE_MATCH_MS)) flashItems.delete(id);
    }
    merge(flashItems, items);
  }
  /**
   * 刚读完时按连接状态重排；断开时只会提前，反复断开也不会把补读一直往后推。
   * 上次读取失败（如重连补读撞上 429 暂停）时按断开的间隔重试，不等 5 分钟。
   */
  function scheduleFlashPoll(afterRead: boolean): void {
    const at = now() + (connection.state === 'open' && flashRest.error === null ? FLASH_POLL_UP_MS : FLASH_POLL_DOWN_MS);
    if (!afterRead && flashPoll && flashPollAt <= at) return;
    cancel(flashPoll);
    flashPollAt = at;
    flashPoll = later(at - now(), () => { flashPoll = undefined; void refreshFlash(); });
  }

  // ---- 推送连接 ----
  const connection = { state: 'connecting' as ConnectionState, since: now(), lastPushAt: null as number | null, closeCode: null as number | null, reconnects: 0 };
  let socket: NewsSocket | null = null, generation = 0, attempt = 0, openedAt = 0, lastSeen = 0, downSince: number | null = null;
  let pingTimer: ReturnType<typeof setTimeout> | undefined, openTimer: ReturnType<typeof setTimeout> | undefined;
  // 推送后的 REST 核对：2 秒那次已排上就不再排（连续推送时最多每 2 秒一次），15 秒那次按最后一条推送重排。
  let pushSoon: ReturnType<typeof setTimeout> | undefined, pushLate: ReturnType<typeof setTimeout> | undefined;
  const setState = (state: ConnectionState) => { if (connection.state !== state) { connection.state = state; connection.since = now(); } };

  function open(): void {
    if (stopped.signal.aborted) return;
    const id = ++generation;
    setState(connection.reconnects === 0 && downSince === null ? 'connecting' : 'retrying');
    let current: NewsSocket;
    try { current = connect(EQN_WS); }
    catch { down(id, null); return; }
    socket = current;
    const mine = () => id === generation && !stopped.signal.aborted;
    openTimer = later(OPEN_TIMEOUT_MS, () => { if (mine() && connection.state !== 'open') { try { current.close(); } catch { /* 下面照样重连 */ } down(id, null); } });
    current.addEventListener('open', () => {
      if (!mine()) return;
      cancel(openTimer);
      openedAt = lastSeen = now();
      setState('open');
      if (downSince !== null) log(`EQN 快讯推送已恢复（断开 ${Math.round((now() - downSince) / 1_000)} 秒）`);
      downSince = null;
      heartbeat(id);
      // 推送没有回放，连上就补最新一页。
      void refreshFlash();
    });
    current.addEventListener('message', event => {
      if (!mine()) return;
      lastSeen = now();
      const data = event.data;
      if (typeof data !== 'string' || data.length > FRAME_MAX || data === 'pong') return;
      let frame: unknown;
      try { frame = JSON.parse(data); } catch { return; }
      const item = parsePushFrame(frame, now());
      if (!item) return;
      connection.lastPushAt = now();
      merge(flashItems, [item]);
      if (!pushSoon) pushSoon = later(PUSH_CHECK_MS[0], () => { pushSoon = undefined; void refreshFlash(); });
      cancel(pushLate);
      pushLate = later(PUSH_CHECK_MS[1], () => { pushLate = undefined; void refreshFlash(); });
    });
    current.addEventListener('error', () => { /* close 随后带关闭码到达 */ });
    current.addEventListener('close', event => { if (mine()) down(id, typeof event.code === 'number' ? event.code : null); });
  }

  function heartbeat(id: number): void {
    pingTimer = later(PING_MS, () => {
      if (id !== generation || !socket) return;
      if (now() - lastSeen > SILENT_MS) { try { socket.close(); } catch { /* 下面照样重连 */ } down(id, null); return; }
      try { socket.send('ping'); } catch { /* 发送失败时 close 会到 */ }
      heartbeat(id);
    });
  }

  function down(id: number, code: number | null): void {
    if (id !== generation || stopped.signal.aborted) return;
    generation++;
    cancel(pingTimer); cancel(openTimer);
    socket = null;
    const wasOpen = connection.state === 'open';
    if (wasOpen && now() - openedAt >= STABLE_MS) attempt = 0;
    connection.closeCode = code;
    connection.reconnects++;
    if (downSince === null) {
      downSince = now();
      log(`EQN 快讯推送${wasOpen ? `断开（关闭码 ${code ?? '无'}，连接 ${Math.round((now() - openedAt) / 1_000)} 秒）` : `连接失败（关闭码 ${code ?? '无'}）`}，自动重连；期间每分钟用 REST 补读`);
    }
    setState('retrying');
    const backoff = Math.min(RETRY_MAX_MS, 1_000 * 2 ** attempt++) * (0.8 + 0.4 * random());
    // 1012（上游重启）先快速重连，连续出现时随退避增长。
    const delay = code === 1012 ? Math.max(1_000 + 4_000 * random(), backoff) : code === 1008 || code === 1013 ? Math.max(15_000, backoff) : backoff;
    later(Math.round(delay), open);
    scheduleFlashPoll(false);
  }

  // ---- 异动行情 ----
  const moves = new Map<MoveChannel, { items: Map<string, NewsItem>; at: number | null; error: string | null }>(MOVE_CHANNELS.map(channel => [channel.key, { items: new Map(), at: null, error: null }]));
  let interestUntil = 0, movesRunning = false;
  async function pollMoves(): Promise<void> {
    movesRunning = true;
    try {
      for (const { key: channel } of MOVE_CHANNELS) {
        if (stopped.signal.aborted) return;
        const slot = moves.get(channel)!;
        try { merge(slot.items, await readPage(channel, slot.at === null ? 50 : 20)); slot.at = now(); slot.error = null; }
        catch (error) { if (!stopped.signal.aborted) slot.error = failure(error); }
      }
    } finally {
      if (!stopped.signal.aborted && now() < interestUntil) later(MOVES_POLL_MS, () => void pollMoves());
      else movesRunning = false;
    }
  }

  open();
  void refreshFlash();

  return {
    flash: () => ({ connection: { ...connection }, rest: { ...flashRest }, items: [...flashItems.values()].sort(newestFirst).slice(0, FLASH_VIEW) }),
    moves: () => {
      interestUntil = now() + MOVES_INTEREST_MS;
      if (!movesRunning && !stopped.signal.aborted) void pollMoves();
      const channels = MOVE_CHANNELS.map(({ key: channel, name }) => ({ key: channel, name, at: moves.get(channel)!.at, error: moves.get(channel)!.error }));
      const items = [...moves.values()].flatMap(slot => [...slot.items.values()]);
      // 同一条快讯可能同时属于几个异动频道。
      const unique = new Map(items.map(item => [key(item), item]));
      return { channels, loading: channels.every(channel => channel.at === null && channel.error === null), items: [...unique.values()].sort(newestFirst).slice(0, MOVES_VIEW) };
    },
    close: () => {
      if (stopped.signal.aborted) return;
      stopped.abort();
      generation++;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      try { socket?.close(); } catch { /* 停服时不再关心 */ }
      socket = null;
      setState('closed');
    },
  };
}
