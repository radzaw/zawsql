import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callAt, activeParam, builtinSignature, paramList } from '../../src/ZawSQL/wwwroot/js/sqlsigs.js';
import { FUNCTIONS } from '../../src/ZawSQL/wwwroot/js/editor.js';

const at = (sql) => callAt(sql.replace('|', ''), sql.indexOf('|'));

test('signatures: every function the editor completes has one', () => {
  for (const f of FUNCTIONS) assert.ok(builtinSignature(f), f);
  assert.equal(builtinSignature('concat').name, 'CONCAT');
  assert.equal(builtinSignature('toString'), null); // not inherited from Object
  assert.equal(builtinSignature('nosuch'), null);
  assert.equal(paramList(builtinSignature('LEFT')), '(str, len)');
  assert.deepEqual(builtinSignature('NOW').params, ['[fsp]']);
  assert.deepEqual(builtinSignature('UUID').params, []);
});

test('signatures: the argument the caret is in', () => {
  assert.deepEqual(at('SELECT CONCAT(|'), { name: 'CONCAT', qualifier: null, argIndex: 0, open: 13 });
  assert.equal(at('SELECT CONCAT(a, b, |').argIndex, 2);
  assert.equal(at('SELECT CONCAT (a, |').name, 'CONCAT'); // a space before "(" is allowed
  assert.equal(at('SELECT CONCAT(a, b)|'), null); // after the call
  assert.equal(at('SELECT 1|'), null);
});

test('signatures: nested calls and plain parentheses', () => {
  assert.deepEqual([at('SELECT IFNULL(LEFT(x, |').name, at('SELECT IFNULL(LEFT(x, |').argIndex], ['LEFT', 1]);
  assert.deepEqual([at('SELECT IFNULL(LEFT(x, 2), |').name, at('SELECT IFNULL(LEFT(x, 2), |').argIndex], ['IFNULL', 1]);
  // Grouping parentheses are looked through to the call around them.
  assert.deepEqual([at('SELECT ROUND((a + |').name, at('SELECT ROUND((a + |').argIndex], ['ROUND', 0]);
  assert.equal(at('SELECT ROUND((a + b) / 2, |').argIndex, 1);
  // A keyword before "(" is a name the caller has no signature for, so the outer call is not hinted.
  assert.equal(at('SELECT IF(x IN (1, |').name, 'IN');
});

test('signatures: strings, comments and quoted names', () => {
  assert.equal(at("SELECT CONCAT('a, (b', |").argIndex, 1);
  assert.equal(at("SELECT CONCAT('a, |"), null); // inside a string
  assert.equal(at("SELECT CONCAT('a\\'|"), null); // an escaped quote doesn't close it
  assert.equal(at('SELECT CONCAT(a /* , ( */, |').argIndex, 1);
  assert.equal(at('SELECT CONCAT(a, -- x, (\n|').argIndex, 1);
  assert.equal(at('SELECT CONCAT(a, /* |'), null); // inside a comment
  assert.deepEqual(at('CALL `my db`.`do it`(1, |'), { name: 'do it', qualifier: 'my db', argIndex: 1, open: 20 });
  assert.deepEqual([at('CALL shop.add_order(|').name, at('CALL shop.add_order(|').qualifier], ['add_order', 'shop']);
});

test('signatures: a semicolon starts a new statement', () => {
  assert.equal(at('SELECT CONCAT(a; SELECT |'), null);
  assert.equal(at('SELECT CONCAT(a; SELECT LEFT(|').name, 'LEFT');
});

test('signatures: the highlighted parameter', () => {
  assert.equal(activeParam(['str', 'len'], 1), 1);
  assert.equal(activeParam(['str', 'len'], 2), -1); // too many arguments
  assert.equal(activeParam(['str', '…'], 5), 1); // repeats
  assert.equal(activeParam([], 0), -1);
});
