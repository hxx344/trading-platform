// 资金费组合页（docs/fundingbook.md）的本地预览：替身行情（四个场所、四个标的，确定的资金费与价格序列），不联网、
// 不用任何密钥。启动时参数已启用，几秒内补齐历史并出第一轮规划；加 --fresh 从「未启用」开始看设置页。
//   pnpm build:web; node scripts/dev-fundingbook.ts [--port 4735] [--fresh]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/store.ts';
import { createExecutor } from '../src/executor.ts';
import { createSimulatedVenues } from '../src/simulation.ts';
import { runExecutor } from '../src/runtime.ts';
import { loadWebApp } from '../src/web-assets.ts';
import type { MarketSource, SourceQuote } from '../src/fundingbook/engine.ts';
import { DEFAULT_SETTINGS } from '../src/fundingbook/model.ts';
import { HOUR } from '../src/fundingbook/stats.ts';
import { FUNDINGBOOK_FILE, openFundingBookStore } from '../src/fundingbook/store.ts';
import { openFundingBook } from '../src/service/fundingbook.ts';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4735' }, fresh: { type: 'boolean', default: false } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');

// 年化资金费（多头付为正）：BTC 在 Lighter 明显偏高，BNB 各所接近（只有对冲价值），SOL 有小息差，ETH 几乎没有。
const APR: Record<string, Record<string, number>> = {
  lighter: { BTC: 0.101, ETH: 0.035, SOL: 0.062, BNB: 0.030 }, bybit: { BTC: 0.0283, ETH: 0.034, SOL: 0.021, BNB: 0.0411 },
  bitget: { BTC: 0.0144, ETH: 0.036, SOL: 0.035, BNB: 0.0328 }, okx: { BTC: 0.022, ETH: 0.033, SOL: 0.03, BNB: 0.035 },
};
const PRICE: Record<string, number> = { BTC: 103_400, ETH: 3_420, SOL: 187, BNB: 912 };
// 各标的对共同因子的敞口与自身波动：BNB、ETH 与 BTC 高度相关。
const LOADING: Record<string, [number, number, number]> = { BTC: [1, 0.25, 0], ETH: [1.25, 0.5, 1], SOL: [1.5, 0.9, 2], BNB: [1, 0.45, 3] };
const interval = (venue: string): number => venue === 'lighter' ? HOUR : 8 * HOUR;
const symbolOf = (venue: string, base: string): string => venue === 'lighter' ? base : venue === 'okx' ? `${base}-USDT-SWAP` : `${base}USDT`;
const baseOf = (symbol: string): string => Object.keys(PRICE).find(base => symbol.startsWith(base))!;
function level(base: string, time: number): number {
  const k = time / HOUR, [common, own, phase] = LOADING[base]!;
  return PRICE[base]! * Math.exp(0.0042 * (common * (Math.sin(k * 1.7) + Math.sin(k * 0.37)) + own * Math.sin(k * 2.9 + phase)));
}
const source: MarketSource = {
  running: () => true,
  quotes: () => Object.keys(APR).flatMap(venue => Object.keys(PRICE).map((base): SourceQuote => {
    const mark = level(base, Date.now()), hours = interval(venue) / HOUR;
    return { exchange: venue, symbol: symbolOf(venue, base), base, quoteCurrency: venue === 'lighter' ? 'USDC' : 'USDT', bid: mark * 0.9999, ask: mark * 1.0001, mark, last: mark,
      fundingRate: APR[venue]![base]! / 8760 * hours * (1 + 0.3 * Math.sin(Date.now() / 60_000)), fundingIntervalHours: hours };
  })),
  async funding(venue, symbol, range) {
    const step = interval(venue), base = baseOf(symbol), records = [];
    // 逐次结算围绕均值上下浮动，短窗口与长窗口因此略有差别。
    for (let time = Math.ceil(range.from / step) * step; time <= range.to; time += step) records.push({ time, rate: APR[venue]![base]! / 8760 * step / HOUR * (1 + 0.6 * Math.sin(time / (5 * 24 * HOUR))) });
    return records;
  },
  async price(_venue, symbol, range) {
    const base = baseOf(symbol), points = [];
    for (let time = Math.floor(range.from / HOUR) * HOUR + HOUR; time <= range.to; time += HOUR) points.push({ time, close: level(base, time) });
    return points;
  },
};

const app = loadWebApp();
const dir = mkdtempSync(join(tmpdir(), 'tp-dev-fundingbook-'));
if (!values.fresh) {
  const seed = openFundingBookStore(join(dir, FUNDINGBOOK_FILE));
  seed.saveSettings({ ...DEFAULT_SETTINGS, enabled: true, roundMinutes: 5 }, Date.now());
  seed.close();
}
const fundingbook = openFundingBook(dir, () => source, {}, { log: line => process.stderr.write(`${line}\n`) });

const store = openStore(join(dir, 'executor.sqlite'));
const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
const service = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
if (!service.acquire()) throw new Error('写入租约被占用');
const run = runExecutor({
  executor: service, store, dir, port, app, passes: [],
  views: { fundingbook: fundingbook.views },
  startedMessage: `资金费组合预览（替身行情）已启动，数据目录 ${dir}`,
  background: context => [fundingbook.loop(context)],
});
let link = '';
for (let i = 0; i < 100 && !link; i++) {
  try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim().split('\n').at(-1)!; }
  catch { await new Promise(resolve => setTimeout(resolve, 50)); }
}
process.stdout.write(link ? `登录链接：${link}\n登录后打开：http://127.0.0.1:${port}/#/fundingbook\n按 Ctrl+C 停止（临时数据目录随之删除）\n` : '未能读到登录链接\n');
await run.done;
rmSync(dir, { recursive: true, force: true });
