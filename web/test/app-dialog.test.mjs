import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialogController } from '../src/app-dialog-queue.ts';

function setup() {
  const queue = [];
  let triggerHashChange = () => {};
  const controller = createDialogController({
    hasDocument: () => true,
    addHashChange: listener => {
      triggerHashChange = listener;
      return () => { triggerHashChange = () => {}; };
    },
  });
  const host = {
    enqueue: req => queue.push(req),
    cancel: req => {
      controller.settle(req, false);
      const index = queue.indexOf(req);
      if (index >= 0) queue.splice(index, 1);
    },
    cancelAllConfirms: () => {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].kind === 'confirm') {
          controller.settle(queue[i], false);
          queue.splice(i, 1);
        }
      }
    },
  };
  return { controller, queue, host, fireHashChange: () => triggerHashChange() };
}

test('单确认锁阻止并发重入并在结算后恢复', async () => {
  const { controller, queue, host } = setup();
  const detach = controller.attachHost(host);

  const first = controller.confirm('确认实盘发送？');
  const second = controller.confirm('重复触发？');
  assert.equal(await second, false);
  assert.equal(queue.length, 1);

  const req = queue.shift();
  controller.settle(req, true);
  assert.equal(await first, true);

  const third = controller.confirm('下一笔确认？');
  assert.equal(queue.length, 1);
  controller.settle(queue.shift(), false);
  assert.equal(await third, false);

  detach();
  controller.dispose();
});

test('settle 幂等：重复结算同一请求只生效一次，不解开后续确认锁', async () => {
  const { controller, queue, host } = setup();
  const detach = controller.attachHost(host);

  const first = controller.confirm('第一笔');
  const firstReq = queue.shift();
  controller.settle(firstReq, true);
  assert.equal(await first, true);

  const second = controller.confirm('第二笔');
  const secondReq = queue.shift();
  // 误对旧请求再次结算 false 不得释放当前 secondReq 持有的确认锁
  controller.settle(firstReq, false);
  const blocked = controller.confirm('期间并发触发');
  assert.equal(await blocked, false);

  controller.settle(secondReq, true);
  assert.equal(await second, true);

  detach();
  controller.dispose();
});

test('AbortSignal 支持预中止、等待期中止，并在正常结算后移除 abort 监听', async () => {
  const { controller, queue, host } = setup();
  const detach = controller.attachHost(host);

  // 1. 预中止信号直接返回 false 且不占用锁
  const preAborted = new AbortController();
  preAborted.abort();
  assert.equal(await controller.confirm('已卸载', { signal: preAborted.signal }), false);

  // 2. 等待期内 abort 自动取消并释放锁
  const inFlight = new AbortController();
  const abortedPromise = controller.confirm('等待中离开', { signal: inFlight.signal });
  assert.equal(queue.length, 1);
  inFlight.abort();
  assert.equal(await abortedPromise, false);
  assert.equal(queue.length, 0);

  // 3. 正常结算后移除 abort 监听器（使用监听计数断言清理生效）
  const live = new AbortController();
  const baseAdd = live.signal.addEventListener.bind(live.signal);
  const baseRemove = live.signal.removeEventListener.bind(live.signal);
  let activeListeners = 0;
  live.signal.addEventListener = (type, listener, opts) => {
    if (type === 'abort') activeListeners++;
    return baseAdd(type, listener, opts);
  };
  live.signal.removeEventListener = (type, listener, opts) => {
    if (type === 'abort') activeListeners--;
    return baseRemove(type, listener, opts);
  };

  const normalPromise = controller.confirm('正常完成', { signal: live.signal });
  assert.equal(activeListeners, 1);
  controller.settle(queue.shift(), true);
  assert.equal(await normalPromise, true);
  assert.equal(activeListeners, 0);

  detach();
  controller.dispose();
});

test('hashchange 自动取消活动及排队中的确认框但保留 alert 队列，挂载宿主时按序排空', async () => {
  const { controller, queue, host, fireHashChange } = setup();

  // 无宿主时先进入 pendingQueue：一个 confirm + 一个 alert
  const pendingConfirm = controller.confirm('挂起确认');
  const pendingAlert = controller.alert('挂起提示');
  fireHashChange();
  assert.equal(await pendingConfirm, false);

  // 挂载宿主后，应仅剩 pendingAlert 被排空到 host queue
  const detach = controller.attachHost(host);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].kind, 'alert');
  controller.settle(queue.shift(), true);
  await pendingAlert;

  // 宿主已挂载状态下打开 confirm，hashchange 后自动取消
  const activeConfirm = controller.confirm('切换页面取消');
  assert.equal(queue.length, 1);
  fireHashChange();
  assert.equal(await activeConfirm, false);
  assert.equal(queue.length, 0);

  detach();
  controller.dispose();
});
