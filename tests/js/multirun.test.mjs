import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineResults, summarySet, serverStatus, runSummary, pickerItems } from '../../src/ZawSQL/wwwroot/js/multirunlogic.js';

const col = (name, extra = {}) => ({ name, type: 'INT', kind: 'number', ...extra });
const set = (statement, cols, rows, extra = {}) => ({ statement, sql: `q${statement}`, columns: cols.map(c => col(c)), rows, truncated: false, ...extra });

test('multi-run: the same statement on each server becomes one result with a Server column', () => {
  const servers = [
    { name: 'a', resultSets: [set(0, ['n'], [['1'], ['2']]), set(1, ['x', 'y'], [['5', '6']])] },
    { name: 'b', resultSets: [set(0, ['n'], [['3']], { truncated: true })] },
  ];
  const sets = combineResults(servers);
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[0].columns.map(c => c.name), ['Server', 'n']);
  assert.deepEqual(sets[0].rows, [['a', '1'], ['a', '2'], ['b', '3']]);
  assert.equal(sets[0].truncated, true);
  assert.deepEqual(sets[0].servers, ['a', 'b']);
  assert.ok(sets.every(s => s.multi));
  assert.deepEqual(sets[1].rows, [['a', '5', '6']]);
});

test('multi-run: different columns on servers stay separate; several sets of one statement are kept apart', () => {
  const servers = [
    { name: 'a', resultSets: [set(0, ['n'], [['1']]), set(0, ['m'], [['7']])] }, // a CALL returning two sets
    { name: 'b', resultSets: [set(0, ['n', 'extra'], [['2', 'x']]), set(0, ['m'], [['8']])] },
  ];
  const sets = combineResults(servers);
  assert.deepEqual(sets.map(s => [s.statement, s.columns.map(c => c.name).join(','), s.servers.join(',')]), [
    [0, 'Server,n', 'a'],
    [0, 'Server,n,extra', 'b'],
    [0, 'Server,m', 'a,b'],
  ]);
});

test('multi-run: combined columns lose their source table so they are never edited in place', () => {
  const s = { statement: 0, sql: 'q', columns: [col('id', { table: 't', baseName: 'id', schema: 'd' })], rows: [['1']] };
  const [c] = combineResults([{ name: 'a', resultSets: [s] }]);
  assert.deepEqual(c.columns[1], { name: 'id', type: 'INT', kind: 'number' });
});

test('multi-run: summary row per server', () => {
  const servers = [
    { name: 'ok', executed: 2, affected: 3, ms: 1234, resultSets: [set(0, ['n'], [['1'], ['2']])], errors: [] },
    { name: 'sqlerr', executed: 1, affected: 0, ms: 10, resultSets: [], errors: [{ statement: 1, code: 1146, message: 'no table' }] },
    { name: 'ro', executed: 0, affected: 0, ms: 5, resultSets: [], errors: [{ statement: 0, code: 0, message: 'writes' }] },
    { name: 'down', executed: 0, affected: 0, ms: 50, error: 'Access denied', resultSets: [], errors: [] },
    { name: 'stopped', executed: 0, affected: 0, ms: 50, error: 'Stopped.', resultSets: [], errors: [] },
  ];
  const s = summarySet(servers, 2);
  assert.ok(s.summary && s.multi);
  assert.deepEqual(s.rows[0], ['ok', 'OK', '2 of 2', '2', '3', '1.234', null]);
  assert.equal(s.rows[1][1], 'Error');
  assert.equal(s.rows[1][6], '#2: SQL Error (1146): no table');
  assert.equal(s.rows[2][6], '#1: Blocked in read-only mode: writes');
  assert.deepEqual(s.rows[3].slice(0, 2), ['down', 'Failed']);
  assert.equal(s.rows[3][6], 'Access denied');
  assert.equal(serverStatus(servers[4]), 'Stopped');
  assert.equal(runSummary(servers), '1 of 5 servers OK, 4 with errors');
  assert.equal(runSummary([servers[0]]), '1 server OK');
});

test('multi-run: picker lists sessions by name, marks connected ones and remembers the last choice', () => {
  const items = pickerItems([
    { id: '2', name: 'beta', host: 'b', production: true },
    { id: '1', name: 'Alpha', host: 'a', hasPassword: false, savePassword: false },
    { id: '3', name: 'gamma', host: 'g', hasPassword: false, savePassword: false },
  ], new Set(['3']), ['2', 'x']);
  assert.deepEqual(items.map(i => i.name), ['Alpha', 'beta', 'gamma']);
  assert.deepEqual(items.map(i => i.checked), [false, true, false]);
  assert.equal(items[0].needsPassword, true); // not connected and no saved password
  assert.equal(items[2].needsPassword, false); // connected: the typed password is used
  assert.equal(items[2].connected, true);
  assert.equal(items[1].production, true);
});
