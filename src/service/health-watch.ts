// The parts the trading service depends on but does not run itself: the public market process, the control process in
// front of the page, the ASTER user streams and the perpetual collector's venues. A problem that lasts is posted to
// Feishu once (some repeat while they last) and its end is posted too. Nothing here decides readiness: /api/ready and
// the second server's heartbeat still only speak for this process, so restarting the market or control process during
// an upgrade never makes the executor look down.
import { marketHealth } from '../market/ipc.ts';
import type { PerpetualStatusView } from '../monitor/perpetual.ts';
import { lasted } from './feishu.ts';
import type { WatchStatus } from './watch.ts';

export const HEALTH_TICK_MS = 10_000;
/** The market or control process unreachable this long is posted. */
export const PROCESS_DOWN_AFTER_MS = 30_000;
/** A user stream down this long is posted (a planned reconnect takes a second or two). */
export const STREAM_DOWN_AFTER_MS = 60_000;
/** A venue of the perpetual collector not live this long is posted, once (its end too). */
export const FEED_DOWN_AFTER_MS = 120_000;
/** While the market or control process or a user stream stays down, the post is repeated this often. */
export const HEALTH_REPEAT_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 3_000;

export interface IncidentView { key: string; title: string; subject: string; problem: string; since: number; alerted: boolean }

/**
 * Open problems by key. observe() with a problem starts or keeps one, posting it once it has lasted afterMs (and again
 * every repeatMs, when given); observe() with null ends it, posting the recovery only if the problem had been posted.
 */
export function createIncidents({ notify, now = Date.now }: { notify: (text: string) => void; now?: () => number }) {
  const open = new Map<string, IncidentView & { sentAt: number | null }>();
  return {
    observe(key: string, title: string, subject: string, problem: string | null, { afterMs, repeatMs }: { afterMs: number; repeatMs: number | null }): void {
      const at = now(), entry = open.get(key);
      if (problem === null) {
        if (entry?.sentAt != null) notify(`【${title}恢复】${subject}，异常共约 ${lasted(at - entry.since)}`);
        open.delete(key);
        return;
      }
      const current = entry ?? { key, title, subject, problem, since: at, alerted: false, sentAt: null };
      current.problem = problem;
      open.set(key, current);
      if (current.sentAt === null) {
        if (at - current.since < afterMs) return;
        current.sentAt = at; current.alerted = true;
        notify(`【${title}】${subject}：${problem}，已持续约 ${lasted(at - current.since)}`);
      } else if (repeatMs !== null && at - current.sentAt >= repeatMs) {
        current.sentAt = at;
        notify(`【${title}仍未恢复】${subject}：${problem}，已持续约 ${lasted(at - current.since)}`);
      }
    },
    /** Drops the problems under a key prefix without a recovery post: what they watched was switched off. */
    forget(prefix: string): void { for (const key of [...open.keys()]) if (key.startsWith(prefix)) open.delete(key); },
    view: (): IncidentView[] => [...open.values()].map(({ sentAt: _, ...item }) => item),
  };
}

export interface ProcessHealth {
  /** null before the first probe. */
  ok: boolean | null;
  checkedAt: number | null;
  lastOkAt: number | null;
  error: string | null;
  /** Restarts seen since this service started (market only: its instance id changed). */
  restarts: number;
}

/** One line of the page's connection badge (web/src/ConnectionStatus.tsx). */
export interface ConnectionView { id: string; label: string; state: 'ok' | 'warn' | 'down' | 'unknown'; detail: string }
/** A heartbeat that last got through longer ago than this shows as late. */
const HEARTBEAT_LATE_MS = 3 * 60_000;

export interface StreamRow { account: string; connected: boolean; since: number | null; lastError: string | null }

export interface HealthWatchOptions {
  marketSocketPath?: string;
  /** The browser port, when a separate control process listens on it. */
  controlPort?: number;
  streams: () => readonly StreamRow[];
  /** The perpetual collector's status while it runs; null when there is none or it is switched off. */
  perpetual?: () => PerpetualStatusView | null;
  notify: (text: string) => void;
  now?: () => number;
  probeMarket?: (socketPath: string) => Promise<unknown>;
  probeControl?: (port: number) => Promise<void>;
}

const clip = (text: string, max = 160) => text.length > max ? `${text.slice(0, max)}…` : text;
const reason = (error: unknown) => clip(error instanceof Error ? (error.cause instanceof Error ? `${error.message}（${error.cause.message}）` : error.message) : String(error));
const FEED_STATUS: Record<string, string> = { connecting: '连接中', stale: '数据过期', error: '出错', disabled: '已停用', live: '正常' };

/** Any HTTP answer from the control port means the control process is up; only a refused, reset or silent connection is not. */
async function probeControlPort(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
  await response.body?.cancel();
}

export function createHealthWatch({ marketSocketPath, controlPort, streams, perpetual, notify, now = Date.now, probeMarket = marketHealth, probeControl = probeControlPort }: HealthWatchOptions) {
  const incidents = createIncidents({ notify, now });
  const blank = (): ProcessHealth => ({ ok: null, checkedAt: null, lastOkAt: null, error: null, restarts: 0 });
  const market = marketSocketPath ? blank() : null, control = controlPort !== undefined ? blank() : null;
  let marketInstance: string | null = null;
  const record = (row: ProcessHealth, error: unknown | null) => {
    row.checkedAt = now();
    row.ok = error === null;
    if (error === null) { row.lastOkAt = row.checkedAt; row.error = null; } else row.error = reason(error);
  };

  async function checkMarket(): Promise<void> {
    if (!market || !marketSocketPath) return;
    try {
      const status = await probeMarket(marketSocketPath) as { instance?: unknown } | null;
      const instance = typeof status?.instance === 'string' ? status.instance : null;
      record(market, null);
      if (instance && marketInstance && instance !== marketInstance) {
        market.restarts += 1;
        notify('【行情服务已重启】公开行情进程（trading-platform-market）换了新实例，期间的行情订阅已重新建立；如非升级所致，请查看该服务日志');
      }
      if (instance) marketInstance = instance;
    } catch (error) { record(market, error); }
    incidents.observe('market', '行情服务不可用', '公开行情进程（trading-platform-market）', market.ok ? null : `无法连接：${market.error}`, { afterMs: PROCESS_DOWN_AFTER_MS, repeatMs: HEALTH_REPEAT_MS });
  }

  async function checkControl(): Promise<void> {
    if (!control || controlPort === undefined) return;
    try { await probeControl(controlPort); record(control, null); } catch (error) { record(control, error); }
    incidents.observe('control', '页面控制面不可用', `控制面进程（trading-platform-control，端口 ${controlPort}）`, control.ok ? null : `无法连接：${control.error}；页面打不开，交易执行不受影响（探测经控制面转回本服务，本服务长时间繁忙时也会如此）`, { afterMs: PROCESS_DOWN_AFTER_MS, repeatMs: HEALTH_REPEAT_MS });
  }

  function checkStreams(): void {
    for (const row of streams()) {
      incidents.observe(`stream:${row.account}`, 'ASTER 用户推送断开', `账户 ${row.account}`, row.connected ? null : `${row.lastError ? clip(row.lastError, 120) : '尚未连上'}；ADL 改由历史扫描发现，延迟变大`, { afterMs: STREAM_DOWN_AFTER_MS, repeatMs: HEALTH_REPEAT_MS });
    }
  }

  function checkFeeds(): void {
    const view = perpetual?.() ?? null;
    if (!view?.running) { incidents.forget('feed:'); return; }
    const at = now();
    for (const venue of view.venues) {
      const problem = venue.status === 'live' || venue.status === 'disabled' ? null
        : `${FEED_STATUS[venue.status] ?? venue.status}${venue.lastMessageAt ? `，最后一条消息在 ${lasted(Math.max(0, at - venue.lastMessageAt))}前` : '，尚未收到消息'}${venue.error ? `：${clip(venue.error, 100)}` : ''}`;
      incidents.observe(`feed:${venue.id}`, '永续行情断流', `${venue.id}`, problem, { afterMs: FEED_DOWN_AFTER_MS, repeatMs: null });
    }
  }

  return {
    async tick(): Promise<void> {
      await Promise.all([checkMarket(), checkControl()]);
      checkStreams();
      checkFeeds();
    },
    view: () => ({ market, control, incidents: incidents.view() }),
    /** What the service is connected to, one line each, for the page's top bar; parts that are not set up are left out. */
    connections(heartbeat: WatchStatus | null): ConnectionView[] {
      const list: ConnectionView[] = [];
      const processLine = (id: string, label: string, row: ProcessHealth | null) => {
        if (!row) return;
        list.push({ id, label, state: row.ok === null ? 'unknown' : row.ok ? 'ok' : 'down',
          detail: row.ok === null ? '检测中' : row.ok ? `正常${row.restarts ? `（本次启动以来重启 ${row.restarts} 次）` : ''}` : `无法连接：${row.error ?? '未知原因'}` });
      };
      processLine('market', '行情服务', market);
      processLine('control', '页面控制面', control);
      const rows = streams();
      if (rows.length) {
        const down = rows.filter(row => !row.connected);
        list.push({ id: 'streams', label: 'ASTER 用户推送', state: down.length ? 'down' : 'ok',
          detail: down.length ? `${rows.length - down.length}/${rows.length} 已连接；断开：${down.map(row => row.account).join('、')}` : `${rows.length} 个账户均已连接` });
      }
      const view = perpetual?.() ?? null;
      if (view?.running) {
        const active = view.venues.filter(venue => venue.status !== 'disabled'), live = active.filter(venue => venue.status === 'live');
        const others = active.filter(venue => venue.status !== 'live');
        list.push({ id: 'perpetual', label: '永续行情', state: !active.length ? 'unknown' : others.length === 0 ? 'ok' : live.length ? 'warn' : 'down',
          detail: `${live.length}/${active.length} 个交易所正常${others.length ? `；${others.map(venue => `${venue.id} ${FEED_STATUS[venue.status] ?? venue.status}`).join('、')}` : ''}` });
      }
      if (heartbeat) {
        const at = now(), late = heartbeat.lastOkAt === null || at - heartbeat.lastOkAt > HEARTBEAT_LATE_MS;
        list.push({ id: 'heartbeat', label: '副服务器心跳', state: heartbeat.failures === 0 && !late ? 'ok' : heartbeat.lastOkAt === null && heartbeat.failures === 0 ? 'unknown' : late ? 'down' : 'warn',
          detail: heartbeat.failures ? `连续 ${heartbeat.failures} 次推送失败：${clip(heartbeat.lastError ?? '未知原因', 100)}` : heartbeat.lastOkAt === null ? '尚未推送' : `上次送达在 ${lasted(Math.max(0, at - heartbeat.lastOkAt))}前` });
      }
      return list;
    },
  };
}

export type HealthWatch = ReturnType<typeof createHealthWatch>;
