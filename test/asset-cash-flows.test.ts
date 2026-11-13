// Copied from project_aggregation modules/asset/tests/cash-flows.test.ts at 0014655; the expectations are unchanged.
// Changes: imports point at src/asset; the first case replays its revisions through amendCashFlows and settings instead of saveCashFlow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openAssetDb, type AssetDb } from '../src/asset/db.ts';
import { CASH_FLOW_KEY, amendCashFlows, cashFlowEvidence, intervalCashFlows, parseCashFlow, type CashFlowInput } from '../src/asset/cash-flows.ts';
import { loadCashFlows } from '../src/asset/store.ts';

const now = Date.parse('2026-11-10T12:00:00Z');
const input = (extra: Partial<CashFlowInput> = {}): CashFlowInput => ({ id: randomUUID(), revision: 0, date: '2026-11-10', account: 'account-a', currency: 'USD', amount: '100',
  kind: 'external', transferId: null, usdRate: null, rateAt: null, reference: 'statement:1', reason: '核对流水', void: false, ...extra });

test('cash flow amendments preserve original versions, reject stale edits and make identical lost-response retries idempotent', async t => {
  const database = openAssetDb(':memory:'); t.after(() => database.close());
  // What saveCashFlow does in the workbench (cash-flow-store.ts), without its sync lock and owner: parse, amend, store.
  const saveCashFlow = async (database: AssetDb, value: unknown, now: number) => {
    const next = amendCashFlows(await loadCashFlows(database), parseCashFlow(value, now), now);
    database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(CASH_FLOW_KEY, JSON.stringify(next)).run();
    return next;
  };
  const original = input();
  const first = await saveCashFlow(database, original, now);
  assert.equal(first[0].revision, 1); assert.equal((await saveCashFlow(database, original, now)).length, 1);
  await assert.rejects(saveCashFlow(database, { ...original, amount: '101' }, now), /已被修改/);
  await saveCashFlow(database, { ...original, revision: 1, amount: '101', reason: '凭证更正' }, now);
  const audit = await loadCashFlows(database); assert.deepEqual(audit.map(row => row.amount), ['100', '101']);
  const voided = amendCashFlows(audit, { ...original, revision: 2, amount: '101', reason: '撤回错误标注', void: true }, now);
  assert.equal(cashFlowEvidence(voided).length, 0); assert.equal(voided.length, 3);
});

test('internal transfer pairing requires one unique same-day equal opposite pair, and duplicates/cross-day remain pending', () => {
  const outgoing = input({ kind: 'internal', transferId: 'transfer-1', amount: '-10' });
  const incoming = input({ kind: 'internal', transferId: 'transfer-1', account: 'account-b', amount: '10' });
  const audit = amendCashFlows(amendCashFlows([], outgoing, now), incoming, now);
  assert.deepEqual(cashFlowEvidence(audit).map(row => [row.status, row.usdValue]), [['paired', 0], ['paired', 0]]);
  assert.equal(intervalCashFlows(audit, '2026-11-09', '2026-11-10').knownNetUsd, null, 'paired records are not external contribution');
  const duplicate = amendCashFlows(audit, input({ ...incoming, id: randomUUID() }), now);
  assert.ok(cashFlowEvidence(duplicate).every(row => row.status === 'pending'));
  const crossed = amendCashFlows(audit, { ...incoming, revision: 1, date: '2026-11-09', reason: '实际到账为前一日' }, now);
  assert.ok(cashFlowEvidence(crossed).every(row => row.status === 'pending'));
});

test('missing or old FX remains unknown and native amounts are never replaced with USD guesses', () => {
  const missing = input({ currency: 'USDT', amount: '10' });
  const old = input({ currency: 'EUR', usdRate: '1.1', rateAt: '2026-11-09T00:00:00Z' });
  const current = input({ currency: 'EUR', usdRate: '1.1', rateAt: '2026-11-10T00:00:00Z' });
  const audit = [missing, old, current].reduce((rows, row) => amendCashFlows(rows, row, now), [] as ReturnType<typeof amendCashFlows>);
  const evidence = cashFlowEvidence(audit); assert.equal(evidence[0].usdValue, null); assert.equal(evidence[1].usdValue, null);
  assert.match(evidence[1].note!, /日期/); assert.equal(evidence[2].usdValue, 110);
  assert.throws(() => parseCashFlow({ ...missing, reference: '' }, now));
  assert.throws(() => parseCashFlow({ ...missing, apiSecret: 'no' }, now));
  assert.throws(() => parseCashFlow({ ...missing, date: '2026-02-31' }, now));
});

test('cash flow kind rejects arrays and coercible objects before enum validation', () => {
  const row = input();
  for (const kind of [['external'], ['internal'], { toString: () => 'external' }, { valueOf: () => 'internal' }, null, 0]) {
    assert.throws(() => parseCashFlow({ ...row, kind }, now), /资金流字段无效/);
  }
  assert.equal(parseCashFlow(row, now).kind, 'external');
  assert.equal(parseCashFlow({ ...row, kind: 'internal', transferId: 'pair-1' }, now).kind, 'internal');
});
