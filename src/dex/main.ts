// DEX 价差服务入口（docs/dexspread.md 第 11 节）：trading-platform-dex.service 以独立账户运行，库在自己的状态目录，
// 只对执行服务开放本机套接字。Var token 由执行服务推送，只存在内存里。
import { chmodSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readComponentBuild } from '../component-build.ts';
import { crashReportKey, installCrashGuard, readCrashRecord } from '../crash-guard.ts';
import { openVarLighter, routePage, varLighterLoop, varLighterViews, type VarLighterOptions } from './host.ts';
import { configuredVenues, guardedAccounts, takeDexKeys } from './keys.ts';
import { DEX_TOKEN_LEASE_MS, tokenDigest, type DexCrashView, type DexTokenPush } from './protocol.ts';
import { createDexServer } from './server.ts';

export const DEX_PROCESS_NAME = 'DEX 价差服务';
const WAITING = '等待执行服务推送 Var token';
const EXPIRED = '超过 1 分钟没收到执行服务推送的 Var token，已暂停询价';
/** 崩溃记录不清除（状态目录只有 DEX 自己写）；只报告这么久以内的，免得每次启动都把很久以前的那次带出去。 */
export const DEX_CRASH_REPORT_MS = 24 * 3600_000;

/** 起 DEX 服务：打开库、监听套接字、跑采集循环；返回停止函数（等循环关库后才结束）。测试与本地预览在同一进程里调用。 */
export function startDex({ socket, stateDir, build, options = {}, log = line => process.stderr.write(`${line}\n`), now = Date.now }:
  { socket: string; stateDir: string; build: string; options?: VarLighterOptions; log?: (line: string) => void; now?: () => number }) {
  let token: DexTokenPush | null = null, receivedAt = 0;
  const current = (): DexTokenPush | null => token && now() - receivedAt <= DEX_TOKEN_LEASE_MS ? token : null;
  const source = () => {
    const live = current();
    if (live) return { token: live.token, problem: live.problem };
    return { token: '', problem: token ? EXPIRED : WAITING };
  };
  const holder = openVarLighter(stateDir, { ...options, tokenSource: source }, log);
  const views = varLighterViews(holder);
  const last = readCrashRecord(stateDir);
  const crash: DexCrashView | null = last && now() - last.at <= DEX_CRASH_REPORT_MS ? { at: last.at, key: crashReportKey(last), text: `${last.kind === 'unhandledRejection' ? '未处理的 Promise 拒绝' : '未捕获的异常'}：${last.message}` } : null;
  const service = createDexServer({
    page: request => routePage(views, request, log),
    // 空 token 立即生效：之后不再询价（docs/dexspread.md 11.4）。
    token: push => {
      // 租约内只收更大的序号；租约过期后任何推送都收，执行服务重启后墙钟回拨也不会被一直拒绝。
      if (current() && push.seq <= token!.seq) return false;
      token = push; receivedAt = now();
      return true;
    },
    tokenDigest: () => { const live = current(); return live ? tokenDigest(live) : null; },
    crash: () => crash,
    alerts: () => holder.engine?.liveAlerts() ?? [],
  }, build);
  let stopped = false;
  const stopping = new AbortController();
  const loop = varLighterLoop(holder, { stopped: () => stopped, pause: ms => pause(ms, undefined, { signal: stopping.signal }).catch(() => undefined) });
  const ready = new Promise<void>((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen({ path: socket }, () => {
      try { if (process.platform !== 'win32') chmodSync(socket, 0o660); resolve(); }
      catch (error) { reject(error as Error); }
    });
  });
  return {
    ready, instance: service.instance,
    async stop() {
      if (stopped) return;
      stopped = true; stopping.abort();
      service.close();
      await loop;
    },
  };
}

function main(): void {
  const { values } = parseArgs({ options: { socket: { type: 'string' }, 'state-dir': { type: 'string' }, 'keys-file': { type: 'string' } } });
  // 先取走场所账户并从环境里删掉，之后启动的子进程不再继承（启动时的环境块仍在 /proc/<pid>/environ，见 L211）。
  const taken = takeDexKeys(process.env);
  const keysFile = values['keys-file'];
  if (keysFile !== undefined && !isAbsolute(keysFile)) throw new Error('--keys-file 须为绝对路径');
  if (!values.socket || !isAbsolute(values.socket)) throw new Error('需要绝对路径 --socket');
  const stateDir = values['state-dir'];
  if (!stateDir || !isAbsolute(stateDir)) throw new Error('需要绝对路径 --state-dir');
  const build = readComponentBuild(fileURLToPath(new URL('../..', import.meta.url)), 'dex');
  const accounts = guardedAccounts(taken, keysFile ?? null);
  // 启动时说一句账户取用的结果（只有场所个数，没有编号与地址）：真实 systemd 验收靠它确认正常录入的文件被接受。
  const first = accounts();
  if (taken.present || first.problem) process.stdout.write(first.problem ? `场所账户未使用：${first.problem}\n` : `场所账户：已取到 ${configuredVenues(first.accounts).length} 个场所\n`);
  const dex = startDex({ socket: values.socket, stateDir, build, options: { accounts } });
  dex.ready.then(() => process.stdout.write('DEX 价差服务已就绪\n'), (error: Error) => {
    process.stderr.write(`DEX 价差服务监听失败：${error.message}\n`); process.exitCode = 1; void dex.stop();
  });
  const stop = () => { void dex.stop().catch(error => { process.stderr.write(`DEX 价差服务停止出错：${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (import.meta.main) {
  const dir = parseArgs({ options: { socket: { type: 'string' }, 'state-dir': { type: 'string' }, 'keys-file': { type: 'string' } }, strict: false }).values['state-dir'];
  installCrashGuard(DEX_PROCESS_NAME, typeof dir === 'string' && isAbsolute(dir) ? { dir } : {});
  try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'DEX 价差服务启动失败'}\n`); process.exitCode = 1; }
}
