import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fragPct, skipReason, fragmented, fragSummary, fragSchemas, fragKey, optimizeOutcome, expiryText } from '../../src/ZawSQL/wwwroot/js/fraglogic.js';

const MIB = 1024 * 1024;
const t = (schema, name, engine, data, index, free) => ({ schema, name, engine, rows: 1, dataBytes: data * MIB, indexBytes: index * MIB, freeBytes: free * MIB });
const tables = [
  t('shop', 'orders', 'InnoDB', 80, 10, 110),   // 55 %
  t('shop', 'small', 'InnoDB', 1, 0, 4),          // 4 MiB: under the default 10 MiB
  t('shop', 'big', 'InnoDB', 9000, 1000, 200),    // 2 %: under the default 10 %
  t('logs', 'events', 'MyISAM', 30, 5, 15),       // 30 %
  t('logs', 'mem', 'MEMORY', 10, 0, 20),          // engine without OPTIMIZE
  t('logs', 'clean', 'InnoDB', 10, 0, 0),
];

test('fragmentation: share of free space', () => {
  assert.equal(fragPct(t('a', 'b', 'InnoDB', 60, 20, 20)), 20);
  assert.equal(fragPct(t('a', 'b', 'InnoDB', 0, 0, 0)), 0);
});

test('fragmentation: thresholds, filters and order', () => {
  assert.deepEqual(fragmented(tables).map(x => x.name), ['orders', 'mem', 'events']);
  assert.deepEqual(fragmented(tables, { minFree: 0, minPct: 0 }).map(x => x.name), ['big', 'orders', 'mem', 'events', 'small']);
  assert.deepEqual(fragmented(tables, { schema: 'logs' }).map(x => x.name), ['mem', 'events']);
  assert.deepEqual(fragmented(tables, { text: 'myisam' }).map(x => x.name), ['events']);
  assert.deepEqual(fragmented(tables, { text: 'shop.ord' }).map(x => x.name), ['orders']);
  // Tables just optimized stay listed even when they are now under the thresholds.
  assert.deepEqual(fragmented(tables, { keep: new Set([fragKey(tables[5])]) }).map(x => x.name), ['orders', 'mem', 'events', 'clean']);
  assert.deepEqual(fragSchemas(tables), ['logs', 'shop']);
});

test('fragmentation: tables optimizing would not help are skipped', () => {
  assert.equal(skipReason(tables[0], true), null);
  assert.equal(skipReason(tables[3], null), null);
  assert.match(skipReason(tables[4], true), /MEMORY doesn't support/);
  assert.match(skipReason(tables[0], false), /innodb_file_per_table is off/);
  assert.equal(skipReason(tables[3], false), null); // MyISAM has its own files anyway
  const rows = fragmented(tables);
  assert.deepEqual(fragSummary(rows), { tables: 3, freeBytes: 145 * MIB, optimizable: 2, reclaimBytes: 125 * MIB, sizeBytes: 125 * MIB });
});

test('fragmentation: OPTIMIZE TABLE results', () => {
  // InnoDB: a note about recreate + analyze, then OK.
  assert.deepEqual(optimizeOutcome([
    ['shop.orders', 'optimize', 'note', 'Table does not support optimize, doing recreate + analyze instead'],
    ['shop.orders', 'optimize', 'status', 'OK'],
  ]), { ok: true, text: 'OK' });
  assert.deepEqual(optimizeOutcome([['logs.events', 'optimize', 'status', 'Table is already up to date']]), { ok: true, text: 'Table is already up to date' });
  assert.deepEqual(optimizeOutcome([
    ['shop.x', 'optimize', 'Error', "Table 'shop.x' doesn't exist"],
    ['shop.x', 'optimize', 'status', 'Operation failed'],
  ]), { ok: false, text: "Table 'shop.x' doesn't exist" });
  assert.equal(optimizeOutcome([['logs.mem', 'optimize', 'note', "The storage engine for the table doesn't support optimize"]]).ok, false);
  assert.equal(optimizeOutcome([]).ok, false);
});

test('fragmentation: statistics cache age', () => {
  assert.equal(expiryText(86400), '24 h');
  assert.equal(expiryText(600), '10 min');
  assert.equal(expiryText(45), '45 s');
  assert.equal(expiryText(null), '');
});
