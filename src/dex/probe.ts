// 安装器的 DEX 价差服务探测（docs/dexspread.md 11.9）：以执行面账户、DEX 通信组身份读 status，核对协议与目标版本的组件编号。
import { parseArgs } from 'node:util';
import { readComponentBuild } from '../component-build.ts';
import { dexStatus } from './ipc.ts';
import { DEX_PROTOCOL } from './protocol.ts';

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { socket: { type: 'string' }, root: { type: 'string' } } });
    if (!values.socket || !values.root) throw new Error('需要 --socket 和 --root');
    const status = await dexStatus(values.socket);
    if (status.protocol !== DEX_PROTOCOL || status.build !== readComponentBuild(values.root, 'dex')) throw new Error('DEX 价差组件尚未切到目标版本');
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'DEX 价差服务探测失败'}\n`); process.exitCode = 1; }
}
