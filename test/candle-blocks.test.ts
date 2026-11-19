import assert from 'node:assert/strict';
import test from 'node:test';
import { candleKnown, mergeCandleBlocks } from '../src/candle-blocks.ts';
import { encodeCandleBlocks } from '../src/candle-blocks-server.ts';

type Candle = { time: number; price: number | null };
const span = 1_000;
const candles = (...times: number[]): Candle[] => times.map(time => ({ time, price: time }));

test('切大窗口只取缺段，窗口边界在已取过的段内移动时传零行', () => {
  const all = candles(100, 200, 1_000, 1_100, 2_000, 2_100, 3_000);
  const last = mergeCandleBlocks([], encodeCandleBlocks(all, span, '', 2_050), span);
  assert.deepEqual(last.flatMap(b => b.rows), all.slice(-3));
  const expanded = encodeCandleBlocks(all, span, candleKnown(last), 1_090);
  assert.deepEqual(expanded.blocks.flatMap(b => b.rows ?? []), all.slice(2, 4));
  const merged = mergeCandleBlocks(last, expanded, span);
  assert.deepEqual(merged.flatMap(b => b.rows), all.slice(2));
  const steady = encodeCandleBlocks(all, span, candleKnown(merged), 1_100);
  assert.equal(steady.blocks.flatMap(b => b.rows ?? []).length, 0);
  assert.equal(mergeCandleBlocks(merged, steady, span), merged);
  assert.deepEqual(mergeCandleBlocks(merged, encodeCandleBlocks(all, span, candleKnown(merged), 3_000), span).flatMap(b => b.rows), all.slice(-1));
});

test('新增、补旧缺口、同一时刻补腿或修价、删除旧行都按时间合并', () => {
  const before = candles(100, 200, 400, 2_000, 2_100, 2_200, 2_300, 3_100, 3_200);
  before[0]!.price = null;
  const saved = mergeCandleBlocks([], encodeCandleBlocks(before, span, ''), span);
  const after = candles(100, 200, 300, 400, 2_000, 2_100, 2_300, 3_100, 3_200, 3_300);
  after[5]!.price = 55;
  const response = encodeCandleBlocks(after, span, candleKnown(saved));
  assert.deepEqual(response.blocks.flatMap(b => b.rows ?? []).map(row => row.time), [100, 300, 2_100, 3_300]);
  assert.deepEqual(response.blocks.flatMap(b => b.removed ?? []), [2_200]);
  assert.deepEqual(mergeCandleBlocks(saved, response, span).flatMap(b => b.rows), after);
  assert.throws(() => mergeCandleBlocks([], response, span), /缺少/);
  assert.deepEqual(saved.flatMap(b => b.rows), before);
});

test('平台进程重启仍复用不变的内容，只有基准已逐出且有修改的区块需要重传', async () => {
  const before = candles(10, 20, 1_000, 1_010, 2_000);
  const saved = mergeCandleBlocks([], encodeCandleBlocks(before, span, ''), span);
  const fresh = await import(new URL('../src/candle-blocks-server.ts?restart', import.meta.url).href) as typeof import('../src/candle-blocks-server.ts');
  const after = [...before.map(row => row.time === 1_010 ? { ...row, price: 7 } : row), ...candles(2_020)];
  const response = fresh.encodeCandleBlocks(after, span, candleKnown(saved));
  assert.deepEqual(response.blocks.flatMap(b => b.rows ?? []).map(row => row.time), [1_000, 1_010, 2_020]);
  assert.deepEqual(mergeCandleBlocks(saved, response, span).flatMap(b => b.rows), after);
});
