// The 系统更新 button's wording and when the page lets the update start (web/src/update-view.ts, docs/update.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedReason, nextWatched, parseUpdateView, readsInBackground, reloading, summaryOf, toneOf, updating, type UpdatePageState, type UpdateView } from '../web/src/update-view.ts';

const base = (over: Partial<UpdateView> = {}): UpdateView => ({
  current: { version: 'v0.49.1', commit: 'abcdef123456', packaged: true },
  latest: { version: 'v0.50.0', name: 'v0.50.0', notes: '- 在线更新', publishedAt: '2026-11-16T08:00:00Z', url: 'https://github.com/hxx344/trading-platform/releases/tag/v0.50.0' },
  checkedAt: 1, checking: false, error: null, retryAt: null, manualAt: 0, available: true, enabled: true, pending: null, job: null, ...over,
});
const page = (view: UpdateView | null, over: Partial<UpdatePageState> = {}): UpdatePageState => ({ view, offline: false, busy: null, watched: null, ...over });
const job = (phase: 'running' | 'done' | 'failed', extra: object = {}) => ({ id: 'job-1', version: 'v0.50.0', from: 'v0.49.1', startedAt: 1, at: 2, phase, message: 'm', output: [], ...extra });

test('系统更新：有新版本时可查看更新，按钮高亮', () => {
  const state = page(base());
  assert.equal(summaryOf(state), '发现新版本 v0.50.0');
  assert.equal(toneOf(state), 'available');
  assert.equal(blockedReason(state), null);
});

test('系统更新：待启用、检查失败、开发环境、断线、已是最新时不能开始更新', () => {
  assert.equal(summaryOf(page(base({ enabled: false }))), '待启用');
  assert.equal(blockedReason(page(base({ enabled: false }))), '在线更新待启用');
  assert.equal(toneOf(page(base({ enabled: false }))), 'attention');
  assert.equal(summaryOf(page(base({ error: 'GitHub 返回 HTTP 500' }))), '检查失败');
  assert.match(blockedReason(page(base({ error: 'x' }))) ?? '', /检查失败/);
  assert.equal(blockedReason(page(base({ current: { version: 'v0.49.1', commit: null, packaged: false } }))), '开发环境不能在页面更新');
  assert.equal(blockedReason(page(base(), { offline: true })), '连接待恢复');
  assert.equal(summaryOf(page(base({ available: false }))), '已是最新正式版');
  assert.equal(blockedReason(page(base({ available: false }))), '没有可更新的正式版');
  assert.equal(blockedReason(page(null)), '正在读取状态');
});

test('系统更新：请求等待取走或助手运行中算更新中；过期的不算，标为需处理', () => {
  const pending = base({ pending: { id: 'job-1', version: 'v0.50.0', at: 1, stale: false } });
  assert.equal(updating(pending), true);
  assert.equal(summaryOf(page(pending)), '更新进行中');
  assert.equal(blockedReason(page(pending)), '更新进行中');
  const stale = base({ pending: { id: 'job-1', version: 'v0.50.0', at: 1, stale: true } });
  assert.equal(updating(stale), false);
  assert.equal(toneOf(page(stale)), 'attention');
  assert.equal(blockedReason(page(stale)), null, '过期请求可以重新确认');
  assert.equal(updating(base({ job: job('running') })), true);
  const interrupted = base({ job: { ...job('running'), stale: true } });
  assert.equal(updating(interrupted), false);
  assert.equal(summaryOf(page({ ...interrupted, available: true })), '发现新版本 v0.50.0');
  assert.equal(summaryOf(page({ ...interrupted, available: false })), '已是最新正式版，上次更新已中断');
  assert.equal(summaryOf(page(base({ available: false, job: job('running') }), { offline: true, watched: 'job-1' })), '更新中，等待重连');
});

test('系统更新：只有本页提交或看到运行的任务成功后才刷新页面', () => {
  const done = base({ available: false, current: { version: 'v0.50.0', commit: '0123456789ab', packaged: true }, job: job('done') });
  assert.equal(reloading(page(done)), false, '打开页面时已完成的任务不刷新');
  assert.equal(reloading(page(done, { watched: 'job-1' })), true);
  assert.equal(summaryOf(page(done, { watched: 'job-1' })), '更新已完成，正在刷新页面');
  assert.equal(reloading(page(base({ job: job('failed') }), { watched: 'job-1' })), false);
  assert.equal(toneOf(page(base({ available: false, job: job('failed') }))), 'attention');
});

test('系统更新：只盯住本页提交或看到运行的任务，失败、中断、无人取走、别的请求的结果都结束盯住', () => {
  assert.equal(nextWatched(null, base({ job: job('running') })), 'job-1', '看到运行中的任务就盯住');
  assert.equal(nextWatched(null, base({ job: { ...job('running'), stale: true } })), null, '超时的“运行中”不盯');
  const pending = (stale: boolean) => base({ pending: { id: 'job-1', version: 'v0.50.0', at: 1, stale } });
  assert.equal(nextWatched('job-1', pending(false)), 'job-1', '请求等待取走');
  assert.equal(nextWatched('job-1', pending(true)), null, '请求没人取走');
  assert.equal(nextWatched('job-1', base({ job: job('done') })), 'job-1', '成功后保留到刷新');
  assert.equal(nextWatched('job-1', base({ job: job('failed') })), null);
  assert.equal(nextWatched('job-1', base({ job: { ...job('running'), stale: true } })), null, '中断');
  assert.equal(nextWatched('job-1', base({ job: job('failed', { id: null }) })), null, '助手对无效请求文件写 id 为空的失败');
  assert.equal(nextWatched('job-1', base({ job: job('done', { id: 'old' }) })), null, '别的请求的结果');
  assert.equal(nextWatched('job-1', base({ job: job('done', { id: 'old' }), pending: { id: 'job-1', version: 'v0.50.0', at: 1, stale: false } })), 'job-1', '旧结果还在、本页请求在等');
  assert.equal(reloading(page(base({ job: job('done', { id: null }) }), { watched: null })), false);
});

test('系统更新：应答形状不对按读取失败处理；结果未知、检查中、助手结果读不了时不能确认', () => {
  assert.equal(parseUpdateView(base()).latest?.version, 'v0.50.0');
  for (const bad of [{}, null, [], { ...base(), current: null }, { ...base(), job: { phase: 'running' } }, { ...base(), enabled: 'yes' }]) assert.throws(() => parseUpdateView(bad), /无法识别/);
  assert.equal(blockedReason(page(base(), { uncertain: true })), '确认结果未知，正在读取服务器记录');
  assert.equal(summaryOf(page(base(), { uncertain: true })), '更新进行中');
  assert.equal(blockedReason(page(base({ checking: true }))), '正在检查版本');
  assert.equal(blockedReason(page(base(), { busy: 'check' })), '请求进行中');
  assert.equal(blockedReason(page(base({ jobError: '无法读取更新结果' }))), '无法读取更新结果');
  assert.equal(toneOf(page(base({ jobError: 'x' }))), 'attention');
  assert.equal(toneOf(page(base(), { offline: true })), 'attention');
  assert.equal(summaryOf(page(base(), { offline: true })), '连接待恢复');
});

test('系统更新：服务换成页面载入时以外的版本且没有更新在进行时刷新页面（别处发起的更新）', () => {
  const moved = base({ current: { version: 'v0.50.0', commit: null, packaged: true } });
  assert.equal(reloading(page(moved, { loaded: 'v0.49.1' })), true);
  assert.equal(summaryOf(page(moved, { loaded: 'v0.49.1' })), '更新已完成，正在刷新页面');
  assert.equal(reloading(page(moved, { loaded: 'v0.50.0' })), false, '版本未变不刷新');
  assert.equal(reloading(page(moved, { loaded: null })), false, '还没读到载入时的版本不刷新');
  assert.equal(reloading(page(base({ current: moved.current, job: job('running') }), { loaded: 'v0.49.1' })), false, '更新还在进行（可能回退）时等结果');
  assert.equal(reloading(page(base({ current: moved.current, pending: { id: 'r-1', version: 'v0.50.0', at: 1, stale: false } }), { loaded: 'v0.49.1' })), false);
  assert.equal(reloading(page(base({ current: moved.current, job: job('running', { stale: true }) }), { loaded: 'v0.49.1' })), true, '超时的运行结果不算进行中');
});

test('系统更新：本页跟着一次更新时后台也继续读取，其余时候随页面暂停', () => {
  assert.equal(readsInBackground(page(base())), false);
  assert.equal(readsInBackground(page(base(), { watched: 'job-1' })), true);
  assert.equal(readsInBackground(page(base({ job: job('running') }))), true);
  assert.equal(readsInBackground(page(base(), { busy: 'apply' })), true);
  assert.equal(readsInBackground(page(base(), { uncertain: true })), true);
  assert.equal(readsInBackground(page(base(), { busy: 'check' })), false);
  assert.equal(readsInBackground(page(null)), false);
});
