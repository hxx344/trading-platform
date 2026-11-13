// The input rules of the asset writes (src/asset/validation.ts), which stand in for the workbench's zod schemas. The first
// case is the editSchema/editValue part of project_aggregation modules/asset/tests/exchanges.test.ts at 0014655 ("Invalid
// numbers, unexpected mutation properties ..."), expectations unchanged (parse() is parseEdit; finite and connectionSchema
// belong to A-3). The rest walks each schema's bounds the way zod 3 applies them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetInputError, editValue, parseEdit, parseFx, parseWithdrawal, parseWithdrawalId } from '../src/asset/validation.ts';

test('Invalid numbers, unexpected mutation properties and invalid wallet inputs are rejected', () => {
  assert.throws(() => parseEdit({ id: 'row-2', quantity: -1, price: 1 }));
  assert.throws(() => parseEdit({ id: 'row-2', quantity: 1, price: 1, mode: 'manual' }));
  assert.throws(() => editValue(1, null)); assert.equal(editValue(0, null), 0); assert.equal(editValue(100, 0.625), 62.5);
});

const refused = (run: () => unknown) => assert.throws(run, AssetInputError);

test('资产输入校验：编辑行的编号、数量与单价边界（含 null 单价与未知字段）', () => {
  assert.deepEqual(parseEdit({ id: 'row-12', quantity: 0, price: null }), { id: 'row-12', quantity: 0, price: null });
  assert.deepEqual(parseEdit({ id: 'row-1', quantity: 1e15, price: 1e9 }), { id: 'row-1', quantity: 1e15, price: 1e9 });
  for (const body of [
    null, [], 'row-1', {},
    { id: 'row-1', quantity: 1 }, // price is required (nullable, not optional)
    { id: 'row-x', quantity: 1, price: 1 }, { id: 'recorded-withdrawals', quantity: 1, price: 1 }, { id: 1, quantity: 1, price: 1 },
    { id: 'row-1', quantity: 1e15 + 1e3, price: 1 }, { id: 'row-1', quantity: 1, price: 1e9 + 1 }, { id: 'row-1', quantity: 1, price: -0.01 },
    { id: 'row-1', quantity: '1', price: 1 }, { id: 'row-1', quantity: NaN, price: 1 }, { id: 'row-1', quantity: Infinity, price: 1 }, { id: 'row-1', quantity: null, price: 1 },
    { id: 'row-1', quantity: 1, price: 1, owner: 'x' },
  ]) refused(() => parseEdit(body));
});

test('资产输入校验：汇率须大于 0 且不超过 1000，且只有 fx 一个字段', () => {
  assert.equal(parseFx({ fx: 7.1 }), 7.1);
  assert.equal(parseFx({ fx: 1000 }), 1000);
  assert.equal(parseFx({ fx: 0.001 }), 0.001);
  for (const body of [{ fx: 0 }, { fx: -1 }, { fx: 1000.01 }, { fx: '7' }, { fx: null }, { fx: Infinity }, {}, { fx: 7, source: 'manual' }]) refused(() => parseFx(body));
});

test('资产输入校验：出金的编号、日期、金额与备注（缺省备注为空，null 备注拒绝）', () => {
  const id = '8e7a9b2c-1d3f-4a5b-9c6d-7e8f9a0b1c2d';
  assert.deepEqual(parseWithdrawal({ id, date: '2024-02-29', amount: 1e12 }), { id, date: '2024-02-29', amount: 1e12, note: '' });
  assert.equal(parseWithdrawal({ id, date: '2026-09-19', amount: 0.01, note: ' ' + 'x'.repeat(200) + ' ' }).note.length, 200);
  // zod 3's uuid pattern takes any version and either case.
  assert.equal(parseWithdrawal({ id: id.toUpperCase().replace('4A5B', '1A5B'), date: '2026-09-19', amount: 1 }).id, id.toUpperCase().replace('4A5B', '1A5B'));
  for (const changes of [{ date: '2025-02-29' }, { date: '2026-9-19' }, { date: '2026-13-01' }, { amount: 1e12 + 0.01 }, { amount: '1' }, { note: null }, { note: 1 }, { id: id.replace(/-/g, '') }]) {
    refused(() => parseWithdrawal({ id, date: '2026-09-19', amount: 1, ...changes }));
  }
  refused(() => parseWithdrawal({ id, amount: 1 }));
  assert.equal(parseWithdrawalId({ id }), id);
  for (const body of [{}, { id: 'row-1' }, { id, date: '2026-09-19' }, null]) refused(() => parseWithdrawalId(body));
});
