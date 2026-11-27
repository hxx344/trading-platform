import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api.ts';
import { acceptedFourLegText, acceptedJobText, confirmRefused, executeOrderConfirm, leaveOrderPreview } from '../src/order-confirm.ts';
import { RequestIds } from '../src/request-ids.ts';

function setup({ previewId = 'prev-1', alive = true, confirmAnswer = true } = {}) {
  let busy = false, currentId = previewId, unanswered = null, message = null, isAlive = alive;
  let seq = 0;
  const accepted = [], confirms = [];
  const ids = new RequestIds(() => `req-${++seq}`);
  const dialog = {
    async confirm(text, opts) { confirms.push({ text, opts }); return typeof confirmAnswer === 'function' ? confirmAnswer(text, opts) : confirmAnswer; },
    isAlive: () => isAlive,
  };
  return {
    dialog, ids, accepted, confirms,
    setBusyValue: v => { busy = v; },
    setPreviewId: id => { currentId = id; },
    setAlive: v => { isAlive = v; },
    state: () => ({ busy, currentId, unanswered, message }),
    options: (overrides = {}) => ({
      previewId,
      confirmText: '确认发送测试单',
      confirmTitle: '确认实盘执行',
      dialog,
      ids,
      isBusy: () => busy,
      setBusy: next => { busy = next; },
      currentPreviewId: () => currentId,
      send: async requestId => ({ duplicate: false, job: { id: `job-${requestId}-1234`, status: 'accepted' } }),
      formatAccepted: result => acceptedJobText(result, '已受理'),
      onAccepted: result => accepted.push(result.job),
      clearPreview: () => { currentId = undefined; },
      setUnanswered: value => { unanswered = value; },
      setMessage: value => { message = value; },
      ...overrides,
    }),
  };
}

test('executeOrderConfirm：成功受理清预览并注销 requestId；未知失败保留 requestId 供同号重试，4xx 明确拒绝销毁 requestId', async () => {
  const s = setup();
  let calls = 0;
  const seenIds = [];

  // 1. Network error (no status) -> unanswered kept, requestId retained for retry.
  await executeOrderConfirm(s.options({
    send: async requestId => { seenIds.push(requestId); calls++; throw new Error('断网'); },
  }));
  assert.equal(calls, 1);
  assert.equal(s.state().unanswered, 'prev-1');
  assert.equal(s.state().currentId, 'prev-1');
  assert.match(s.state().message.text, /结果未知，可再次点击确认/);
  assert.equal(s.state().busy, false);

  // 2. Retry reuses exact same requestId and succeeds.
  await executeOrderConfirm(s.options({
    send: async requestId => { seenIds.push(requestId); return { duplicate: true, job: { id: 'abcdef1234', status: 'accepted' } }; },
  }));
  assert.deepEqual(seenIds, ['req-1', 'req-1']);
  assert.equal(s.state().unanswered, null);
  assert.equal(s.state().currentId, undefined);
  assert.equal(s.accepted.length, 1);
  assert.match(s.state().message.text, /该请求已受理过/);

  // 3. Explicit 400 refusal clears unanswered and retires requestId, while request_reused keeps unanswered.
  s.setPreviewId('prev-1');
  await executeOrderConfirm(s.options({
    send: async requestId => { seenIds.push(requestId); throw new ApiError('余额不足', 400, 'insufficient'); },
  }));
  assert.equal(seenIds.at(-1), 'req-2');
  assert.equal(s.state().unanswered, null);
  assert.equal(confirmRefused(new ApiError('reused', 409, 'request_reused')), false);

  // Next attempt allocates fresh req-3 after 400 settled req-2.
  await executeOrderConfirm(s.options({
    send: async requestId => { seenIds.push(requestId); throw new ApiError('stale', 409, 'request_reused'); },
  }));
  assert.equal(seenIds.at(-1), 'req-3');
  assert.equal(s.state().unanswered, 'prev-1');
});

test('executeOrderConfirm：确认取消、并发 busy、预览已变化或组件卸载均不发送且清理正确', async () => {
  const canceled = setup({ confirmAnswer: false });
  let sent = 0;
  await executeOrderConfirm(canceled.options({ send: async () => { sent++; return {}; } }));
  assert.equal(sent, 0);

  const changed = setup();
  changed.options();
  await executeOrderConfirm(changed.options({
    dialog: { async confirm() { changed.setPreviewId('prev-2'); return true; }, isAlive: () => true },
    send: async () => { sent++; return {}; },
  }));
  assert.equal(sent, 0);

  const busyCase = setup();
  busyCase.setBusyValue(true);
  await executeOrderConfirm(busyCase.options({ send: async () => { sent++; return {}; } }));
  assert.equal(sent, 0);
  assert.equal(busyCase.confirms.length, 0);

  const unmounted = setup();
  await executeOrderConfirm(unmounted.options({
    send: async () => { unmounted.setAlive(false); return { job: { id: 'j1', status: 'accepted' } }; },
  }));
  assert.equal(unmounted.accepted.length, 0);
  assert.equal(unmounted.state().busy, false);
});

test('leaveOrderPreview：无未知结果直接清理；有未知结果须二次确认且确认期间换预览不误清', async () => {
  let cleared = 0;
  const s = setup();
  await leaveOrderPreview({
    dialog: s.dialog,
    isBusy: () => false,
    currentPreviewId: () => 'prev-1',
    unansweredId: null,
    onClear: () => { cleared++; },
  });
  assert.equal(cleared, 1);
  assert.equal(s.confirms.length, 0);

  // With unanswered: confirm false keeps preview; confirm true clears; switched preview aborts clear.
  const denied = setup({ confirmAnswer: false });
  await leaveOrderPreview({
    dialog: denied.dialog,
    isBusy: () => false,
    currentPreviewId: () => 'prev-1',
    unansweredId: 'prev-1',
    onClear: () => { cleared++; },
  });
  assert.equal(cleared, 1);
  assert.equal(denied.confirms.length, 1);

  let current = 'prev-1';
  const switched = {
    async confirm() { current = 'prev-2'; return true; },
    isAlive: () => true,
  };
  await leaveOrderPreview({
    dialog: switched,
    isBusy: () => false,
    currentPreviewId: () => current,
    unansweredId: 'prev-1',
    onClear: () => { cleared++; },
  });
  assert.equal(cleared, 1);
});

test('executeOrderConfirm：500/401/403与空对象响应保留 requestId 与预览，非 request_reused 409 注销 requestId，卸载失败路径不更新状态', async () => {
  for (const status of [500, 401, 403]) {
    const s = setup();
    const seen = [];
    await executeOrderConfirm(s.options({
      send: async requestId => { seen.push(requestId); throw new ApiError(`fail-${status}`, status); },
    }));
    await executeOrderConfirm(s.options({
      send: async requestId => { seen.push(requestId); return { duplicate: true, job: { id: 'settled123', status: 'accepted' } }; },
    }));
    assert.deepEqual(seen, ['req-1', 'req-1'], `HTTP ${status} 须保留 requestId`);
  }

  // Empty/malformed {} response must throw inside ids.run BEFORE retiring requestId or clearing preview.
  const empty = setup();
  const seenEmpty = [];
  await executeOrderConfirm(empty.options({
    send: async requestId => { seenEmpty.push(requestId); return {}; },
  }));
  assert.equal(empty.state().currentId, 'prev-1');
  assert.equal(empty.state().unanswered, 'prev-1');
  assert.match(empty.state().message.text, /确认响应缺少任务编号.*沿用同一请求编号/);
  await executeOrderConfirm(empty.options({
    send: async requestId => { seenEmpty.push(requestId); return { duplicate: true, job: { id: 'ok12345678', status: 'accepted' } }; },
  }));
  assert.deepEqual(seenEmpty, ['req-1', 'req-1']);
  assert.equal(empty.state().currentId, undefined);
  assert.equal(empty.state().unanswered, null);

  // Non-request_reused 409 retires requestId and clears unanswered.
  const conflict = setup();
  const seen409 = [];
  await executeOrderConfirm(conflict.options({
    send: async requestId => { seen409.push(requestId); throw new ApiError('被锁定', 409, 'locked'); },
  }));
  assert.equal(conflict.state().unanswered, null);
  await executeOrderConfirm(conflict.options({
    send: async requestId => { seen409.push(requestId); return { duplicate: false, job: { id: 'next123456', status: 'accepted' } }; },
  }));
  assert.deepEqual(seen409, ['req-1', 'req-2']);

  // Four-leg accepted formatter + malformed input checks (including empty jobs array).
  assert.match(acceptedFourLegText({ group: 'group12345', jobs: [{ id: 'aaaa1111' }, { id: 'bbbb2222' }] }), /已受理：四腿组 group123，任务 aaaa1111、bbbb2222/);
  assert.match(acceptedFourLegText({ duplicate: true, group: 'group12345', jobs: [{ id: 'aaaa1111' }] }), /该请求已受理过：四腿组 group123/);
  assert.throws(() => acceptedJobText({}, '已受理'), /确认响应缺少任务编号/);
  assert.throws(() => acceptedFourLegText({}), /确认响应缺少四腿任务编号/);
  assert.throws(() => acceptedFourLegText({ group: 'g1', jobs: [] }), /确认响应缺少四腿任务编号/);
  assert.throws(() => acceptedFourLegText({ group: 'g1', jobs: [{}] }), /确认响应缺少四腿任务编号/);

  // Real caller pattern `result?.job?.status ?? ''` must reach acceptedJobText without TypeError and preserve requestId/preview.
  for (const malformed of [{}, { job: null }]) {
    const callerState = setup();
    const seenIds = [];
    await executeOrderConfirm(callerState.options({
      send: async requestId => { seenIds.push(requestId); return malformed; },
      formatAccepted: result => acceptedJobText(result, result?.job?.status ?? ''),
    }));
    assert.equal(callerState.state().currentId, 'prev-1');
    assert.equal(callerState.state().unanswered, 'prev-1');
    assert.match(callerState.state().message.text, /^确认响应缺少任务编号（结果未知/);
    await executeOrderConfirm(callerState.options({
      send: async requestId => { seenIds.push(requestId); return { duplicate: true, job: { id: 'ok88888888', status: 'accepted' } }; },
      formatAccepted: result => acceptedJobText(result, result?.job?.status ?? ''),
    }));
    assert.deepEqual(seenIds, ['req-1', 'req-1']);
    assert.equal(callerState.state().unanswered, null);
  }

  // Empty four-leg jobs array in executeOrderConfirm also preserves requestId and preview.
  const emptyFour = setup();
  await executeOrderConfirm(emptyFour.options({
    send: async () => ({ group: 'g1', jobs: [] }),
    formatAccepted: acceptedFourLegText,
  }));
  assert.equal(emptyFour.state().currentId, 'prev-1');
  assert.equal(emptyFour.state().unanswered, 'prev-1');
  assert.match(emptyFour.state().message.text, /^确认响应缺少四腿任务编号（结果未知/);

  // Unmounted on catch branch resets busy without touching message or unanswered.
  const deadErr = setup();
  await executeOrderConfirm(deadErr.options({
    send: async () => { deadErr.setAlive(false); throw new Error('断网'); },
  }));
  assert.equal(deadErr.state().busy, false);
  assert.equal(deadErr.state().unanswered, null);
  assert.equal(deadErr.state().message.text, '发送中…');

  // leaveOrderPreview guards busy and unmounted after confirm.
  let extraClears = 0;
  await leaveOrderPreview({ dialog: deadErr.dialog, isBusy: () => true, currentPreviewId: () => 'prev-1', unansweredId: null, onClear: () => { extraClears++; } });
  const deadLeave = setup();
  await leaveOrderPreview({
    dialog: { async confirm() { deadLeave.setAlive(false); return true; }, isAlive: () => deadLeave.dialog.isAlive() },
    isBusy: () => false,
    currentPreviewId: () => 'prev-1',
    unansweredId: 'prev-1',
    onClear: () => { extraClears++; },
  });
  assert.equal(extraClears, 0);
});
