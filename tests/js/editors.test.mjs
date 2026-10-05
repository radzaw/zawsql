import { test } from 'node:test';
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

test('named subpartitions: names per partition, validation, appending with names', () => {
  const p = buildPartModel(namedSubMeta);
  assert.equal(p.locked, null);
  assert.equal(p.sub.named, true);
  assert.deepEqual(p.parts.map(x => x.subs), ['s0, s1', 's2, s3']);
  assert.equal(partChanged(p), false);
  assert.equal(partitionClause(p), "PARTITION BY LIST (`y`)\nSUBPARTITION BY KEY (`id`) (\n\tPARTITION `p0` VALUES IN (1,2) COMMENT = 'pc' (SUBPARTITION `s0`, SUBPARTITION `s1`),\n\tPARTITION `p1` VALUES IN (3) (SUBPARTITION `s2`, SUBPARTITION `s3`)\n)");

  p.parts.push({ name: 'p2', values: '4', comment: '', subs: 's4, s5', isNew: true });
  assert.deepEqual(partitionAlter(p, T), [`ALTER TABLE ${T} ADD PARTITION (\n\tPARTITION \`p2\` VALUES IN (4) (SUBPARTITION \`s4\`, SUBPARTITION \`s5\`)\n)`]);

  // What the server would refuse is caught before saving.
  p.parts[2].subs = 's4';
  assert.deepEqual(partitionProblems(p), ['Every partition needs the same number of subpartitions.']);
  p.parts[2].subs = 's0, s5';
  assert.deepEqual(partitionProblems(p), ['The name s0 is used twice; partition and subpartition names must all differ.']);
  p.parts[2].subs = 'p1, s5';
  assert.match(partitionProblems(p)[0], /The name p1 is used twice/);
  p.parts[2].subs = '';
  assert.deepEqual(partitionProblems(p), ['Name the subpartitions of every partition (p2 has none).']);
  p.parts[2].subs = 's4, s5';
  p.sub.expr = '';
  assert.deepEqual(partitionProblems(p), ['Subpartitioning by KEY needs one or more columns.']);
});

test('renaming subpartitions redefines; names the server would give are the same as no names', () => {
  const p = buildPartModel(namedSubMeta);
  p.parts[1].subs = 's2, s9';
  assert.match(partitionAlter(p, T)[0], /^ALTER TABLE `shop`.`sales`\nPARTITION BY LIST \(`y`\)\nSUBPARTITION BY KEY \(`id`\) \(\n.*\(SUBPARTITION `s2`, SUBPARTITION `s9`\)/s);

  // Naming them p0sp0, p0sp1 … by hand changes nothing.
  const q = buildPartModel(autoSubMeta);
  q.sub.named = true;
  q.parts.forEach(x => { x.subs = `${x.name}sp0, ${x.name}sp1`; });
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

test('subpartitions the editor cannot model keep the table locked', () => {
  // Subpartitions with comments of their own would be lost by a redefinition.
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
