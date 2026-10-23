import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionColumns, orderByColumns, resolveTables, suggestIndexes, finishSuggestion, describeColumns } from '../../src/ZawSQL/wwwroot/js/indexadvice.js';
import { parsePlan } from '../../src/ZawSQL/wwwroot/js/explainlogic.js';

const cols = text => conditionColumns(text).map(c => `${c.qualifier ?? ''}.${c.column}:${c.use}${c.other != null ? '>' + c.other : ''}`);

test('index advice: columns of a MySQL condition', () => {
  assert.deepEqual(cols("((`shop`.`o`.`status` = 'paid') and (`shop`.`o`.`created` >= TIMESTAMP'2024-01-01 00:00:00'))"), ['o.status:eq', 'o.created:range']);
  assert.deepEqual(cols('(`shop`.`o`.`customer_id` = `shop`.`c`.`id`)'), ['o.customer_id:eq>c', 'c.id:eq>o']);
  assert.deepEqual(cols("(`t`.`a`.`n` between 1 and 5)"), ['a.n:range']);
  assert.deepEqual(cols("(`t`.`a`.`n` in (1,2,3))"), ['a.n:eq']);
  assert.deepEqual(cols("(`t`.`a`.`name` like 'ab%')"), ['a.name:range']);
  assert.deepEqual(cols("(`t`.`a`.`name` like _utf8mb4'ab%')"), ['a.name:range']);
  assert.deepEqual(cols("(`t`.`a`.`name` like '%ab')"), []);
  assert.deepEqual(cols('(`t`.`a`.`d` is null)'), ['a.d:eq']);
  assert.deepEqual(cols('(`t`.`a`.`d` is not null)'), []); // the optimizer adds it to join columns
  assert.deepEqual(cols("(5 < `t`.`a`.`n`)"), ['a.n:range']);
});

test('index advice: what an index can\'t serve is left out', () => {
  assert.deepEqual(cols("((`t`.`a`.`x` = 1) or (`t`.`a`.`y` = 2))"), []);
  assert.deepEqual(cols("((`t`.`a`.`z` = 3) and ((`t`.`a`.`x` = 1) or (`t`.`a`.`y` = 2)))"), ['a.z:eq']);
  assert.deepEqual(cols("(cast(`t`.`a`.`created` as date) = '2024-01-01')"), []);
  assert.deepEqual(cols("(year(`t`.`a`.`created`) = 2024)"), []);
  assert.deepEqual(cols("(`t`.`a`.`x` <> 1)"), []);
  assert.deepEqual(cols("(not((`t`.`a`.`x` = 1)))"), []);
  assert.deepEqual(cols("((`t`.`a`.`x` + 1) = 5)"), []);
  assert.deepEqual(cols("(`t`.`a`.`x` not in (1,2))"), []);
  assert.deepEqual(cols("(`t`.`a`.`s` = 'it''s = `x`.`y`')"), ['a.s:eq']);
});

test('index advice: MariaDB conditions', () => {
  assert.deepEqual(cols("o.`status` = 'paid' and o.created > '2024-01-01'"), ['o.status:eq', 'o.created:range']);
  assert.deepEqual(cols('t2.b = t1.a'), ['t2.b:eq>t1', 't1.a:eq>t2']);
});

test('index advice: ORDER BY of the outer query', () => {
  assert.deepEqual(orderByColumns('SELECT * FROM t WHERE a = 1 ORDER BY t.b DESC, c DESC LIMIT 10').map(c => `${c.qualifier}.${c.column}:${c.desc}`), ['t.b:true', 'null.c:true']);
  assert.deepEqual(orderByColumns('SELECT * FROM (SELECT * FROM t ORDER BY x) d'), []);
  assert.deepEqual(orderByColumns('SELECT * FROM t ORDER BY lower(name)'), []);
  assert.deepEqual(orderByColumns('SELECT * FROM t ORDER BY 2').length, 0);
});

test('index advice: tables behind aliases', () => {
  assert.deepEqual(resolveTables('SELECT * FROM orders o, items JOIN shop2.customers AS c ON c.id = o.cid WHERE 1', [], 'shop'),
    { o: { db: 'shop', table: 'orders' }, c: { db: 'shop2', table: 'customers' }, items: { db: 'shop', table: 'items' } });
  assert.deepEqual(resolveTables('DELETE FROM logs WHERE level > 3', [], 'app'), { logs: { db: 'app', table: 'logs' } });
  assert.deepEqual(resolveTables('UPDATE `my t` x SET a = 1', [], 'app'), { x: { db: 'app', table: 'my t' } });
  const notes = [{ code: '1003', message: '/* select#1 */ select `shop`.`o`.`id` AS `id` from `shop`.`orders` `o` join `shop`.`customers` where (`shop`.`o`.`cid` = `shop`.`customers`.`id`)' }];
  assert.deepEqual(resolveTables('SELECT o.id FROM orders o JOIN customers ON 1', notes, 'x'), { o: { db: 'shop', table: 'orders' }, customers: { db: 'shop', table: 'customers' } });
});

const plan = (tables, extra = {}) => JSON.stringify({ query_block: { select_id: 1, ...(tables.length === 1 ? { table: tables[0] } : { nested_loop: tables.map(t => ({ table: t })) }), ...extra } });

test('index advice: suggestions from a plan', () => {
  const r = {
    statement: "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'paid' AND o.created >= '2024-01-01'",
    database: 'shop', notes: [],
    json: plan([
      { table_name: 'o', access_type: 'ALL', rows_examined_per_scan: 50000, attached_condition: "((`shop`.`o`.`status` = 'paid') and (`shop`.`o`.`created` >= '2024-01-01'))" },
      { table_name: 'c', access_type: 'eq_ref', key: 'PRIMARY', rows_examined_per_scan: 1 },
    ]),
  };
  const s = suggestIndexes(r, parsePlan(r.json));
  assert.equal(s.length, 1);
  assert.deepEqual({ db: s[0].db, table: s[0].table, cols: s[0].columns.map(c => c.name + ':' + c.use) }, { db: 'shop', table: 'orders', cols: ['status:eq', 'created:range'] });
  assert.equal(describeColumns(s[0].columns), 'looks up status, then narrows created to a range');
});

test('index advice: a join through a join buffer, and ORDER BY', () => {
  const join = {
    statement: 'SELECT * FROM a JOIN b ON b.aid = a.id', database: 'd', notes: [],
    json: plan([
      { table_name: 'a', access_type: 'ALL', rows_examined_per_scan: 20 },
      { table_name: 'b', access_type: 'ALL', rows_examined_per_scan: 90000, using_join_buffer: 'hash join', attached_condition: '(`d`.`b`.`aid` = `d`.`a`.`id`)' },
    ]),
  };
  assert.deepEqual(suggestIndexes(join, parsePlan(join.json)).map(s => `${s.table}(${s.columns.map(c => c.name).join(',')}) ${s.reason}`), ['b(aid) join']);

  const sorted = {
    statement: 'SELECT * FROM events WHERE kind = 3 ORDER BY at DESC LIMIT 20', database: 'd', notes: [],
    json: plan([{ table_name: 'events', access_type: 'ALL', rows_examined_per_scan: 400000, attached_condition: '(`d`.`events`.`kind` = 3)', using_filesort: true }]),
  };
  assert.deepEqual(suggestIndexes(sorted, parsePlan(sorted.json))[0].columns.map(c => c.name + ':' + c.use), ['kind:eq', 'at:order']);

  const small = { statement: 'SELECT * FROM t WHERE a = 1', database: 'd', notes: [], json: plan([{ table_name: 't', access_type: 'ALL', rows_examined_per_scan: 12, attached_condition: '(`d`.`t`.`a` = 1)' }]) };
  assert.deepEqual(suggestIndexes(small, parsePlan(small.json)), []);
});

test('index advice: checked against the table', () => {
  const cand = { db: 'shop', table: 'orders', columns: [{ name: 'STATUS', use: 'eq' }, { name: 'note', use: 'eq' }, { name: 'gone', use: 'eq' }, { name: 'created', use: 'range' }] };
  const meta = {
    columns: [{ name: 'id', type: 'int' }, { name: 'status', type: 'varchar(20)' }, { name: 'note', type: 'text' }, { name: 'created', type: 'datetime' }],
    indexes: [{ name: 'PRIMARY', columns: [{ name: 'id' }] }, { name: 'idx_status_note_created', columns: [{ name: 'x' }] }],
  };
  const s = finishSuggestion(cand, meta);
  assert.equal(s.sql, 'ALTER TABLE `shop`.`orders` ADD INDEX `idx_status_note_created_2` (`status`, `note`(64), `created`)');
  assert.equal(s.existing, null);

  const covered = finishSuggestion({ db: 'shop', table: 'orders', columns: [{ name: 'status', use: 'eq' }] },
    { columns: meta.columns, indexes: [{ name: 'by_status', columns: [{ name: 'status' }, { name: 'created' }] }] });
  assert.equal(covered.existing, 'by_status');
  assert.equal(finishSuggestion(cand, { isView: true }), null);
  assert.equal(finishSuggestion({ db: 'd', table: 't', columns: [{ name: 'doc', use: 'eq' }] }, { columns: [{ name: 'doc', type: 'json' }], indexes: [] }), null);
});

test('index advice: the column a joined table looks rows up by', () => {
  const r = {
    statement: "SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country = 'DE'", database: 'shop', notes: [],
    json: plan([
      { table_name: 'o', access_type: 'ALL', rows_examined_per_scan: 30000, attached_condition: '(`shop`.`o`.`customer_id` is not null)' },
      { table_name: 'c', access_type: 'eq_ref', key: 'PRIMARY', ref: ['shop.o.customer_id'], rows_examined_per_scan: 1, attached_condition: "(`shop`.`c`.`country` = 'DE')" },
    ]),
  };
  const [s, ...more] = suggestIndexes(r, parsePlan(r.json));
  assert.equal(more.length, 0);
  assert.deepEqual(s.columns, [{ name: 'customer_id', use: 'join' }]);
  assert.equal(describeColumns(s.columns), 'finds the rows matching the joined table by customer_id');
});
