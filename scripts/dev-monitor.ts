// A local preview of the monitor page on the stand-in venues of test/monitor-fake.ts: a simulated executor, the built
// page and the Anthropic, oil and Hynix collectors in a throwaway data directory, removed on exit. Nothing goes to the network. Unlike the
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
import { closeMonitor, monitorLoops, monitorStatus, monitorViews, openMonitor, stopMonitor } from '../src/service/monitor.ts';
import { fakeAnthropicVenues } from '../test/monitor-fake.ts';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4731' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');
const app = loadWebApp();
const dir = mkdtempSync(join(tmpdir(), 'tp-dev-monitor-'));
// Hynix listed as on the real venues (first settlement 2026-07-10 15:00), so the settled funding backfills in 60-day segments.
const venues = fakeAnthropicVenues({ listedAt: { skhy: Date.UTC(2026, 6, 10, 14), skhx: Date.UTC(2026, 6, 10, 14) } });
// A stand-in Feishu robot for the alert panel (M-3a): queued alerts and test messages print here, an alert counts as sent 2 s
// after it was queued.
const outbox: { text: string; at: number }[] = [];
const alertHooks = {
  notify: (text: string) => { outbox.push({ text, at: Date.now() }); process.stdout.write(`[替身飞书·入队] ${text}\n`); return outbox.length; },
  delivery: (ids: readonly number[]) => new Map(ids.flatMap(id => { const item = outbox[id - 1]; return item ? [[id, { sentAt: Date.now() - item.at >= 2_000 ? item.at + 2_000 : null, attempts: 0, lastError: null, nextAt: item.at }] as const] : []; })),
  robot: () => true,
  test: async (text: string) => { process.stdout.write(`[替身飞书·测试] ${text}\n`); },
};
const monitor = openMonitor(parseMonitorConfig({ anthropic: {}, oil: {}, hynix: {} }), dir, { fetchImpl: venues.fetch, WebSocketImpl: venues.WebSocket, alertHooks });
const store = openStore(join(dir, 'executor.sqlite'));
const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
const executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
if (!executor.acquire()) throw new Error('写入租约被占用');

const run = runExecutor({
  executor, store, dir, port, app, passes: [],
  views: { monitor: monitorViews(monitor), status: () => ({ monitor: { available: true, error: null, ...monitorStatus(monitor) } }) },
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
