import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampedBandY, inPlotDomain } from '../src/svg-plot-geometry.ts';

test('inPlotDomain respects domain bounds regardless of order', () => {
  assert.equal(inPlotDomain(10, [-20, 20]), true);
  assert.equal(inPlotDomain(-20, [-20, 20]), true);
  assert.equal(inPlotDomain(20, [-20, 20]), true);
  assert.equal(inPlotDomain(20.1, [-20, 20]), false);
  assert.equal(inPlotDomain(-20.1, [-20, 20]), false);
  assert.equal(inPlotDomain(0, [10, -10]), true);
});

test('clampedBandY clamps zones to the plot rectangle', () => {
  const y = value => 200 - (value + 10) * 10;
  assert.deepEqual(clampedBandY(-5, 5, y, 20, 220), { y: 50, height: 100 });
  assert.deepEqual(clampedBandY(-20, 20, y, 20, 220), { y: 20, height: 200 });
  assert.deepEqual(clampedBandY(50, 60, y, 20, 220), { y: 20, height: 0 });
  assert.deepEqual(clampedBandY(-50, -40, y, 20, 220), { y: 220, height: 0 });
  assert.deepEqual(clampedBandY(5, -5, y, 20, 220), { y: 50, height: 100 });
  const invertedY = value => 20 + (value + 10) * 10;
  assert.deepEqual(clampedBandY(-5, 5, invertedY, 20, 220), { y: 70, height: 100 });
  assert.deepEqual(clampedBandY(5, -5, invertedY, 20, 220), { y: 70, height: 100 });
});

test('SvgPlot renders overlays outside clipPath without inline style attributes', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/svg-plot.tsx'), 'utf8');
  assert.equal(/\sstyle=/.test(source), false, 'SvgPlot 不得写 JSX style= 属性');
  const clipStart = source.indexOf('<g clipPath={`url(#${clip})`}');
  assert.ok(clipStart >= 0);
  const clipTagRe = /<g(?:\s|>)|<\/g>/g;
  clipTagRe.lastIndex = clipStart;
  let depth = 0;
  let clipClose = -1;
  for (let match = clipTagRe.exec(source); match; match = clipTagRe.exec(source)) {
    depth += match[0] === '</g>' ? -1 : 1;
    if (depth === 0) {
      clipClose = match.index;
      break;
    }
  }
  const overlayIndex = source.indexOf('{overlay?.(');
  assert.ok(clipClose > clipStart && overlayIndex > clipClose, 'overlay 须位于绘图区 clipPath 之外');
});
