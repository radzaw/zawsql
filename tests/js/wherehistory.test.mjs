import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberWhere, forgetWhere, whereLabel, whereKey } from '../../src/ZawSQL/wwwroot/js/wherehistory.js';

test('filters are remembered per table, most recent first, once each', () => {
  const k = whereKey('shop', 'orders');
  assert.equal(k, 'shop.orders');
  let s = rememberWhere(undefined, k, "status = 'new'");
  s = rememberWhere(s, k, 'total > 100');
  s = rememberWhere(s, whereKey('shop', 'customers'), "country = 'PL'");
  // Used again (even with different spacing or line breaks): moves to the top, no duplicate.
  s = rememberWhere(s, k, "status =\n  'new'");
  assert.deepEqual(s[k], ["status =\n  'new'", 'total > 100']);
  assert.deepEqual(s['shop.customers'], ["country = 'PL'"]);
  // Empty filters aren't remembered.
  assert.equal(rememberWhere(s, k, '   '), s);
});

test('the history stays bounded', () => {
  let s = {};
  for (let i = 0; i < 30; i++) s = rememberWhere(s, 't', `id = ${i}`, { perTable: 20 });
  assert.equal(s.t.length, 20);
  assert.equal(s.t[0], 'id = 29');
  // Beyond the table limit, the tables used least recently are dropped.
  let m = {};
  for (const t of ['a', 'b', 'c', 'd']) m = rememberWhere(m, t, 'x = 1', { tables: 3 });
  assert.deepEqual(Object.keys(m), ['b', 'c', 'd']);
  m = rememberWhere(m, 'b', 'y = 2', { tables: 3 }); // using a table makes it the most recent
  m = rememberWhere(m, 'e', 'x = 1', { tables: 3 });
  assert.deepEqual(Object.keys(m), ['d', 'b', 'e']);
});

test('forgetting one filter or a whole table', () => {
  let s = rememberWhere(rememberWhere({}, 't', 'a = 1'), 't', 'b = 2');
  s = forgetWhere(s, 't', 'a  =  1');
  assert.deepEqual(s.t, ['b = 2']);
  s = forgetWhere(s, 't', 'b = 2');
  assert.equal(s.t, undefined); // an empty list disappears
  s = rememberWhere(s, 'u', 'c = 3');
  assert.deepEqual(forgetWhere(s, 'u'), {});
  assert.deepEqual(forgetWhere({}, 'nope', 'x'), {});
});

test('menu labels are one line and short', () => {
  assert.equal(whereLabel("status = 'new'\n  AND total > 10"), "status = 'new' AND total > 10");
  const long = 'x = 1 AND '.repeat(20);
  assert.equal(whereLabel(long).length, 90);
  assert.ok(whereLabel(long).endsWith('…'));
});
