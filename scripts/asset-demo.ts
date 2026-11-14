// Local preview of the asset page with made-up data: writes a workbench-style ledger (test/asset-fixture.ts), imports
// it with src/asset/import.ts and serves the built page beside simulated venues, the way src/main.ts runs them.
//   pnpm build:web; node scripts/asset-demo.ts --data-dir <absolute empty directory> [--port 4730]
// The login link is written to <data-dir>/access-url. Nothing here touches a real ledger or exchange: the sync and the
// connection checks read the made-up sources below (a credential whose key or address contains "fail" is refused).
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/store.ts';
import { createExecutor, type Executor } from '../src/executor.ts';
import { DATABASE_FILES, assertDedicatedDataDir } from '../src/data-dir.ts';
import { SIM_BINDINGS, createSimulatedVenues } from '../src/simulation.ts';
import { runExecutor } from '../src/runtime.ts';
import { loadWebApp } from '../src/web-assets.ts';
import { ASSET_DB_FILE } from '../src/asset/db.ts';
import { importLedger } from '../src/asset/import.ts';
import { createAssetStore } from '../src/asset/store.ts';
import type { AssetSources } from '../src/asset/sync.ts';
import type { Balance } from '../src/asset/types.ts';
import { OWNER, writeWorkbenchLedger } from '../test/asset-fixture.ts';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, port: { type: 'string', default: '4730' } } });
if (!values['data-dir']) throw new Error('需要 --data-dir <独立目录的绝对路径>');
const dir = assertDedicatedDataDir(values['data-dir']);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');
// The import below replaces asset.sqlite, so only an empty directory or one this script made is accepted.
const DEMO_MARKER = 'asset-demo';
if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, DEMO_MARKER))) throw new Error(`${dir} 不是空目录，也不是本脚本建的示例目录；请换一个空目录`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, DEMO_MARKER), '资产页示例数据目录，可以整个删除\n');

const source = join(dir, 'demo-workbench-ledger.sqlite');
// Rewritten on every start so the dates stay around today.
rmSync(source, { force: true });
writeWorkbenchLedger(source, { now: Date.now() });
const imported = importLedger({ from: source, owner: OWNER, dataDir: dir });
process.stdout.write(`示例账本已导入：资产 ${imported.assets} 条，快照 ${imported.snapshots} 条\n`);

const app = loadWebApp();
/** Made-up readers: fixed balances after a short delay, so the page's busy states show. */
const pause = () => new Promise(resolve => setTimeout(resolve, 400));
const balance = (coin: string, account: string, quantity: number): Balance => ({ coin, account, quantity, value: quantity, price: 1 });
const read = async (credential: { apiKey?: string; walletAddress?: string; token?: string }, total: number) => {
  await pause();
  if (JSON.stringify(credential).toLowerCase().includes('fail')) throw new Error('示例：API Key 无效或权限不足');
  return { total, details: [balance('USDT', '合约', total * 0.8), balance('USDC', '现货', total * 0.2)], updatedAt: new Date().toISOString() };
};
const demoSources: AssetSources = {
  async quotes() { await pause(); const at = new Date().toISOString(); return { VIRTUAL: { price: 1.23, at, source: '示例' }, USDT: { price: 1, at, source: '示例' }, USDC: { price: 1, at, source: '示例' } }; },
  async yuanQuote() { await pause(); return { rate: 7.12, status: { source: 'Coinbase', fetchedAt: new Date().toISOString(), rateDate: null, error: null } }; },
  syncBinance: c => read(c, 12_345.67), syncBybit: c => read(c, 8_765.43), syncAster: c => read(c, 2_500),
  validateAsterWallet: c => ({ address: c.walletAddress }),
  syncOkx: c => read(c, 3_210), syncGate: c => read(c, 1_100), syncVariational: c => read(c as never, 640),
  syncHyperliquid: c => read(c, 4_400), syncRhLighter: c => read(c, 950),
};
const asset = createAssetStore(join(dir, ASSET_DB_FILE), { sources: demoSources });
// The environment marker is left out: its directory fsync is refused on Windows, and this directory only ever holds the demo.
const store = openStore(join(dir, DATABASE_FILES.simulated));
const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
const executor: Executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
if (!executor.acquire()) throw new Error('另一个实例持有这个数据目录的写入租约；等它的租约过期后再启动，或换一个数据目录');
for (const binding of SIM_BINDINGS) executor.registerAccount(binding);

runExecutor({ executor, store, dir, port, app, views: { asset }, startedMessage: `资产页示例（模拟交易所）已启动，打开 http://127.0.0.1:${port}/#/asset`, onStopped: () => asset.close() });
