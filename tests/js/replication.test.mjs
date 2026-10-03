import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadState, lagState, channelHealth, roleSummary, gtidParts, advice, pushLag, LAG_HISTORY_MS } from '../../src/ZawSQL/wwwroot/js/replicationlogic.js';

const ch = extra => ({ channel: '', sourceHost: 'db1', sourcePort: 3306, ioRunning: 'Yes', sqlRunning: 'Yes', lagSeconds: 0, sqlDelay: 0, sqlError: null, ioError: null, ...extra });
const status = extra => ({
  server: 'mysql', role: 'standalone', channels: [], connected: [], registered: [],
  identity: { readOnly: false, logBin: true, binlogFormat: 'ROW', syncBinlog: 1 }, gtid: { mode: 'ON' }, ...extra,
});

test('thread states and lag', () => {
  assert.deepEqual(threadState('Yes'), { label: 'Running', severity: 'good' });
  assert.equal(threadState('Connecting').severity, 'warning');
  assert.equal(threadState('No').label, 'Stopped');
  assert.deepEqual(lagState(ch({ lagSeconds: 0 })), { label: 'In sync', severity: 'good' });
  assert.equal(lagState(ch({ lagSeconds: 30 })).severity, 'warning');
  assert.equal(lagState(ch({ lagSeconds: 30 })).label, '30 s behind');
  assert.equal(lagState(ch({ lagSeconds: 600 })).severity, 'critical');
  assert.deepEqual(lagState(ch({ lagSeconds: 3600, sqlDelay: 3600 })), { label: 'Delayed by design (1 h 0 min)', severity: 'good' });
  assert.equal(lagState(ch({ lagSeconds: null, sqlRunning: 'No' })).label, 'Unknown – applier stopped');
  assert.equal(lagState(ch({ lagSeconds: null, ioRunning: 'No' })).label, 'Unknown – not receiving events');
});

test('channel health: errors first, then stopped threads, then lag', () => {
  assert.deepEqual(channelHealth(ch({ sqlRunning: 'No', sqlError: { number: 1062 } })), { label: 'Stopped by an error (1062)', severity: 'critical' });
  assert.equal(channelHealth(ch({ ioRunning: 'Connecting', ioError: { number: 2003 } })).label, "Can't reach the source (2003)");
  assert.equal(channelHealth(ch({ ioRunning: 'No', sqlRunning: 'No', lagSeconds: null })).label, 'Stopped');
  assert.equal(channelHealth(ch({ ioRunning: 'Connecting' })).severity, 'warning');
  assert.equal(channelHealth(ch({ lagSeconds: 2 })).label, '2 s behind');
});

test('role summary and GTID sets', () => {
  assert.equal(roleSummary(status({ role: 'replica', channels: [ch()] })), 'Replica of db1');
  assert.equal(roleSummary(status({ role: 'replica', channels: [ch(), ch({ channel: 'eu', sourceHost: 'db2', sourcePort: 3307 })] })), 'Replica of 2 sources');
  assert.equal(roleSummary(status({ role: 'primary', connected: [{}], registered: [{}, {}] })), 'Primary with 2 replicas');
  assert.equal(roleSummary(status({ role: 'both', channels: [ch()], connected: [{}] })), 'Replica of db1, and primary for 1 replica');
  assert.equal(roleSummary(status()), 'Not replicating – binary log on, no replicas connected');
  assert.deepEqual(gtidParts('a:1-5,\nb:1-9'), ['a:1-5', 'b:1-9']);
  assert.deepEqual(gtidParts(null), []);
});

test('configuration advice', () => {
  assert.match(advice(status({ role: 'replica', channels: [ch()] }))[0].text, /accepts writes/);
  assert.deepEqual(advice(status({ role: 'replica', channels: [ch()], identity: { readOnly: true, logBin: true, binlogFormat: 'ROW' } })), []);
  const primary = advice(status({ role: 'primary', connected: [{}], identity: { readOnly: false, logBin: true, binlogFormat: 'MIXED', syncBinlog: 0 }, gtid: { mode: 'OFF' } }));
  assert.deepEqual(primary.map(a => a.text.slice(0, 18)), ['binlog_format is M', 'sync_binlog = 0: a', 'GTIDs are OFF: wit']);
  assert.match(advice(status({ server: 'mariadb', role: 'replica', channels: [ch({ usingGtid: 'No' })], identity: { readOnly: true, logBin: false } }))[0].text, /MASTER_USE_GTID/);
});

test('lag history per channel keeps 15 minutes', () => {
  const h = new Map();
  pushLag(h, 0, [ch({ lagSeconds: 1 }), ch({ channel: 'eu', lagSeconds: 7 })]);
  pushLag(h, 1000, [ch({ lagSeconds: 2 })]); // channel "eu" was removed
  assert.deepEqual([...h.keys()], ['']);
  assert.deepEqual(h.get('').map(p => p.values.lag), [1, 2]);
  pushLag(h, LAG_HISTORY_MS + 5000, [ch({ lagSeconds: 3 })]);
  assert.deepEqual(h.get('').map(p => p.values.lag), [3]);
});
