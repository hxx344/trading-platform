import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiryNotice, generateBody, navNotice, parseAlias, scopeText, setupCommands, type ReadTokenItem, type ReadTokenView } from '../web/src/read-token-form.ts';

const DAY = 86_400_000;
const item = (patch: Partial<ReadTokenItem>): ReadTokenItem => ({ id: '1a2b3c4d', name: 'MCP', scopes: ['public', 'system', 'portfolio'], state: 'active', createdAt: 0, expiresAt: 90 * DAY, lastUsedAt: null, requests24h: 0, warn: false, ...patch });
const view = (...tokens: Partial<ReadTokenItem>[]): ReadTokenView => ({ tokens: tokens.map(item), max: 8, error: null });

test('只读令牌页面：别名查询只接受平台发出的三种别名，大小写与空白归一', () => {
  assert.equal(parseAlias(' ADDR-1A2B3C4D '), 'addr-1a2b3c4d');
  assert.equal(parseAlias('acct-00ff00ff'), 'acct-00ff00ff');
  for (const bad of ['', 'addr-1a2b3c4', 'key-1a2b3c4d', '0x1a2b3c4d', 'addr-1a2b3c4dz']) assert.equal(parseAlias(bad), null, bad);
});

test('只读令牌页面：到期前 7 天起提示剩余天数，到期后提示重新生成；没有令牌不提示；多个令牌逐个写名称', () => {
  assert.equal(expiryNotice(view({}), 10 * DAY), null);
  assert.equal(navNotice(view({}), 10 * DAY), null);
  assert.match(expiryNotice(view({ warn: true }), 83 * DAY + 1)!, /「MCP」将在 7 天内到期/);
  assert.equal(navNotice(view({ warn: true }), 89.5 * DAY), '只读令牌 1 天内到期');
  assert.match(expiryNotice(view({ state: 'expired', warn: true }), 91 * DAY)!, /「MCP」已到期/);
  assert.equal(navNotice(view({ warn: true }), 90 * DAY), '只读令牌已到期');
  assert.equal(expiryNotice(view(), 0), null);
  assert.equal(expiryNotice(null, 0), null);
  const many = view({ id: 'a', name: '甲', state: 'expired' }, { id: 'b', name: '乙', state: 'expired' }, { id: 'c', name: '丙', warn: true, expiresAt: 95 * DAY }, { id: 'd', name: '丁', expiresAt: 200 * DAY });
  const text = expiryNotice(many, 91 * DAY)!;
  assert.match(text, /「甲」「乙」已到期/);
  assert.match(text, /「丙」将在 4 天内到期/);
  assert.doesNotMatch(text, /丁/);
  assert.equal(navNotice(many, 91 * DAY), '2 个只读令牌已到期');
});

test('只读令牌页面：生成请求要名称（1–40 个字、无控制字符）与至少一个范围，范围按固定顺序，满 8 个不发', () => {
  assert.deepEqual(generateBody('  本机 Claude Code ', new Set(['portfolio', 'public']), view()), { body: { name: '本机 Claude Code', scopes: ['public', 'portfolio'] } });
  assert.match((generateBody('  ', new Set(['public']), view()) as { error: string }).error, /名称/);
  assert.match((generateBody('字'.repeat(41), new Set(['public']), view()) as { error: string }).error, /40/);
  assert.ok('body' in generateBody('字'.repeat(40), new Set(['public']), view()));
  assert.match((generateBody('a\tb', new Set(['public']), view()) as { error: string }).error, /控制字符/);
  assert.match((generateBody('a', new Set(), view()) as { error: string }).error, /范围/);
  const full = view(...Array.from({ length: 8 }, (_, i) => ({ id: String(i) })));
  assert.match((generateBody('a', new Set(['public']), full) as { error: string }).error, /最多 8 个/);
  assert.equal(scopeText(['public', 'system']), '公开行情、系统状态');
});

test('只读令牌页面：设置命令不把令牌写进命令行，地址用页面来源', () => {
  const text = setupCommands('http://100.64.0.1:8787');
  assert.doesNotMatch(text, /tpr_/);
  assert.match(text, /cat > ~\/\.config\/trading-platform\/read-token/);
  assert.match(text, /TP_MCP_URL=http:\/\/100\.64\.0\.1:8787 /);
});
