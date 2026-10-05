import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsPreview, prettyValue, previewText, placePreview } from '../../src/ZawSQL/wwwroot/js/cellpreview.js';

test('cell preview: only for text that is cut off or shown altered', () => {
  assert.equal(needsPreview('short', false), false);
  assert.equal(needsPreview('cut off by the column width', true), true);
  assert.equal(needsPreview('two\nlines', false), true); // the grid shows ¶ instead of the line break
  assert.equal(needsPreview('x'.repeat(401), false), true); // the grid shortens it
  assert.equal(needsPreview(null, true), false); // (NULL)
  assert.equal(needsPreview('', true), false);
  assert.equal(needsPreview(12345, true), true);
});

test('cell preview: JSON objects and arrays are indented, other text kept as it is', () => {
  assert.deepEqual(prettyValue('{"a":1,"b":[2,3]}'), { text: '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}', json: true });
  assert.equal(prettyValue(' [1] ').json, true);
  assert.deepEqual(prettyValue('{not json}'), { text: '{not json}', json: false });
  assert.deepEqual(prettyValue('"just a string"'), { text: '"just a string"', json: false });
  assert.deepEqual(prettyValue('a\r\nb\rc'), { text: 'a\nb\nc', json: false });
});

test('cell preview: long values are cut, with the size and what was left out', () => {
  const p = previewText('line one\nline two');
  assert.deepEqual(p, { text: 'line one\nline two', more: 0, json: false, info: '17 characters · 2 lines' });
  const big = previewText('x'.repeat(5000), 4000);
  assert.equal(big.text.length, 4000);
  assert.equal(big.more, 1000);
  assert.equal(big.info, '5,000 characters');
  assert.equal(previewText('{"a":1}').info, '7 characters · 3 lines · JSON');
  assert.equal(previewText('x').info, '1 character');
});

test('cell preview: placed below the cell, above when there is no room, inside the window', () => {
  const vp = { width: 1000, height: 800 };
  const size = { width: 300, height: 200 };
  assert.deepEqual(placePreview({ left: 100, top: 100, bottom: 121 }, size, vp), { left: 100, top: 123 });
  assert.deepEqual(placePreview({ left: 100, top: 700, bottom: 721 }, size, vp), { left: 100, top: 498 });
  assert.deepEqual(placePreview({ left: 900, top: 100, bottom: 121 }, size, vp), { left: 696, top: 123 });
  assert.deepEqual(placePreview({ left: -50, top: 100, bottom: 121 }, size, vp), { left: 4, top: 123 });
  // Taller than the space above and below: as high as fits.
  assert.deepEqual(placePreview({ left: 10, top: 150, bottom: 171 }, { width: 100, height: 700 }, vp), { left: 10, top: 96 });
});
