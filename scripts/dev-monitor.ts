// A local preview of the monitor page on the stand-in venues of test/monitor-fake.ts: a simulated executor, the built
// page and the Anthropic collector in a throwaway data directory, removed on exit. Nothing goes to the network. Unlike the
// service it takes no account locks and writes no environment marker, so it also runs on Windows.
//   pnpm build:web; node scripts/dev-monitor.ts [--port 4731]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/store.ts';
import { createExecutor } from '../src/executor.ts';
import { createSimulatedVenues } from '../src/simulation.ts';
import { runExecutor } from '../src/runtime.ts';
import { loadWebApp } from '../src/web-assets.ts';
import { parseMonitorConfig } from '../src/service/monitor-config.ts';
import { closeMonitor, monitorLoops, monitorViews, openMonitor, stopMonitor } from '../src/service/monitor.ts';
import { fakeAnthropicVenues } from '../test/monitor-fake.ts';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4731' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');
const app = loadWebApp();
const dir = mkdtempSync(join(tmpdir(), 'tp-dev-monitor-'));
const venues = fakeAnthropicVenues();
const monitor = openMonitor(parseMonitorConfig({ anthropic: {} }), dir, { fetchImpl: venues.fetch });
const store = openStore(join(dir, 'executor.sqlite'));
const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
const executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
if (!executor.acquire()) throw new Error('写入租约被占用');

const run = runExecutor({
  executor, store, dir, port, app, passes: [],
  views: { monitor: monitorViews(monitor), status: () => ({ monitor: { available: true, error: null, anthropic: monitor.anthropic.status() } }) },
  startedMessage: `行情监控预览（替身行情）已启动，数据目录 ${dir}`,
  background: context => monitorLoops(monitor, context),
  onStopping: () => stopMonitor(monitor),
  onStopped: () => closeMonitor(monitor),
});
let link = '';
for (let i = 0; i < 100 && !link; i++) {
  try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim().split('\n').at(-1)!; }
  catch { await new Promise(resolve => setTimeout(resolve, 50)); }
}
process.stdout.write(link ? `登录链接：${link}\n登录后打开：http://127.0.0.1:${port}/#/monitor\n按 Ctrl+C 停止（临时数据目录随之删除）\n` : '未能读到登录链接\n');
await run.done;
rmSync(dir, { recursive: true, force: true });
