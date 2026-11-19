import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findMatches, expandReplacement, replaceAll, matchIndexFrom, matchAt, matchSummary, lineColumnOffset, initialQuery, searchRegex, MAX_MATCHES,
} from '../../src/ZawSQL/wwwroot/js/editorfind.js';

const spans = (text, q, o) => findMatches(text, q, o).matches.map(m => text.slice(m.start, m.end));

test('find: plain text ignores case unless asked, and special characters are literal', () => {
  assert.deepEqual(spans('SELECT a FROM t; select b', 'select'), ['SELECT', 'select']);
  assert.deepEqual(spans('SELECT a FROM t; select b', 'select', { caseSensitive: true }), ['select']);
  assert.deepEqual(spans('a.b + a*b (x)', 'a.b'), ['a.b']);
  assert.deepEqual(spans('price $1 (x)', '(x)'), ['(x)']);
  assert.deepEqual(findMatches('abc', '').matches, []);
});

test('find: whole word does not match inside longer names', () => {
  const sql = 'SELECT id, user_id, `id`, $id, id2 FROM t WHERE id=1';
  assert.deepEqual(findMatches(sql, 'id', { wholeWord: true }).matches.map(m => m.start), [7, 21, 48]);
});

test('find: regex, with empty matches skipped and errors reported', () => {
  assert.deepEqual(spans('t1 t22 x3', 't\\d+', { regex: true }), ['t1', 't22']);
  assert.deepEqual(spans('a\nb', '^', { regex: true }), []);
  assert.deepEqual(spans('a\nb\n', '^\\w$', { regex: true }), ['a', 'b']); // ^ and $ per line
  const bad = findMatches('x', '(', { regex: true });
  assert.deepEqual(bad.matches, []);
  assert.match(bad.error, /\(/);
  assert.equal(searchRegex('(', { regex: true }).re, null);
});

test('find: stops counting at the cap', () => {
  const r = findMatches('a'.repeat(MAX_MATCHES + 5), 'a');
  assert.equal(r.matches.length, MAX_MATCHES);
  assert.equal(r.capped, true);
  assert.equal(matchSummary(r, -1), '10,000+ matches');
});

test('replace: literal unless regex; groups, names, $& and escapes', () => {
  const m = findMatches('t12', '(?<p>t)(\\d)(\\d)', { regex: true }).matches[0];
  assert.equal(expandReplacement('$2-$1-$&-$$-$<p>-\\n\\t\\\\', m, { regex: true }), '1-t-t12-$-t-\n\t\\');
  assert.equal(expandReplacement('$2', m), '$2'); // literal
  assert.equal(expandReplacement('$4|$9', m, { regex: true }), '$4|$9'); // no such group
  assert.equal(expandReplacement('$10', m, { regex: true }), 't0'); // group 1, then "0"
});

test('replace all: one pass, matches in the replacement are not replaced again', () => {
  assert.deepEqual(replaceAll('a a a', 'a', 'aa'), { text: 'aa aa aa', count: 3 });
  assert.deepEqual(replaceAll('x', 'y', 'z'), { text: 'x', count: 0 });
  assert.deepEqual(replaceAll('`old_t` JOIN old_t2', 'old_t', 'new_t', { wholeWord: true }), { text: '`new_t` JOIN old_t2', count: 1 });
  assert.equal(replaceAll('a = 1, b = 2', '(\\w) = (\\d)', '$1 := $2', { regex: true }).text, 'a := 1, b := 2');
});

test('navigation: next from the caret, previous before it, wrapping', () => {
  const ms = [{ start: 2, end: 4 }, { start: 10, end: 12 }, { start: 20, end: 22 }];
  assert.equal(matchIndexFrom(ms, 0), 0);
  assert.equal(matchIndexFrom(ms, 4), 1);
  assert.equal(matchIndexFrom(ms, 21), 0); // wraps
  assert.equal(matchIndexFrom(ms, 10, true), 0);
  assert.equal(matchIndexFrom(ms, 1, true), 2); // wraps
  assert.equal(matchIndexFrom([], 3), -1);
  assert.equal(matchAt(ms, 10, 12), 1);
  assert.equal(matchAt(ms, 10, 11), -1);
});

test('summary texts', () => {
  assert.equal(matchSummary({ matches: [] }, -1), 'No results');
  assert.equal(matchSummary({ matches: [{}, {}, {}] }, 1), '2 of 3');
  assert.equal(matchSummary({ matches: [{}] }, -1), '1 match');
  assert.equal(matchSummary({ matches: [], error: 'Unterminated group' }, -1), 'Unterminated group');
});

test('go to line: line or line:column, clamped to the text', () => {
  const t = 'one\ntwo\nthree';
  assert.equal(lineColumnOffset(t, '1'), 0);
  assert.equal(lineColumnOffset(t, '2'), 4);
  assert.equal(lineColumnOffset(t, ' 3:3 '), 10);
  assert.equal(lineColumnOffset(t, '2,99'), 7); // end of line 2
  assert.equal(lineColumnOffset(t, '99'), 8); // last line
  assert.equal(lineColumnOffset(t, '0'), 0);
  assert.equal(lineColumnOffset(t, 'abc'), null);
  assert.equal(lineColumnOffset(t, ''), null);
});

test('the selection starts the search only when it is short and on one line', () => {
  assert.equal(initialQuery('orders'), 'orders');
  assert.equal(initialQuery(''), null);
  assert.equal(initialQuery('a\nb'), null);
  assert.equal(initialQuery('x'.repeat(201)), null);
});
