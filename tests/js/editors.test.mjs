import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPartModel, partitionClause, partitionAlter, partChanged, partitionCount } from '../../src/ZawSQL/wwwroot/js/views/partitions.js';
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

test('subpartitioned tables are locked and never altered', () => {
  const p = buildPartModel({ ...rangeMeta, subMethod: 'HASH' });
  assert.ok(p.locked);
  p.method = '';
  assert.deepEqual(partitionAlter(p, T), []);
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
