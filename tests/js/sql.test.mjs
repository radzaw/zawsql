import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSql, statementAt } from '../../src/ZawSQL/wwwroot/js/sqlsplit.js';
import { lacksWhere, isReadOnlyStatement } from '../../src/ZawSQL/wwwroot/js/sqlcheck.js';
import { highlightSql } from '../../src/ZawSQL/wwwroot/js/editor.js';

const sqls = text => splitSql(text).map(s => s.sql);

test('splitSql honours quotes, comments and DELIMITER', () => {
  assert.deepEqual(sqls("SELECT 'a;b'; SELECT \"x;\" -- c;\n; # x;\nSELECT 3"), ["SELECT 'a;b'", 'SELECT "x;" -- c;', '# x;\nSELECT 3']);
  assert.deepEqual(sqls('DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\nDELIMITER ;\nSELECT 4;'),
    ['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'SELECT 4']);
  assert.deepEqual(sqls('/*!40101 SET NAMES utf8 */;\n-- only a comment;\n'), ['/*!40101 SET NAMES utf8 */']);
  assert.deepEqual(sqls("SELECT 'it''s; fine', `we;ird`"), ["SELECT 'it''s; fine', `we;ird`"]);
  assert.deepEqual(sqls(''), []);
});

test('splitSql reports positions and statementAt picks the statement at the caret', () => {
  const text = 'SELECT 1;\nSELECT 2;';
  const stmts = splitSql(text);
  assert.equal(text.slice(stmts[1].start, stmts[1].end), 'SELECT 2');
  assert.equal(statementAt(stmts, 9).sql, 'SELECT 1'); // right after the first ';'
  assert.equal(statementAt(stmts, 10).sql, 'SELECT 2');
  assert.equal(statementAt(stmts, 0).sql, 'SELECT 1');
});

test('lacksWhere flags UPDATE/DELETE without a top-level WHERE', () => {
  const yes = ['UPDATE t SET a = 1', 'DELETE FROM t', 'UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)',
    'DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id', 'WITH c AS (SELECT 1) DELETE FROM t', "UPDATE t SET note = 'where'", '-- WHERE\nDELETE FROM t'];
  const no = ['update t set a=1 where id=2', 'DELETE FROM t WHERE x', 'SELECT * FROM t FOR UPDATE',
    'INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1', 'SELECT 1'];
  for (const s of yes) assert.equal(lacksWhere(s), true, s);
  for (const s of no) assert.equal(lacksWhere(s), false, s);
});

test('isReadOnlyStatement separates reads from changes', () => {
  for (const s of ['SELECT 1', 'SHOW CREATE TABLE t', "SELECT REPLACE(a,'x','y') FROM t", 'EXPLAIN SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x'])
    assert.equal(isReadOnlyStatement(s), true, s);
  for (const s of ['UPDATE t SET a=1 WHERE b', '/*!40101 SET NAMES utf8 */', 'SET @a = 1', 'CALL p()', 'DROP TABLE t', 'WITH c AS (SELECT 1) DELETE FROM t'])
    assert.equal(isReadOnlyStatement(s), false, s);
});

test('highlightSql marks keywords, strings, numbers, comments and escapes HTML', () => {
  const html = highlightSql("SELECT COUNT(id), 'a<b', 42 FROM `t` -- note");
  assert.match(html, /<span class="t-kw">SELECT<\/span>/);
  assert.match(html, /<span class="t-fn">COUNT<\/span>/);
  assert.match(html, /<span class="t-str">&#39;a&lt;b&#39;<\/span>/);
  assert.match(html, /<span class="t-num">42<\/span>/);
  assert.match(html, /<span class="t-id">`t`<\/span>/);
  assert.match(html, /<span class="t-com">-- note<\/span>/);
});
