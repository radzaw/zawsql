import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidFromPath, isStatement, useDb, explainable, filterEntries, isFiltering, exportSql, exportFileName } from '../../src/ZawSQL/wwwroot/js/loglogic.js';
import { fmtLogTime } from '../../src/ZawSQL/wwwroot/js/util.js';

test('log: the session of a request comes from its path', () => {
  assert.equal(sidFromPath('/s/abc123/exec'), 'abc123');
  assert.equal(sidFromPath('/s/abc123/data?db=x'), 'abc123');
  assert.equal(sidFromPath('/multi/run'), null);
  assert.equal(sidFromPath('/connect'), null);
  assert.equal(sidFromPath(undefined), null);
});

test('log: statements, USE lines and what EXPLAIN accepts', () => {
  assert.equal(isStatement('SELECT 1'), true);
  assert.equal(isStatement('/* Connected. Thread-ID: 5 */'), false);
  assert.equal(isStatement('  '), false);
  assert.equal(useDb('USE `shop`'), 'shop');
  assert.equal(useDb('USE `we``ird`'), 'we`ird');
  assert.equal(useDb('use shop;'), 'shop');
  assert.equal(useDb('SELECT 1'), null);
  for (const s of ['SELECT 1', ' with x as (select 1) select * from x', 'UPDATE t SET a = 1', 'DELETE FROM t', 'INSERT INTO t VALUES (1)', 'REPLACE INTO t VALUES (1)', 'TABLE t', '/* note */ SELECT 1', '-- c\nSELECT 1']) {
    assert.equal(explainable(s), true, s);
  }
  for (const s of ['SHOW TABLES', 'SET @a = 1', 'CREATE TABLE t (a INT)', 'USE `x`', '/* only a comment */', '']) {
    assert.equal(explainable(s), false, s);
  }
});

const entries = [
  { text: 'USE `shop`', sid: 'a' },
  { text: 'SELECT * FROM customers', sid: 'a', slow: true },
  { text: 'SELECT * FROM nope', sid: 'a' },
  { text: '/* SQL Error (1146): Table nope does not exist */', sid: 'a', err: true },
  { text: 'SELECT * FROM orders', sid: 'b' },
  { text: '/* Connected. */', sid: null },
];

test('log: filters by text (ignoring case), slow lines and session', () => {
  assert.deepEqual(filterEntries(entries, { text: 'select * from c' }), [false, true, false, false, false, false]);
  assert.deepEqual(filterEntries(entries, { slow: true }), [false, true, false, false, false, false]);
  assert.deepEqual(filterEntries(entries, { sid: 'b' }), [false, false, false, false, true, false]);
  assert.deepEqual(filterEntries(entries, { text: 'select', sid: 'a' }), [false, true, true, false, false, false]);
  assert.deepEqual(filterEntries(entries, {}), entries.map(() => true));
});

test('log: the errors filter also shows the statement that failed', () => {
  assert.deepEqual(filterEntries(entries, { errors: true }), [false, false, true, true, false, false]);
  assert.deepEqual(filterEntries(entries, { errors: true, sid: 'b' }), entries.map(() => false));
  assert.deepEqual(filterEntries(entries, { errors: true, text: 'nope' }), [false, false, true, true, false, false]);
  assert.equal(isFiltering({}), false);
  assert.equal(isFiltering({ text: '  ' }), false);
  assert.equal(isFiltering({ sid: '' }), false);
  assert.equal(isFiltering({ errors: true }), true);
  assert.equal(isFiltering({ sid: 'a' }), true);
});

test('log: export is a runnable .sql file with times, durations and sessions as comments', () => {
  const t0 = new Date(2026, 9, 5, 14, 30, 0, 123).getTime();
  const sql = exportSql([
    { text: 'USE `shop`', time: t0, sid: 'a' },
    { text: 'SELECT 1', time: t0 + 5, ms: 2.4, sid: 'a' },
    { text: 'DELETE FROM t WHERE id = 1;', time: t0 + 9, ms: 1500, sid: 'a' },
    { text: '/* SQL Error (1146): no */', time: t0 + 10, sid: 'a' },
    { text: 'SELECT 2', time: t0 + 20, ms: 0.5, sid: 'b' },
  ], { sessionName: sid => ({ a: 'Prod */ shop', b: null })[sid], now: t0 + 60_000 });
  assert.deepEqual(sql.split('\n'), [
    `/* ZawSQL SQL log, saved ${fmtLogTime(t0 + 60_000)} – 5 lines */`,
    '/* Session: Prod * / shop */',
    `/* ${fmtLogTime(t0)} */ USE \`shop\`;`,
    `/* ${fmtLogTime(t0 + 5)} */ SELECT 1; /* 2 ms */`,
    `/* ${fmtLogTime(t0 + 9)} */ DELETE FROM t WHERE id = 1; /* 1.50 s */`,
    `/* ${fmtLogTime(t0 + 10)} */ /* SQL Error (1146): no */`,
    `/* ${fmtLogTime(t0 + 20)} */ SELECT 2; /* 0.5 ms */`, // session b is gone: no header
    '',
  ]);
  assert.equal(exportSql([{ text: 'SELECT 1', time: t0, ms: 3 }], { timestamps: false, durations: false, now: t0 }).split('\n')[1], 'SELECT 1;');
  assert.equal(exportFileName(t0), 'zawsql-log-2026-10-05-1430.sql');
});
