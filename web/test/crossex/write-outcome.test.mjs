// What the CrossEx page does after a confirm or cancel write comes back (web/src/crossex/write-outcome.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../src/api.ts';
import { RequestIds } from '../../src/request-ids.ts';
import { writeOutcome, writeRefused, writeResultState } from '../../src/crossex/write-outcome.ts';

const notSubmitted = new ApiError('预览已过期，请重新预览', 409, 'not_submitted', { code: 'not_submitted', message: '预览已过期，请重新预览', requestStatus: 'not_submitted' });
const refused = new ApiError('订单状态尚未确认、已结束或撤单处理中，不能重复撤单', 409, 'crossex', { code: 'crossex', message: '…' });
const badRequest = new ApiError('请求标识无效，请刷新页面重试', 400, 'crossex');
const csrf = new ApiError('缺少本页面请求标记', 403, 'csrf');
const serverError = new ApiError('请求失败（HTTP 500）', 500);
const unavailable = new ApiError('本次确认等待时间已用尽，请查看已记录的实际订单结果', 503, 'crossex');
const expired = new ApiError('会话无效，请刷新页面重新登录', 401, 'session');
const timeout = new DOMException('请求超时，结果未知；请刷新核对后再操作', 'TimeoutError');
const network = new TypeError('Failed to fetch');

test('写入成功：请求编号结束；结果已定时清掉待确认请求，结果仍不确定时保留', () => {
  assert.deepEqual(writeOutcome({ ok: true, state: 'completed' }), { retireRequestId: true, clearPending: true, keepReview: false, expired: false });
  assert.deepEqual(writeOutcome({ ok: true, state: 'FILLED' }), { retireRequestId: true, clearPending: true, keepReview: false, expired: false });
  for (const state of ['UNKNOWN', 'sending', 'CANCEL_PENDING', 'reconciling', 'INVALID', undefined, '']) {
    assert.deepEqual(writeOutcome({ ok: true, state }), { retireRequestId: true, clearPending: false, keepReview: false, expired: false }, String(state));
  }
});

test('写入成功的结果状态：执行的 state 优先，其次订单状态，再其次应答自身', () => {
  assert.equal(writeResultState({ execution: { state: 'partial', status: 'x' }, order: { status: 'NEW' } }), 'partial');
  assert.equal(writeResultState({ order: { id: 'o1', status: 'CANCEL_PENDING' }, status: 'ok' }), 'CANCEL_PENDING');
  assert.equal(writeResultState({ state: 'completed' }), 'completed');
  assert.equal(writeResultState({ status: 'CANCELLED' }), 'CANCELLED');
  assert.equal(writeResultState({}), undefined);
  assert.equal(writeResultState(null), undefined);
});

test('服务证明未提交：换编号、清掉待确认请求、确认框留着重新预览', () => {
  assert.deepEqual(writeOutcome({ ok: false, error: notSubmitted }), { retireRequestId: true, clearPending: true, keepReview: true, expired: false });
  // The code alone or the body's requestStatus alone is enough, whatever the status.
  assert.equal(writeOutcome({ ok: false, error: new ApiError('x', 503, undefined, { requestStatus: 'not_submitted' }) }).keepReview, true);
  assert.equal(writeOutcome({ ok: false, error: new ApiError('x', 400, 'not_submitted') }).clearPending, true);
});

test('其他明确拒绝（4xx）：换编号，但先前是否已发出仍待查询，保留待确认请求并关闭确认框', () => {
  for (const error of [refused, badRequest, csrf, new ApiError('太多请求', 429)]) {
    assert.equal(writeRefused(error), true, error.message);
    assert.deepEqual(writeOutcome({ ok: false, error }), { retireRequestId: true, clearPending: false, keepReview: false, expired: false }, error.message);
  }
});

test('结果未知（500、503、超时、断网）：不换编号、保留待确认请求、关闭确认框', () => {
  for (const error of [serverError, unavailable, new ApiError('超时', 408), timeout, network, new Error('响应无法解析'), undefined]) {
    assert.equal(writeRefused(error), false, String(error));
    assert.deepEqual(writeOutcome({ ok: false, error }), { retireRequestId: false, clearPending: false, keepReview: false, expired: false }, String(error));
  }
});

test('401：会话失效立即提示重新登录；结果按未知处理，不换编号、保留待确认请求', () => {
  assert.equal(writeRefused(expired), false);
  assert.deepEqual(writeOutcome({ ok: false, error: expired }), { retireRequestId: false, clearPending: false, keepReview: false, expired: true });
});

test('配合 RequestIds：结果未知后重试沿用同一编号，明确拒绝或成功后换新编号', async () => {
  let n = 0;
  const ids = new RequestIds(() => `request-${++n}`);
  const settles = error => writeOutcome({ ok: false, error }).retireRequestId;
  const seen = [];
  const fail = error => requestId => { seen.push(requestId); return Promise.reject(error); };
  for (const error of [serverError, timeout, network, expired]) await assert.rejects(ids.run('confirm:p1', '', fail(error), settles));
  assert.deepEqual(seen, ['request-1', 'request-1', 'request-1', 'request-1']);
  await assert.rejects(ids.run('confirm:p1', '', fail(refused), settles));
  await assert.rejects(ids.run('confirm:p1', '', fail(notSubmitted), settles));
  assert.equal(await ids.run('confirm:p1', '', async requestId => { seen.push(requestId); return 'ok'; }, settles), 'ok');
  await ids.run('confirm:p1', '', async requestId => { seen.push(requestId); }, settles);
  assert.deepEqual(seen.slice(4), ['request-1', 'request-2', 'request-3', 'request-4']);
});
