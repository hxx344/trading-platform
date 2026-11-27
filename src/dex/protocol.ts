import { createHash } from 'node:crypto';
import type { DexAccountsState } from './keys.ts';

export type { DexAccountsState } from './keys.ts';

// DEX 价差服务的本机协议（docs/dexspread.md 第 11.2 节）。只有执行服务账户（DEX 通信组）能连这个套接字。
export const DEX_PATH = '/dex/v1/';
export const DEX_PROTOCOL = 1;
export const DEX_INSTANCE_HEADER = 'x-dex-instance';
/** 转发的请求体上限：参数 64 KB，回测与其余请求按执行面原来的默认上限。 */
export const DEX_INPUT_LIMIT = 2 * 1024 * 1024;
export const DEX_OUTPUT_LIMIT = 32 * 1024 * 1024;
export const DEX_READ_TIMEOUT_MS = 10_000;
export const DEX_BACKTEST_TIMEOUT_MS = 120_000;
/** page 里 path 的写法：`/api/varlighter/` 之后的部分。 */
export const DEX_PAGE_PATH = /^[a-z][a-z0-9/-]{0,63}$/;

export interface DexPageRequest { method: 'GET' | 'POST'; path: string; query: [string, string][]; body?: unknown }
export interface DexPageAnswer { status: number; body: unknown }
/**
 * 执行面推给 DEX 的 Var token 状态；token 为空表示没有可用 token，problem 是给页面的提示。`seq` 单调递增（毫秒时刻起算），
 * DEX 丢弃不比已收到的新的推送（超时后才到的旧推送不会盖掉新的）。执行面每轮都推，同时是租约续期。
 */
export interface DexTokenPush { seq: number; token: string; problem: string }
/** 这么久没收到推送，DEX 清空 token、不再询价（执行面停了或卡住时 token 不会一直留在 DEX 里，L207）。 */
export const DEX_TOKEN_LEASE_MS = 60_000;
export interface DexProcessStatus { rss: number; heapUsed: number; loopDelayMs: number | null }
export interface DexCrashView { at: number; key: string; text: string }
/** 实盘告警：执行服务按 key 只发一次飞书。 */
export interface DexAlertView { key: string; text: string }
export interface DexStatus { build: string; instance: string; protocol: number; process: DexProcessStatus; crash: DexCrashView | null; token: string | null; /** 旧版本的 DEX 服务没有这个字段。 */ alerts?: DexAlertView[] }

export class DexError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) { super(message); this.status = status; }
}

/** token 推送的摘要：DEX 在 status 里报告它持有的摘要，执行面不一致就重推（docs/dexspread.md 11.4）。 */
export function tokenDigest(push: DexTokenPush): string {
  return createHash('sha256').update(JSON.stringify([push.token, push.problem])).digest('hex').slice(0, 32);
}
