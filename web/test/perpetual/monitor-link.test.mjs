// M-5c: the workbench's chart URL next to this page's hash route (web/src/monitor-link.ts and perpetual-chart-state.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedMonitorTab, perpetualWorkspaceLink, withoutMonitorLink } from '../../src/monitor-link.ts';
import { perpetualChartUrl, readPerpetualChartSelection } from '../../src/perpetual-chart-state.ts';

const selected = { base: 'ETH', longKey: 'binance:ETHUSDT', shortKey: 'bybit:ETHUSDT', days: 7 };

test('图表地址：查询参数放在 #/monitor 之前，hash 与其它参数保留，读回同一组合', () => {
  const href = perpetualChartUrl('https://tp.local/?lang=zh#/monitor', selected);
  const url = new URL(href);
  assert.equal(url.hash, '#/monitor');
  assert.equal(url.searchParams.get('lang'), 'zh');
  assert.equal(linkedMonitorTab(href), 'perpetual');
  assert.deepEqual(readPerpetualChartSelection(url.searchParams), selected);
  const swapped = new URL(perpetualChartUrl(href, { ...selected, longKey: selected.shortKey, shortKey: selected.longKey, days: 30 }));
  assert.equal(swapped.hash, '#/monitor');
  assert.deepEqual(readPerpetualChartSelection(swapped.searchParams), { ...selected, longKey: selected.shortKey, shortKey: selected.longKey, days: 30 });
});

test('离开图表或切换市场：去掉 monitor 与全部图表参数，hash 与其它参数保留', () => {
  const href = perpetualChartUrl('https://tp.local/?lang=zh#/monitor', selected);
  const left = withoutMonitorLink(href);
  assert.equal(left, 'https://tp.local/?lang=zh#/monitor');
  assert.equal(linkedMonitorTab(left), null);
  assert.equal(withoutMonitorLink('https://tp.local/#/options'), 'https://tp.local/#/options', '没有图表参数时不变');
});

test('无效链接：窗口或合约不合规时读不出组合（页面显示空态）', () => {
  for (const query of ['monitor=perpetual&perpView=chart', 'monitor=perpetual&perpView=chart&chartBase=ETH&chartLong=binance%3AETHUSDT&chartShort=bybit%3AETHUSDT&chartDays=5',
    'monitor=perpetual&perpView=chart&chartBase=ETH&chartLong=binance%3AETHUSDT&chartShort=binance%3AETHUSDT&chartDays=7']) {
    const url = new URL(`https://tp.local/?${query}#/monitor`);
    assert.equal(linkedMonitorTab(url.href), 'perpetual');
    assert.equal(readPerpetualChartSelection(url.searchParams), null, query);
  }
  assert.equal(linkedMonitorTab('not a url'), null);
});

test('M-5e1 持仓跟踪：带 monitor=perpetual 与 perpView=positions，去掉图表参数；回到发现机会全部去掉，hash 与其它参数保留', () => {
  const chart = perpetualChartUrl('https://tp.local/?lang=zh#/monitor', selected);
  const positions = new URL(perpetualWorkspaceLink(chart, 'positions'));
  assert.equal(positions.searchParams.get('monitor'), 'perpetual');
  assert.equal(positions.searchParams.get('perpView'), 'positions');
  assert.equal(readPerpetualChartSelection(positions.searchParams), null);
  assert.equal(positions.hash, '#/monitor');
  assert.equal(linkedMonitorTab(positions.href), 'perpetual');
  assert.equal(perpetualWorkspaceLink(positions.href, 'opportunities'), 'https://tp.local/?lang=zh#/monitor');
});
