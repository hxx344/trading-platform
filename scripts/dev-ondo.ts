// A local preview of the Ondo page (docs/ondo.md): the module in a throwaway data directory, with the reward collector
// reading a simulated public book (a random walk per market, about 0.04% a minute, depth thinning away from the mid)
// instead of Ondo: a simulated feed pushes every market about 4 times a second while open, except the eighth market,
// which it leaves to the REST fallback. Nothing goes to the network as long as the quoting session is not started; there
// is no API key, so live mode is refused. The 1-minute volatility shows after about 10 minutes (20 returns).
// Removed on exit, like scripts/dev-hynix.ts.
//   pnpm build:web; node scripts/dev-ondo.ts [--port 4733]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/store.ts';
import { createExecutor } from '../src/executor.ts';
import { runExecutor } from '../src/runtime.ts';
import { loadWebApp } from '../src/web-assets.ts';
import { createOndoModule } from '../src/service/ondo.ts';
import { REWARD_MARKETS } from '../src/ondo/rewards.ts';
import type { OndoClient } from '../src/vendor/ondo/client.mjs';
import { parseOndoBook, type OndoStreamFactory } from '../src/vendor/ondo/stream.mjs';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4733' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');
const app = loadWebApp();
const dir = mkdtempSync(join(tmpdir(), 'tp-dev-ondo-'));
const store = openStore(join(dir, 'executor.sqlite'));
const executor = createExecutor({ store, connectors: [] });
if (!executor.acquire()) throw new Error('写入租约被占用');

// Each market: a starting price, a 1-minute σ and how much size rests near the mid.
const books = new Map(REWARD_MARKETS.map((market, i) => [market, {
  mid: [6800, 24_000, 40, 30, 120, 330, 180, 25, 22, 700, 160, 260, 380, 45, 90, 4000, 50, 62, 95_000, 3500][i] ?? 100,
  sigma: 0.0002 + 0.0001 * (i % 7), depth: 2000 * (1 + (i * 7919) % 13), at: Date.now(),
}]));
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const side = (mid: number, depth: number, sign: 1 | -1, tick: number): [string, string][] => Array.from({ length: 80 }, (_, i) => {
  const price = Math.round((mid * (1 + sign * (0.5 + i * 0.35) / 1e4)) / tick) * tick;
  const usd = depth * Math.exp(-i / 18) * (0.4 + Math.random());
  // The feed refuses a zero size, as Ondo never sends one.
  return [price.toFixed(4), Math.max(usd / price, 0.001).toFixed(3)];
});
const snapshot = (market: string) => {
  const book = books.get(market);
  if (!book) throw new Error(`未知市场 ${market}`);
  const now = Date.now();
  book.mid *= Math.exp(book.sigma * Math.sqrt((now - book.at) / 60_000) * gauss());
  book.at = now;
  return { market, bids: side(book.mid, book.depth, -1, 0.0001), asks: side(book.mid, book.depth, 1, 0.0001) };
};
const feed: OndoStreamFactory = ({ markets, onBook }) => {
  let timer: NodeJS.Timeout | undefined;
  return {
    start() {
      timer = setInterval(() => {
        // A market added on the page that the simulation does not know is left to the REST fallback (which reports it).
        for (const market of markets) if (market !== REWARD_MARKETS[7] && books.has(market)) onBook(market, parseOndoBook({ time: new Date().toISOString(), ...snapshot(market) }), Date.now());
      }, 250);
    },
    status: () => ({ connected: true, publicReady: true, privateReady: false, lastFrameAt: Date.now(), error: null }),
    close() { clearInterval(timer); },
  };
};
const client = {
  async markets() { return new Map(REWARD_MARKETS.map((market, i) => [market, { tick: '0.0001', step: '0.001', trading: i !== 7, makerFee: i % 3 === 0 ? null : '0.0001' }])); },
  async depth(market: string) { return snapshot(market); },
  close() {},
} as unknown as OndoClient;

const log = (line: string) => process.stderr.write(`${line}\n`);
const ondo = await createOndoModule({}, undefined, dir, { log, rewardsClient: () => client, rewardsStream: feed });
const run = runExecutor({
  executor, store, dir, port, app, passes: [],
  views: { ondo: ondo.views },
  startedMessage: `Ondo 预览（模拟盘口）已启动，数据目录 ${dir}`,
  background: context => [ondo.loop(context)],
  onStopped: async () => { await ondo.close(); },
});
let link = '';
for (let i = 0; i < 100 && !link; i++) {
  try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim().split('\n').at(-1)!; }
  catch { await new Promise(resolve => setTimeout(resolve, 50)); }
}
process.stdout.write(link ? `登录链接：${link}\n登录后打开：http://127.0.0.1:${port}/#/ondo\n按 Ctrl+C 停止（临时数据目录随之删除）\n` : '未能读到登录链接\n');
await run.done;
rmSync(dir, { recursive: true, force: true });
