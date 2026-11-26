import { VENUE_NAMES } from './model.ts';

type Release = () => void;
type Waiter = { scanning: boolean; grant(release: Release): void };

const STARTS_PER_SECOND = 3, MAX_ACTIVE = 4;
// Reserve both places in a batch for every venue, even with manual readers already waiting.
const MAX_SCAN_WAITERS = 2 * Object.keys(VENUE_NAMES).length, MAX_MANUAL_WAITERS = 2;

export function createQuoteBudget(now: () => number) {
  const queue: Waiter[] = [];
  let active = 0, starts: number[] = [], timer: ReturnType<typeof setTimeout> | undefined;

  function drain() {
    clearTimeout(timer); timer = undefined;
    const at = now();
    // After a backward clock correction, keep the recent starts charged for one further second.
    starts = starts.map(time => Math.min(time, at)).filter(time => time > at - 1000);
    while (queue.length && active < MAX_ACTIVE && starts.length < STARTS_PER_SECOND) {
      const next = queue.shift()!;
      starts.push(at); active++;
      let released = false;
      next.grant(() => {
        if (released) return;
        released = true; active--; drain();
      });
    }
    if (queue.length && active < MAX_ACTIVE) {
      timer = setTimeout(drain, Math.max(1, starts[0]! + 1000 - at));
      timer.unref?.();
    }
  }

  return function acquire(signal: AbortSignal, scanning: boolean): Promise<Release> {
    signal.throwIfAborted();
    const limit = scanning ? MAX_SCAN_WAITERS : MAX_MANUAL_WAITERS;
    if (queue.filter(waiter => waiter.scanning === scanning).length >= limit) {
      // An internal scan backlog is local load. Only actual upstream 429s should suspend a venue.
      throw Object.assign(new Error('同时查询的币种较多，请稍后重试'), { status: scanning ? 503 : 429 });
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { scanning, grant(release) { signal.removeEventListener('abort', cancel); resolve(release); } };
      function cancel() {
        queue.splice(queue.indexOf(waiter), 1);
        if (!queue.length) { clearTimeout(timer); timer = undefined; }
        reject(signal.reason);
      }
      signal.addEventListener('abort', cancel, { once: true });
      queue.push(waiter); drain();
    });
  };
}
