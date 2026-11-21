// Page sessions (src/sessions.ts): one per login, kept as digests in the data directory, ended by their 30 days, a week
// unused, a logout, or a new login password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SESSIONS, SESSION_IDLE_MS, SESSION_LIFETIME_MS, executorSessionId, openSessionStore, sessionEpoch } from '../src/sessions.ts';

function withDir(run: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-sessions-'));
  try { run(join(dir, 'http-session')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('页面会话：每次登录一个，文件只存摘要且仅本账户可读，重启沿用；单个退出不影响别的', () => withDir(file => {
  const clock = { now: 1_000_000 };
  const open = () => openSessionStore({ file, epoch: 'e1', now: () => clock.now, log: () => undefined });
  const store = open();
  const a = store.create(), b = store.create();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes(a) && !text.includes(b), '文件里没有 cookie 值');
  assert.equal(store.check(a)?.id, executorSessionId(a));
  assert.equal(store.check('wrong'), null);
  assert.equal(store.maxAgeS, SESSION_LIFETIME_MS / 1000);

  const again = open();
  assert.equal(again.count(), 2);
  assert.equal(again.check(b)?.id, executorSessionId(b));
  assert.equal(again.remove(a), true);
  assert.equal(again.check(a), null);
  assert.ok(again.check(b));
  assert.equal(open().check(a), null, '退出写进文件');
  assert.equal(again.removeAll(), 1);
  assert.equal(open().count(), 0);
}));

test('页面会话：闲置 7 天或登录满 30 天即失效，每次请求都检查；使用会续上闲置期', () => withDir(file => {
  const clock = { now: 5_000_000 };
  const store = openSessionStore({ file, epoch: 'e', now: () => clock.now, log: () => undefined });
  const idle = store.create(), busy = store.create();
  clock.now += SESSION_IDLE_MS - 1;
  assert.ok(store.check(busy));
  clock.now += 1;
  assert.equal(store.check(idle), null, '闲置满 7 天');
  // Used every few days, it still ends 30 days after its login.
  while (clock.now + 3 * 86_400_000 < 5_000_000 + SESSION_LIFETIME_MS) { clock.now += 3 * 86_400_000; assert.ok(store.check(busy)); }
  clock.now = 5_000_000 + SESSION_LIFETIME_MS;
  const info = openSessionStore({ file, epoch: 'e', now: () => clock.now - 1, log: () => undefined }).check(busy);
  assert.equal(info?.expiresAt, 5_000_000 + SESSION_LIFETIME_MS, '从文件读回时闲置期已按小时写入');
  assert.equal(store.check(busy), null, '满 30 天');
}));

test('页面会话：换了登录密码（epoch 不同）全部作废；旧版单值文件接管为一个会话且执行器会话号不变，过期的不接管', () => withDir(file => {
  const first = openSessionStore({ file, epoch: sessionEpoch(undefined), log: () => undefined });
  const token = first.create();
  const password = { salt: Buffer.alloc(16, 1), key: Buffer.alloc(32, 2) };
  assert.notEqual(sessionEpoch(password), sessionEpoch(undefined));
  assert.equal(openSessionStore({ file, epoch: sessionEpoch(password), log: () => undefined }).check(token), null);

  const legacy = 'L'.repeat(43);
  writeFileSync(file, `${legacy}\n`, { mode: 0o600 });
  const taken = openSessionStore({ file, epoch: 'e', log: () => undefined });
  assert.equal(taken.check(legacy)?.id, executorSessionId(legacy));
  assert.ok(!readFileSync(file, 'utf8').includes(legacy), '接管后改写为摘要格式');
  assert.ok(openSessionStore({ file, epoch: 'e', log: () => undefined }).check(legacy));

  writeFileSync(file, `${legacy}\n`, { mode: 0o600 });
  const old = (Date.now() - SESSION_LIFETIME_MS - 60_000) / 1000;
  utimesSync(file, old, old);
  assert.equal(openSessionStore({ file, epoch: 'e', log: () => undefined }).check(legacy), null);

  writeFileSync(file, '');
  assert.equal(openSessionStore({ file, epoch: 'e', log: () => undefined }).count(), 0, '空文件或格式不对时从零开始');
}));

test('页面会话：超过上限时去掉最久未用的；预置会话不过期、不写文件', () => withDir(file => {
  const clock = { now: 1 };
  const store = openSessionStore({ file, epoch: 'e', seed: ['seeded-value'], now: () => clock.now, log: () => undefined });
  const tokens = Array.from({ length: MAX_SESSIONS }, () => { clock.now += 1; return store.create(); });
  clock.now += 1;
  assert.ok(store.check(tokens[0]!), '最早的刚用过');
  clock.now += 1;
  store.create();
  assert.ok(store.check(tokens[0]!));
  assert.equal(store.check(tokens[1]!), null, '最久未用的被挤掉');
  clock.now += SESSION_LIFETIME_MS * 2;
  assert.ok(store.check('seeded-value'));
  assert.ok(!readFileSync(file, 'utf8').includes(executorSessionId('seeded-value')));
}));

test('页面会话：退出或注销全部时文件写不进去，就删掉文件，重启后被注销的会话不会复活', () => withDir(file => {
  const lines: string[] = [];
  let fail = false;
  const open = () => openSessionStore({ file, epoch: 'e', log: line => lines.push(line), writeTemp: (path, text) => {
    if (fail) throw new Error('ENOSPC: no space left on device');
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
  } });
  const store = open();
  const a = store.create(), b = store.create();
  fail = true;
  store.create();
  assert.ok(existsSync(file), '新建会话写失败时保留原文件');
  assert.equal(store.removeAll(), 3);
  assert.ok(!existsSync(file));
  assert.match(lines.at(-1)!, /已删除该文件/);
  fail = false;
  const again = open();
  assert.equal(again.check(a), null);
  assert.equal(again.check(b), null);
}));
