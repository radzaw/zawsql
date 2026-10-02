import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushSample, rate, totalQps, CHARTS, chartPoints, summarize, kpis, niceScale, formatValue, formatUptime,
  utilizationStatus, OWN, MAX_HISTORY_MS,
} from '../../src/ZawSQL/wwwroot/js/views/monitor-metrics.js';

const sample = (t, status, variables = {}) => ({ t, status: { Uptime: 100 + t / 1000, ...status }, variables });

test('rates are per second, null when unknown, and never negative', () => {
  const a = { t: 0, s: { Questions: 100 } }, b = { t: 2000, s: { Questions: 160 } };
  assert.equal(rate(a, b, 'Questions'), 30);
  assert.equal(rate(a, b, 'Questions', 6), 27);
  assert.equal(rate(a, b, 'Missing'), null);
  assert.equal(rate(b, a, 'Questions'), null); // went backwards
  assert.equal(rate(a, { t: 0, s: { Questions: 200 } }, 'Questions'), null); // dt = 0
});

test("the monitor's own statements are not counted as load", () => {
  const own = OWN.select + OWN.other;
  const a = { t: 0, s: { Questions: 1000, Com_select: 500, Com_insert: 0, Com_replace: 0, Com_update: 0, Com_delete: 0 } };
  const b = { t: 1000, s: { Questions: 1000 + own, Com_select: 500 + OWN.select, Com_insert: 0, Com_replace: 0, Com_update: 0, Com_delete: 0 } };
  assert.equal(totalQps(a, b), 0);
  const qps = CHARTS.find(c => c.id === 'queries');
  for (const s of qps.series) assert.equal(s.value(a, b), 0, s.key);
});

test('history restarts when counters reset and keeps 15 minutes', () => {
  const h = [];
  assert.equal(pushSample(h, sample(0, { Questions: 10 })), false);
  pushSample(h, sample(1000, { Questions: 20 }));
  assert.equal(pushSample(h, { t: 2000, status: { Uptime: 1, Questions: 1 }, variables: {} }), true); // restart
  assert.equal(h.length, 1);
  for (let t = 3000; t < MAX_HISTORY_MS + 60_000; t += 10_000) pushSample(h, sample(t, {}));
  assert.ok(h[h.length - 1].t - h[0].t <= MAX_HISTORY_MS);
});

test('chart points, summaries and KPIs', () => {
  const h = [];
  pushSample(h, sample(0, { Threads_connected: 4, Threads_running: 1, Innodb_buffer_pool_read_requests: 1000, Innodb_buffer_pool_reads: 10, Innodb_buffer_pool_pages_total: 100, Innodb_buffer_pool_pages_free: 25 }, { max_connections: '10', innodb_buffer_pool_size: '134217728' }));
  pushSample(h, sample(1000, { Threads_connected: 8, Threads_running: 3, Innodb_buffer_pool_read_requests: 2000, Innodb_buffer_pool_reads: 20, Innodb_buffer_pool_pages_total: 100, Innodb_buffer_pool_pages_free: 20 }, { max_connections: '10', innodb_buffer_pool_size: '134217728' }));
  const pts = chartPoints(h, CHARTS.find(c => c.id === 'connections'));
  assert.deepEqual(pts.map(p => p.values), [{ connected: 8, running: 3 }]);
  assert.deepEqual(summarize(pts, 'connected'), { current: 8, avg: 8, peak: 8 });
  const k = kpis(h);
  assert.equal(k.connectionUse, 0.8);
  assert.equal(k.hitRatio, 1 - 10 / 1000);
  assert.equal(k.bufferPoolUse, 0.8);
  assert.deepEqual(utilizationStatus(k.connectionUse), { level: 'warning', label: 'High' });
  assert.equal(utilizationStatus(0.5), null);
  assert.equal(utilizationStatus(0.97).level, 'critical');
});

test('row operations use InnoDB counters when present, else Handler counters (MariaDB)', () => {
  const rows = CHARTS.find(c => c.id === 'rows');
  const read = rows.series.find(s => s.key === 'read');
  const mysqlA = { t: 0, s: { Innodb_rows_read: 100, Handler_read_key: 0 } }, mysqlB = { t: 1000, s: { Innodb_rows_read: 150, Handler_read_key: 999 } };
  assert.equal(read.value(mysqlA, mysqlB), 50);
  const mariaA = { t: 0, s: { Handler_read_key: 10, Handler_read_rnd_next: 100 } }, mariaB = { t: 2000, s: { Handler_read_key: 30, Handler_read_rnd_next: 140 } };
  assert.equal(read.value(mariaA, mariaB), 30); // (20 + 40) / 2 s
});

test('axis scales are clean and cover the data', () => {
  assert.deepEqual(niceScale(0, 'rate').ticks, [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(niceScale(37, 'rate'), { max: 40, ticks: [0, 10, 20, 30, 40] });
  assert.deepEqual(niceScale(0.6, 'rate').ticks, [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(niceScale(3, 'int').ticks, [0, 1, 2, 3, 4]);
  assert.deepEqual(niceScale(181, 'int').ticks, [0, 50, 100, 150, 200]);
  assert.deepEqual(niceScale(5000, 'bytes').ticks, [0, 2048, 4096, 6144, 8192]); // 0, 2, 4, 6, 8 KiB/s
  assert.deepEqual(niceScale(3_000_000, 'bytes').ticks.map(t => t / 1048576), [0, 1, 2, 3, 4]);
});

test('values are formatted compactly per unit', () => {
  assert.equal(formatValue(null, 'rate'), '–');
  assert.equal(formatValue(3.14159, 'rate'), '3.14');
  assert.equal(formatValue(42.5, 'rate'), '42.5');
  assert.equal(formatValue(12345, 'rate'), '12.3K');
  assert.equal(formatValue(2048, 'bytes'), '2.0 KiB/s');
  assert.equal(formatValue(512, 'bytes'), '512 B/s');
  assert.equal(formatValue(0.991, 'percent'), '99.1%');
  assert.equal(formatValue(1234.4, 'int'), '1,234');
  assert.equal(formatUptime(93784), '1d 2h');
  assert.equal(formatUptime(125), '2m 5s');
});
