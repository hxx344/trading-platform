// 执行服务这一侧的 DEX 价差（docs/dexspread.md 第 11 节）：把 /api/varlighter/* 转发给 DEX 价差服务，并把 Var token 推过去。
// 不导入 src/varlighter/**：只改 DEX 价差的版本不会改动执行面的组件指纹（deploy/component-digests.mjs 有断言）。
import { join } from 'node:path';
import { createDexClient, dexCompatible, type DexClient, type DexPageAnswer, type DexPageRequest } from '../dex/ipc.ts';
import { tokenDigest, type DexTokenPush } from '../dex/protocol.ts';
import { VARIATIONAL_SESSION_FILE, readVariationalSessionFile } from '../monitor/variational-session.ts';

export const DEX_TOKEN_TICK_MS = 15_000;

/** http.ts 用的转发：确定没发出返回 503；POST 发出后结果未知时抛 DexOutcomeUnknown。 */
export interface DexForward { page(request: DexPageRequest): Promise<DexPageAnswer> }

/** 读执行面数据目录里的 Var token 文件（行情监控保存的那一份），规则与原来 DEX 引擎读文件时一致。 */
export function readTokenPush(dir: string, seq: number): DexTokenPush {
  const { state, problem } = readVariationalSessionFile(join(dir, VARIATIONAL_SESSION_FILE));
  return { seq, token: state.token, problem };
}

export interface DexLink { client: DexClient; forward: DexForward; tick(): Promise<void>; close(): void }

/**
 * 每轮（15 秒）读一次 DEX 的 status：协议版本不认识就停止转发；DEX 带出的上次崩溃记录按键发一次告警；然后推送 token。
 * 每轮都推（也是 DEX 那边一分钟租约的续期），序号单调递增；推送失败只记一次日志，下一轮照推。
 * status 读失败（例如 DEX 忙于回测时超时）不跳过推送，沿用上一次的兼容判断：只有确知版本不兼容时才不推。
 */
export function createDexLink({ socketPath, dir, notifyOnce, log, client = createDexClient(socketPath) }:
  { socketPath: string; dir: string; notifyOnce: (key: string, text: string) => void; log: (line: string) => void; client?: DexClient }): DexLink {
  let pushFailing = false, seq = 0, compatible = true;
  const nextSeq = () => { seq = Math.max(seq + 1, Date.now()); return seq; };
  return {
    client,
    forward: { page: request => client.page(request) },
    async tick() {
      let status = null;
      try { status = await client.status(); } catch { /* 沿用上一次的判断 */ }
      if (status) { compatible = dexCompatible(status); client.setCompatible(compatible); }
      if (!compatible) return;
      if (status?.crash) {
        const { at, key, text } = status.crash;
        try { notifyOnce(`dex:${key}`, `【DEX 价差服务上次异常退出】北京时间 ${new Date(at + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}，${text}。已由 systemd 重启，交易执行不受影响`); }
        catch (error) { log(`DEX 价差服务崩溃告警未能入队：${error instanceof Error ? error.message.slice(0, 160) : String(error)}`); }
      }
      const push = readTokenPush(dir, nextSeq());
      try {
        const answer = await client.pushToken(push);
        // 以 DEX 报告的当前生效摘要为准：被丢弃的旧推送或租约问题都会在这里显出来。
        if (answer.token !== tokenDigest(push)) throw new Error('DEX 当前生效的 token 与推送的不一致');
        if (pushFailing) log('Var token 已推送到 DEX 价差服务');
        pushFailing = false;
      } catch (error) {
        if (!pushFailing) log(`Var token 推送到 DEX 价差服务失败，下一轮重试：${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
        pushFailing = true;
      }
    },
    close: () => client.close(),
  };
}
