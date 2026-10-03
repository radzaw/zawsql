import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableNameFromFile, autoMap, buildTarget, isValidType, fmtDuration } from '../../src/ZawSQL/wwwroot/js/importlogic.js';

test('a table name is derived from the file name', () => {
  assert.equal(tableNameFromFile('Sales Report 2024 (final).csv'), 'sales_report_2024_final');
  assert.equal(tableNameFromFile('Zamówienia – łódź.xlsx'), 'zamowienia_lodz');
  assert.equal(tableNameFromFile('2024.csv'), 't_2024');
  assert.equal(tableNameFromFile('---.csv'), 'imported');
  assert.equal(tableNameFromFile('x'.repeat(80) + '.csv').length, 64);
});

test('file columns are matched to table columns by name, or by position without a header', () => {
  assert.deepEqual(autoMap(['Customer ID', 'E-mail', 'Name', 'unknown'], ['customer_id', 'name', 'email']), ['customer_id', 'email', 'name', null]);
  assert.deepEqual(autoMap(['Nazwa', 'Ilość'], ['nazwa', 'ilosc']), ['nazwa', 'ilosc']); // accents ignored
  assert.deepEqual(autoMap(['id', 'ID'], ['id']), ['id', null]); // each table column once
  assert.deepEqual(autoMap(['column_1', 'column_2'], ['a', 'b'], { header: false }), ['a', 'b']);
  assert.deepEqual(autoMap(['column_1', 'column_2'], ['a', 'b', 'c'], { header: false }), [null, null]);
});

test('the target payload is validated', () => {
  const cols = [
    { include: true, name: 'sku', type: 'VARCHAR(16)', target: 'code' },
    { include: false, name: 'skip', type: 'INT', target: null },
    { include: true, name: 'price', type: 'DECIMAL(10,2)', target: 'price' },
  ];
  assert.deepEqual(buildTarget({ target: 'new', columns: cols, addId: true }), {
    create: [{ name: 'sku', type: 'VARCHAR(16)' }, { name: 'price', type: 'DECIMAL(10,2)' }],
    mapping: [{ source: 0, column: 'sku' }, { source: 2, column: 'price' }],
  });
  assert.deepEqual(buildTarget({ target: 'existing', columns: cols }), { create: null, mapping: [{ source: 0, column: 'code' }, { source: 2, column: 'price' }] });
  assert.throws(() => buildTarget({ target: 'new', columns: [{ include: true, name: 'id', type: 'INT' }], addId: true }), /auto-increment id/);
  assert.throws(() => buildTarget({ target: 'new', columns: [{ include: true, name: 'a', type: 'INT; DROP' }] }), /not a valid type/);
  assert.throws(() => buildTarget({ target: 'new', columns: [{ include: true, name: 'a', type: 'INT' }, { include: true, name: 'A', type: 'INT' }] }), /twice/);
  assert.throws(() => buildTarget({ target: 'existing', columns: [{ target: 'x' }, { target: 'x' }] }), /mapped twice/);
  assert.throws(() => buildTarget({ target: 'existing', columns: [{ target: null }] }), /at least one/);
  assert.ok(isValidType("ENUM('a','b')") && isValidType('DECIMAL(10, 2) UNSIGNED') && !isValidType('1INT'));
  assert.equal(fmtDuration(65_000), '1 min 5 s');
});
