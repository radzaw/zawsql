import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInterval, scheduleText, nextRun, fmtDt, fromNow } from '../../src/ZawSQL/wwwroot/js/eventlogic.js';

const ev = o => ({ status: 'ENABLED', type: 'RECURRING', timeZone: 'SYSTEM', nowThere: '2026-10-23 12:00:00', ...o });
const next = o => { const n = nextRun(ev(o)); return n.at != null ? fmtDt(n.at) : n.note; };

test('events: intervals', () => {
  assert.deepEqual(parseInterval('2', 'HOUR'), { months: 0, seconds: 7200, parts: [[2, 'HOUR']] });
  assert.deepEqual(parseInterval('1', 'QUARTER').months, 3);
  assert.equal(parseInterval('1 12', 'DAY_HOUR').seconds, 86400 + 12 * 3600);
  assert.equal(parseInterval('1:30', 'HOUR_MINUTE').seconds, 5400);
  assert.equal(parseInterval('30', 'HOUR_MINUTE').seconds, 1800); // filled from the right
  assert.equal(parseInterval("'1 2:03:04'", 'DAY_SECOND').seconds, 86400 + 7200 + 184);
  assert.equal(parseInterval('1 6', 'YEAR_MONTH').months, 18);
  assert.equal(parseInterval('5', 'MINUTE_MICROSECOND'), null);
});

test('events: schedule in words', () => {
  assert.equal(scheduleText(ev({ intervalValue: '1', intervalField: 'DAY', starts: '2026-01-01 03:00:00' })), 'every 1 day from 2026-01-01 03:00:00');
  assert.equal(scheduleText(ev({ intervalValue: '1 12', intervalField: 'DAY_HOUR', ends: '2027-01-01 00:00:00', timeZone: '+02:00' })), 'every 1 day 12 hours until 2027-01-01 00:00:00 (+02:00)');
  assert.equal(scheduleText(ev({ type: 'ONE TIME', executeAt: '2026-11-01 00:00:00' })), 'once at 2026-11-01 00:00:00');
});

test('events: next run of recurring events', () => {
  assert.equal(next({ intervalValue: '1', intervalField: 'HOUR', starts: '2026-10-01 00:15:00' }), '2026-10-23 12:15:00');
  assert.equal(next({ intervalValue: '1', intervalField: 'DAY', starts: '2026-12-01 03:00:00' }), '2026-12-01 03:00:00'); // not started yet
  assert.equal(next({ intervalValue: '1', intervalField: 'DAY', starts: '2026-10-20 12:00:00' }), '2026-10-24 12:00:00'); // exactly now: the next one
  assert.equal(next({ intervalValue: '1', intervalField: 'MONTH', starts: '2026-01-31 01:00:00' }), '2026-10-31 01:00:00');
  assert.equal(next({ intervalValue: '1', intervalField: 'MONTH', starts: '2026-01-31 13:00:00', nowThere: '2026-11-15 00:00:00' }), '2026-11-30 13:00:00'); // no 31st
  assert.equal(next({ intervalValue: '1', intervalField: 'YEAR', starts: '2020-03-01 00:00:00' }), '2027-03-01 00:00:00');
  assert.equal(next({ intervalValue: '1', intervalField: 'DAY', starts: '2026-10-01 00:00:00', ends: '2026-10-23 06:00:00' }), 'ended');
});

test('events: one-time, disabled and unknown', () => {
  assert.equal(next({ type: 'ONE TIME', executeAt: '2026-10-23 18:00:00' }), '2026-10-23 18:00:00');
  assert.equal(next({ type: 'ONE TIME', executeAt: '2026-10-22 18:00:00' }), 'already ran');
  assert.equal(next({ status: 'DISABLED', intervalValue: '1', intervalField: 'DAY' }), 'disabled');
  assert.equal(next({ status: 'SLAVESIDE_DISABLED', intervalValue: '1', intervalField: 'DAY' }), 'disabled on this replica');
  assert.equal(next({ intervalValue: '1', intervalField: 'SECOND_MICROSECOND' }), 'unknown interval');
});

test('events: relative time', () => {
  const t = Date.UTC(2026, 0, 1);
  assert.equal(fromNow(t + 30e3, t), 'in 30 s');
  assert.equal(fromNow(t + 35 * 60e3, t), 'in 35 min');
  assert.equal(fromNow(t + 5 * 3600e3, t), 'in 5 h');
  assert.equal(fromNow(t + 4 * 86400e3, t), 'in 4 days');
});
