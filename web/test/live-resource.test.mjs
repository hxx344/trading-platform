// The shared read layer's hidden-page rules (web/src/live-resource.ts): reads pause in a hidden tab unless a subscriber
// asks for background reads, as the 系统更新 button does while it follows an update (docs/update.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceStore } from '../src/live-resource.ts';

function fakeEnvironment() {
  let now = 0, hidden = false, online = true, nextId = 0;
  const timers = new Map();
  let wake = () => {};
  const env = {
    now: () => now,
    hidden: () => hidden,
    online: () => online,
    setTimer: (callback, ms) => { const id = ++nextId; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimer: timer => { timers.delete(timer); },
    listen: listener => { wake = listener; return () => { wake = () => {}; }; },
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    env,
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await settle();
      }
      now = until;
    },
    async setHidden(value) { hidden = value; wake(); await settle(); },
    async setOnline(value) { online = value; wake(); await settle(); },
    settle,
  };
}

function setup() {
  const fake = fakeEnvironment();
  const store = createResourceStore(fake.env);
  let reads = 0;
  const read = async () => ++reads;
  const snapshots = [];
  return { fake, store, read, reads: () => reads, snapshots, last: () => snapshots.at(-1) };
}

test('live-resource：页面隐藏后普通订阅暂停轮询，回到前台立即重读', async () => {
  const { fake, store, read, reads, snapshots, last } = setup();
  store.subscribe('/a', { read, intervalMs: 1_000 }, snapshot => snapshots.push(snapshot));
  await fake.settle();
  assert.equal(reads(), 1);
  await fake.setHidden(true);
  assert.equal(last().status, 'paused');
  await fake.advance(10_000);
  assert.equal(reads(), 1);
  await fake.setHidden(false);
  assert.equal(reads(), 2);
  assert.equal(last().status, 'ready');
});

test('live-resource：要求后台读取的订阅在页面隐藏时照常轮询，离线时仍暂停', async () => {
  const { fake, store, read, reads, snapshots, last } = setup();
  store.subscribe('/a', { read, intervalMs: 1_000, background: true }, snapshot => snapshots.push(snapshot));
  await fake.settle();
  await fake.setHidden(true);
  assert.equal(last().status, 'ready');
  await fake.advance(3_000);
  assert.equal(reads(), 4);
  assert.equal(last().data, 4);
  await fake.setOnline(false);
  assert.equal(last().status, 'offline');
  await fake.advance(3_000);
  assert.equal(reads(), 4);
  await fake.setOnline(true);
  assert.equal(reads(), 5);
});

test('live-resource：隐藏时打开后台读取立即恢复轮询，关闭后再次暂停', async () => {
  const { fake, store, read, reads, snapshots, last } = setup();
  const subscription = store.subscribe('/a', { read, intervalMs: 1_000 }, snapshot => snapshots.push(snapshot));
  await fake.settle();
  await fake.setHidden(true);
  await fake.advance(5_000);
  assert.equal(reads(), 1);
  subscription.setBackground(true);
  await fake.settle();
  assert.equal(reads(), 2, '暂停期间已到期，打开后台读取即补读');
  await fake.advance(2_000);
  assert.equal(reads(), 4);
  subscription.setBackground(false);
  await fake.settle();
  assert.equal(last().status, 'paused');
  await fake.advance(5_000);
  assert.equal(reads(), 4);
});

test('live-resource：共享条目中要求后台读取的订阅者离开后，隐藏页面的读取暂停', async () => {
  const { fake, store, read, reads, snapshots, last } = setup();
  store.subscribe('/a', { read, intervalMs: 1_000 }, snapshot => snapshots.push(snapshot));
  const leave = store.subscribe('/a', { read, intervalMs: 1_000, background: true }, () => {});
  await fake.settle();
  await fake.setHidden(true);
  await fake.advance(2_000);
  assert.equal(reads(), 3);
  leave();
  await fake.settle();
  assert.equal(last().status, 'paused');
  await fake.advance(5_000);
  assert.equal(reads(), 3);
});

// A read that stays in flight until the test settles it; aborts are recorded.
function pendingReads() {
  const calls = [];
  const read = signal => new Promise((resolve, reject) => {
    const call = { resolve, reject, aborted: false };
    signal.addEventListener('abort', () => { call.aborted = true; reject(new Error('aborted')); });
    calls.push(call);
  });
  return { calls, read };
}

test('live-resource：后台读取时页面切到隐藏，在途读取不被中止、也不多发', async () => {
  const fake = fakeEnvironment();
  const store = createResourceStore(fake.env);
  const { calls, read } = pendingReads();
  const snapshots = [];
  store.subscribe('/a', { read, intervalMs: 1_000, background: true }, snapshot => snapshots.push(snapshot));
  await fake.settle();
  assert.equal(calls.length, 1);
  await fake.setHidden(true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].aborted, false);
  calls[0].resolve(7);
  await fake.settle();
  assert.equal(snapshots.at(-1).data, 7);
  assert.equal(snapshots.at(-1).status, 'ready');
});

test('live-resource：读取在途时关闭后台读取会中止它，回到前台重读', async () => {
  const fake = fakeEnvironment();
  const store = createResourceStore(fake.env);
  const { calls, read } = pendingReads();
  const snapshots = [];
  const subscription = store.subscribe('/a', { read, intervalMs: 1_000, background: true }, snapshot => snapshots.push(snapshot));
  await fake.setHidden(true);
  await fake.settle();
  assert.equal(calls.length, 1);
  subscription.setBackground(false);
  await fake.settle();
  assert.equal(calls[0].aborted, true);
  assert.equal(snapshots.at(-1).status, 'paused');
  await fake.advance(5_000);
  assert.equal(calls.length, 1);
  await fake.setHidden(false);
  assert.equal(calls.length, 2);
});

test('live-resource：后台读取遇到 401 后不自动重试，隐藏与恢复都只显示失败', async () => {
  const fake = fakeEnvironment();
  const store = createResourceStore(fake.env);
  let reads = 0;
  const read = async () => { reads++; throw Object.assign(new Error('expired'), { status: 401 }); };
  const snapshots = [];
  const subscription = store.subscribe('/a', { read, intervalMs: 1_000, background: true }, snapshot => snapshots.push(snapshot));
  await fake.settle();
  assert.equal(reads, 1);
  await fake.setHidden(true);
  await fake.advance(5_000);
  subscription.setBackground(false);
  subscription.setBackground(true);
  await fake.setHidden(false);
  await fake.advance(5_000);
  assert.equal(reads, 1);
  assert.equal(snapshots.at(-1).status, 'error');
});

test('live-resource：隐藏时带后台读取的订阅者加入已暂停的共享条目，立即恢复读取', async () => {
  const fake = fakeEnvironment();
  const store = createResourceStore(fake.env);
  let reads = 0;
  const read = async () => ++reads;
  const snapshots = [];
  store.subscribe('/a', { read, intervalMs: 60_000 }, snapshot => snapshots.push(snapshot));
  await fake.settle();
  await fake.setHidden(true);
  assert.equal(snapshots.at(-1).status, 'paused');
  store.subscribe('/a', { read, intervalMs: 60_000, background: true }, () => {});
  await fake.settle();
  assert.equal(reads, 2);
  assert.equal(snapshots.at(-1).status, 'ready');
});

test('live-resource：读取失败后因隐藏暂停时保留错误，读成功才清空（系统更新据此判断连续读不到）', async () => {
  const fake = fakeEnvironment();
  const store = createResourceStore(fake.env);
  let fail = true;
  const read = async () => { if (fail) throw new Error('down'); return 1; };
  const snapshots = [];
  store.subscribe('/a', { read, intervalMs: 1_000 }, snapshot => snapshots.push(snapshot));
  await fake.settle();
  await fake.setHidden(true);
  assert.equal(snapshots.at(-1).status, 'paused');
  assert.equal(snapshots.at(-1).error?.message, 'down');
  fail = false;
  await fake.setHidden(false);
  assert.equal(snapshots.at(-1).status, 'ready');
  assert.equal(snapshots.at(-1).error, null);
});
