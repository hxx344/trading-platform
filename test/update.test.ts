// Online update (docs/update.md): the service's release check and hand-off, the root helper, and the HTTP routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  UPDATE_READY_FILE, UPDATE_REQUEST_FILE, UPDATE_RESULT_FILE, compareVersions, createUpdates, parseRelease, readInstalledVersion, readUpdateResult,
  releaseNotes, updateReadyFile, type InstalledVersion, type UpdateFetch, type UpdateResult,
} from '../src/service/update.ts';
import { assertNonRootOwner, checksumOf, recoverUpdate, runUpdateHelper, takeUpdateRequest } from '../src/service/update-helper.ts';
import { createExecutorServer } from '../src/http.ts';
import { bindAccounts, createHarness } from './harness.ts';

const CURRENT: InstalledVersion = { version: 'v0.49.1', commit: 'abc1234def56', packaged: true };
const NOTES = '## 更新说明\n- 新功能一\n- 修复二\n\n## 安装或升级\n\n```bash\ncurl …\n```\n';
const release = (tag = 'v0.50.0', extra: Record<string, unknown> = {}) => ({ tag_name: tag, name: tag, body: NOTES, published_at: '2026-11-16T08:00:00Z', html_url: `https://github.com/hxx344/trading-platform/releases/tag/${tag}`, ...extra });
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'tp-update-test-')); }

/** A fake clock and GitHub; each fetch takes the next scripted answer. */
function setup(answers: (() => Response | Promise<Response>)[], { ready = true, dir = tempDir() as string | null } = {}) {
  let clock = 1_800_000_000_000;
  const calls: string[] = [];
  const fetchImpl: UpdateFetch = async url => { calls.push(url); const next = answers.shift(); if (!next) throw new Error('没有更多应答'); return next(); };
  if (dir && ready) writeFileSync(join(dir, UPDATE_READY_FILE), 'v0.50.0\n');
  const logs: string[] = [];
  const updates = createUpdates({ current: CURRENT, dir, readyFile: dir ? join(dir, UPDATE_READY_FILE) : null, fetchImpl, now: () => clock, log: line => { logs.push(line); } });
  return { updates, calls, logs, dir, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

const API_URL = 'https://api.github.com/repos/hxx344/trading-platform/releases/latest';
const PAGE_URL = 'https://github.com/hxx344/trading-platform/releases/latest';
/** github.com's answer to releases/latest: a redirect to the latest release's tag page. */
const redirect = (tag: string, base = 'https://github.com/hxx344/trading-platform') => () => new Response(null, { status: 302, headers: { location: `${base}/releases/tag/${tag}` } });

test('在线更新：版本比较与更新说明只取「更新说明」一节', () => {
  assert.equal(compareVersions('v0.50.0', 'v0.49.1'), 1);
  assert.equal(compareVersions('v0.49.1', 'v0.49.10'), -1);
  assert.equal(compareVersions('v1.0.0', 'v1.0.0'), 0);
  assert.throws(() => compareVersions('0.50.0', 'v0.49.1'), /版本号无效/);
  assert.equal(releaseNotes(NOTES), '- 新功能一\n- 修复二');
  assert.equal(releaseNotes('只有一行说明'), '只有一行说明');
  const parsed = parseRelease(release('v0.50.0', { html_url: 'https://evil.example/x' }));
  assert.equal(parsed.url, 'https://github.com/hxx344/trading-platform/releases/tag/v0.50.0', '仓库外的链接换成本仓库的 Release 页');
  assert.throws(() => parseRelease(release('v0.50.0-rc1')), /vX\.Y\.Z/);
});

test('在线更新：读已装版本取 VERSION 文件，没有时取 package.json', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'package.json'), '{"version":"0.49.1"}');
    assert.deepEqual(readInstalledVersion(dir), { version: 'v0.49.1', commit: null, packaged: false });
    writeFileSync(join(dir, 'VERSION'), 'v0.50.0 0123456789ab\n');
    assert.deepEqual(readInstalledVersion(dir), { version: 'v0.50.0', commit: '0123456789ab', packaged: true });
    writeFileSync(join(dir, 'VERSION'), 'garbage\n');
    assert.throws(() => readInstalledVersion(dir), /版本号无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('在线更新：检查成功后显示可更新；手动检查 60 秒内只一次；失败后退避', async () => {
  const s = setup([() => answer(200, release()), () => answer(500, {}), () => answer(200, release('v0.50.1'))]);
  try {
    assert.equal(s.updates.status().available, false);
    await s.updates.tick();
    assert.equal(s.calls.length, 0, '启动后 1 分钟内不检查');
    s.advance(60_000);
    await s.updates.tick();
    let view = s.updates.status();
    assert.equal(view.latest?.version, 'v0.50.0');
    assert.equal(view.latest?.notes, '- 新功能一\n- 修复二');
    assert.equal(view.available, true);
    assert.equal(view.enabled, true);
    assert.equal(view.error, null);
    assert.match(s.calls[0]!, /^https:\/\/api\.github\.com\/repos\/hxx344\/trading-platform\/releases\/latest$/);
    await s.updates.check();
    view = s.updates.status();
    assert.equal(view.error, 'GitHub 返回 HTTP 500');
    assert.equal(view.latest?.version, 'v0.50.0', '失败不清掉上次结果');
    await assert.rejects(s.updates.check(), (error: Error & { status?: number }) => error.status === 429 && /秒后再检查/.test(error.message));
    await s.updates.tick();
    assert.equal(s.calls.length, 2, '失败后 1 分钟内不自动重试');
    s.advance(60_000);
    await s.updates.tick();
    assert.equal(s.updates.status().latest?.version, 'v0.50.1');
    assert.equal(s.updates.status().error, null);
  } finally { rmSync(s.dir!, { recursive: true, force: true }); }
});

test('在线更新：GitHub 限流时按恢复时间暂停，手动检查也不绕过', async () => {
  const s = setup([]);
  const reset = Math.floor(s.now() / 1000) + 3600;
  const answers = [() => answer(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })];
  const calls: string[] = [];
  const limited = createUpdates({ current: CURRENT, dir: s.dir, readyFile: join(s.dir!, UPDATE_READY_FILE), now: s.now, fetchImpl: async url => { calls.push(url); return url === PAGE_URL ? redirect('v0.50.0')() : answers.shift()!(); } });
  try {
    await limited.check();
    const view = limited.status();
    assert.equal(view.retryAt, reset * 1000);
    assert.match(view.error ?? '', /额度已用完/);
    s.advance(120_000);
    await assert.rejects(limited.check(), (error: Error & { status?: number }) => error.status === 429 && /额度已用完/.test(error.message));
    await limited.tick();
    assert.deepEqual(calls, [API_URL, PAGE_URL], '限流期间只探测发布页，探测到新标签也不读 API');
    assert.match(limited.status().error ?? '', /额度已用完/);
  } finally { rmSync(s.dir!, { recursive: true, force: true }); }
});

test('在线更新：每分钟探测发布页的跳转，标签没变只确认上次检查，变了立即读 API', async () => {
  const s = setup([() => answer(200, release()), redirect('v0.50.0'), redirect('v0.50.1'), () => answer(200, release('v0.50.1'))]);
  try {
    s.advance(60_000);
    await s.updates.tick();
    const first = s.updates.status().checkedAt;
    await s.updates.tick();
    s.advance(59_000);
    await s.updates.tick();
    assert.deepEqual(s.calls, [API_URL], '读过 API 后 1 分钟内不探测');
    s.advance(1_000);
    await s.updates.tick();
    assert.deepEqual(s.calls, [API_URL, PAGE_URL]);
    assert.equal(s.updates.status().checkedAt, first! + 60_000, '标签没变：上次检查时间前进');
    assert.equal(s.updates.status().latest?.version, 'v0.50.0');
    s.advance(30_000);
    await s.updates.tick();
    assert.equal(s.calls.length, 2, '探测 1 分钟一次');
    s.advance(30_000);
    await s.updates.tick();
    assert.deepEqual(s.calls.slice(2), [PAGE_URL, API_URL], '标签变了：同一轮里读 API');
    const view = s.updates.status();
    assert.equal(view.latest?.version, 'v0.50.1');
    assert.equal(view.latest?.notes, '- 新功能一\n- 修复二');
    assert.equal(view.available, true);
    assert.deepEqual(s.logs, []);
  } finally { rmSync(s.dir!, { recursive: true, force: true }); }
});

test('在线更新：服务停止时进行中的探测静默结束，不记日志', async () => {
  const logs: string[] = [];
  let clock = 1_800_000_000_000, asked = 0;
  const updates = createUpdates({
    current: CURRENT, dir: null, readyFile: null, now: () => clock, log: line => { logs.push(line); },
    fetchImpl: (url, init) => url === PAGE_URL
      ? new Promise<Response>((_resolve, reject) => { asked++; init.signal!.addEventListener('abort', () => reject(init.signal!.reason)); })
      : Promise.resolve(answer(200, release())),
  });
  clock += 60_000;
  await updates.tick();
  clock += 60_000;
  const pending = updates.tick();
  assert.equal(asked, 1);
  updates.abort();
  await pending;
  assert.deepEqual(logs, []);
  assert.equal(updates.status().latest?.version, 'v0.50.0');
});

test('在线更新：发布页与 API 的结果不一致时，探测提前的 API 检查 5 分钟最多一次', async () => {
  const s = setup([() => answer(200, release()), redirect('v0.50.1'), () => answer(200, release()), redirect('v0.50.1'), redirect('v0.50.1'), redirect('v0.50.1'), redirect('v0.50.1'), redirect('v0.50.1'), () => answer(200, release('v0.50.1'))]);
  try {
    s.advance(60_000);
    await s.updates.tick();
    s.advance(60_000);
    await s.updates.tick();
    assert.deepEqual(s.calls, [API_URL, PAGE_URL, API_URL]);
    assert.equal(s.updates.status().latest?.version, 'v0.50.0', 'API 还没跟上');
    for (let minute = 0; minute < 4; minute++) { s.advance(60_000); await s.updates.tick(); }
    assert.deepEqual(s.calls.slice(3), [PAGE_URL, PAGE_URL, PAGE_URL, PAGE_URL], '5 分钟内不再提前读 API');
    s.advance(60_000);
    await s.updates.tick();
    assert.deepEqual(s.calls.slice(7), [PAGE_URL, API_URL]);
    assert.equal(s.updates.status().latest?.version, 'v0.50.1');
  } finally { rmSync(s.dir!, { recursive: true, force: true }); }
});

test('在线更新：探测失败只记一行日志，不改检查结果；API 检查失败后的退避不被探测打断', async () => {
  const s = setup([
    () => answer(200, release()),
    () => { throw new Error('connect ECONNREFUSED'); }, () => new Response('', { status: 404 }), redirect('v0.50.1', 'https://github.com/someone/else'), redirect('v0.50.0-rc1'),
    redirect('v0.50.0'),
    () => answer(500, {}), () => answer(500, {}), redirect('v0.50.1'),
  ]);
  try {
    s.advance(60_000);
    await s.updates.tick();
    const first = s.updates.status().checkedAt;
    for (let minute = 0; minute < 4; minute++) { s.advance(60_000); await s.updates.tick(); }
    assert.deepEqual(s.calls.slice(1), [PAGE_URL, PAGE_URL, PAGE_URL, PAGE_URL], '连接失败、非跳转、别的仓库、不是正式版标签都不读 API');
    assert.equal(s.logs.length, 1, '连续失败只记一次');
    assert.match(s.logs[0]!, /探测失败（连接 GitHub 失败：connect ECONNREFUSED）/);
    let view = s.updates.status();
    assert.equal(view.error, null);
    assert.equal(view.checkedAt, first);
    assert.equal(view.latest?.version, 'v0.50.0');
    s.advance(60_000);
    await s.updates.tick();
    assert.equal(s.logs.length, 2);
    assert.match(s.logs[1]!, /已恢复/);
    assert.equal(s.updates.status().checkedAt, first! + 5 * 60_000);
    // Two failed API checks: the second waits two minutes, and the probe in between finds a new tag.
    await s.updates.check();
    s.advance(60_000);
    await s.updates.tick();
    assert.deepEqual(s.calls.slice(6), [API_URL, API_URL]);
    s.advance(60_000);
    await s.updates.tick();
    assert.deepEqual(s.calls.slice(8), [PAGE_URL], '退避期间探测到新标签也不提前读 API');
    view = s.updates.status();
    assert.equal(view.error, 'GitHub 返回 HTTP 500');
    assert.equal(view.checkedAt, first! + 5 * 60_000, 'API 检查失败后探测不再更新上次检查时间');
  } finally { rmSync(s.dir!, { recursive: true, force: true }); }
});

test('在线更新：确认更新只接受最新且更新的版本，写出请求文件；未启用、忙、检查失败时拒绝', async () => {
  const s = setup([() => answer(200, release()), () => answer(500, {}), () => answer(200, release())]);
  const dir = s.dir!;
  try {
    assert.throws(() => s.updates.apply({ version: 'v0.50.0' }), (error: Error & { code?: string }) => error.code === 'update_changed', '还没检查过');
    await s.updates.check();
    assert.throws(() => s.updates.apply({ version: 'latest' }), (error: Error & { code?: string }) => error.code === 'update_version');
    assert.throws(() => s.updates.apply({ version: 'v0.50.0', force: true }), (error: Error & { code?: string }) => error.code === 'unknown_field');
    assert.throws(() => s.updates.apply({ version: 'v0.49.0' }), (error: Error & { code?: string }) => error.code === 'update_changed');
    rmSync(join(dir, UPDATE_READY_FILE));
    assert.throws(() => s.updates.apply({ version: 'v0.50.0' }), (error: Error & { code?: string }) => error.code === 'update_disabled');
    writeFileSync(join(dir, UPDATE_READY_FILE), 'v0.50.0\n');
    const view = s.updates.apply({ version: 'v0.50.0' });
    const request = JSON.parse(readFileSync(join(dir, UPDATE_REQUEST_FILE), 'utf8')) as { id: string; version: string; at: number };
    assert.equal(request.version, 'v0.50.0');
    assert.equal(view.pending?.id, request.id);
    assert.equal(view.pending?.stale, false);
    assert.equal(statSync(join(dir, UPDATE_REQUEST_FILE)).mode & 0o777, 0o600);
    assert.throws(() => s.updates.apply({ version: 'v0.50.0' }), (error: Error & { code?: string }) => error.code === 'update_busy', '请求还没被取走');
    s.advance(121_000);
    assert.equal(s.updates.status().pending?.stale, true, '超过 2 分钟没被取走');
    rmSync(join(dir, UPDATE_REQUEST_FILE));
    const running: UpdateResult = { id: randomUUID(), version: 'v0.50.0', from: 'v0.49.1', startedAt: s.now(), at: s.now(), phase: 'running', step: 'install', message: '…', output: [] };
    writeFileSync(join(dir, UPDATE_RESULT_FILE), JSON.stringify(running));
    assert.throws(() => s.updates.apply({ version: 'v0.50.0' }), (error: Error & { code?: string }) => error.code === 'update_busy', '正在更新');
    s.advance(2_200_000);
    assert.equal(s.updates.status().job?.stale, true, '超过助手时限仍在运行算中断');
    rmSync(join(dir, UPDATE_RESULT_FILE));
    await s.updates.check();
    assert.throws(() => s.updates.apply({ version: 'v0.50.0' }), (error: Error & { code?: string }) => error.code === 'update_check_failed');
    s.advance(61_000);
    await s.updates.check();
    const second = s.updates.apply({ version: 'v0.50.0' }).pending!;
    // The helper takes the request file before it writes its first result: the request still shows as waiting.
    rmSync(join(dir, UPDATE_REQUEST_FILE));
    const old: UpdateResult = { ...running, id: randomUUID(), phase: 'failed', startedAt: second.at - 5, at: second.at - 1 };
    writeFileSync(join(dir, UPDATE_RESULT_FILE), JSON.stringify(old));
    assert.equal(s.updates.status().pending?.id, second.id, '助手取走请求、还没写结果时仍算等待');
    assert.throws(() => s.updates.apply({ version: 'v0.50.0' }), (error: Error & { code?: string }) => error.code === 'update_busy');
    writeFileSync(join(dir, UPDATE_RESULT_FILE), JSON.stringify({ ...old, id: second.id, phase: 'running', at: second.at + 1 }));
    assert.equal(s.updates.status().pending, null, '有了这次请求的结果就不再算等待');
    writeFileSync(join(dir, UPDATE_RESULT_FILE), JSON.stringify({ ...old, id: null, at: second.at + 1 }));
    assert.equal(s.updates.status().pending, null, '之后写的无 id 失败（请求文件无效）也算回答');
    writeFileSync(join(dir, UPDATE_RESULT_FILE), JSON.stringify(old));
    s.advance(121_000);
    assert.equal(s.updates.status().pending, null, '取走后 2 分钟仍没结果就不再显示');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const none = createUpdates({ current: CURRENT, dir: null, readyFile: null, fetchImpl: async () => answer(200, release()) });
  await none.check();
  assert.equal(none.status().enabled, false);
  assert.throws(() => none.apply({ version: 'v0.50.0' }), (error: Error & { code?: string }) => error.code === 'update_disabled');
});

/** An install.sh layout: app/current → app/releases/<old> with VERSION, the hand-off dir and a data dir. */
function helperLayout() {
  const root = tempDir();
  const app = join(root, 'opt'), dir = join(root, 'import'), data = join(root, 'var');
  for (const path of [join(app, 'releases', 'old'), join(app, 'releases', 'new'), dir, data]) mkdirSync(path, { recursive: true });
  writeFileSync(join(app, 'releases', 'old', 'VERSION'), 'v0.49.1 abcdef123456\n');
  writeFileSync(join(app, 'releases', 'new', 'VERSION'), 'v0.50.0 0123456789ab\n');
  symlinkSync(join(app, 'releases', 'old'), join(app, 'current'));
  const request = (version: string, at = Date.now()) => { const id = randomUUID(); writeFileSync(join(dir, UPDATE_REQUEST_FILE), JSON.stringify({ id, version, at }), { mode: 0o600 }); return id; };
  const switchTo = (name: string) => { rmSync(join(app, 'current')); symlinkSync(join(app, 'releases', name), join(app, 'current')); };
  const script = '#!/usr/bin/env bash\necho installed\n';
  const sums = (text = script) => `${createHash('sha256').update(text).digest('hex')}  install.sh\n${'0'.repeat(64)}  trading-platform.tar.gz\n`;
  const download = (files: Record<string, string>) => (url: string, target: string) => {
    const name = url.split('/').at(-1)!;
    if (!(name in files)) throw new Error(`下载失败：${url}`);
    writeFileSync(target, files[name]!);
  };
  return { root, app, dir, data, request, switchTo, script, sums, download, result: () => readUpdateResult(dir) };
}

test('在线更新助手：核对 install.sh 后以 --version 执行，成功写“已更新”并带输出', async () => {
  const l = helperLayout();
  try {
    const id = l.request('v0.50.0');
    const runs: { script: string; version: string; text: string }[] = [];
    const handled = await runUpdateHelper({
      dir: l.dir, appDir: l.app, dataDir: l.data, log: () => undefined,
      download: l.download({ SHA256SUMS: l.sums(), 'install.sh': l.script }),
      runInstaller: async (script, version, onLine) => {
        runs.push({ script, version, text: readFileSync(script, 'utf8') });
        const running = l.result();
        assert.equal(running?.phase, 'running');
        assert.equal(running?.step, 'install');
        onLine('\x1b[1m下载程序包（版本 v0.50.0）。\x1b[0m');
        l.switchTo('new');
        onLine('版本：v0.50.0');
        return 0;
      },
    });
    assert.equal(handled, true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.version, 'v0.50.0');
    assert.equal(runs[0]!.text, l.script);
    const done = l.result();
    assert.equal(done?.id, id);
    assert.equal(done?.phase, 'done');
    assert.equal(done?.from, 'v0.49.1');
    assert.equal(done?.installed, 'v0.50.0');
    assert.equal(done?.message, '已更新到 v0.50.0');
    assert.deepEqual(done?.output, ['下载程序包（版本 v0.50.0）。', '版本：v0.50.0'], '去掉了颜色控制符');
    assert.equal(existsSync(join(l.dir, UPDATE_REQUEST_FILE)), false, '请求已取走');
    assert.equal(await runUpdateHelper({ dir: l.dir, appDir: l.app, dataDir: l.data, log: () => undefined }), false, '没有请求时什么也不做');
  } finally { rmSync(l.root, { recursive: true, force: true }); }
});

test('在线更新助手：install.sh 与校验清单不一致、安装失败、请求过期或不比已装版本新时不安装并写明原因', async () => {
  const l = helperLayout();
  const never = async () => { throw new Error('不应执行 install.sh'); };
  const quiet = () => undefined;
  try {
    l.request('v0.50.0');
    await runUpdateHelper({ dir: l.dir, appDir: l.app, dataDir: l.data, log: quiet, runInstaller: never, download: l.download({ SHA256SUMS: l.sums('别的内容'), 'install.sh': l.script }) });
    assert.equal(l.result()?.phase, 'failed');
    assert.match(l.result()?.message ?? '', /与 SHA256SUMS 不一致/);
    assert.equal(l.result()?.installed, 'v0.49.1');

    l.request('v0.50.0');
    await runUpdateHelper({ dir: l.dir, appDir: l.app, dataDir: l.data, log: quiet, runInstaller: never, download: l.download({ 'install.sh': l.script }) });
    assert.match(l.result()?.message ?? '', /下载失败：.*\/download\/v0\.50\.0\/SHA256SUMS/);

    l.request('v0.50.0');
    await runUpdateHelper({
      dir: l.dir, appDir: l.app, dataDir: l.data, log: quiet, download: l.download({ SHA256SUMS: l.sums(), 'install.sh': l.script }),
      runInstaller: async (_script, _version, onLine) => { onLine('安装失败：新版本 v0.50.0 启动失败，已回退到 v0.49.1 并确认运行正常；请按上面的日志处理'); onLine('最后一行'); return 1; },
    });
    assert.equal(l.result()?.phase, 'failed');
    assert.equal(l.result()?.message, '安装失败：新版本 v0.50.0 启动失败，已回退到 v0.49.1 并确认运行正常；请按上面的日志处理（当前版本 v0.49.1）');

    l.request('v0.50.0', Date.now() - 200_000);
    await runUpdateHelper({ dir: l.dir, appDir: l.app, dataDir: l.data, log: quiet, runInstaller: never, download: never as never });
    assert.match(l.result()?.message ?? '', /已过期/);

    for (const version of ['v0.49.1', 'v0.48.0']) {
      l.request(version);
      await runUpdateHelper({ dir: l.dir, appDir: l.app, dataDir: l.data, log: quiet, runInstaller: never, download: never as never });
      assert.match(l.result()?.message ?? '', /不比已装版本 v0\.49\.1 新/, version);
    }

    writeFileSync(join(l.dir, UPDATE_REQUEST_FILE), JSON.stringify({ id: randomUUID(), version: 'v0.50.0; rm -rf /', at: Date.now() }));
    await runUpdateHelper({ dir: l.dir, appDir: l.app, dataDir: l.data, log: quiet, runInstaller: never, download: never as never });
    assert.equal(l.result()?.phase, 'failed');
    assert.match(l.result()?.message ?? '', /更新请求无效：目标版本无效/);
  } finally { rmSync(l.root, { recursive: true, force: true }); }
});

test('在线更新助手：只认服务账户的请求文件；中断后把“进行中”标为中断', () => {
  const l = helperLayout();
  try {
    l.request('v0.50.0');
    const taken = takeUpdateRequest(l.dir, { uid: process.getuid!() + 1 });
    assert.deepEqual(taken, { invalid: '请求文件不属于服务账户' });
    assert.equal(existsSync(join(l.dir, UPDATE_REQUEST_FILE)), false, '无效的请求文件也删掉');
    assert.equal(checksumOf(l.sums(), 'install.sh'), createHash('sha256').update(l.script).digest('hex'));
    assert.equal(checksumOf(l.sums(), 'install-watch.sh'), null);

    const owner = { uid: process.getuid!(), gid: process.getgid!() };
    assert.equal(recoverUpdate(l.dir, l.app, owner), false, '没有结果时不动');
    const running: UpdateResult = { id: randomUUID(), version: 'v0.50.0', from: 'v0.49.1', startedAt: 1, at: 1, phase: 'running', step: 'install', message: '…', output: ['a'] };
    writeFileSync(join(l.dir, UPDATE_RESULT_FILE), JSON.stringify(running));
    assert.equal(recoverUpdate(l.dir, l.app, owner, 5), true);
    const result = l.result();
    assert.equal(result?.phase, 'failed');
    assert.equal(result?.installed, 'v0.49.1');
    assert.match(result?.message ?? '', /被中断.*当前版本 v0\.49\.1/);
    assert.deepEqual(result?.output, ['a']);
    assert.equal(recoverUpdate(l.dir, l.app, owner), false, '已结束的结果不再改');
  } finally { rmSync(l.root, { recursive: true, force: true }); }
});

test('在线更新 HTTP：读状态、检查与确认更新都要登录，写操作要页面请求标记', async () => {
  const h = createHarness();
  bindAccounts(h.ex);
  const calls: string[] = [];
  const views = { update: { status: () => ({ ok: true }), check: async () => { calls.push('check'); return { checked: true }; }, apply: (body: unknown) => { calls.push(JSON.stringify(body)); return { applied: true }; } } };
  const server = createExecutorServer({ executor: h.ex, accessToken: 'update-access-token-01', session: 'update-session-value-01', views });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/update`)).status, 401);
    const login = await fetch(`${base}/login?token=update-access-token-01`, { redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.deepEqual(await (await fetch(`${base}/api/update`, { headers: { cookie } })).json(), { ok: true });
    const post = (path: string, body: unknown, marked = true) => fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...(marked ? { 'x-pa-executor': '1' } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/api/update/apply', { version: 'v0.50.0' }, false)).status, 403);
    assert.equal((await post('/api/update/check', { extra: 1 })).status, 400);
    assert.deepEqual(await (await post('/api/update/check', {})).json(), { checked: true });
    assert.deepEqual(await (await post('/api/update/apply', { version: 'v0.50.0' })).json(), { applied: true });
    assert.deepEqual(calls, ['check', '{"version":"v0.50.0"}']);
    assert.equal((await fetch(`${base}/api/update/apply`, { headers: { cookie } })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
});

test('在线更新：就绪标记在 root 所有的程序目录（releases 的上一级），开发检出没有；非程序包与过远的限流时间', async () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, 'opt', 'releases', 'abc'), { recursive: true });
    symlinkSync(join(root, 'opt', 'releases', 'abc'), join(root, 'opt', 'current'));
    assert.equal(updateReadyFile(join(root, 'opt', 'current')), join(root, 'opt', UPDATE_READY_FILE), '经 current 链接也找到程序目录');
    assert.equal(updateReadyFile(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const dir = tempDir();
  try {
    writeFileSync(join(dir, UPDATE_READY_FILE), '');
    const dev = createUpdates({ current: { version: 'v0.0.0', commit: null, packaged: false }, dir, readyFile: join(dir, UPDATE_READY_FILE), fetchImpl: async () => answer(200, release()) });
    await dev.check();
    assert.throws(() => dev.apply({ version: 'v0.50.0' }), (error: Error & { code?: string }) => error.code === 'update_unpackaged');

    let clock = 1_800_000_000_000;
    const far = createUpdates({ current: CURRENT, dir, readyFile: null, now: () => clock, fetchImpl: async () => answer(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(clock / 1000 + 86_400 * 30) }) });
    await far.check();
    assert.equal(far.status().retryAt, clock + 3_600_000, '最多停 1 小时');
    clock += 1;

    const huge = createUpdates({ current: CURRENT, dir, readyFile: null, fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)); } }), { status: 200 }) });
    await huge.check();
    assert.equal(huge.status().error, 'GitHub 返回的版本信息过大', '边读边数，超过上限就停');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('在线更新助手：请求文件是符号链接、多个硬链接或过大时不读，删掉并写失败', () => {
  const l = helperLayout();
  const owner = { uid: process.getuid!() };
  try {
    const outside = join(l.root, 'outside.json');
    writeFileSync(outside, JSON.stringify({ id: randomUUID(), version: 'v0.50.0', at: Date.now() }));
    symlinkSync(outside, join(l.dir, UPDATE_REQUEST_FILE));
    assert.ok('invalid' in (takeUpdateRequest(l.dir, owner) ?? {}), '符号链接');
    assert.equal(existsSync(outside), true, '链接指向的文件不动');
    assert.equal(existsSync(join(l.dir, UPDATE_REQUEST_FILE)), false);

    linkSync(outside, join(l.dir, UPDATE_REQUEST_FILE));
    assert.ok('invalid' in (takeUpdateRequest(l.dir, owner) ?? {}), '硬链接');
    assert.equal(existsSync(outside), true);

    writeFileSync(join(l.dir, UPDATE_REQUEST_FILE), 'x'.repeat(64 * 1024));
    assert.ok('invalid' in (takeUpdateRequest(l.dir, owner) ?? {}), '过大');
    assert.equal(existsSync(join(l.dir, UPDATE_REQUEST_FILE)), false);
  } finally { rmSync(l.root, { recursive: true, force: true }); }
});

test('在线更新助手：root 身份下拒绝由 root 拥有的请求账户或数据目录', async () => {
  const { assertNonRootOwner, recoverUpdateHelper, runUpdateHelper } = await import('../src/service/update-helper.ts');
  assert.throws(() => assertNonRootOwner({ uid: 0 }, '更新请求账户', 0), /属主不能是 root/);
  assert.doesNotThrow(() => assertNonRootOwner({ uid: 1000 }, '更新请求账户', 0));
  assert.doesNotThrow(() => assertNonRootOwner({ uid: 0 }, '更新请求账户', 1000));
  const dir = mkdtempSync(join(tmpdir(), 'tp-update-root-'));
  try {
    await assert.rejects(
      () => runUpdateHelper({ dir, appDir: dir, dataDir: dir, requestOwner: { uid: 0, gid: 0 }, checkHandoffDir: () => {}, currentUid: 0, log: () => undefined }),
      /属主不能是 root/,
    );
    await assert.rejects(
      () => runUpdateHelper({ dir, appDir: dir, dataDir: dir, checkHandoffDir: () => {}, readOwner: () => ({ uid: 0, gid: 0 }), currentUid: 0, log: () => undefined }),
      /属主不能是 root/,
    );
    assert.throws(
      () => recoverUpdateHelper({ dir, appDir: dir, dataDir: dir, requestOwner: { uid: 0, gid: 0 }, checkHandoffDir: () => {}, currentUid: 0 }),
      /属主不能是 root/,
    );
    assert.throws(
      () => recoverUpdateHelper({ dir, appDir: dir, dataDir: dir, checkHandoffDir: () => {}, readOwner: () => ({ uid: 0, gid: 0 }), currentUid: 0 }),
      /属主不能是 root/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
