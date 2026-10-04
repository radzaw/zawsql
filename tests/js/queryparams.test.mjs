import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findParams, paramNames, bindParams, literal, guessType, rememberParams } from '../../src/ZawSQL/wwwroot/js/queryparams.js';
import { formatSql } from '../../src/ZawSQL/wwwroot/js/sqlformat.js';
import { highlightSql } from '../../src/ZawSQL/wwwroot/js/editor.js';

const names = sql => findParams(sql).map(p => p.name);

test('parameters are found in code only', () => {
  assert.deepEqual(names('SELECT * FROM t WHERE id = :id AND x=:x_2 OR y IN (:list)'), ['id', 'x_2', 'list']);
  // Not in strings, quoted names or comments.
  assert.deepEqual(names("SELECT ':a', \":b\", `:c`, 'it''s :d', 'x\\':e' FROM t -- :f\n# :g\n/* :h */ WHERE k = :k"), ['k']);
  // Not labels, assignments, casts or times.
  assert.deepEqual(names('lbl: LOOP SET @a := 1; END LOOP lbl'), []);
  assert.deepEqual(names('lbl:BEGIN END'), []);
  assert.deepEqual(names("SELECT a::int, TIME '10:30', `t`:x, (a):y"), []);
  // Positions point at the placeholder.
  assert.deepEqual(findParams('WHERE a = :abc;'), [{ name: 'abc', start: 10, end: 14 }]);
  // Names in order of first appearance, once, across statements.
  assert.deepEqual(paramNames(['SELECT :b, :a', 'UPDATE t SET x = :a WHERE y = :c']), ['b', 'a', 'c']);
  assert.deepEqual(paramNames(['SELECT 1']), []);
});

test('values become SQL literals', () => {
  assert.equal(literal('text', "O'Brien\\"), "'O\\'Brien\\\\'");
  assert.equal(literal('text', ''), "''");
  assert.equal(literal('number', ' 42 '), '42');
  assert.equal(literal('number', '-3.5e2'), '-3.5e2');
  assert.throws(() => literal('number', '42; DROP TABLE t'), /isn't a number/);
  assert.throws(() => literal('number', ''), /isn't a number/);
  assert.equal(literal('null', 'ignored'), 'NULL');
  assert.equal(literal('sql', '1, 2, 3'), '1, 2, 3');
  assert.throws(() => literal('sql', '  '), /Enter the SQL/);
});

test('binding replaces every occurrence and leaves strings alone', () => {
  const v = { id: { type: 'number', value: '7' }, name: { type: 'text', value: "a'b" }, ids: { type: 'sql', value: '1,2' } };
  assert.equal(bindParams("SELECT ':id', :id FROM t WHERE name = :name OR id IN (:ids) OR parent = :id", v),
    "SELECT ':id', 7 FROM t WHERE name = 'a\\'b' OR id IN (1,2) OR parent = 7");
  assert.throws(() => bindParams('SELECT :missing', v), /No value for :missing/);
  assert.equal(bindParams('SELECT 1', {}), 'SELECT 1');
});

test('the first type offered', () => {
  assert.equal(guessType(['SELECT * FROM t LIMIT :n'], 'n'), 'number');
  assert.equal(guessType(['SELECT * FROM t LIMIT :size OFFSET :skip'], 'skip'), 'number');
  assert.equal(guessType(['SELECT * FROM t LIMIT 10, :n'], 'n'), 'number');
  assert.equal(guessType(['SELECT * FROM t WHERE id = :id'], 'id'), 'text');
  assert.equal(guessType(['SELECT * FROM t LIMIT :n'], 'n', { type: 'sql' }), 'sql'); // what was used last time wins
});

test('used values are remembered with recent suggestions', () => {
  let s = rememberParams({}, { id: { type: 'number', value: '1' } });
  s = rememberParams(s, { id: { type: 'number', value: '2' }, q: { type: 'text', value: '' } });
  s = rememberParams(s, { id: { type: 'number', value: '1' } });
  assert.deepEqual(s.id, { type: 'number', value: '1', recent: ['1', '2'] });
  assert.deepEqual(s.q, { type: 'text', value: '', recent: [] });
  const many = Array.from({ length: 12 }, (_, i) => String(i)).reduce((st, v) => rememberParams(st, { x: { type: 'text', value: v } }), {});
  assert.equal(many.x.recent.length, 8);
  assert.equal(many.x.recent[0], '11');
});

test('the formatter and the highlighter keep parameters whole', () => {
  assert.equal(formatSql('select * from t where id=:id and d >= :from_date limit :n', {}),
    'SELECT *\nFROM t\nWHERE id = :id\n  AND d >= :from_date\nLIMIT :n');
  assert.equal(formatSql('select a from t where b in (:ids)', {}), 'SELECT a\nFROM t\nWHERE b IN (:ids)');
  // A label stays a label.
  assert.match(formatSql('CREATE PROCEDURE p() BEGIN lbl: LOOP LEAVE lbl; END LOOP lbl; END', {}), /lbl: LOOP/);
  const html = highlightSql("SELECT :id, ':no', a::b FROM t");
  assert.match(html, /<span class="t-param">:id<\/span>/);
  assert.ok(!html.includes('t-param">:no') && !html.includes('t-param">:b'));
});
