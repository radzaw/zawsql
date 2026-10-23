import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterLog, countByPrio, parseInnodbStatus, innodbFacts } from '../../src/ZawSQL/wwwroot/js/serverlogslogic.js';

const log = [
  { logged: '2026-10-23 11:58:00.123456', prio: 'Error', code: 'MY-010584', subsystem: 'Repl', data: 'Replica I/O: error connecting to source' },
  { logged: '2026-10-23 10:00:00.000000', prio: 'Warning', code: 'MY-010068', subsystem: 'Server', data: 'CA certificate is self signed.' },
  { logged: '2026-10-20 09:00:00.000000', prio: 'System', code: 'MY-010931', subsystem: 'Server', data: 'ready for connections' },
  { logged: '2026-10-20 08:59:00.000000', prio: 'Note', code: 'MY-010747', subsystem: 'Server', data: 'Plugin loaded' },
];

test('error log: filters by priority, period and text', () => {
  const now = '2026-10-23 12:00:00.000000';
  assert.deepEqual(filterLog(log, { now }).map(r => r.prio), ['Error', 'Warning', 'System', 'Note']);
  assert.deepEqual(filterLog(log, { prios: ['Error', 'Warning'], now }).map(r => r.prio), ['Error', 'Warning']);
  assert.deepEqual(filterLog(log, { since: '1h', now }).map(r => r.prio), ['Error']);
  assert.deepEqual(filterLog(log, { since: '24h', now }).length, 2);
  assert.deepEqual(filterLog(log, { text: 'repl', now }).map(r => r.code), ['MY-010584']);
  assert.deepEqual(filterLog(log, { text: 'MY-010747', now }).map(r => r.prio), ['Note']);
  assert.deepEqual(countByPrio(log), { System: 1, Error: 1, Warning: 1, Note: 1 });
});

const STATUS = `
=====================================
2026-10-23 12:00:00 128334232122944 INNODB MONITOR OUTPUT
=====================================
Per second averages calculated from the last 17 seconds
-----------------
BACKGROUND THREAD
-----------------
srv_master_thread loops: 10 srv_active, 0 srv_shutdown, 900 srv_idle
----------
SEMAPHORES
----------
OS WAIT ARRAY INFO: reservation count 1234
--Thread 140 has waited at buf0buf.cc line 1 for 3.00 seconds the semaphore:
--Thread 141 has waited at buf0buf.cc line 1 for 12.00 seconds the semaphore:
------------------------
LATEST DETECTED DEADLOCK
------------------------
2026-10-23 11:00:00 0x7f2c
*** (1) TRANSACTION:
------------
TRANSACTIONS
------------
Trx id counter 99999
Purge done for trx's n:o < 99000 undo n:o < 0 state: running but idle
History list length 250000
LIST OF TRANSACTIONS FOR EACH SESSION:
---TRANSACTION 421, not started
0 lock struct(s), heap size 1128, 0 row lock(s)
---TRANSACTION 99998, ACTIVE 700 sec starting index read
LOCK WAIT 2 lock struct(s), heap size 1128, 1 row lock(s)
---TRANSACTION 99997, ACTIVE 5 sec
--------
FILE I/O
--------
Pending normal aio reads: [0, 0, 0, 0] , aio writes: [0, 0, 0, 0] ,
Pending flushes (fsync) log: 0; buffer pool: 0
0.00 reads/s, 0 avg bytes/read, 12.50 writes/s, 1.25 fsyncs/s
---
LOG
---
Log sequence number          104857600
Log flushed up to            104857600
Last checkpoint at           100000000
----------------------
BUFFER POOL AND MEMORY
----------------------
Buffer pool size   8192
Free buffers       1000
Database pages     7000
Modified db pages  700
Buffer pool hit rate 900 / 1000, young-making rate 0 / 1000 not 0 / 1000
--------------
ROW OPERATIONS
--------------
0 queries inside InnoDB, 2 queries in queue
1 read views open inside InnoDB
0.00 inserts/s, 1.00 updates/s, 0.00 deletes/s, 2500.50 reads/s
----------------------------
END OF INNODB MONITOR OUTPUT
============================
`;

test('innodb status: sections', () => {
  const p = parseInnodbStatus(STATUS);
  assert.equal(p.created, '2026-10-23 12:00:00');
  assert.equal(p.seconds, 17);
  assert.deepEqual(p.sections.map(s => s.title), ['BACKGROUND THREAD', 'SEMAPHORES', 'LATEST DETECTED DEADLOCK', 'TRANSACTIONS', 'FILE I/O', 'LOG', 'BUFFER POOL AND MEMORY', 'ROW OPERATIONS']);
  assert.match(p.sections[3].text, /^Trx id counter 99999\n/);
  assert.match(p.sections[3].text, /---TRANSACTION 99997, ACTIVE 5 sec$/);
  assert.deepEqual(parseInnodbStatus('').sections, []);
});

test('innodb status: figures and findings', () => {
  const { tiles, facts, findings } = innodbFacts(parseInnodbStatus(STATUS));
  const tile = l => tiles.find(t => t.label === l)?.value;
  assert.equal(tile('History list'), '250,000');
  assert.equal(tile('Active transactions'), '2');
  assert.equal(tile('Checkpoint age'), '4.6 MiB');
  assert.equal(tile('Buffer pool hit rate'), '90.0%');
  assert.equal(tile('Rows read / s'), '2,501');
  assert.deepEqual(Object.fromEntries(facts.TRANSACTIONS), { 'History list length': '250,000', 'Active transactions': '2 (oldest 700 s)', 'Waiting for a lock': '1' });
  assert.deepEqual(Object.fromEntries(facts['BUFFER POOL AND MEMORY'])['Modified (dirty)'], '700 pages (10%)');
  assert.deepEqual(Object.fromEntries(facts['FILE I/O'])['Writes / s'], '12.5');
  assert.deepEqual(findings.map(f => f.severity + ': ' + f.text), [
    'warning: Purge is behind: 250,000 undo records wait (history list length)',
    'warning: 1 transaction waiting for a row lock',
    'warning: A transaction has been active for 700 s',
    'warning: 2 threads waiting for an internal latch, the longest for 12 s',
    'warning: Buffer pool hit rate is 90.0%',
    'warning: 2 queries wait to enter InnoDB',
    'info: The latest deadlock was detected at 2026-10-23 11:00:00',
  ]);
});

test('innodb status: a quiet server', () => {
  const quiet = STATUS.replace('History list length 250000', 'History list length 3').replace(/^--Thread.*\n/gm, '').replace(/^LOCK WAIT.*\n/m, '')
    .replace('ACTIVE 700 sec', 'ACTIVE 1 sec').replace('900 / 1000', '1000 / 1000').replace('2 queries in queue', '0 queries in queue')
    .replace(/-{24}\nLATEST DETECTED DEADLOCK\n-{24}\n[^]*?(?=-{12}\nTRANSACTIONS)/, '');
  assert.deepEqual(innodbFacts(parseInnodbStatus(quiet)).findings, []);
});
