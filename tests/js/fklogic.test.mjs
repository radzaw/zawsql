import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlLiteral, matchWhere, linkColumns, rowLinks, tableLabel } from '../../src/ZawSQL/wwwroot/js/fklogic.js';

const rel = {
  outgoing: [
    { name: 'fk_cust', columns: ['customer_id'], refDb: 'shop', refTable: 'customers', refColumns: ['id'] },
    { name: 'fk_prod', columns: ['shop_id', 'sku'], refDb: 'catalog', refTable: 'products', refColumns: ['shop', 'sku'] },
  ],
  incoming: [
    { name: 'fk_line', db: 'shop', table: 'order_lines', columns: ['order_id'], refColumns: ['id'] },
  ],
};
const cols = [{ name: 'id', kind: 'int' }, { name: 'customer_id', kind: 'int' }, { name: 'shop_id', kind: 'int' }, { name: 'sku', kind: 'text' }];

test('values become literals that match their column', () => {
  assert.equal(sqlLiteral('42', 'int'), '42');
  assert.match(sqlLiteral("O'Brien", 'text'), /^'O.*Brien'$/);
  assert.equal(sqlLiteral('0xDEADBEEF', 'binary'), '0xDEADBEEF');
  // Not a number after all: quoted rather than pasted into the SQL.
  assert.match(sqlLiteral('1; DROP', 'int'), /^'/);
  assert.equal(sqlLiteral(null, 'int'), 'NULL');
});

test('a NULL foreign key leads nowhere', () => {
  assert.equal(matchWhere(['a', 'b'], ['1', "'x'"]), "`a` = 1 AND `b` = 'x'");
  assert.equal(matchWhere(['a', 'b'], ['1', null]), null);
  assert.equal(matchWhere([], []), null);
});

test('foreign key columns are marked as links', () => {
  assert.deepEqual([...linkColumns(rel)].sort(), ['customer_id', 'shop_id', 'sku']);
  assert.equal(linkColumns(null).size, 0);
});

test('a row leads to the rows it references and the rows referencing it', () => {
  const r = rowLinks(rel, cols, ['7', '3', '1', 'A-1'], 'sku');
  // The key containing the clicked column comes first.
  assert.deepEqual(r.outgoing.map(l => l.table), ['products', 'customers']);
  assert.equal(r.outgoing[0].where, "`shop` = 1 AND `sku` = 'A-1'");
  assert.equal(r.outgoing[0].db, 'catalog');
  assert.equal(r.outgoing[1].where, '`id` = 3');
  assert.equal(r.incoming[0].where, '`order_id` = 7');
  assert.equal(tableLabel(r.outgoing[0], 'shop'), 'catalog.products (shop, sku)');
  assert.equal(tableLabel(r.outgoing[1], 'shop'), 'customers (id)');

  const nulls = rowLinks(rel, cols, ['7', null, '1', null]);
  assert.equal(nulls.outgoing[0].where, null);
  assert.equal(nulls.outgoing[1].where, null);
  assert.equal(nulls.incoming[0].where, '`order_id` = 7');
});

test('column names match regardless of case, and a missing column disables the link', () => {
  const r = rowLinks({ outgoing: [{ columns: ['Customer_ID'], refDb: 's', refTable: 'c', refColumns: ['id'] }], incoming: [] }, cols, ['1', '5', '1', 'x']);
  assert.equal(r.outgoing[0].where, '`id` = 5');
  const m = rowLinks({ outgoing: [{ columns: ['gone'], refDb: 's', refTable: 'c', refColumns: ['id'] }], incoming: [] }, cols, ['1', '5', '1', 'x']);
  assert.equal(m.outgoing[0].where, null);
});
