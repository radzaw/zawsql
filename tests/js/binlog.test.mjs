import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventGtid, eventKind, annotateEvents, filterEvents, eventIndexAt, nextFile, prevFile } from '../../src/ZawSQL/wwwroot/js/binloglogic.js';

const U = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const ev = (pos, type, info) => ({ pos, type, info, serverId: 1, endPos: pos + 10 });

test('binlog: GTIDs of MySQL (also tagged) and MariaDB, none for anonymous transactions', () => {
  assert.equal(eventGtid(ev(4, 'Gtid', `SET @@SESSION.GTID_NEXT= '${U}:23'`)), `${U}:23`);
  assert.equal(eventGtid(ev(4, 'Gtid_tagged_log_event', `SET @@SESSION.GTID_NEXT= '${U}:etl:5'`)), `${U}:etl:5`);
  assert.equal(eventGtid(ev(4, 'Anonymous_Gtid', "SET @@SESSION.GTID_NEXT= 'ANONYMOUS'")), null);
  assert.equal(eventGtid(ev(4, 'Gtid', 'BEGIN GTID 0-1-17')), '0-1-17');
  assert.equal(eventGtid(ev(4, 'Gtid', 'GTID 0-1-18')), '0-1-18');
  assert.equal(eventGtid(ev(4, 'Query', 'BEGIN')), null);
});

test('binlog: event kinds', () => {
  assert.equal(eventKind(ev(4, 'Format_desc', 'Server ver: 8.4')), 'meta');
  assert.equal(eventKind(ev(4, 'Xid', 'COMMIT /* xid=9 */')), 'commit');
  assert.equal(eventKind(ev(4, 'Query', 'COMMIT')), 'commit');
  assert.equal(eventKind(ev(4, 'Write_rows', 'table_id: 92 flags: STMT_END_F')), 'rows');
  assert.equal(eventKind(ev(4, 'Update_rows_v1', 'table_id: 92')), 'rows');
  assert.equal(eventKind(ev(4, 'Gtid', 'BEGIN GTID 0-1-1')), 'gtid');
  assert.equal(eventKind(ev(4, 'Query', 'use `shop`; CREATE TABLE t (id INT)')), 'other');
});

test('binlog: MySQL row-based transactions, a DDL, and row events named by their table', () => {
  const a = annotateEvents([
    ev(4, 'Format_desc', 'Server ver: 8.4.3'),
    ev(126, 'Previous_gtids', ''),
    ev(157, 'Gtid', `SET @@SESSION.GTID_NEXT= '${U}:1'`),
    ev(236, 'Query', 'use `shop`; CREATE TABLE t (id INT PRIMARY KEY)'),
    ev(370, 'Gtid', `SET @@SESSION.GTID_NEXT= '${U}:2'`),
    ev(449, 'Query', 'BEGIN'),
    ev(524, 'Table_map', 'table_id: 92 (shop.t)'),
    ev(570, 'Write_rows', 'table_id: 92 flags: STMT_END_F'),
    ev(610, 'Xid', 'COMMIT /* xid=31 */'),
    ev(641, 'Rotate', 'binlog.000003;pos=4'),
  ]);
  assert.deepEqual(a.map(e => e.gtid), [null, null, `${U}:1`, `${U}:1`, `${U}:2`, `${U}:2`, `${U}:2`, `${U}:2`, `${U}:2`, null]);
  assert.deepEqual(a.map(e => e.tx), [null, null, 1, 1, 2, 2, 2, 2, 2, null]);
  assert.equal(a[6].table, 'shop.t');
  assert.equal(a[7].table, 'shop.t');
  assert.equal(a[0].kind, 'meta');
});

test('binlog: MariaDB transactions start with BEGIN GTID; statement-based changes stay inside it', () => {
  const a = annotateEvents([
    ev(4, 'Gtid', 'BEGIN GTID 0-1-5'),
    ev(40, 'Query', 'use `shop`; INSERT INTO t VALUES (1)'),
    ev(90, 'Query', 'use `shop`; INSERT INTO t VALUES (2)'),
    ev(140, 'Xid', 'COMMIT /* xid=3 */'),
    ev(170, 'Gtid', 'GTID 0-1-6'),
    ev(200, 'Query', 'use `shop`; DROP TABLE t'),
    ev(260, 'Query', 'use `shop`; something without a GTID'),
  ]);
  assert.deepEqual(a.map(e => e.gtid), ['0-1-5', '0-1-5', '0-1-5', '0-1-5', '0-1-6', '0-1-6', null]);
});

test('binlog: a page that starts mid-transaction has no GTID for those events', () => {
  const a = annotateEvents([ev(500, 'Write_rows', 'table_id: 7 flags: STMT_END_F'), ev(540, 'Xid', 'COMMIT')]);
  assert.deepEqual(a.map(e => [e.gtid, e.tx, e.table]), [[null, null, null], [null, null, null]]);
});

test('binlog: filter by text and hide bookkeeping events', () => {
  const a = annotateEvents([
    ev(4, 'Format_desc', 'Server ver'), ev(157, 'Gtid', `SET @@SESSION.GTID_NEXT= '${U}:9'`), ev(236, 'Query', 'BEGIN'),
    ev(300, 'Table_map', 'table_id: 1 (shop.orders)'), ev(350, 'Delete_rows', 'table_id: 1 flags: STMT_END_F'), ev(400, 'Xid', 'COMMIT'),
  ]);
  assert.equal(filterEvents(a, { changesOnly: true }).length, 5);
  assert.deepEqual(filterEvents(a, { text: 'ORDERS' }).map(e => e.pos), [300, 350]);
  assert.equal(filterEvents(a, { text: `${U}:9` }).length, 5);
  assert.deepEqual(filterEvents(a, { text: '236' }).map(e => e.pos), [236]);
});

test('binlog: positions and neighbouring files', () => {
  const es = [ev(4, 'Format_desc'), ev(126, 'Previous_gtids'), ev(157, 'Gtid')];
  assert.equal(eventIndexAt(es, 126), 1);
  assert.equal(eventIndexAt(es, 130), 2);
  assert.equal(eventIndexAt(es, 999), -1);
  assert.equal(eventIndexAt(es, null), -1);
  const files = [{ name: 'b.1' }, { name: 'b.2' }, { name: 'b.3' }];
  assert.equal(nextFile(files, 'b.2'), 'b.3');
  assert.equal(nextFile(files, 'b.3'), null);
  assert.equal(prevFile(files, 'b.2'), 'b.1');
  assert.equal(prevFile(files, 'b.1'), null);
  assert.equal(nextFile(files, 'x'), null);
});
