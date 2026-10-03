import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtMs, fmtSeconds, snapshot, sinceSnapshot, derive, sortRows, filterRows, querySql, holderActivity, isIdleHolder, lockSummary,
} from '../../src/ZawSQL/wwwroot/js/insightlogic.js';

const row = (digest, extra = {}) => ({
  digest, schema: 'shop', text: `SELECT * FROM t${digest}`, sample: null, count: 10, totalMs: 100, maxMs: 30, lockMs: 1, errors: 0, warnings: 0,
  rowsAffected: 0, rowsSent: 10, rowsExamined: 10, tmpDisk: 0, tmpTables: 0, fullJoins: 0, scans: 0, sortRows: 0, noIndex: 0, noGoodIndex: 0, ...extra,
});

test('durations are formatted compactly', () => {
  assert.equal(fmtMs(0.345), '0.34 ms');
  assert.equal(fmtMs(12.34), '12.3 ms');
  assert.equal(fmtMs(456.7), '457 ms');
  assert.equal(fmtMs(1234), '1.23 s');
  assert.equal(fmtMs(12_345), '12.3 s');
  assert.equal(fmtMs(125_000), '2 min 5 s');
  assert.equal(fmtSeconds(3725), '1 h 2 min');
  assert.equal(fmtSeconds(90_000), '1 d 1 h');
  assert.equal(fmtMs(null), '–');
});

test('a snapshot measures only what ran since it was taken', () => {
  const before = [row('a'), row('b'), row('c')];
  const snap = snapshot(before, 1000);
  const now = [row('a', { count: 15, totalMs: 160, rowsExamined: 30 }), row('b'), row('c', { count: 2, totalMs: 5 }), row('d', { count: 1, totalMs: 9 })];
  const d = sinceSnapshot(now, snap);
  assert.deepEqual(d.map(r => r.digest), ['a', 'c', 'd']); // b didn't run; c was reset (count went down); d is new
  assert.equal(d[0].count, 5);
  assert.equal(d[0].totalMs, 60);
  assert.equal(d[0].rowsExamined, 20);
  assert.equal(d[0].maxMs, 30); // all-time maximum
  assert.equal(d[1].count, 2);
  assert.ok(d[2].isNew && !d[0].isNew);
  assert.equal(sinceSnapshot(now, null), now);
});

test('per-call values and warning flags', () => {
  const r = derive(row('x', { count: 4, totalMs: 200, rowsExamined: 400_000, rowsSent: 4, noIndex: 4, tmpDisk: 1, fullJoins: 2, errors: 1 }));
  assert.equal(r.avgMs, 50);
  assert.equal(r.examinedPerCall, 100_000);
  assert.deepEqual(r.flags, ['no index used', 'join without index', 'temp table on disk', 'examines 100000× the rows it returns', '1 error']);
  assert.deepEqual(derive(row('y')).flags, []);
  assert.deepEqual(derive(row('z', { noGoodIndex: 1 })).flags, ['no good index']);
});

test('sorting, filtering and SQL for a query tab', () => {
  const rows = [derive(row('a', { totalMs: 5 })), derive(row('b', { totalMs: 50, schema: 'crm' })), derive(row('c', { totalMs: 20, sample: "SELECT * FROM tc WHERE id = 7" }))];
  assert.deepEqual(sortRows(rows, 'totalMs').map(r => r.digest), ['b', 'c', 'a']);
  assert.deepEqual(sortRows(rows, 'totalMs', 'asc').map(r => r.digest), ['a', 'c', 'b']);
  assert.deepEqual(filterRows(rows, '', 'crm').map(r => r.digest), ['b']);
  assert.deepEqual(filterRows(rows, 'select id = 7', '').map(r => r.digest), ['c']);
  const sys = [
    row('s1', { text: 'SELECT `TABLE_NAME` FROM `information_schema` . `TABLES` WHERE `TABLE_SCHEMA` = ?' }),
    row('s2', { text: 'SHOW FULL COLUMNS FROM `shop` . `orders`' }),
    row('s3', { text: 'SELECT @@`version_comment`' }),
    row('s4', { text: 'SET NAMES `utf8mb4`' }),
    row('u1', { text: 'SELECT * FROM `orders` WHERE `status` = ?' }),
    row('u2', { text: 'UPDATE `mysql_jobs` SET `done` = ?' }), // a user table that merely starts with "mysql"
  ];
  assert.deepEqual(filterRows(sys, '', '', { hideSystem: true }).map(r => r.digest), ['u1', 'u2']);
  assert.equal(filterRows(sys, '', '').length, 6);
  assert.equal(querySql(rows[2]), 'SELECT * FROM tc WHERE id = 7;');
  assert.equal(querySql(rows[2], { explain: true }), 'EXPLAIN SELECT * FROM tc WHERE id = 7;');
  assert.equal(querySql(rows[0]), 'SELECT * FROM ta;');
});

test('lock holders: activity, idle transactions and the summary line', () => {
  assert.equal(holderActivity({ query: 'UPDATE t SET v = 1' }), 'UPDATE t SET v = 1');
  assert.equal(holderActivity({ query: null, command: 'Sleep', time: 125 }), 'idle in transaction for 2 min 5 s');
  assert.equal(holderActivity(null), 'unknown');
  assert.ok(isIdleHolder({ query: null, command: 'Sleep', rowsLocked: 2, tablesLocked: 1, time: 30 }));
  assert.ok(!isIdleHolder({ query: null, command: 'Sleep', rowsLocked: 0, tablesLocked: 0, time: 30 }));
  assert.ok(!isIdleHolder({ query: 'SELECT 1', command: 'Query', rowsLocked: 5, time: 30 }));
  assert.equal(lockSummary({ waits: [{}], metadata: [], transactions: [{ age: 30 }, { age: 700 }] }), '1 row lock wait · 0 metadata lock waits · 2 open transactions (oldest 11 min 40 s)');
});
