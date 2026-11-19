import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiryNotice, navNotice, parseAlias, setupCommands, type ReadTokenView } from '../web/src/read-token-form.ts';

const DAY = 86_400_000;
const view = (patch: Partial<ReadTokenView>): ReadTokenView => ({ state: 'active', id: '1a2b3c4d', createdAt: 0, expiresAt: 90 * DAY, lastUsedAt: null, requests24h: 0, warn: false, error: null, ...patch });

test('只读令牌页面：别名查询只接受平台发出的三种别名，大小写与空白归一', () => {
  assert.equal(parseAlias(' ADDR-1A2B3C4D '), 'addr-1a2b3c4d');
  assert.equal(parseAlias('acct-00ff00ff'), 'acct-00ff00ff');
  for (const bad of ['', 'addr-1a2b3c4', 'key-1a2b3c4d', '0x1a2b3c4d', 'addr-1a2b3c4dz']) assert.equal(parseAlias(bad), null, bad);
});

test('只读令牌页面：到期前 7 天起提示剩余天数，到期后提示重新生成；未生成不提示', () => {
  assert.equal(expiryNotice(view({}), 10 * DAY), null);
  assert.equal(navNotice(view({}), 10 * DAY), null);
  assert.match(expiryNotice(view({ warn: true }), 83 * DAY + 1)!, /将在 7 天内到期/);
  assert.equal(navNotice(view({ warn: true }), 89.5 * DAY), '只读令牌 1 天内到期');
  assert.match(expiryNotice(view({ state: 'expired', warn: true }), 91 * DAY)!, /已到期/);
  assert.equal(navNotice(view({ warn: true }), 90 * DAY), '只读令牌已到期');
  assert.equal(expiryNotice(view({ state: 'none', id: null, expiresAt: null }), 0), null);
  assert.equal(expiryNotice(null, 0), null);
});

test('只读令牌页面：设置命令不把令牌写进命令行，地址用页面来源', () => {
  const text = setupCommands('http://100.64.0.1:8787');
  assert.doesNotMatch(text, /tpr_/);
  assert.match(text, /cat > ~\/\.config\/trading-platform\/read-token/);
  assert.match(text, /TP_MCP_URL=http:\/\/100\.64\.0\.1:8787 /);
});
