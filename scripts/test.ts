// Runs the test suite: `pnpm test` runs every file, extra arguments go to `node --test` (before the files).
// With TEST_SHARD=i/n only shard i of n runs. Files are dealt longest first, each to the shard with the least time so
// far, by scripts/test-durations.json (milliseconds per file on a CI runner); a file not listed counts as the median.
// The n shards together run every file exactly once whatever the durations say; stale durations only unbalance them.
// `node scripts/test.ts --measure` runs each file on its own, three at a time, and rewrites the durations file; a file
// that fails keeps its old duration and the command exits 1. The ci workflow's manual run does this on a CI runner.
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const durationsFile = fileURLToPath(new URL('test-durations.json', import.meta.url));
const patterns = ['test/*.test.ts', 'test/crossex/*.test.mjs', 'web/test/*.test.mjs', 'web/test/crossex/*.test.mjs', 'test/perpetual/*.test.mjs', 'test/ondo/*.test.mjs', 'web/test/perpetual/*.test.mjs'];
const files = [...new Set(patterns.flatMap(pattern => globSync(pattern, { cwd: root })))].sort();

export function shardFiles(all: readonly string[], durations: Record<string, number>, index: number, total: number): string[] {
  const known = all.map(file => durations[file]).filter((ms): ms is number => typeof ms === 'number' && ms >= 0).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (file: string) => { const ms = durations[file]; return typeof ms === 'number' && ms >= 0 ? ms : fallback; };
  const order = [...all].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const load = new Array<number>(total).fill(0);
  const picked: string[] = [];
  for (const file of order) {
    let target = 0;
    for (let i = 1; i < total; i++) if (load[i] < load[target]) target = i;
    load[target] += weight(file);
    if (target === index - 1) picked.push(file);
  }
  return picked.sort();
}

function readDurations(): Record<string, number> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(durationsFile, 'utf8')); } catch (error) { process.stderr.write(`读不到 ${durationsFile}（${(error as Error).message}），按空表处理\n`); return {}; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, number>;
  process.stderr.write(`${durationsFile} 不是对象，按空表处理\n`);
  return {};
}

async function measure(): Promise<void> {
  const previous = readDurations();
  const result: Record<string, number> = {};
  let failed = 0;
  const queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const started = performance.now();
      const code = await new Promise<number | null>(resolve => spawn(process.execPath, ['--test', '--test-reporter=dot', file], { cwd: root, stdio: 'ignore' }).on('close', resolve).on('error', () => resolve(null)));
      const ms = Math.round(performance.now() - started);
      if (code === 0) result[file] = ms;
      else { failed++; if (typeof previous[file] === 'number') result[file] = previous[file]; }
      process.stderr.write(`${ms} ms ${code === 0 ? '' : '（失败，保留原值）'}${file}\n`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  writeFileSync(durationsFile, JSON.stringify(Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + '\n');
  if (failed) { process.stderr.write(`${failed} 个文件失败\n`); process.exitCode = 1; }
}

if (import.meta.main) {
  if (process.argv[2] === '--measure') {
    await measure();
  } else {
    let selected = files;
    const shard = process.env.TEST_SHARD;
    if (shard) {
      const match = /^(\d+)\/(\d+)$/.exec(shard);
      const index = Number(match?.[1]), total = Number(match?.[2]);
      if (!match || index < 1 || index > total) { process.stderr.write(`TEST_SHARD 须形如 1/6，收到 ${shard}\n`); process.exit(2); }
      selected = shardFiles(files, readDurations(), index, total);
      process.stderr.write(`分片 ${shard}：${selected.length} / ${files.length} 个文件\n`);
      // node --test with no files would fall back to its own default patterns.
      if (!selected.length) process.exit(0);
    }
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...process.argv.slice(2), ...selected], { cwd: root, stdio: 'inherit' });
    if (run.status === null) process.stderr.write(`node --test 未正常结束：${run.error?.message ?? `信号 ${run.signal}`}\n`);
    process.exit(run.status ?? 1);
  }
}
