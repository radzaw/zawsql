import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDuration, slowLevel, thresholdLabel, slowThreshold, nextSlow, SLOW_CHOICES, DEFAULT_SLOW_MS } from '../../src/ZawSQL/wwwroot/js/logslow.js';

test('slow markers: durations read naturally from sub-millisecond to hours', () => {
  assert.equal(fmtDuration(0.4), '0.4 ms');
  assert.equal(fmtDuration(0), '0.0 ms');
  assert.equal(fmtDuration(85.4), '85 ms');
  assert.equal(fmtDuration(999.4), '999 ms');
  assert.equal(fmtDuration(1000), '1.00 s');
  assert.equal(fmtDuration(2345), '2.35 s');
  assert.equal(fmtDuration(42_140), '42.1 s');
  assert.equal(fmtDuration(185_000), '3 min 05 s');
  assert.equal(fmtDuration(3_725_000), '1 h 02 min');
  assert.equal(fmtDuration(null), '');
  assert.equal(fmtDuration(-1), '');
});

test('slow markers: at or over the threshold is slow, ten times over is very slow', () => {
  assert.equal(slowLevel(999, 1000), null);
  assert.equal(slowLevel(1000, 1000), 'slow');
  assert.equal(slowLevel(9999, 1000), 'slow');
  assert.equal(slowLevel(10_000, 1000), 'very');
  assert.equal(slowLevel(null, 1000), null); // comments and unmeasured lines
  assert.equal(slowLevel(50_000, 0), null); // markers off
});

test('slow markers: threshold choices, labels and the saved preference', () => {
  assert.equal(SLOW_CHOICES[0], 0);
  assert.ok(SLOW_CHOICES.includes(DEFAULT_SLOW_MS));
  assert.equal(thresholdLabel(0), 'Off');
  assert.equal(thresholdLabel(250), 'Slower than 250 ms');
  assert.equal(thresholdLabel(2000), 'Slower than 2.00 s');
  assert.equal(slowThreshold(undefined), DEFAULT_SLOW_MS);
  assert.equal(slowThreshold('x'), DEFAULT_SLOW_MS);
  assert.equal(slowThreshold(-5), DEFAULT_SLOW_MS);
  assert.equal(slowThreshold(0), 0);
  assert.equal(slowThreshold('500'), 500);
});

test('slow markers: "Next slow statement" steps forward and wraps around', () => {
  const levels = [null, 'slow', null, 'very', null];
  assert.equal(nextSlow(levels, -1), 1);
  assert.equal(nextSlow(levels, 1), 3);
  assert.equal(nextSlow(levels, 3), 1);
  assert.equal(nextSlow(levels, 4), 1);
  assert.equal(nextSlow([null, null], 0), -1);
  assert.equal(nextSlow([], -1), -1);
});
