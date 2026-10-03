import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandSnippet, snippetVars, normalizeLibrary, groupByFolder, matches, findSnippet, mergeLibrary, restoreDefaultSnippets,
  uniqueName, suggestName, normalizeFolder, isValidTrigger, makeQuery, makeSnippet, DEFAULT_SNIPPETS,
} from '../../src/ZawSQL/wwwroot/js/library.js';

const pick = (r, i) => r.text.slice(r.stops[i].start, r.stops[i].end);

test('snippet tab stops are ordered by number, with defaults selected and $0 as the final caret', () => {
  const r = expandSnippet('SELECT ${2:*} FROM ${1:t} WHERE $3;$0 -- end');
  assert.equal(r.text, 'SELECT * FROM t WHERE ; -- end');
  assert.deepEqual(r.stops.map((_, i) => pick(r, i)), ['t', '*', '']);
  assert.equal(r.stops[2].start, 'SELECT * FROM t WHERE '.length);
  assert.equal(r.cursor, 'SELECT * FROM t WHERE ;'.length);
  assert.equal(expandSnippet('x').cursor, 1); // no $0: the end
});

test('variables fill in, fall back to their default, and nest inside tab stops', () => {
  const vars = { TABLE: '`order items`', DB: '', SELECTION: 'SELECT 1;' };
  assert.equal(expandSnippet('FROM ${TABLE}', vars).text, 'FROM `order items`');
  assert.equal(expandSnippet('USE ${DB:mydb};', vars).text, 'USE mydb;');
  const r = expandSnippet('FROM ${1:${TABLE:tbl}} AND ${2:${DB:db}}', vars);
  assert.equal(r.text, 'FROM `order items` AND db');
  assert.equal(pick(r, 0), '`order items`');
  assert.equal(pick(r, 1), 'db');
  assert.equal(expandSnippet('BEGIN;\n${SELECTION}\nCOMMIT;', vars).text, 'BEGIN;\nSELECT 1;\nCOMMIT;');
  assert.equal(expandSnippet('${UNKNOWN}x', vars).text, 'x');
});

test('dollar signs that are not snippet syntax stay literal', () => {
  assert.equal(expandSnippet('DELIMITER $$\nEND$$\nSET @$a = 1; \\${1} $x').text, 'DELIMITER $$\nEND$$\nSET @$a = 1; ${1} $x');
  assert.deepEqual(expandSnippet('\\$1').stops, []);
});

test('continuation lines keep the indentation of the insertion line; variable values are inserted as is', () => {
  const r = expandSnippet('SELECT\n  ${1:a}\nFROM t;', {}, '    ');
  assert.equal(r.text, 'SELECT\n      a\n    FROM t;');
  assert.equal(pick(r, 0), 'a');
  assert.equal(expandSnippet('-- ${SELECTION}', { SELECTION: 'x\ny' }, '  ').text, '-- x\ny');
});

test('nested numbered stops become plain default text; repeated numbers are visited in text order', () => {
  const r = expandSnippet('${1:a ${2:b} c} $2');
  assert.equal(r.text, 'a b c ');
  assert.equal(r.stops.length, 2);
  assert.equal(pick(r, 0), 'a b c');
  const rep = expandSnippet('${1:x} = ${1:x}');
  assert.deepEqual(rep.stops.map(s => s.start), [0, 4]);
});

test('every default snippet expands with stops inside the text', () => {
  const vars = snippetVars({ db: 'shop', table: 'order items', ident: n => (/\s/.test(n) ? '`' + n + '`' : n), now: new Date(2026, 0, 5) });
  assert.equal(vars.DATE, '2026-01-05');
  assert.equal(vars.TABLE, '`order items`');
  for (const s of DEFAULT_SNIPPETS) {
    assert.ok(isValidTrigger(s.trigger), s.trigger);
    const r = expandSnippet(s.body, vars);
    assert.ok(!/\$\{|\$\d/.test(r.text), `${s.trigger}: ${r.text}`);
    for (const st of r.stops) assert.ok(st.start <= st.end && st.end <= r.text.length, s.trigger);
  }
  assert.match(expandSnippet(DEFAULT_SNIPPETS.find(s => s.trigger === 'sel').body, vars).text, /FROM `order items`/);
});

test('a missing library seeds the default snippets; stored data is cleaned', () => {
  const fresh = normalizeLibrary(null);
  assert.equal(fresh.queries.length, 0);
  assert.equal(fresh.snippets.length, DEFAULT_SNIPPETS.length);
  const lib = normalizeLibrary({
    queries: [{ id: 'q1', name: '  Report ', folder: ' a // b/ ', sql: 'SELECT 1' }, null, 'junk', { sql: 'SELECT 2' }],
    snippets: [{ id: 's1', name: 'Bad trigger', trigger: 'two words', body: 'x' }],
  });
  assert.deepEqual(lib.queries.map(q => [q.name, q.folder]), [['Report', 'a/b'], ['Untitled', '']]);
  assert.equal(lib.snippets[0].trigger, '');
  assert.equal(normalizeLibrary({ queries: [], snippets: [] }).snippets.length, 0); // deleted defaults stay deleted
});

test('queries are grouped by folder (unfiled first) and filtered on every term', () => {
  const qs = [
    makeQuery({ name: 'Zeta', folder: 'Reports', sql: 'SELECT 1' }),
    makeQuery({ name: 'alpha', folder: 'Reports', sql: 'SELECT * FROM orders' }),
    makeQuery({ name: 'Loose', sql: 'SHOW TABLES' }),
    makeQuery({ name: 'Cleanup', folder: 'Admin', description: 'nightly', sql: 'DELETE FROM logs' }),
  ];
  assert.deepEqual(groupByFolder(qs).map(g => [g.folder, g.items.map(q => q.name)]),
    [['', ['Loose']], ['Admin', ['Cleanup']], ['Reports', ['alpha', 'Zeta']]]);
  assert.deepEqual(groupByFolder(qs, 'orders reports').map(g => g.items.map(q => q.name)), [['alpha']]);
  assert.ok(matches(qs[3], 'NIGHTLY'));
  assert.ok(!matches(qs[3], 'nightly weekly'));
});

test('snippet triggers are found case-insensitively', () => {
  const sn = [makeSnippet({ name: 'A', trigger: 'Sel', body: '1' }), makeSnippet({ name: 'B', body: '2' })];
  assert.equal(findSnippet(sn, 'sel').name, 'A');
  assert.equal(findSnippet(sn, ''), null);
  assert.equal(findSnippet(sn, 'B'), null); // no trigger
});

test('import merges new items, updates newer copies, skips duplicates and keeps triggers unique', () => {
  const lib = normalizeLibrary({ queries: [{ id: 'q1', name: 'Report', sql: 'SELECT 1', updated: 100 }], snippets: [{ id: 's1', name: 'Sel', trigger: 'sel', body: 'SELECT', updated: 100 }] });
  const res = mergeLibrary(lib, {
    queries: [
      { id: 'q1', name: 'Report', sql: 'SELECT 2', updated: 200 }, // newer: replaces
      { id: 'x1', name: 'Report', sql: 'SELECT 1', updated: 50 }, // same as the replaced? no: different sql now → added with a unique name
      { id: 'x2', name: 'Report', sql: 'SELECT 2', updated: 50 }, // identical to q1 now: skipped
    ],
    snippets: [{ id: 'x3', name: 'Other sel', trigger: 'SEL', body: 'other' }, { id: 'x4', name: 'Dup', trigger: 'sel', body: 'SELECT' }],
  });
  assert.deepEqual(res, { added: 2, updated: 1, skipped: 2 });
  assert.deepEqual(lib.queries.map(q => [q.name, q.sql]), [['Report', 'SELECT 2'], ['Report (2)', 'SELECT 1']]);
  assert.equal(lib.snippets.find(s => s.id === 'x3').trigger, ''); // trigger taken
  assert.equal(restoreDefaultSnippets(lib), DEFAULT_SNIPPETS.length - 1); // "sel" exists
  assert.equal(restoreDefaultSnippets(lib), 0);
});

test('names, folders and triggers', () => {
  assert.equal(uniqueName('Report', ['report', 'Report (2)']), 'Report (3)');
  assert.equal(uniqueName('New', []), 'New');
  assert.equal(suggestName('\n-- Monthly revenue\nSELECT 1'), 'Monthly revenue');
  assert.equal(suggestName('/* top customers */'), 'top customers');
  assert.equal(suggestName('   '), 'Query');
  assert.equal(suggestName('SELECT ' + 'x'.repeat(100)).length, 58);
  assert.equal(normalizeFolder(' /Reports/ /2026 '), 'Reports/2026');
  assert.ok(isValidTrigger('sel_2$'));
  assert.ok(!isValidTrigger('sel x') && !isValidTrigger('') && !isValidTrigger('a-b'));
});
