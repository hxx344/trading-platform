// The page stylesheets are concatenated into one file by the build, so a block left open in one of them swallows every
// file imported after it: v0.54.0–v0.59.0 shipped positions.css with its last `@media(pointer:coarse){` unclosed, and the
// options, CrossEx and (unreleased) Ondo styles only applied on touch screens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

test('页面样式文件的花括号都闭合', () => {
  const files = globSync('web/src/**/*.css', { cwd: root });
  assert.ok(files.length > 5);
  for (const file of files) {
    // Comments and strings can hold braces of their own.
    const text = readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
    let depth = 0;
    for (const char of text) {
      if (char === '{') depth += 1;
      else if (char === '}') { depth -= 1; assert.ok(depth >= 0, `${file} 有多余的 }`); }
    }
    assert.equal(depth, 0, `${file} 有 ${depth} 个没闭合的 {`);
  }
});
