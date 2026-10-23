import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchBracket, caretContext, missingCloser } from '../../src/ZawSQL/wwwroot/js/sqlbrackets.js';

const at = sql => [sql.replace('|', ''), sql.indexOf('|')];

test('brackets: the partner of the bracket before or after the caret', () => {
  assert.deepEqual(matchBracket(...at('SELECT (a + (b))|')), { at: 15, match: 7 });
  assert.deepEqual(matchBracket(...at('SELECT |(a + (b))')), { at: 7, match: 15 });
  assert.deepEqual(matchBracket(...at('SELECT (a + (|b))')), { at: 12, match: 14 }); // before the caret wins
  assert.equal(matchBracket(...at('SELECT a|')), null);
});

test('brackets: unmatched and mismatched', () => {
  assert.deepEqual(matchBracket(...at('SELECT (a|')), null);
  assert.deepEqual(matchBracket(...at('SELECT (|a')), { at: 7, match: -1 });
  assert.deepEqual(matchBracket(...at('SELECT a)|')), { at: 8, match: -1 });
  assert.deepEqual(matchBracket(...at('SELECT [a)|')), { at: 9, match: -1 });
});

test('brackets: strings, names and comments are skipped', () => {
  assert.deepEqual(matchBracket(...at("SELECT (')', `(` /* ) */)|")), { at: 24, match: 7 });
  assert.equal(matchBracket(...at("SELECT ')|'")), null); // the bracket is in a string
});

test('brackets: what the caret is in', () => {
  assert.equal(caretContext(...at('SELECT |')), 'code');
  assert.equal(caretContext(...at("SELECT 'ab|")), "'");
  assert.equal(caretContext(...at("SELECT 'ab'|")), 'code');
  assert.equal(caretContext(...at('SELECT "ab|')), '"');
  assert.equal(caretContext(...at('SELECT `my|')), '`');
  assert.equal(caretContext(...at('SELECT 1 -- note|')), 'comment');
  assert.equal(caretContext(...at('SELECT 1 /* a|')), 'comment');
  assert.equal(caretContext(...at('SELECT 1 -- note\n|')), 'code');
});

test('brackets: whether a closer is still missing', () => {
  assert.equal(missingCloser('SELECT f(g(x)', ')'), true);
  assert.equal(missingCloser('SELECT f(x)', ')'), false);
  assert.equal(missingCloser("SELECT f(')'", ')'), true); // the one in the string doesn't count
});
