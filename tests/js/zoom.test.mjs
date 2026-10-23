import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZOOM_STEPS, nextZoom } from '../../src/ZawSQL/wwwroot/js/util.js';

test('zoom: steps up and down, stopping at the ends', () => {
  assert.equal(nextZoom(100, 1), 110);
  assert.equal(nextZoom(100, -1), 90);
  assert.equal(nextZoom(ZOOM_STEPS.at(-1), 1), ZOOM_STEPS.at(-1));
  assert.equal(nextZoom(ZOOM_STEPS[0], -1), ZOOM_STEPS[0]);
});

test('zoom: a level between steps goes to the neighbouring step', () => {
  assert.equal(nextZoom(105, 1), 110);
  assert.equal(nextZoom(105, -1), 100);
});
