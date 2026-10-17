import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipCell } from '../../src/ZawSQL/wwwroot/js/grid.js';

test('copied cells with tabs, line breaks or quotes stay one spreadsheet cell', () => {
  assert.equal(clipCell(null, true), 'NULL');
  assert.equal(clipCell('plain', true), 'plain');
  assert.equal(clipCell('a\tb', true), '"a\tb"');
  assert.equal(clipCell('line 1\nline 2', true), '"line 1\nline 2"');
  assert.equal(clipCell('say "hi"', true), '"say ""hi"""');
  // A single copied cell is pasted as it is (into an editor, a search box …).
  assert.equal(clipCell('line 1\nline 2', false), 'line 1\nline 2');
});
