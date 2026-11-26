import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createMarketClient } from '../../src/market/ipc.ts';
import { createMonitorData } from '../../src/market/monitor-data.ts';
import { createMarketServer } from '../../src/market/server.ts';
import { initialCrossExSettings, openCrossExSettingsStore, PERPETUAL_CROSSEX_FILE, PERPETUAL_CROSSEX_IMPORT_FILE } from '../../src/monitor/perpetual-crossex-store.ts';
import { createCrossExFilterService } from '../../src/vendor/perpetual-crossex-service.mjs';
import { filterCrossExRanking } from '../../src/vendor/perpetual-crossex-eligibility.ts';
import { visiblePerpetualSnapshot } from '../../src/vendor/perpetual-spreads.ts';
import { closeMonitor, openMonitor, settleMonitor, stopMonitor } from '../../src/service/monitor.ts';
import { fakePerpetualVenues } from '../perpetual-fake.ts';

const quiet = () => {};
test('从工作台导入的旧别名屏蔽同时覆盖页面报价与组合', () => {
  const quotes = ['BTC', 'LUNA2', 'BTCST'].map(base => ({ base }));
  const blocked = ['XBT', 'LUNA'];
  assert.deepEqual(visiblePerpetualSnapshot({ quotes }, new Set(blocked)).quotes, [quotes[2]]);
  assert.deepEqual(filterCrossExRanking(quotes, { config: { requireSpotTransfer: false, blockedBases: blocked } }, new Map(), Date.now()), [quotes[2]]);
});
async function until(read) {
  const deadline = Date.now() + 7_000;
  while (!read()) { assert.ok(Date.now() < deadline, '等待报价、汇率或资格采集超时'); await pause(20); }
}

test('待导入设置可在运行中或中断后载入；并发的旧页面、重复导入均不能覆盖已保存设置', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-crossex-import-')), file = join(dir, PERPETUAL_CROSSEX_FILE), pending = join(dir, PERPETUAL_CROSSEX_IMPORT_FILE);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openCrossExSettingsStore(dir, quiet), service = createCrossExFilterService({ store });
  const incoming = { ...initialCrossExSettings(), config: { requireSpotTransfer: true, blockedBases: ['btc'] } };
  const tmp = join(dir, 'helper.tmp');
  writeFileSync(tmp, JSON.stringify(incoming), { mode: 0o600 });
  linkSync(tmp, pending);
  await assert.rejects(service.update({ revision: 0, config: { requireSpotTransfer: false } }), { status: 409 });
  unlinkSync(tmp);
  assert.equal(service.view().revision, 1);
  assert.deepEqual(service.view().config, { requireSpotTransfer: true, blockedBases: ['BTC'] });
  await service.update({ revision: 1, config: { requireSpotTransfer: false, blockedBases: ['ETH'] } });
  writeFileSync(pending + '.loading', JSON.stringify(incoming));
  const restarted = openCrossExSettingsStore(dir, quiet);
  assert.deepEqual(restarted.get().config.blockedBases, ['ETH']);
  assert.equal(existsSync(pending + '.loading'), false);
  unlinkSync(file);
  writeFileSync(pending + '.loading', JSON.stringify(incoming));
  assert.equal(openCrossExSettingsStore(dir, quiet).get().config.requireSpotTransfer, true);
  unlinkSync(file);
  writeFileSync(pending, 'malformed');
  assert.deepEqual(openCrossExSettingsStore(dir, quiet).get(), initialCrossExSettings());
  assert.equal(readFileSync(pending + '.loading.rejected', 'utf8'), 'malformed');
  assert.equal(existsSync(file), false);
});

test('行情 IPC 为 v2 后台采集公开汇率及现货充提资料，设置立即过滤两代信号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-opportunity-ipc-'));
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\tp-opportunity-' + randomUUID() : join(dir, 'market.sock');
  const venue = fakePerpetualVenues(), transfers = [];
  const options = { ...venue, now: Date.now, observationIntervalMs: 0,
    async discover(exchange, opts) {
      const rows = await venue.discover(exchange, opts);
      return rows.map(q => ({ ...q, multiplier: 1, collateralCurrency: q.quoteCurrency, crossexVerified: true, delisting: !!q.delisting, delistingAt: q.delistingAt ?? null }));
    },
    parse(exchange, ...args) {
      const rows = venue.parse(exchange, ...args);
      const price = { binance: 100, bybit: 104, okx: 105, lighter: 108, hyperliquid: 109 }[exchange];
      return rows.map(q => ({ ...q, bid: price, ask: price + 1, ...(exchange === 'lighter' ? { sourceTime: null } : {}) }));
    },
    crossEx: { read: async (exchange, signal) => {
      signal.throwIfAborted(); transfers.push(exchange);
      return { at: Date.now(), assets: new Map([['BTC', { base: 'BTC', spotSymbols: ['BTCUSDT'], networks: [{ network: 'BTC', contract: '', deposit: true, withdraw: true }] }]]) };
    } },
  };
  const worker = createMarketServer({ monitor: createMonitorData({ perpetual: options, log: quiet }) }, 'opportunities');
  await new Promise((resolve, reject) => { worker.server.once('error', reject); worker.server.listen(socket, resolve); });
  const client = createMarketClient(socket);
  const runtime = openMonitor({ perpetual: {} }, dir, { marketClient: client, log: quiet });
  const perp = runtime.perpetual;
  try {
    perp.start();
    await until(() => perp.opportunities(2).signals.some(signal => signal.short.settlementCurrency === 'USDC') && perp.opportunities(1).signals.length);
    const cross = perp.opportunities(2).signals.find(signal => signal.short.settlementCurrency === 'USDC');
    assert.ok(cross.referenceSellPrice < cross.short.bid);
    assert.ok(cross.expiresAt <= cross.observedAt + 10_000);
    await until(() => perp.opportunities(2).quotes.some(q => q.exchange === 'lighter'));
    assert.ok(perp.snapshot().quotes.some(q => q.exchange === 'lighter' && q.bidAskAt), '页面可展示本地收包时间');
    assert.ok(perp.opportunities(2).quotes.filter(q => q.exchange === 'lighter').every(q => q.bidAskAt === undefined));
    assert.ok(perp.opportunities(2).signals.every(s => s.long.exchange !== 'lighter' && s.short.exchange !== 'lighter'));
    assert.deepEqual(transfers, []);
    await perp.updateCrossExSettings({ revision: 0, config: { requireSpotTransfer: true, blockedBases: [] } });
    await until(() => perp.crossExSettings().spotTransferPairs.length);
    assert.deepEqual(perp.crossExSettings().spotTransferPairs[0].networks, ['BTC']);
    assert.deepEqual(transfers.sort(), ['binance', 'gate']);
    assert.deepEqual(perp.opportunities(2).signals, [], '替身没有 Gate 合约，没有双边通过充提核验的机会');
    const base = cross.base;
    await perp.updateCrossExSettings({ revision: 1, config: { requireSpotTransfer: false, blockedBases: [base] } });
    for (const v of [1, 2]) assert.ok(perp.opportunities(v).signals.every(signal => signal.base !== base));
    assert.equal(perp.opportunities(2).crossexFilter.revision, 2);
    assert.deepEqual(transfers.sort(), ['binance', 'gate'], '重复读机会不触发上游请求');
    perp.stop();
    assert.equal(perp.opportunities(2).fx, null);
    assert.deepEqual(perp.opportunities(2).signals, []);
  } finally {
    stopMonitor(runtime); await settleMonitor(runtime); closeMonitor(runtime); client.close(); worker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
