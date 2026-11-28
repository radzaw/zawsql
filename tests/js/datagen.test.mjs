import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseType, detect, checkColumn, generate, insertStatements, toSql, toDisplay, uniqueColumns, rng } from '../../src/ZawSQL/wwwroot/js/datagen.js';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const col = (name, type, more = {}) => ({ name, type, nullable: false, extra: '', default: null, ...more });

test('column types are read with their length, scale, sign and values', () => {
  assert.deepEqual(parseType('varchar(40)'), { base: 'varchar', len: 40, scale: 0, unsigned: false, values: null });
  assert.deepEqual(parseType('decimal(10,2) unsigned'), { base: 'decimal', len: 10, scale: 2, unsigned: true, values: null });
  assert.deepEqual(parseType("enum('new','paid')").values, ['new', 'paid']);
  assert.deepEqual(parseType("set('a','b','c')").values, ['a', 'b', 'c']);
});

test('generators are picked from the column name and type', () => {
  const k = (c, info) => detect(c, info, NOW).kind;
  assert.equal(k(col('id', 'int', { extra: 'auto_increment' })), 'skip');
  assert.equal(k(col('total', 'int', { extra: 'STORED GENERATED' })), 'skip');
  assert.equal(detect(col('total', 'int', { extra: 'STORED GENERATED' })).locked, true);
  assert.equal(k(col('created_at', 'timestamp', { default: 'CURRENT_TIMESTAMP' })), 'skip');
  assert.equal(k(col('email', 'varchar(255)')), 'email');
  assert.equal(k(col('first_name', 'varchar(50)')), 'first');
  assert.equal(k(col('surname', 'varchar(50)')), 'last');
  assert.equal(k(col('name', 'varchar(100)')), 'full');
  assert.equal(k(col('phone', 'varchar(30)')), 'phone');
  assert.equal(k(col('notes', 'text')), 'paragraph');
  assert.equal(k(col('title', 'varchar(200)')), 'sentence');
  assert.equal(k(col('status', "enum('a','b')")), 'enum');
  assert.equal(k(col('is_vip', 'bit(1)')), 'bool');
  assert.equal(k(col('active', 'tinyint(1)')), 'bool');
  assert.equal(k(col('uuid', 'char(36)')), 'uuid');
  assert.equal(k(col('avatar', 'blob')), 'hex');
  assert.equal(k(col('meta', 'json')), 'json');
  assert.equal(detect(col('price', 'decimal(10,2)')).options, '1..1000');
  assert.equal(detect(col('age', 'int')).options, '18..90');
  assert.equal(detect(col('birthday', 'date')).options, '1950-01-01..2006-12-31');
  assert.equal(detect(col('sold', 'date'), {}, NOW).options, '2024-06-15..2026-06-15');
  assert.equal(k(col('whatever', 'varchar(20)')), 'words');
  // Keys: a foreign key picks parents; an integer key without AUTO_INCREMENT continues after the maximum.
  assert.equal(k(col('customer_id', 'int'), { foreignKeys: [{ name: 'fk', columns: ['customer_id'] }] }), 'fk');
  assert.deepEqual(detect(col('id', 'int'), { maxima: { id: '41' } }), { kind: 'seq', options: '42' });
  assert.deepEqual(detect(col('id', 'int'), { maxima: { id: null } }), { kind: 'seq', options: '1' });
});

test('settings that cannot work are reported', () => {
  assert.match(checkColumn(col('n', 'int'), { kind: 'int', options: '10..1' }), /min\.\.max/);
  assert.equal(checkColumn(col('n', 'int'), { kind: 'int', options: '1..10' }), null);
  assert.match(checkColumn(col('d', 'date'), { kind: 'date', options: 'soon..later' }), /from\.\.to/);
  assert.match(checkColumn(col('n', 'int'), { kind: 'null', options: '' }), /NOT NULL/);
  const info = { foreignKeys: [{ name: 'fk', columns: ['c'], refTable: 'parents' }], samples: [{ name: 'fk', rows: [], kinds: ['int'] }] };
  assert.match(checkColumn(col('c', 'int'), { kind: 'fk', options: '' }, info), /parents has no rows/);
  assert.equal(checkColumn(col('c', 'int', { nullable: true }), { kind: 'fk', options: '' }, info), null);
});

test('rows are reproducible with a seed and respect ranges and lengths', () => {
  const cols = [col('id', 'int', { extra: 'auto_increment' }), col('n', 'int'), col('code', 'varchar(5)'), col('d', 'date'), col('price', 'decimal(8,2)')];
  const gens = [{ kind: 'skip', options: '' }, { kind: 'int', options: '5..7' }, { kind: 'paragraph', options: '' }, { kind: 'date', options: '2024-01-01..2024-01-31' }, { kind: 'decimal', options: '1..2' }];
  const a = generate({ cols, gens, count: 50, seed: 7 });
  const b = generate({ cols, gens, count: 50, seed: 7 });
  assert.deepEqual(a, b);
  assert.deepEqual(a.columns, ['n', 'code', 'd', 'price']);
  for (const [n, code, d, price] of a.rows) {
    assert.ok(n >= 5 && n <= 7);
    assert.ok(code.length <= 5);
    assert.ok(d >= '2024-01-01' && d <= '2024-01-31');
    assert.match(price.sql, /^[12]\.\d\d$/);
  }
});

test('sequences count on, unique values get a suffix, nullable columns get some NULLs', () => {
  const cols = [col('id', 'bigint'), col('email', 'varchar(30)'), col('nick', 'varchar(40)', { nullable: true })];
  const gens = [{ kind: 'seq', options: '9007199254740993' }, { kind: 'email', options: '' }, { kind: 'username', options: '' }];
  const g = generate({ cols, gens, count: 200, seed: 1, unique: new Set(['email']), nullPct: 50, runId: 'r' });
  assert.equal(g.rows[0][0].sql, '9007199254740993');
  assert.equal(g.rows[199][0].sql, '9007199254741192'); // beyond Number precision: counted as BigInt
  const emails = g.rows.map(r => r[1]);
  assert.equal(new Set(emails).size, 200);
  for (const e of emails) { assert.ok(e.length <= 30, e); assert.match(e, /\.r\d+@/); }
  const nulls = g.rows.filter(r => r[2] === null).length;
  assert.ok(nulls > 60 && nulls < 140, `${nulls} NULLs`);
  // Unique and NOT NULL columns never get NULLs.
  assert.ok(g.rows.every(r => r[1] !== null));
});

test('composite foreign keys take both values from the same parent row', () => {
  const info = {
    foreignKeys: [{ name: 'fk_p', columns: ['shop', 'sku'], refTable: 'products' }],
    samples: [{ name: 'fk_p', kinds: ['int', 'text'], rows: [['1', 'A'], ['2', 'B'], ['3', "O'C"]] }],
  };
  const cols = [col('shop', 'int'), col('sku', 'varchar(10)')];
  const g = generate({ cols, gens: [{ kind: 'fk', options: '' }, { kind: 'fk', options: '' }], info, count: 60, seed: 3 });
  const pairs = new Set(g.rows.map(([a, b]) => `${a.sql}|${b.sql}`));
  for (const p of pairs) assert.ok(["1|'A'", "2|'B'", "3|'O''C'"].includes(p), p);
  assert.equal(toDisplay(g.rows.find(r => r[0].sql === '3')?.[1] ?? { sql: "'O''C'" }), "O'C");
});

test('rows become batched multi-row INSERTs', () => {
  const rows = Array.from({ length: 5 }, (_, i) => [i, `v'${i}`, null, { sql: '0xAB' }]);
  const s = insertStatements('shop', 'my`t', ['a', 'b', 'c', 'd'], rows, 2);
  assert.equal(s.length, 3);
  assert.equal(s[0], "INSERT INTO `shop`.`my``t` (`a`, `b`, `c`, `d`) VALUES\n(0, 'v''0', NULL, 0xAB),\n(1, 'v''1', NULL, 0xAB)");
  assert.equal(toSql('a\\b'), "'a\\\\b'");
});

test('only single-column primary and unique keys count as unique', () => {
  const u = uniqueColumns([
    { type: 'PRIMARY', columns: [{ name: 'ID' }] },
    { type: 'UNIQUE', columns: [{ name: 'email' }] },
    { type: 'UNIQUE', columns: [{ name: 'a' }, { name: 'b' }] },
    { type: 'KEY', columns: [{ name: 'name' }] },
  ]);
  assert.deepEqual([...u].sort(), ['email', 'id']);
});

test('the random source is uniform enough and stays in range', () => {
  const r = rng(42);
  const counts = [0, 0, 0];
  for (let i = 0; i < 3000; i++) counts[r.int(0, 2)]++;
  for (const c of counts) assert.ok(c > 900 && c < 1100, String(counts));
});
