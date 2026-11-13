import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { LOG_RETENTION_MS, createServiceLog, logLevel, teeStream } from '../src/service/service-log.ts';

const withLog = (run: (log: ReturnType<typeof createServiceLog>, clock: { at: number }) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-logs-'));
  const clock = { at: Date.UTC(2026, 10, 13, 4) };
  const log = createServiceLog({ file: join(dir, 'logs.sqlite'), now: () => clock.at });
  try { run(log, clock); } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
};

test('页面日志：按行写入，分出告警与问题，新到旧分页，筛选只看问题', () => withLog(log => {
  assert.equal(logLevel('告警：【划转结果未知】p1'), 'alert');
  assert.equal(logLevel('用户推送 ***abcd 断开：连接出错（代码 1006）'), 'problem');
  assert.equal(logLevel('ASTER 服务已启动（1 个配对）'), 'info');
  log.take('第一行\n告警：【服务启动】\n半');
  log.take('行\x1b[31m 带控制字符\n\n   \n');
  log.append('余额采样失败：磁盘已满');
  const all = log.page({ limit: 2 });
  assert.deepEqual(all.items.map(row => [row.level, row.text]), [['problem', '余额采样失败：磁盘已满'], ['info', '半行 [31m 带控制字符']]);
  assert.equal(all.next, all.items[1]!.id);
  const older = log.page({ before: Number(all.next), limit: 2 });
  assert.deepEqual(older.items.map(row => row.text), ['告警：【服务启动】', '第一行']);
  assert.equal(older.next, null);
  assert.deepEqual(log.page({ filter: 'problems' }).items.map(row => row.level), ['problem', 'alert']);
}));

test('页面日志：每分钟最多 1200 行，超出的下一分钟记一行说明；超过 14 天的清理', () => withLog((log, clock) => {
  for (let i = 0; i < 1205; i++) log.append(`第 ${i} 行`);
  assert.equal(log.page({ limit: 1 }).items[0]!.text, '第 1199 行');
  clock.at += 60_000;
  log.append('下一分钟');
  assert.deepEqual(log.page({ limit: 2 }).items.map(row => row.text), ['下一分钟', '日志过多：上一分钟有 5 行未写入页面日志（服务日志 journalctl 里完整）']);
  clock.at += LOG_RETENTION_MS + 60_000;
  log.append('两周后');
  log.prune();
  assert.deepEqual(log.page({}).items.map(row => row.text), ['两周后']);
}));

test('页面日志：复制写入的流，原输出不变，撤销后不再复制', () => withLog(log => {
  const seen: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, done) { seen.push(String(chunk)); done(); } }) as unknown as NodeJS.WriteStream;
  const undo = teeStream(stream, log);
  stream.write('一行\n');
  stream.write(Buffer.from('字节行\n'));
  undo();
  stream.write('撤销后\n');
  assert.deepEqual(seen, ['一行\n', '字节行\n', '撤销后\n']);
  assert.deepEqual(log.page({}).items.map(row => row.text), ['字节行', '一行']);
}));

test('页面日志：标准输出的半行不会和标准错误的整行拼在一起', () => withLog(log => {
  log.take('前半', '1');
  log.take('错误输出一整行\n', '2');
  log.take('后半\n', '1');
  assert.deepEqual(log.page({}).items.map(row => row.text).reverse(), ['错误输出一整行', '前半后半']);
}));
