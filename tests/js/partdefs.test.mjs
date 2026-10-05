import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePartitionDefs, partitionClauseOf, splitInherited, emptyOptions, normDir, hasOptions } from '../../src/ZawSQL/wwwroot/js/partdefs.js';

// SHOW CREATE TABLE output of MySQL 8.4 and MariaDB 11.4 for the same tables (fixtures/partitions).
const read = (server, table) => readFileSync(new URL(`./fixtures/partitions/${server}/${table}.sql`, import.meta.url), 'utf8');
const opts = o => ({ ...emptyOptions(), ...o });

for (const server of ['mysql', 'mariadb']) {
  test(`${server}: named subpartitions with options`, () => {
    const d = parsePartitionDefs(read(server, 'full_opts'));
    assert.equal(d.subpartitionsAuto, false);
    assert.deepEqual(d.partitions.map(p => p.name), ['p0', 'p1']);
    const [p0, p1] = d.partitions;
    assert.deepEqual(p0.opts, emptyOptions()); // the server keeps options on the subpartitions
    assert.deepEqual(p0.subs.map(s => s.name), ['s0', 's1']);
    assert.deepEqual(p0.subs[0].opts, opts({ comment: 'first half', dataDir: '/tmp/pdata', maxRows: '500', minRows: '10' }));
    assert.deepEqual(p0.subs[1].opts, opts({ comment: "it's second", maxRows: '1000', minRows: '10' }));
    assert.equal(p0.subs[0].engine, 'InnoDB');
    assert.deepEqual(p1.subs[1].opts, opts({ dataDir: '/tmp/pdata', minRows: '5' }));
  });

  test(`${server}: plain partitions, HASH, server-named subpartitions`, () => {
    const plain = parsePartitionDefs(read(server, 'plain_opts')).partitions;
    assert.deepEqual(plain[0].opts, opts({ comment: 'x', maxRows: '7' }));
    assert.deepEqual(plain[1].opts, opts({ dataDir: '/tmp/pdata' }));
    assert.equal(plain[1].engine, 'InnoDB');
    assert.equal(parsePartitionDefs(read(server, 'hash_auto')), null); // PARTITIONS n: no list
    assert.deepEqual(parsePartitionDefs(read(server, 'hash_named')).partitions.map(p => [p.name, p.opts.comment]), [['h0', 'zero'], ['h1', '']]);
    const auto = parsePartitionDefs(read(server, 'autosub'));
    assert.equal(auto.subpartitionsAuto, true);
    assert.deepEqual(auto.partitions.map(p => p.subs.length), [0, 0]);
  });
}

test('per-partition tablespace (MySQL) and index directory (MariaDB MyISAM)', () => {
  assert.equal(parsePartitionDefs(read('mysql', 'ts')).partitions[0].opts.tablespace, 'innodb_file_per_table');
  const mys = parsePartitionDefs(read('mariadb', 'mys')).partitions[0];
  assert.deepEqual(mys.opts, opts({ dataDir: '/tmp/pdata', indexDir: '/tmp/pdata' }));
  assert.equal(mys.engine, 'MyISAM');
});

test('the clause is found only at the top level', () => {
  assert.equal(partitionClauseOf("CREATE TABLE t (a INT COMMENT 'PARTITION BY x') COMMENT='PARTITION BY y'"), null);
  assert.match(partitionClauseOf(read('mysql', 'plain_opts')), /^PARTITION BY RANGE \(`id`\)\n\(PARTITION a/);
  assert.equal(parsePartitionDefs('CREATE TABLE t (a INT)'), null);
  assert.throws(() => parsePartitionDefs('CREATE TABLE t (a INT) PARTITION BY RANGE (a) (PARTITION p0 VALUES LESS THAN (1) BOGUS, PARTITION p1)'));
});

test('options shared by all subpartitions become the partition\'s', () => {
  const { common, own } = splitInherited(opts({ comment: 'pc' }), [
    { opts: opts({ dataDir: '/d', maxRows: '5' }) },
    { opts: opts({ dataDir: '/d', comment: 'mine' }) },
  ]);
  assert.deepEqual(common, opts({ dataDir: '/d' }));
  assert.deepEqual(own, [opts({ comment: 'pc', maxRows: '5' }), opts({ comment: 'mine' })]);
  assert.equal(normDir('/tmp/pdata/'), '/tmp/pdata');
  assert.equal(normDir('/'), '/');
  assert.equal(hasOptions(emptyOptions()), false);
  assert.equal(hasOptions(opts({ minRows: '1' })), true);
});
