import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanView, rememberView, viewFor, withExistingSort } from '../../src/ZawSQL/wwwroot/js/dataviewstate.js';

test('sorting and filter are remembered per table', () => {
  let s = rememberView(undefined, 'shop.orders', { sort: { col: 'total', dir: 'desc' }, where: "status = 'paid'", search: '' });
  s = rememberView(s, 'shop.customers', { sort: { col: 'name', dir: 'asc' }, where: '', search: '' });
  assert.deepEqual(viewFor(s, 'shop.orders'), { sort: { col: 'total', dir: 'desc' }, where: "status = 'paid'", search: '' });
  assert.deepEqual(viewFor(s, 'shop.customers'), { sort: { col: 'name', dir: 'asc' }, where: '', search: '' });
  // A table never sorted or filtered opens with the defaults.
  assert.deepEqual(viewFor(s, 'shop.products'), { sort: null, where: '', search: '' });
  assert.deepEqual(viewFor(undefined, 'x'), { sort: null, where: '', search: '' });
});

test('going back to the default view forgets the table', () => {
  let s = rememberView({}, 't', { sort: { col: 'id', dir: 'asc' } });
  s = rememberView(s, 't', { sort: null, where: '  ', search: '' });
  assert.deepEqual(s, {});
});

test('quick search text is kept with the filter it produced', () => {
  const s = rememberView({}, 't', { where: "`name` LIKE '%ann%'", search: 'ann' });
  assert.deepEqual(viewFor(s, 't'), { sort: null, where: "`name` LIKE '%ann%'", search: 'ann' });
});

test('stored views are normalized', () => {
  assert.equal(cleanView(null), null);
  assert.equal(cleanView({ sort: { dir: 'desc' } }), null); // no column
  assert.deepEqual(cleanView({ sort: { col: 'id', dir: 'sideways' }, where: ' a = 1 ' }), { sort: { col: 'id', dir: 'asc' }, where: 'a = 1' });
});

test('the store stays bounded, dropping the tables used least recently', () => {
  let s = {};
  for (const t of ['a', 'b', 'c', 'd']) s = rememberView(s, t, { where: 'x = 1' }, { tables: 3 });
  assert.deepEqual(Object.keys(s), ['b', 'c', 'd']);
  s = rememberView(s, 'b', { where: 'y = 2' }, { tables: 3 }); // using a table makes it the most recent
  s = rememberView(s, 'e', { where: 'x = 1' }, { tables: 3 });
  assert.deepEqual(Object.keys(s), ['d', 'b', 'e']);
});

test('a sort column the table no longer has is dropped', () => {
  const v = { sort: { col: 'old_name', dir: 'asc' }, where: 'id > 1', search: '' };
  assert.deepEqual(withExistingSort(v, ['id', 'new_name']), { ...v, sort: null });
  assert.equal(withExistingSort(v, ['id', 'old_name']), v);
});
