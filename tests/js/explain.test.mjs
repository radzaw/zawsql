import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  parsePlan, findIssues, tables, totalCost, walk, accessInfo, tableTitle, parseAnalyzeTree, flattenSteps, misestimates,
} from '../../src/ZawSQL/wwwroot/js/explainlogic.js';

// Real EXPLAIN FORMAT=JSON output of MySQL 8.4 and MariaDB 11.4 for the same queries (see fixtures/explain).
const dir = new URL('./fixtures/explain/', import.meta.url);
const plan = name => parsePlan(readFileSync(new URL(name + '.json', dir), 'utf8'));
const shape = n => (n.kind === 'table' ? `${n.title}:${n.access}` : n.kind === 'message' ? `"${n.title}"` : n.title)
  + (n.children.length ? `(${n.children.map(shape).join(', ')})` : '');
const severities = issues => issues.map(i => i.severity);

test('every captured plan parses into a tree with its tables', () => {
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const root = parsePlan(readFileSync(new URL(f, dir), 'utf8'));
    assert.equal(root.kind, 'block', f);
    walk(root, n => assert.ok(n.title, `${f}: node without title`));
  }
});

test('join with GROUP BY and ORDER BY: same steps from both servers', () => {
  assert.equal(shape(plan('mysql_join_group')), 'SELECT #1(Sort (ORDER BY)(Group (GROUP BY)(Nested loop join(o:ALL, c:eq_ref))))');
  assert.equal(shape(plan('mariadb_join_group')), 'SELECT #1(Sort(Temporary table(Nested loop join(o:ALL, c:eq_ref))))');
  const [o, c] = tables(plan('mysql_join_group'));
  assert.equal(o.rows, 5000);
  assert.equal(o.filtered, 10);
  assert.equal(o.accessLabel, 'Full table scan');
  assert.equal(o.selfCost, 504);
  assert.deepEqual([c.key, c.ref, c.accessLabel, c.severity], ['PRIMARY', ['xp.o.customer_id'], 'Unique key lookup', 'good']);
  assert.equal(totalCost(plan('mysql_join_group')), 679);
  const issues = findIssues(plan('mysql_join_group'));
  assert.deepEqual(severities(issues), ['warning', 'info', 'info']); // 5,000-row scan; filesort; temporary table
  assert.match(issues[0].text, /Full table scan of o \(5,000 rows/);
  assert.match(issues[0].hint, /idx_customer/);
});

test('hash join and block nested loop join are flagged as joins without an index', () => {
  const my = findIssues(plan('mysql_hashjoin'));
  assert.ok(my.some(i => /o is joined without an index \(hash join\)/.test(i.text)));
  const maria = plan('mariadb_hashjoin');
  assert.equal(shape(maria), 'SELECT #1(Nested loop join(p:ALL, o:ALL))');
  const o = tables(maria)[1];
  assert.equal(o.joinBuffer, 'BNL');
  assert.equal(o.joinCondition, 'o.product_code = p.`code`');
  assert.ok(findIssues(maria).some(i => /joined without an index \(BNL\)/.test(i.text)));
});

test('dependent subqueries, derived tables and unions', () => {
  assert.equal(shape(plan('mysql_dependent')), 'SELECT #1(c:ALL(Dependent subquery in WHERE(SELECT #2(o:ref))))');
  assert.equal(shape(plan('mariadb_dependent')), 'SELECT #1(c:ALL, Dependent subquery(SELECT #2(o:ref)))');
  for (const f of ['mysql_dependent', 'mariadb_dependent']) assert.ok(findIssues(plan(f)).some(i => /once for every row/.test(i.text)), f);

  assert.equal(shape(plan('mysql_derived')), 'SELECT #1(x:ALL(Materialized from(SELECT #2(Group (GROUP BY)(orders:index)))))');
  assert.equal(shape(plan('mariadb_derived')), 'SELECT #1(derived table #2:ALL(Materialized from(SELECT #2(Sort(Temporary table(orders:ALL))))))');
  assert.equal(plan('mariadb_derived').children[0].children[0].children[0].condition, 'HAVING s > 1000');

  assert.equal(shape(plan('mysql_union')), 'SELECT #?(UNION(SELECT #1(customers:ALL), SELECT #2(orders:ALL)))');
  assert.equal(shape(plan('mariadb_union')), 'SELECT #?(UNION(SELECT #1(customers:ALL), UNION SELECT #2(orders:ALL)))');
  assert.equal(plan('mysql_union').children[0].sub, 'union of #1, #2');
});

test('const lookups, UPDATE, range scans with a sort, and plans without tables', () => {
  const c = tables(plan('mysql_const'))[0];
  assert.deepEqual([c.access, c.severity], ['const', 'good']);
  assert.deepEqual(findIssues(plan('mysql_const')), []);
  const u = tables(plan('mysql_update'))[0];
  assert.deepEqual([u.statement, u.accessLabel, u.key], ['UPDATE', 'Index range scan', 'idx_customer']);
  assert.equal(tables(plan('mariadb_update'))[0].statement, 'UPDATE');
  assert.equal(shape(plan('mariadb_range')), 'SELECT #1(Sort(orders:range))');
  assert.ok(tables(plan('mariadb_range'))[0].flags.includes('index condition pushdown'));
  assert.equal(shape(plan('mysql_notables')), 'SELECT #1("No tables used")');
  assert.equal(shape(plan('mariadb_notables')), 'SELECT #1("No tables used")');
});

test('MariaDB ANALYZE adds measured rows, loops and time', () => {
  const root = plan('mariadb_analyze_join_group');
  assert.ok(root.actual.timeMs > 0);
  assert.ok(root.optimizeMs > 0);
  const [o, c] = tables(root);
  assert.deepEqual([o.actual.rows, o.actual.loops, o.actual.filtered], [5000, 1, 75]);
  assert.ok(o.actual.timeMs > 0);
  assert.equal(c.actual.loops, 3750);
});

test('severity of scans depends on their size; internal table names read naturally', () => {
  assert.equal(accessInfo('ALL', 50).severity, 'ok');
  assert.equal(accessInfo('ALL', 5000).severity, 'warning');
  assert.equal(accessInfo('ALL', 500_000).severity, 'critical');
  assert.equal(accessInfo('ref', 500_000).severity, 'good');
  assert.equal(accessInfo('weird').label, 'weird');
  assert.equal(tableTitle('<derived3>'), 'derived table #3');
  assert.equal(tableTitle('<subquery2>'), 'materialized subquery #2');
  assert.equal(tableTitle('orders'), 'orders');
});

test("misestimated rows are reported (stale statistics)", () => {
  const root = plan('mariadb_analyze_join_group');
  tables(root)[0].actual.rows = 40; // pretend only 40 of the estimated 5,000 rows were read
  assert.ok(findIssues(root).some(i => /^o: estimated 5,000 rows, actually 40/.test(i.text) && /ANALYZE TABLE/.test(i.hint)));
});

test("MySQL's EXPLAIN ANALYZE tree becomes measured steps", () => {
  const roots = parseAnalyzeTree(readFileSync(new URL('mysql_analyze_join_group.txt', dir), 'utf8'));
  assert.equal(roots.length, 1);
  const steps = flattenSteps(roots);
  assert.equal(steps.length, 8);
  assert.deepEqual(steps.map(s => s.depth), [0, 1, 2, 3, 4, 5, 6, 5]);
  assert.equal(steps[0].label, 'Limit: 10 row(s)');
  assert.deepEqual(steps[4].estimate, { cost: 679, rows: 500 });
  assert.equal(steps[4].actual.rows, 3750);
  const lookup = steps[7];
  assert.match(lookup.label, /^Single-row index lookup on c using PRIMARY/);
  assert.equal(lookup.actual.loops, 3750);
  assert.ok(Math.abs(lookup.actual.totalMs - 571e-6 * 3750) < 1e-9);
  assert.deepEqual(misestimates(steps), []); // 500 estimated vs 3,750 actual is 7.5×: below the 10× threshold
  const off = flattenSteps(parseAnalyzeTree('-> Table scan on t  (cost=10 rows=100) (actual time=0.1..5 rows=20000 loops=1)\n    -> Filter: (x > 1)  (cost=1 rows=1) (never executed)'));
  assert.deepEqual(misestimates(off).map(s => s.label), ['Table scan on t']);
  assert.equal(off[1].neverExecuted, true);
  assert.equal(off[1].label, 'Filter: (x > 1)');
});
