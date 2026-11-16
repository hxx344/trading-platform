// A local preview of the oil and SK hynix pages on the simulated Binance and Bybit venues of src/simulation.ts: the
// executor (two-leg and rebalance jobs), the oil and hynix books and positions loops, and the hynix balance settings in a
// throwaway data directory, removed on exit. Nothing goes to the network. It starts with unequal hynix legs (Binance:
// short 10 ADR against long 0.9 ordinary share; Bybit: a single long ADR leg), so the balance panel has something to show.
// Unlike the service it takes no account locks and writes no environment marker, so it also runs on Windows.
//   pnpm build:web; node scripts/dev-hynix.ts [--port 4732]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/store.ts';
import { createExecutor } from '../src/executor.ts';
import { SIM_ACCOUNTS, SIM_BINDINGS, createSimulatedVenues } from '../src/simulation.ts';
import { runExecutor } from '../src/runtime.ts';
import { loadWebApp } from '../src/web-assets.ts';
import { createOilMarket } from '../src/oil/market.ts';
import { createHynixMarket } from '../src/hynix/market.ts';
import { hynixViews, oilLoops, oilViews, openHynixBalance, type OilRuntime } from '../src/service/oil.ts';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4732' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');
const app = loadWebApp();
const dir = mkdtempSync(join(tmpdir(), 'tp-dev-hynix-'));
const store = openStore(join(dir, 'executor.sqlite'));
const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
const executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
if (!executor.acquire()) throw new Error('写入租约被占用');
for (const binding of SIM_BINDINGS) executor.registerAccount(binding);

binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short', '10');
binance.setPosition(SIM_ACCOUNTS.binance, 'SKHYNIXUSDT', 'long', '0.9');
bybit.setPosition(SIM_ACCOUNTS.bybit, 'SKHYUSDT', 'long', '1');

const connectors = [binance, bybit];
// The service builds this in prepareOil after the live start checks; here the simulated venues stand in for the accounts.
const oil = {
  config: { accounts: SIM_BINDINGS }, connectors,
  market: createOilMarket({ connectors, accounts: SIM_BINDINGS, now: Date.now }),
  hynix: createHynixMarket({ connectors, accounts: SIM_BINDINGS, now: Date.now }),
  locks: { release() {} },
} as unknown as OilRuntime;
const balance = openHynixBalance(dir);
const log = (line: string) => process.stderr.write(`${line}\n`);

const run = runExecutor({
  executor, store, dir, port, app, passes: ['jobs'],
  views: { oil: oilViews(oil, executor), hynix: hynixViews(oil, executor, balance) },
  startedMessage: `原油与海力士预览（模拟交易所）已启动，数据目录 ${dir}`,
  background: context => oilLoops(oil, context, log),
  onStopped: async () => { balance.close(); },
});
let link = '';
for (let i = 0; i < 100 && !link; i++) {
  try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim().split('\n').at(-1)!; }
  catch { await new Promise(resolve => setTimeout(resolve, 50)); }
}
process.stdout.write(link ? `登录链接：${link}\n登录后打开：http://127.0.0.1:${port}/#/hynix\n按 Ctrl+C 停止（临时数据目录随之删除）\n` : '未能读到登录链接\n');
await run.done;
rmSync(dir, { recursive: true, force: true });
