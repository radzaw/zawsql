import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtLogTime } from '../../src/ZawSQL/wwwroot/js/util.js';

test('log timestamps: local date, time and milliseconds, zero-padded', () => {
  assert.equal(fmtLogTime(new Date(2026, 9, 5, 14, 3, 21, 457).getTime()), '2026-10-05 14:03:21.457');
  assert.equal(fmtLogTime(new Date(2027, 0, 2, 3, 4, 5, 7).getTime()), '2027-01-02 03:04:05.007');
  assert.equal(fmtLogTime(new Date(2026, 11, 31, 23, 59, 59, 999).getTime()), '2026-12-31 23:59:59.999');
});
