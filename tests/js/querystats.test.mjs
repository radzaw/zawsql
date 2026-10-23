import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, findings, statsLine, statsSet, returnedRows } from '../../src/ZawSQL/wwwroot/js/querystats.js';

const scan = { Handler_read_rnd_next: 50001, Handler_read_first: 1, Select_scan: 1 };
const lookup = { Handler_read_key: 3, Handler_read_next: 40 };

test('query stats: counters summed into rows read by index and by scan', () => {
  const s = summarize({ ...scan, Handler_read_key: 2, Handler_read_rnd: 5, Handler_write: 7, Handler_update: 2, Created_tmp_tables: 1, Created_tmp_disk_tables: 1, Sort_rows: 9, Select_full_join: 1 });
  assert.equal(s.read, 50001 + 1 + 2 + 5);
  assert.equal(s.byIndex, 3);
  assert.equal(s.scanned, 50001);
  assert.deepEqual([s.written, s.updated, s.tmpTables, s.tmpDisk, s.sorted, s.fullJoins], [7, 2, 1, 1, 9, 1]);
  assert.equal(summarize({}).read, 0);
});

test('query stats: findings', () => {
  assert.deepEqual(findings(summarize(scan), 3), ['read 50,001 rows by scanning a table or index', 'read 50,002 rows to return 3 rows']);
  assert.deepEqual(findings(summarize(lookup), 40), []);
  assert.deepEqual(findings(summarize({ Created_tmp_disk_tables: 1, Sort_merge_passes: 2, Select_full_join: 1 })),
    ['1 join without an index', '1 temporary table on disk', 'the sort needed 2 merge passes (sort_buffer_size is too small for it)']);
  assert.deepEqual(findings(summarize({ Handler_read_rnd_next: 999 })), []);
});

test('query stats: message line and result tab', () => {
  const stats = [{ statement: 0, counters: scan }, { statement: 1, counters: { ...lookup, Handler_update: 4 } }];
  const returned = returnedRows([{ statement: 0, rows: [[1], [2], [3]] }]);
  assert.equal(statsLine(stats, returned), 'Rows read: 50,045 (44 by index, 50,001 by scan), changed: 4 – read 50,001 rows by scanning a table or index (+1 more)');
  assert.equal(statsLine([]), '');
  const set = statsSet(stats, ['SELECT  *\n FROM big', 'UPDATE t SET a = 1 WHERE id = 3'], returned);
  assert.equal(set.stats, true);
  assert.equal(set.columns[2].name, 'Rows read');
  assert.deepEqual(set.rows[0].slice(0, 5), ['1', 'SELECT * FROM big', '50002', '1', '50001']);
  assert.equal(set.rows[1][7], '0');
  assert.equal(set.rows[1][6], '4');
  assert.equal(set.rows[1][12], null);
});

test('query stats: rows returned are unknown when the result was cut off', () => {
  assert.deepEqual(returnedRows([{ statement: 0, rows: [[1]] }, { statement: 0, rows: [[1], [2]] }, { statement: 1, rows: [[1]], truncated: true }, { statement: -1, rows: [] }]), { 0: 3 });
});
