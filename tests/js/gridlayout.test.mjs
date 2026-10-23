import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, layoutOf, cleanLayout, moveColumn } from '../../src/ZawSQL/wwwroot/js/gridlayout.js';

const names = ['id', 'name', 'email', 'notes'];

test('grid layout: the default is the data order with nothing hidden', () => {
  const a = arrange(names, null);
  assert.deepEqual(a.seq, [0, 1, 2, 3]);
  assert.equal(a.hidden.size, 0);
  assert.equal(layoutOf(names, a.seq, a.hidden), null);
});

test('grid layout: order and hidden columns round-trip by name', () => {
  const layout = layoutOf(names, [2, 0, 1, 3], new Set([3]));
  assert.deepEqual(layout, { order: ['email', 'id', 'name', 'notes'], hidden: ['notes'] });
  const a = arrange(names, layout);
  assert.deepEqual(a.seq, [2, 0, 1, 3]);
  assert.deepEqual([...a.hidden], [3]);
});

test('grid layout: columns added or dropped since', () => {
  // "phone" is new (shown last), "fax" is gone.
  const a = arrange(['id', 'name', 'phone'], { order: ['name', 'fax', 'id'], hidden: ['fax'] });
  assert.deepEqual(a.seq, [1, 0, 2]);
  assert.equal(a.hidden.size, 0);
});

test('grid layout: at least one column stays visible', () => {
  assert.equal(arrange(['a', 'b'], { order: [], hidden: ['a', 'b'] }).hidden.size, 0);
});

test('grid layout: stored layouts are normalized', () => {
  assert.equal(cleanLayout(null), null);
  assert.equal(cleanLayout({ order: [], hidden: [] }), null);
  assert.deepEqual(cleanLayout({ order: ['a', 1], hidden: 'x' }), { order: ['a', '1'], hidden: [] });
});

test('grid layout: moving a column', () => {
  assert.deepEqual(moveColumn([0, 1, 2, 3], 3, 0), [3, 0, 1, 2]);
  assert.deepEqual(moveColumn([0, 1, 2, 3], 0, null), [1, 2, 3, 0]);
  assert.deepEqual(moveColumn([0, 1, 2, 3], 1, 2), [0, 1, 2, 3]); // just before its right neighbour: no change
  assert.deepEqual(moveColumn([0, 1, 2, 3], 2, 2), [0, 1, 2, 3]);
});
