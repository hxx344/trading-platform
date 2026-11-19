// 改编自工作台 modules/crossex/src/live-loading.ts（提交 7745181）：状态地址改为 /api/crossex/state，去掉 CSRF 令牌与 Monitor 地址字段。
import type { LiveBootstrap, LiveState } from './live-types.ts';
import { CROSSEX_STATE_PATH } from './crossex-api.ts';

export const CATALOG_CACHE_MS = 5 * 60_000;
export const BOOTSTRAP_REFRESH_MS = 30_000;
export const stateReadPath = (tab: string) => tab === 'hedge' ? CROSSEX_STATE_PATH : tab === 'positions' ? `${CROSSEX_STATE_PATH}?opportunities=0&funding=1` : `${CROSSEX_STATE_PATH}?opportunities=0`;
export const needsCatalog = (tab: string) => ['trade', 'hedge', 'positions'].includes(tab);
export const readRetryDelay = (failures: number) => Math.min(30_000, 3000 * 2 ** Math.max(0, Math.min(failures - 1, 4)));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The lightweight response is authoritative configuration, never a manufactured empty account. */
export function parseBootstrap(value: unknown): LiveBootstrap {
  if (!object(value) || !Number.isFinite(value.now) || !object(value.connection)
    || typeof value.connection.configured !== 'boolean' || typeof value.connection.connected !== 'boolean'
    || !object(value.config) || typeof value.config.entryPaused !== 'boolean') {
    throw new Error('连接信息格式不可用，请重试读取');
  }
  return value as LiveBootstrap;
}

export function latestBootstrap(bootstrap: LiveBootstrap | null, state: LiveState | null): LiveBootstrap | null {
  const fromState = state && state.config && state.live?.connection
    ? { now: state.now, config: state.config, connection: state.live.connection, limits: state.limits ?? bootstrap?.limits ?? null } : null;
  if (!bootstrap) return fromState;
  if (!fromState) return bootstrap;
  return bootstrap.now >= fromState.now ? bootstrap : fromState;
}

/** Public catalogue data stays in memory; configuration and secrets never enter this cache. */
export function createTimedCache<T>(ttl: number, clock = Date.now) {
  let value: T | null = null, expiresAt = 0;
  return {
    peek: () => ({ value, fresh: value !== null && clock() < expiresAt, remaining: Math.max(0, expiresAt - clock()) }),
    put(next: T) { value = next; expiresAt = clock() + ttl; },
    invalidate() { expiresAt = 0; },
  };
}
