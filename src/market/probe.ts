import { parseArgs } from 'node:util';
import { readComponentBuild } from '../component-build.ts';
import { marketHealth } from './ipc.ts';

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { socket: { type: 'string' }, root: { type: 'string' } } });
    if (!values.socket || !values.root) throw new Error('需要 --socket 和 --root');
    const status = await marketHealth(values.socket) as { protocol: number; build: string };
    if (status.protocol !== 1 || status.build !== readComponentBuild(values.root, 'market')) throw new Error('行情组件尚未切到目标版本');
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : '行情探测失败'}\n`); process.exitCode = 1; }
}
