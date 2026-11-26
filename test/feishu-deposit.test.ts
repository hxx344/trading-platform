import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createNotifier } from '../src/service/feishu.ts';

const route = 'gate:arbitrum:0x' + 'ab'.repeat(20) + ':spot', key = 'chain-arb-deposit:' + route;
const sample = '【链上折价套利】ARB · Arbitrum One\n经充值地址模拟的样本';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'deposit-outbox-')), file = join(dir, 'notify.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { at: 2_000_000_000_000, fail: false };
  const sent: string[] = [];
  const open = (check?: (key: string, text: string) => number | null) => createNotifier({
    file, events: () => [], latestSeq: () => 0, pairs: () => [], incidentPair: () => null, log: () => {},
    feishu: { webhook: 'https://example.invalid', secret: null }, now: () => state.at, chainArbNotificationExpiry: check,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)).content.text); return Response.json({ code: state.fail ? 1 : 0 });
    },
  });
  return { file, state, sent, open };
}

test('升级旧飞书库会清理未发送的旧机会，已投递历史和同批其他模块照常保留', async t => {
  const { file, open, state, sent } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, sent_at INTEGER, last_error TEXT)');
  const insert = db.prepare('INSERT INTO outbox(created_at,text,next_at,sent_at) VALUES (?,?,?,?)');
  insert.run(state.at, sample, state.at, null);
  insert.run(state.at, '【余额提醒】上一版入队', state.at, null);
  insert.run(state.at, sample, state.at, state.at);
  db.close();
  const first = open();
  assert.equal(first.pending(), 1); assert.equal(first.status().recent.length, 2); first.close();
  const notifier = open();
  try {
    notifier.notifyRepeating('chain-arb:' + route, sample);
    notifier.notifyRepeating(key, sample);
    notifier.notify('【链上折价套利】回退后旧版入队');
    await notifier.flush();
    assert.deepEqual(sent, ['【余额提醒】上一版入队']);
    assert.equal(notifier.pending(), 0);
    assert.deepEqual(notifier.status().recent.map(row => row.id), [3, 2]);
  } finally { notifier.close(); }
});

test('飞书据真实入队键与正文核验每条机会，丢弃旧证明后相同路线可重新入队，已发仍去重', async t => {
  const { open, state, sent } = fixture(t);
  let active = sample;
  const notifier = open((k, text) => k === key && text === active ? state.at + 1 : null);
  try {
    notifier.notifyRepeating(key, sample);
    const rejected = notifier.status().recent[0]!.id;
    active = sample + ' 新一轮';
    notifier.notify('普通通知');
    await notifier.flush();
    assert.deepEqual(sent, ['普通通知']); assert.equal(notifier.delivery([rejected]).size, 0);
    notifier.notifyRepeating(key, active);
    await notifier.flush();
    assert.deepEqual(sent, ['普通通知', active]);
    notifier.notifyRepeating(key, active);
    assert.equal(notifier.pending(), 0);
  } finally { notifier.close(); }
});

test('飞书重试须重新核验，读同批其他账户拖过有效期时清理过期行', async t => {
  const { open, state, sent } = fixture(t);
  const expires = state.at + 15_000, key2 = key.replace(':spot', ':perp');
  let slow = false;
  const notifier = open(k => {
    if (k === key2 && slow) { state.at = expires; throw new Error('账户已撤销'); }
    return expires;
  });
  try {
    notifier.notifyRepeating(key, sample); notifier.notifyRepeating(key2, sample + ' 永续');
    notifier.notify('普通重试');
    state.fail = true; await notifier.flush();
    assert.equal(notifier.status().retrying, 3); assert.equal(sent.length, 1);
    state.at += 5000; state.fail = false; slow = true;
    await notifier.flush();
    assert.deepEqual(sent.slice(1), ['普通重试']);
    assert.equal(notifier.status().recent.length, 1); assert.equal(notifier.pending(), 0);
  } finally { notifier.close(); }
});

test('进程重启后旧样本失去证明，两次打开数据库仍能释放未发送样本的去重', async t => {
  const { open, state, sent } = fixture(t);
  const writer = open(() => state.at + 15_000);
  writer.notifyRepeating(key, sample); writer.close();
  const after = open((_, text) => text === sample ? null : state.at + 15_000);
  try {
    await after.flush();
    assert.deepEqual(sent, []); assert.equal(after.status().recent.length, 0);
    after.notifyRepeating(key, sample + ' 已复核');
    await after.flush(); assert.deepEqual(sent, [sample + ' 已复核']);
  } finally { after.close(); }
});

test('旧版飞书发送查询在入队和失败重试期间都看不到受保护的机会，重新升级清理旧延迟消息', async t => {
  const { file, open, state, sent } = fixture(t);
  const notifier = open(() => state.at + 15_000);
  const db = new DatabaseSync(file);
  // The exact due-row query from v0.101.1, which does not know the account guard or guarded_due_at.
  const oldDue = db.prepare('SELECT id, text, attempts FROM outbox WHERE sent_at IS NULL AND next_at <= ? ORDER BY id LIMIT ?');
  const oldTexts = (at: number) => oldDue.all(at, 10).map(row => row.text);
  const ordinary = '普通通知';
  const initialAt = state.at;
  try {
    notifier.notifyRepeating(key, sample);
    notifier.notify(ordinary);
    const pending = notifier.status().recent.find(row => row.text === sample)!;
    assert.equal(pending.nextAt, initialAt); assert.deepEqual(oldTexts(initialAt), [ordinary]);
    state.fail = true; await notifier.flush();
    assert.equal(notifier.delivery([pending.id]).get(pending.id)?.nextAt, initialAt + 5000);
    assert.equal(notifier.status().nextRetryAt, initialAt + 5000);
    assert.deepEqual(oldTexts(initialAt + 4999), []);
    assert.deepEqual(oldTexts(initialAt + 86_400_000), [ordinary]);
  } finally { notifier.close(); }

  try {
    state.at += 5_000;
    const old = oldDue.all(state.at, 10);
    for (const row of old) db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?').run(state.at, row.id);
    const insert = db.prepare('INSERT INTO outbox(created_at, text, next_at, repeat_key) VALUES (?,?,?,?)');
    insert.run(state.at, sample + ' 旧版未来补发', state.at + 300_000, null);
    insert.run(state.at, sample + ' 旧键未来补发', state.at + 300_000, 'chain-arb:' + route);
    state.fail = false;
    for (let i = 0; i < 2; i++) {
      const restarted = open(() => state.at + 15_000);
      try {
        assert.ok(!restarted.status().recent.some(row => row.text.endsWith('未来补发')));
        if (i === 1) { assert.equal(restarted.pending(), 1); await restarted.flush(); }
      } finally { restarted.close(); }
    }
    assert.deepEqual(sent, [sample + '\n' + ordinary, sample]);
    assert.deepEqual(oldTexts(state.at + 300_000), []);
  } finally { db.close(); }
});
