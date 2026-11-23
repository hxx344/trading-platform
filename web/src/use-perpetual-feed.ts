// 改写自 project-aggregation 工作台 modules/monitor/hooks/use-perpetual-feed.ts（提交 c84ba27）。改动：
// - 地址改为本服务的 /api/monitor/perpetual/stream 与 /quote；快照读取走 api.ts：401 转登录，其它失败给服务的原因。
// - 工作台嵌在宿主里时由宿主决定能否后台读取（lib/read-activity.ts）；本服务没有宿主，按工作台独立打开时的规则：
//   一直可读，页面隐藏时轮询与时钟放慢到 30 秒。
// - paused（M-5a，照工作台）：展开组合详情时停掉连接，时钟照走，保留的报价按时过期。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { createPerpetualClock, parsePerpetualSnapshot, PerpetualRequestError, startPerpetualFeed, type PerpetualConnection } from './perpetual-feed.ts';
import { createPerpetualDisplay, PERPETUAL_DISPLAY_INTERVAL_MS } from './perpetual-display.ts';
import type { PerpetualSnapshot } from '../../src/vendor/perpetual-types.ts';

export const PERPETUAL_STREAM_PATH = '/api/monitor/perpetual/stream';
export const PERPETUAL_QUOTE_PATH = '/api/monitor/perpetual/quote';
const backgroundDelay = (delay: number) => document.hidden ? Math.max(30_000, delay) : delay;

/** The snapshot read: the service's own reason on a refusal, a login prompt on 401. */
export async function readServiceSnapshot(signal: AbortSignal, onExpired: () => void): Promise<PerpetualSnapshot> {
  let value: unknown;
  try { value = await api<unknown>(PERPETUAL_QUOTE_PATH, { signal, timeoutMs: 12_000 }); }
  catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ApiError && error.status === 401) { onExpired(); throw new PerpetualRequestError('登录已过期，请重新登录。'); }
    throw new PerpetualRequestError(error instanceof ApiError ? error.message : '无法读取合约行情，请检查网络与服务。');
  }
  try { return parsePerpetualSnapshot(value); }
  catch { throw new PerpetualRequestError('行情接口返回了无效数据。'); }
}

export function usePerpetualFeed(onExpired: () => void, paused = false) {
  const [data, setData] = useState<PerpetualSnapshot | null>(null);
  const [connection, setConnection] = useState<PerpetualConnection>('connecting');
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const controls = useRef<ReturnType<typeof startPerpetualFeed> | null>(null);
  const display = useRef<ReturnType<typeof createPerpetualDisplay> | null>(null);
  const [sourceClock] = useState(() => createPerpetualClock());
  const expired = useRef(onExpired);
  expired.current = onExpired;

  useEffect(() => {
    const publisher = createPerpetualDisplay({ onData: snapshot => { setData(snapshot); setNow(sourceClock.read()); } });
    display.current = publisher;
    let clock: ReturnType<typeof setInterval> | undefined;
    let background = document.hidden;
    function synchronizeVisibility(event?: Event) {
      clearInterval(clock);
      const previousBackground = background;
      background = document.hidden;
      // Source time still ages between display updates; old quotes must expire on time.
      const updateClock = () => setNow(sourceClock.read());
      updateClock();
      clock = setInterval(updateClock, backgroundDelay(1_000));
      // Inspection stops network work, but source time must still age so a
      // retained quote cannot stay "fresh" indefinitely while the user reads it.
      if (paused) { controls.current?.stop(); controls.current = null; publisher.reset(); setConnection('paused'); return; }
      if (!navigator.onLine) {
        controls.current?.stop(); controls.current = null;
        publisher.reset();
        setConnection('error');
        setError('网络已断开，恢复连接后自动更新。');
        return;
      }
      if (controls.current) {
        if (!background && (previousBackground || event?.type === 'focus' || event?.type === 'pageshow' || event?.type === 'online')) { controls.current.resume(); publisher.flush(); }
        return;
      }
      controls.current = startPerpetualFeed({
        fetchSnapshot: signal => readServiceSnapshot(signal, () => expired.current()),
        pollIntervalMs: () => backgroundDelay(PERPETUAL_DISPLAY_INTERVAL_MS),
        createStream: () => {
          const source = new EventSource(PERPETUAL_STREAM_PATH);
          const adapter: { onmessage: ((event: { data: string }) => void) | null; onerror: (() => void) | null; close: () => void } = { onmessage: null, onerror: null, close: () => source.close() };
          source.onmessage = event => adapter.onmessage?.({ data: event.data });
          source.onerror = () => adapter.onerror?.();
          return adapter;
        },
        onData: (snapshot, context) => {
          sourceClock.accept(snapshot.generatedAt, snapshot.streamId, context.baseline);
          publisher.accept(snapshot);
        }, onConnection: setConnection, onError: setError,
      });
    }
    synchronizeVisibility();
    document.addEventListener('visibilitychange', synchronizeVisibility);
    window.addEventListener('online', synchronizeVisibility);
    window.addEventListener('offline', synchronizeVisibility);
    window.addEventListener('focus', synchronizeVisibility);
    window.addEventListener('pageshow', synchronizeVisibility);
    return () => {
      document.removeEventListener('visibilitychange', synchronizeVisibility);
      window.removeEventListener('online', synchronizeVisibility);
      window.removeEventListener('offline', synchronizeVisibility);
      window.removeEventListener('focus', synchronizeVisibility);
      window.removeEventListener('pageshow', synchronizeVisibility);
      clearInterval(clock);
      publisher.stop(); display.current = null;
      controls.current?.stop(); controls.current = null;
    };
  }, [paused, sourceClock]);

  // The collector starts within a second of the switch being turned on, but a panel mounted in that second finds it stopped:
  // the service closes the stream at once and the feed would retry only after 20 s (snapshot) and 30 s (stream). While the
  // service says the collector is not running, reconnect every 3 s and show what arrived since without the 20 s display
  // pacing; `resume` leaves a stream with recent frames alone. After a minute (a collector that does not come back) the
  // feed's own 20 s / 30 s retries take over again.
  const unavailable = data?.status === 'unavailable';
  useEffect(() => {
    if (!unavailable || paused) return;
    let attempts = 0;
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (++attempts > 20) { clearInterval(timer); return; }
      display.current?.flush(); controls.current?.resume();
    }, 3_000);
    return () => clearInterval(timer);
  }, [unavailable, paused]);

  const refresh = useCallback(() => {
    const feed = controls.current, publisher = display.current;
    if (!feed || !publisher) return;
    publisher.flush();
    void feed.refresh().then(() => { if (controls.current === feed) publisher.flush(); });
  }, []);
  return { data, connection, error, now, refresh };
}
