import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildPartModel, partitionClause, partitionAlter, partChanged, partitionCount, partitionProblems } from '../../src/ZawSQL/wwwroot/js/views/partitions.js';
import { _test as users } from '../../src/ZawSQL/wwwroot/js/views/users.js';
import { exportRows, rowsToSql } from '../../src/ZawSQL/wwwroot/js/views/tools.js';
import { maintenanceSql } from '../../src/ZawSQL/wwwroot/js/views/maintenance.js';

test('maintenance preview matches the statement the backend builds', () => {
  assert.equal(maintenanceSql('check', 'shop', ['a', 'b'], []), 'CHECK TABLE `shop`.`a`, `shop`.`b`');
  assert.equal(maintenanceSql('optimize', 'shop', ['a'], ['LOCAL']), 'OPTIMIZE LOCAL TABLE `shop`.`a`');
  assert.equal(maintenanceSql('repair', 'shop', ['a'], ['LOCAL', 'QUICK']), 'REPAIR LOCAL TABLE `shop`.`a` QUICK');
  assert.equal(maintenanceSql('checksum', 'shop', ['a'], ['EXTENDED']), 'CHECKSUM TABLE `shop`.`a` EXTENDED');
  assert.equal(maintenanceSql('check', 'shop', ['a', 'b', 'c', 'd'], []), 'CHECK TABLE `shop`.`a`, `shop`.`b`, `shop`.`c`, … (4 tables)');
  assert.equal(maintenanceSql('analyze', 'shop', [], []), 'ANALYZE TABLE …');
});

// ---------------------------------------------------------------- partitions

const rangeMeta = {
  method: 'RANGE', expression: 'year(`sold`)', subMethod: null,
  partitions: [
    { name: 'p2023', description: '2024', comment: '', rows: 1, size: 16384 },
    { name: 'pmax', description: 'MAXVALUE', comment: '', rows: 2, size: 16384 },
  ],
};
const T = '`shop`.`sales`';

test('unchanged partitioning produces no statements', () => {
  const p = buildPartModel(rangeMeta);
  assert.equal(partChanged(p), false);
  assert.deepEqual(partitionAlter(p, T), []);
  assert.equal(partitionCount(p), 2);
});

test('appending RANGE partitions uses ADD PARTITION, other changes redefine', () => {
  const p = buildPartModel(rangeMeta);
  p.parts.push({ name: 'p2030', values: '2031', comment: 'future', isNew: true });
  assert.deepEqual(partitionAlter(p, T), [`ALTER TABLE ${T} ADD PARTITION (\n\tPARTITION \`p2030\` VALUES LESS THAN (2031) COMMENT = 'future'\n)`]);

  const q = buildPartModel(rangeMeta);
  q.parts.splice(1, 0, { name: 'p2024', values: '2025', comment: '', isNew: true });
  const [sql] = partitionAlter(q, T);
  assert.match(sql, /^ALTER TABLE `shop`.`sales`\nPARTITION BY RANGE \(year\(`sold`\)\)/);
  assert.match(sql, /PARTITION `pmax` VALUES LESS THAN MAXVALUE/);
});

test('removing partitioning and HASH counts', () => {
  const p = buildPartModel(rangeMeta);
  p.method = '';
  assert.deepEqual(partitionAlter(p, T), [`ALTER TABLE ${T} REMOVE PARTITIONING`]);

  const h = buildPartModel({ method: 'HASH', expression: '`id`', partitions: [0, 1, 2, 3].map(i => ({ name: 'p' + i, description: null })) });
  assert.equal(h.count, 4);
  h.count = 6;
  assert.deepEqual(partitionAlter(h, '`t`'), ['ALTER TABLE `t`\nPARTITION BY HASH (`id`) PARTITIONS 6']);
});

test('new tables get a PARTITION BY clause; RANGE COLUMNS wraps MAXVALUE', () => {
  const p = buildPartModel(null);
  assert.equal(partitionClause(p), '');
  Object.assign(p, { method: 'RANGE COLUMNS', expr: '`d`', parts: [{ name: 'p0', values: "'2025-01-01'", comment: '' }, { name: 'pmax', values: 'MAXVALUE', comment: '' }] });
  assert.equal(partitionClause(p), "PARTITION BY RANGE COLUMNS (`d`) (\n\tPARTITION `p0` VALUES LESS THAN ('2025-01-01'),\n\tPARTITION `pmax` VALUES LESS THAN (MAXVALUE)\n)");
  Object.assign(p, { method: 'LIST', expr: 'region_id', parts: [{ name: 'eu', values: '1, 2', comment: '' }] });
  assert.match(partitionClause(p), /PARTITION `eu` VALUES IN \(1, 2\)/);
  Object.assign(p, { method: 'KEY', expr: '', count: 3 });
  assert.equal(partitionClause(p), 'PARTITION BY KEY () PARTITIONS 3');
});

// Subpartitions as information_schema reports them (MySQL 8.4 and MariaDB 11.4 agree): server-named ones are
// <partition>sp<n>, and a subpartition without a comment of its own reports its partition's comment.
const autoSubMeta = {
  method: 'RANGE', expression: '`y`', subMethod: 'HASH', subExpression: '`id`',
  partitions: [
    { name: 'p0', description: '2000', comment: 'old', subNames: ['p0sp0', 'p0sp1'], subComments: ['old', 'old'], rows: 1, size: 1 },
    { name: 'p1', description: 'MAXVALUE', comment: '', subNames: ['p1sp0', 'p1sp1'], subComments: ['', ''], rows: 1, size: 1 },
  ],
};
const namedSubMeta = {
  method: 'LIST', expression: '`y`', subMethod: 'KEY', subExpression: '`id`',
  partitions: [
    { name: 'p0', description: '1,2', comment: 'pc', subNames: ['s0', 's1'], subComments: ['pc', 'pc'] },
    { name: 'p1', description: '3', comment: '', subNames: ['s2', 's3'], subComments: ['', ''] },
  ],
};

test('server-named subpartitions: SUBPARTITIONS n, appending, counts', () => {
  const p = buildPartModel(autoSubMeta);
  assert.equal(p.locked, null);
  assert.deepEqual(p.sub, { method: 'HASH', expr: '`id`', count: 2, named: false });
  assert.equal(p.parts[0].comment, 'old');
  assert.equal(partChanged(p), false);
  assert.deepEqual(partitionProblems(p), []);
  assert.equal(partitionClause(p), "PARTITION BY RANGE (`y`)\nSUBPARTITION BY HASH (`id`)\nSUBPARTITIONS 2 (\n\tPARTITION `p0` VALUES LESS THAN (2000) COMMENT = 'old',\n\tPARTITION `p1` VALUES LESS THAN MAXVALUE\n)");

  // A partition added at the end gets its subpartitions from the server.
  p.parts.push({ name: 'p2', values: '3000', comment: '', subs: '', isNew: true });
  assert.deepEqual(partitionAlter(p, T), [`ALTER TABLE ${T} ADD PARTITION (\n\tPARTITION \`p2\` VALUES LESS THAN (3000)\n)`]);

  // A different number of subpartitions (or method, or expression) redefines the partitioning.
  const q = buildPartModel(autoSubMeta);
  q.sub.count = 4;
  const [sql] = partitionAlter(q, T);
  assert.match(sql, /^ALTER TABLE `shop`.`sales`\nPARTITION BY RANGE \(`y`\)\nSUBPARTITION BY HASH \(`id`\)\nSUBPARTITIONS 4 \(/);
  const r = buildPartModel(autoSubMeta);
  r.sub.method = '';
  assert.doesNotMatch(partitionAlter(r, T)[0], /SUBPARTITION/); // subpartitioning removed, partitions kept
});

const subs = (...names) => names.map(name => ({ name, comment: '', opts: { dataDir: '', indexDir: '', maxRows: '', minRows: '', tablespace: '' } }));
const subList = x => x.subs.map(s => s.name).join(', ');

test('named subpartitions: names per partition, validation, appending with names', () => {
  const p = buildPartModel(namedSubMeta);
  assert.equal(p.locked, null);
  assert.equal(p.sub.named, true);
  assert.deepEqual(p.parts.map(subList), ['s0, s1', 's2, s3']);
  assert.equal(partChanged(p), false);
  assert.equal(partitionClause(p), "PARTITION BY LIST (`y`)\nSUBPARTITION BY KEY (`id`) (\n\tPARTITION `p0` VALUES IN (1,2) COMMENT = 'pc' (SUBPARTITION `s0`, SUBPARTITION `s1`),\n\tPARTITION `p1` VALUES IN (3) (SUBPARTITION `s2`, SUBPARTITION `s3`)\n)");

  p.parts.push({ name: 'p2', values: '4', comment: '', subs: subs('s4', 's5'), isNew: true });
  assert.deepEqual(partitionAlter(p, T), [`ALTER TABLE ${T} ADD PARTITION (\n\tPARTITION \`p2\` VALUES IN (4) (SUBPARTITION \`s4\`, SUBPARTITION \`s5\`)\n)`]);

  // What the server would refuse is caught before saving.
  p.parts[2].subs = subs('s4');
  assert.deepEqual(partitionProblems(p), ['Every partition needs the same number of subpartitions.']);
  p.parts[2].subs = subs('s0', 's5');
  assert.deepEqual(partitionProblems(p), ['The name s0 is used twice; partition and subpartition names must all differ.']);
  p.parts[2].subs = subs('p1', 's5');
  assert.match(partitionProblems(p)[0], /The name p1 is used twice/);
  p.parts[2].subs = [];
  assert.deepEqual(partitionProblems(p), ['Name the subpartitions of every partition (p2 has none).']);
  p.parts[2].subs = subs('s4', 's5');
  p.sub.expr = '';
  assert.deepEqual(partitionProblems(p), ['Subpartitioning by KEY needs one or more columns.']);
});

test("renaming a subpartition reorganizes just that partition; the server's own names are the same as none", () => {
  const p = buildPartModel(namedSubMeta);
  p.parts[1].subs[1].name = 's9';
  assert.deepEqual(partitionAlter(p, T), [`ALTER TABLE ${T} REORGANIZE PARTITION \`p1\` INTO (\n\tPARTITION \`p1\` VALUES IN (3) (SUBPARTITION \`s2\`, SUBPARTITION \`s9\`)\n)`]);

  // Naming them p0sp0, p0sp1 … by hand changes nothing.
  const q = buildPartModel(autoSubMeta);
  q.sub.named = true;
  q.parts.forEach(x => { x.subs = subs(`${x.name}sp0`, `${x.name}sp1`); });
  assert.equal(partChanged(q), false);
  assert.deepEqual(partitionAlter(q, T), []);
  assert.match(partitionClause(q), /\nSUBPARTITIONS 2 \(/);
});

test('subpartitioning a new or plain table; HASH/KEY partitions have none', () => {
  const p = buildPartModel(rangeMeta);
  p.sub = { method: 'LINEAR KEY', expr: '`id`', count: 3, named: false };
  assert.match(partitionAlter(p, T)[0], /^ALTER TABLE `shop`.`sales`\nPARTITION BY RANGE \(year\(`sold`\)\)\nSUBPARTITION BY LINEAR KEY \(`id`\)\nSUBPARTITIONS 3 \(/);
  const h = buildPartModel({ method: 'HASH', expression: '`id`', partitions: [{ name: 'p0' }, { name: 'p1' }] });
  h.sub = { method: 'HASH', expr: 'id', count: 2, named: false };
  assert.equal(partitionClause(h), 'PARTITION BY HASH (`id`) PARTITIONS 2'); // ignored: only RANGE/LIST can be subpartitioned
  assert.deepEqual(partitionProblems(h), []);
});

test('without SHOW CREATE TABLE, tables the editor cannot model stay locked', () => {
  // Subpartition comments can't be told apart from the partition's without the definitions.
  const withComments = structuredClone(namedSubMeta);
  withComments.partitions[0].subComments = ['sc0', 'pc'];
  const p = buildPartModel(withComments);
  assert.match(p.locked, /own comments/);
  p.method = '';
  assert.deepEqual(partitionAlter(p, T), []);
  const uneven = structuredClone(namedSubMeta);
  uneven.partitions[1].subNames = ['s2'];
  uneven.partitions[1].subComments = [''];
  assert.match(buildPartModel(uneven).locked, /different numbers/);
});

// ---------------------------------------------------------------- partition and subpartition options
// The model reads options from SHOW CREATE TABLE as MySQL 8.4 and MariaDB 11.4 print it (fixtures/partitions).

const fixture = (server, table) => readFileSync(new URL(`./fixtures/partitions/${server}/${table}.sql`, import.meta.url), 'utf8');
const fullOptsMeta = {
  method: 'RANGE', expression: '`y`', subMethod: 'HASH', subExpression: '`id`',
  partitions: [
    { name: 'p0', description: '2000', comment: '', subNames: ['s0', 's1'], subComments: ['first half', "it's second"] },
    { name: 'p1', description: 'MAXVALUE', comment: '', subNames: ['s2', 's3'], subComments: ['', ''] },
  ],
};
const rangeAB = { method: 'RANGE', expression: '`id`', partitions: [{ name: 'a', description: '10', comment: 'x' }, { name: 'b', description: 'MAXVALUE', comment: '' }] };

for (const server of ['mysql', 'mariadb']) {
  test(`${server}: subpartition options are read, kept unchanged and written back`, () => {
    const p = buildPartModel(fullOptsMeta, { create: fixture(server, 'full_opts'), engine: 'InnoDB' });
    assert.equal(p.locked, null); // subpartition comments are modelled now
    assert.equal(p.sub.named, true);
    const [p0, p1] = p.parts;
    // Shared by both subpartitions of p0: MIN_ROWS 10 becomes the partition's; the rest stays on each.
    assert.deepEqual([p0.comment, p0.opts.minRows, p0.opts.maxRows], ['', '10', '']);
    assert.deepEqual(p0.subs.map(s => [s.name, s.comment, s.opts.maxRows, s.opts.dataDir]), [['s0', 'first half', '500', '/tmp/pdata'], ['s1', "it's second", '1000', '']]);
    assert.equal(p1.opts.dataDir, '/tmp/pdata'); // MySQL's trailing slash is dropped
    assert.equal(p1.subs[1].opts.minRows, '5');
    assert.equal(partChanged(p), false);
    assert.equal(partitionClause(p).split('\n').slice(2).join('\n'),
      "\tPARTITION `p0` VALUES LESS THAN (2000) MIN_ROWS = 10 (SUBPARTITION `s0` COMMENT = 'first half' DATA DIRECTORY = '/tmp/pdata' MAX_ROWS = 500, SUBPARTITION `s1` COMMENT = 'it\\'s second' MAX_ROWS = 1000),\n" +
      "\tPARTITION `p1` VALUES LESS THAN MAXVALUE DATA DIRECTORY = '/tmp/pdata' (SUBPARTITION `s2`, SUBPARTITION `s3` MIN_ROWS = 5)\n)");
  });

  test(`${server}: plain partition options and HASH partitions with names of their own`, () => {
    const p = buildPartModel(rangeAB, { create: fixture(server, 'plain_opts'), engine: 'InnoDB' });
    assert.deepEqual([p.parts[0].comment, p.parts[0].opts.maxRows, p.parts[1].opts.dataDir], ['x', '7', '/tmp/pdata']);
    assert.equal(partChanged(p), false);
    // Changing an option rebuilds only that partition.
    p.parts[0].opts.maxRows = '70';
    p.parts[1].opts.dataDir = '';
    assert.deepEqual(partitionAlter(p, T), [
      `ALTER TABLE ${T} REORGANIZE PARTITION \`a\` INTO (\n\tPARTITION \`a\` VALUES LESS THAN (10) COMMENT = 'x' MAX_ROWS = 70\n)`,
      `ALTER TABLE ${T} REORGANIZE PARTITION \`b\` INTO (\n\tPARTITION \`b\` VALUES LESS THAN MAXVALUE\n)`,
    ]);
    // An existing partition's values changed: the partitioning is redefined.
    p.parts[1].values = '15';
    assert.equal(partitionAlter(p, T).length, 1);
    assert.match(partitionAlter(p, T)[0], /^ALTER TABLE `shop`.`sales`\nPARTITION BY RANGE/);

    const hashMeta = { method: 'HASH', expression: '`id`', partitions: [{ name: 'h0' }, { name: 'h1' }] };
    assert.match(buildPartModel(hashMeta, { create: fixture(server, 'hash_named') }).locked, /names or options of their own/);
    const plainHash = { method: 'HASH', expression: '`id`', partitions: [{ name: 'p0' }, { name: 'p1' }, { name: 'p2' }] };
    assert.equal(buildPartModel(plainHash, { create: fixture(server, 'hash_auto') }).locked, null);
  });

  test(`${server}: changed options plus a new partition: REORGANIZE, then ADD`, () => {
    const p = buildPartModel({ ...rangeAB, partitions: [rangeAB.partitions[0], { name: 'b', description: '20' }] },
      { create: fixture(server, 'plain_opts').replace('MAXVALUE', '(20)'), engine: 'InnoDB' });
    p.parts[0].comment = 'y';
    p.parts.push({ name: 'c', values: '30', comment: '', opts: { dataDir: '', indexDir: '', maxRows: '3', minRows: '', tablespace: '' }, subs: [], isNew: true });
    assert.deepEqual(partitionAlter(p, T), [
      `ALTER TABLE ${T} REORGANIZE PARTITION \`a\` INTO (\n\tPARTITION \`a\` VALUES LESS THAN (10) COMMENT = 'y' MAX_ROWS = 7\n)`,
      `ALTER TABLE ${T} ADD PARTITION (\n\tPARTITION \`c\` VALUES LESS THAN (30) MAX_ROWS = 3\n)`,
    ]);
  });

  test(`${server}: server-named subpartitions keep options on the partition`, () => {
    const meta = { method: 'LIST', expression: '`y`', subMethod: 'KEY', subExpression: '`id`',
      partitions: [{ name: 'p0', description: '1,2', subNames: ['p0sp0', 'p0sp1'], subComments: ['', ''] }, { name: 'p1', description: '3', subNames: ['p1sp0', 'p1sp1'], subComments: ['', ''] }] };
    const p = buildPartModel(meta, { create: fixture(server, 'autosub'), engine: 'InnoDB' });
    assert.equal(p.sub.named, false);
    p.parts[0].comment = 'auto subs';
    assert.deepEqual(partitionAlter(p, T), [`ALTER TABLE ${T} REORGANIZE PARTITION \`p0\` INTO (\n\tPARTITION \`p0\` VALUES IN (1,2) COMMENT = 'auto subs'\n)`]);
  });
}

test('option problems: whole numbers for rows, INDEX DIRECTORY only for MyISAM / Aria', () => {
  const p = buildPartModel(rangeAB, { create: fixture('mysql', 'plain_opts'), engine: 'InnoDB' });
  p.parts[0].opts.maxRows = 'lots';
  p.parts[1].opts.indexDir = '/idx';
  assert.deepEqual(partitionProblems(p), [
    'Partition a: Max rows must be a whole number.',
    'Partition b: INDEX DIRECTORY only works for MyISAM and Aria tables; InnoDB refuses it.',
  ]);
  p.parts[0].opts.maxRows = '';
  assert.deepEqual(partitionProblems(p, 'MyISAM'), []);
  const mys = buildPartModel(rangeAB, { create: fixture('mariadb', 'mys'), engine: 'MyISAM' });
  assert.equal(partitionClause(mys).split('\n')[1], "\tPARTITION `a` VALUES LESS THAN (10) DATA DIRECTORY = '/tmp/pdata' INDEX DIRECTORY = '/tmp/pdata',");
  const ts = buildPartModel(rangeAB, { create: fixture('mysql', 'ts'), engine: 'InnoDB' });
  assert.match(partitionClause(ts), /PARTITION `a` VALUES LESS THAN \(10\) TABLESPACE = `innodb_file_per_table`/);
  // A clause that can't be read keeps the editor locked rather than losing options.
  assert.match(buildPartModel(rangeAB, { create: 'CREATE TABLE t (id INT) PARTITION BY RANGE (id) (PARTITION a VALUES LESS THAN (10) WEIRD, PARTITION b)' }).locked, /could not be read/);
});

// ---------------------------------------------------------------- user manager

const appUser = {
  user: 'app', host: '%', plugin: 'caching_sha2_password', locked: false, passwordExpired: false,
  limits: { maxQueries: 0, maxUpdates: 0, maxConnections: 0, maxUserConnections: 0 },
  grants: [
    { level: 'global', privs: ['BACKUP_ADMIN'], all: false, grantOption: false },
    { level: 'db', db: 'shop', privs: ['SELECT', 'INSERT'], all: false, grantOption: false },
    { level: 'column', db: 'shop', table: 'customers', column: 'email', privs: ['UPDATE'], all: false, grantOption: false },
    { level: 'routine', db: 'shop', table: 'top', routineType: 'PROCEDURE', privs: ['EXECUTE'], all: false, grantOption: false },
    { level: 'db', db: 'other', privs: ['SELECT'], all: false, grantOption: true },
  ],
  roles: ['`reader`@`%`'], other: [],
};

test('an unchanged account produces no statements (also for ALL PRIVILEGES)', () => {
  assert.deepEqual(users.genSql(users.toModel(appUser), ''), []);
  const root = { ...appUser, user: 'root', grants: [{ level: 'global', privs: [], all: true, grantOption: true }], roles: [] };
  assert.deepEqual(users.genSql(users.toModel(root), ''), []);
});

test('edits become minimal statements with the password as a placeholder', () => {
  const m = users.toModel(appUser);
  m.user = 'app2';
  m.host = 'localhost';
  m.limits.maxQueries = 500;
  const shop = m.grants.find(g => g.db === 'shop' && g.level === 'db');
  shop.privs.delete('INSERT');
  shop.privs.add('DELETE');
  m.grants = m.grants.filter(g => g.level !== 'column');
  m.grants.find(g => g.db === 'other').grantOption = false;
  m.roles = [];
  assert.deepEqual(users.genSql(m, 'secret'), [
    "RENAME USER 'app'@'%' TO 'app2'@'localhost'",
    "ALTER USER 'app2'@'localhost' IDENTIFIED BY {{PASSWORD}}",
    "ALTER USER 'app2'@'localhost' WITH MAX_QUERIES_PER_HOUR 500",
    "REVOKE INSERT ON `shop`.* FROM 'app2'@'localhost'",
    "GRANT DELETE ON `shop`.* TO 'app2'@'localhost'",
    "REVOKE UPDATE (`email`) ON `shop`.`customers` FROM 'app2'@'localhost'",
    "REVOKE GRANT OPTION ON `other`.* FROM 'app2'@'localhost'",
    "REVOKE `reader`@`%` FROM 'app2'@'localhost'",
  ]);
});

test('new and cloned accounts', () => {
  const n = users.newModel();
  n.user = "o'brien";
  n.grants[0].privs.add('SELECT');
  assert.deepEqual(users.genSql(n, 'pw'), ["CREATE USER 'o\\'brien'@'%' IDENTIFIED BY {{PASSWORD}}", "GRANT SELECT ON *.* TO 'o\\'brien'@'%'"]);
  const c = users.newModel(users.toModel(appUser));
  const sql = users.genSql(c, '');
  assert.equal(sql[0], "CREATE USER 'app_copy'@'%'");
  assert.ok(sql.includes("GRANT SELECT ON `other`.* TO 'app_copy'@'%' WITH GRANT OPTION"));
  assert.ok(sql.includes("GRANT `reader`@`%` TO 'app_copy'@'%'"));
});

// ---------------------------------------------------------------- grid export

const cols = [{ name: 'id', kind: 'int' }, { name: 'txt', kind: 'text' }, { name: 'bin', kind: 'binary' }];
const rows = [['1', 'a,"b"', '0x01'], ['2', null, null]];

test('grid rows export to CSV, TSV, SQL, JSON, Markdown and HTML', () => {
  assert.equal(exportRows('csv', cols, rows), 'id,txt,bin\r\n1,"a,""b""",0x01\r\n2,,');
  assert.equal(exportRows('tsv', cols, rows), 'id\ttxt\tbin\n1\ta,"b"\t0x01\n2\t\\N\t\\N');
  assert.equal(exportRows('sql', cols, rows, { table: 't' }),
    "INSERT INTO `t` (`id`, `txt`, `bin`) VALUES (1, 'a,\"b\"', 0x01);\nINSERT INTO `t` (`id`, `txt`, `bin`) VALUES (2, NULL, NULL);");
  assert.deepEqual(JSON.parse(exportRows('json', cols, rows)), [{ id: 1, txt: 'a,"b"', bin: '0x01' }, { id: 2, txt: null, bin: null }]);
  assert.match(exportRows('md', cols, rows), /^\| id \| txt \| bin \|\n\| --- \| --- \| --- \|/);
  assert.match(exportRows('html', cols, rows), /<td>a,&quot;b&quot;<\/td>/);
  assert.equal(rowsToSql('t', cols, [["5", "it's", ''], ]), "INSERT INTO `t` (`id`, `txt`, `bin`) VALUES (5, 'it\\'s', '');");
});
