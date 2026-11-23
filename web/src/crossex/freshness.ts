import type { State } from './types.ts';

export const STATE_POLL_MS = 2000;
const expired = (at: number | null | undefined, now: number) => !Number.isFinite(at) || !at || now - at > 10000 || at > now + 1000;

/** Use server time plus monotonic elapsed time, independent of the user's clock.
 * Charging the entire request duration is conservative: slow responses never
 * make the data appear younger than it was when the server returned it. */
export function createServerClock(monotonic = () => performance.now()) {
  let serverAt = 0, sampledAt = monotonic();
  return {
    sample(now: number, requestStartedAt: number) {
      sampledAt = monotonic();
      serverAt = now + Math.max(0, sampledAt - requestStartedAt);
    },
    now: () => serverAt + Math.max(0, monotonic() - sampledAt),
  };
}

export function sourceIsStale(source: State['source'] | undefined, now: number, online: boolean) {
  return !online || !source || !['live', 'partial'].includes(source.state) || expired(source.updatedAt, now) || expired(source.generatedAt ?? source.updatedAt, now);
}
