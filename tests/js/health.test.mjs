import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analyze, redundantIndexes, intMax, parseVersion, verdict, reportHtml, reportFileName, CHECK_COUNT,
} from '../../src/ZawSQL/wwwroot/js/healthlogic.js';

// Facts collected by HealthReport.cs from MySQL 8.4 and MariaDB 11.4 (see HealthTests.cs, ZAWSQL_HEALTH_DUMP), with
// planted problems: hc_nopk_* (no primary key, redundant index a_only), hc_myisam_*, hc_ai_* (TINYINT UNSIGNED
// auto-increment at 240), hc_latin_* (latin1) and an account without a password (zt_hc_*).
const load = name => JSON.parse(readFileSync(new URL(`./fixtures/health/${name}.json`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-04T12:00:00Z');
const find = (r, id) => r.findings.find(f => f.id === id);
const passed = (r, id) => r.passed.find(p => p.id === id);
const clone = o => structuredClone(o);

for (const server of ['mysql', 'mariadb']) {
  test(`${server}: the planted problems are found`, () => {
    const f = load(server);
    const r = analyze(f, NOW);
    assert.equal(r.findings.length + r.passed.length + r.skipped.length, CHECK_COUNT);

    const pk = find(r, 'primary-keys');
    assert.equal(pk.severity, 'warning');
    assert.ok(pk.items.rows.some(row => row[0].includes('hc_nopk_')));
    assert.match(pk.fix.sql, /^ALTER TABLE `zt_shop_\w+`\.`hc_nopk_\w+` ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;$/);

    const engines = find(r, 'engines');
    assert.equal(engines.severity, 'warning');
    assert.match(engines.fix.sql, /`hc_myisam_\w+` ENGINE=InnoDB;/);

    const ai = find(r, 'auto-increment');
    assert.equal(ai.severity, 'critical'); // 239 of 255 used
    assert.deepEqual(ai.items.rows[0].slice(1), ['id', 'tinyint unsigned', '240', '255', '93.7%']);
    assert.match(ai.fix.text, /TINYINT → SMALLINT/);

    const cs = find(r, 'charsets');
    assert.ok(cs.items.rows.some(row => row[0].includes('hc_latin_') && row[1].startsWith('latin1')));
    assert.match(cs.fix.sql, /CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_/);

    const red = find(r, 'redundant-indexes');
    assert.deepEqual(red.items.rows.map(row => row.slice(1)), [['a_only', 'a', 'ab', 'a, b']]);
    assert.match(red.fix.sql, /DROP INDEX `a_only`;$/);

    const nopass = find(r, 'empty-passwords');
    assert.equal(nopass.severity, 'critical');
    // Built-in accounts (mariadb.sys, mysql.sys …) are locked or can't log in: not reported.
    assert.deepEqual(nopass.items.rows.map(row => row[0].replace(/_[0-9a-f]{8}'/, "_*'")), ["'zt_hc_*'@'%'"]);

    const admins = find(r, 'remote-admins'); // the Docker images create root@'%'
    assert.deepEqual(admins.items.rows, [["'root'@'%'", 'ALL PRIVILEGES']]);

    assert.ok(passed(r, 'anonymous-accounts'));
    assert.ok(passed(r, 'connections'));
    assert.ok(passed(r, 'sql-mode'));
    assert.ok(passed(r, 'charset-server'));
    // A server that started seconds ago has too little activity to judge its counters.
    for (const id of ['buffer-pool-hits', 'redo-log', 'tmp-disk', 'slow-queries', 'full-joins']) assert.ok(r.skipped.includes(id), id);
    assert.equal(r.overview.tables, f.tables.length);
    assert.equal(r.overview.largest.length, Math.min(10, f.tables.length));
  });
}

test('server-specific findings', () => {
  const my = analyze(load('mysql'), NOW), ma = analyze(load('mariadb'), NOW);
  assert.equal(passed(my, 'version').title, 'MySQL 8.4 is supported until April 2032');
  assert.equal(passed(ma, 'version').title, 'MariaDB 11.4 is supported until May 2029');
  // performance_schema: on in MySQL, off by default in MariaDB.
  assert.ok(passed(my, 'performance-schema'));
  assert.equal(find(ma, 'performance-schema').severity, 'info');
  assert.ok(ma.skipped.includes('unused-indexes'));
  // Unused indexes leave out unique indexes (they enforce a rule) and ones already reported as redundant.
  const unused = find(my, 'unused-indexes');
  const names = unused.items.rows.map(r => r[1]);
  assert.ok(names.includes('idx_name'));
  assert.ok(!names.includes('uq_email') && !names.includes('a_only'));
  assert.equal(unused.severity, 'info'); // uptime of seconds: may still be needed
  assert.match(unused.fix.sql, /ALTER INDEX `idx_name` INVISIBLE;/);
  // MariaDB defaults: sync_binlog = 0 and local_infile = ON.
  assert.deepEqual(find(ma, 'durability').items.rows.map(r => r[0]), ['sync_binlog']);
  assert.equal(find(ma, 'durability').fix.sql, 'SET GLOBAL sync_binlog = 1;');
  assert.ok(passed(my, 'durability'));
  assert.equal(find(ma, 'local-infile').fix.sql, 'SET GLOBAL local_infile = OFF;');
  assert.ok(passed(my, 'local-infile'));
  // The deprecated MySQL password plugin is a MySQL concern only.
  assert.ok(passed(my, 'native-password'));
  assert.ok(ma.skipped.includes('native-password'));
  // TLS is available on both, but not required.
  assert.equal(find(my, 'tls').severity, 'info');
  assert.equal(find(my, 'tls').fix.sql, 'SET PERSIST require_secure_transport = ON;');
  assert.equal(find(ma, 'tls').fix.sql, 'SET GLOBAL require_secure_transport = ON;');
  // Both are primaries without replicas connected: nothing to judge about channels.
  assert.ok(my.skipped.includes('replication-channels'));
});

test('end-of-life dates and release types', () => {
  const at = (server, version, now = NOW) => {
    const f = clone(load(server));
    f.version = version;
    const r = analyze(f, now);
    return find(r, 'version') ?? passed(r, 'version') ?? null;
  };
  assert.deepEqual([at('mysql', '8.0.40').severity, at('mysql', '8.0.40').title], ['critical', 'MySQL 8.0 reached its end of life in April 2026']);
  assert.equal(at('mysql', '9.1.0').severity, 'info');
  assert.equal(at('mariadb', '10.6.18-MariaDB').severity, 'critical');
  assert.equal(at('mariadb', '10.11.9-MariaDB', Date.parse('2027-10-01')).severity, 'warning'); // February 2028 is within six months
  assert.equal(at('mariadb', '11.2.1-MariaDB').title, 'MariaDB 11.2 is a short-term release');
  assert.equal(at('mariadb', '11.8.2-MariaDB'), null); // long-term, no date recorded: no claim either way
  assert.deepEqual(parseVersion('11.4.13-MariaDB-ubu2404-log'), { major: 11, minor: 4, patch: 13, series: '11.4' });
});

test('redundant indexes', () => {
  const ix = (name, columns, { unique = false, type = 'BTREE', table = 't' } = {}) => ({ schema: 'db', table, name, unique: unique || name === 'PRIMARY', type, columns });
  const names = list => redundantIndexes(list).map(r => `${r.index}<${r.coveredBy}`);
  // A leading part of a longer index.
  assert.deepEqual(names([ix('PRIMARY', ['id']), ix('a', ['a']), ix('ab', ['a', 'b'])]), ['a<ab']);
  // The primary key covers its own leading columns.
  assert.deepEqual(names([ix('PRIMARY', ['a', 'b']), ix('a', ['a'])]), ['a<PRIMARY']);
  // A unique index enforces a rule: kept unless an identical unique index exists (the primary key wins).
  assert.deepEqual(names([ix('u_a', ['a'], { unique: true }), ix('ab', ['a', 'b'])]), []);
  assert.deepEqual(names([ix('PRIMARY', ['a']), ix('u_a', ['a'], { unique: true })]), ['u_a<PRIMARY']);
  assert.deepEqual(names([ix('u1', ['a'], { unique: true }), ix('u2', ['a'], { unique: true })]), ['u2<u1']);
  // Exact duplicates: one is kept.
  assert.deepEqual(names([ix('x1', ['a', 'b']), ix('x2', ['a', 'b'])]), ['x2<x1']);
  // Column order matters; other tables don't count.
  assert.deepEqual(names([ix('ba', ['b', 'a']), ix('ab', ['a', 'b']), ix('a', ['a'], { table: 'u' })]), []);
  // Prefix lengths: name(10) is served by name(20) or name, not the other way round.
  assert.deepEqual(names([ix('n10', ['name(10)']), ix('n20', ['name(20)', 'x'])]), ['n10<n20']);
  assert.deepEqual(names([ix('n', ['name']), ix('n10', ['name(10)', 'x'])]), []);
  // FULLTEXT, SPATIAL and functional index parts are left alone.
  assert.deepEqual(names([ix('ft', ['body'], { type: 'FULLTEXT' }), ix('ft2', ['body', 'title'], { type: 'FULLTEXT' })]), []);
  assert.deepEqual(names([ix('e', ['(expression 1)']), ix('e2', ['(expression 1)', 'b'])]), []);
  // Matching is case-insensitive like MySQL column names.
  assert.deepEqual(names([ix('a', ['Code']), ix('ab', ['code', 'b'])]), ['a<ab']);
});

test('integer ranges', () => {
  assert.equal(intMax('tinyint', true), 255);
  assert.equal(intMax('INT', false), 2147483647);
  assert.equal(intMax('int', true), 4294967295);
  assert.equal(intMax('decimal', false), null);
});

test('counter-based checks on a busy server', () => {
  const f = clone(load('mysql'));
  Object.assign(f.status, {
    Uptime: String(40 * 86400), Questions: '5000000', Slow_queries: '120000', Max_used_connections: '151', Connection_errors_max_connections: '17',
    Innodb_buffer_pool_read_requests: '900000000', Innodb_buffer_pool_reads: '72000000', Innodb_os_log_written: String(40 * 24 * 2 * 1024 ** 3),
    Created_tmp_tables: '10000', Created_tmp_disk_tables: '6000', Connections: '200000', Threads_created: '90000', Aborted_connects: '30000',
    Com_select: '3000000', Select_full_join: '90000', Innodb_row_lock_waits: '5000', Innodb_row_lock_time_avg: '1800',
  });
  f.tables.push({ schema: 'big', name: 'events', engine: 'InnoDB', rows: 9e8, dataBytes: 300 * 1024 ** 3, indexBytes: 80 * 1024 ** 3, freeBytes: 120 * 1024 ** 3, collation: 'utf8mb4_0900_ai_ci', partitioned: false });
  const r = analyze(f, NOW);
  assert.equal(find(r, 'connections').severity, 'critical');
  assert.match(find(r, 'connections').title, /17 connections were refused/);
  assert.equal(find(r, 'buffer-pool-size').severity, 'warning'); // still 128 MiB with 380 GiB of data
  assert.match(find(r, 'buffer-pool-size').fix.sql, /^SET PERSIST innodb_buffer_pool_size = 64 \* 1024 \* 1024 \* 1024;$/);
  assert.equal(find(r, 'buffer-pool-hits').severity, 'warning'); // 8% misses
  const redo = find(r, 'redo-log'); // 2 GiB per hour into 100 MiB
  assert.equal(redo.severity, 'warning');
  assert.equal(redo.fix.sql, 'SET PERSIST innodb_redo_log_capacity = 3 * 1024 * 1024 * 1024;');
  assert.equal(find(r, 'tmp-disk').title, '60% of internal temporary tables went to disk');
  assert.equal(find(r, 'thread-cache').fix.sql, 'SET GLOBAL thread_cache_size = 151;');
  assert.equal(find(r, 'slow-queries').severity, 'warning');
  assert.equal(find(r, 'full-joins').severity, 'warning');
  assert.equal(find(r, 'row-lock-waits').severity, 'warning');
  assert.match(find(r, 'aborted-connects').title, /^15\.0% of connection attempts failed$/);
  assert.match(find(r, 'fragmentation').fix.sql, /^OPTIMIZE TABLE `big`\.`events`;$/);
  assert.equal(find(r, 'unused-indexes').severity, 'warning'); // after 40 days, unused means unused
  // Criticals come first.
  assert.equal(r.findings[0].severity, 'critical');
  assert.equal(verdict(r.counts).severity, 'critical');
});

test('a user without access to accounts or performance_schema', () => {
  const f = clone(load('mariadb'));
  f.accounts = null;
  f.replication = null;
  f.notes = ['Accounts can\'t be checked (needs SELECT on mysql.user): denied'];
  const r = analyze(f, NOW);
  for (const id of ['anonymous-accounts', 'empty-passwords', 'remote-admins', 'replication-channels', 'replication-setup']) assert.ok(r.skipped.includes(id), id);
  assert.deepEqual(r.notes, f.notes);
});

test('a broken check is reported, not thrown', () => {
  const f = clone(load('mysql'));
  f.variables.sql_mode = 42; // not a string: the sql-mode check throws
  f.autoIncrement = [{ schema: 'x', table: 'y', column: 'id', type: 'int', unsigned: false, next: 2147483000 }];
  const r = analyze(f, NOW);
  assert.match(find(r, 'sql-mode').title, /The "sql-mode" check failed/);
  assert.equal(find(r, 'auto-increment').severity, 'critical'); // the other checks still ran
});

test('verdicts', () => {
  assert.deepEqual(verdict({ critical: 2, warning: 1, info: 0 }), { severity: 'critical', text: '2 critical problems to fix' });
  assert.deepEqual(verdict({ critical: 0, warning: 1, info: 3 }), { severity: 'warning', text: '1 warning worth a look' });
  assert.deepEqual(verdict({ critical: 0, warning: 0, info: 3 }), { severity: 'good', text: 'No problems found, a few notes' });
});

test('the saved HTML report is self-contained and escaped', () => {
  const f = clone(load('mysql'));
  f.tables[0].name = '<img src=x onerror=alert(1)>';
  f.indexes = f.indexes.filter(i => i.table !== f.tables[0].name);
  const html = reportHtml(analyze(f, NOW), { server: 'db1 <prod>', version: f.version, collectedAt: '2026-10-04 12:00', app: '1.2.0' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Health report – db1 &lt;prod&gt;<\/title>/);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/<script|<link|src="http/.test(html)); // nothing external
  for (const s of ['Configuration', 'Schema', 'Indexes', 'Security', 'Overview', 'prefers-color-scheme: dark', 'ALTER TABLE']) assert.ok(html.includes(s), s);
  assert.equal(reportFileName('db1.example.com:3306', '2026-10-04T12:00:00Z'), 'health-db1.example.com_3306-2026-10-04.html');
});
