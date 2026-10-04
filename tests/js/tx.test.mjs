import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsManual, txStatus, endQuestion, LONG_OPEN_MS } from '../../src/ZawSQL/wwwroot/js/txlogic.js';

test('which tabs start in manual-commit mode', () => {
  assert.equal(wantsManual('auto', { production: true }), false);
  assert.equal(wantsManual('manual', { production: false }), true);
  assert.equal(wantsManual('production', { production: true }), true);
  assert.equal(wantsManual('production', { production: false }), false);
  assert.equal(wantsManual(undefined, { production: true }), false);
});

test('transaction status for the toolbar', () => {
  const now = Date.parse('2026-10-05T10:00:00Z');
  const at = ms => new Date(now - ms).toISOString();
  assert.deepEqual(txStatus(null, now), { text: 'No open transaction', severity: 'idle' });
  assert.deepEqual(txStatus({ open: false, changes: 0 }, now), { text: 'No open transaction', severity: 'idle' });
  assert.deepEqual(txStatus({ open: true, changes: 1, since: at(5_000) }, now), { text: 'Transaction open · 1 change · just now', severity: 'open' });
  assert.deepEqual(txStatus({ open: true, changes: 3, since: at(125_000) }, now), { text: 'Transaction open · 3 changes · 2 min 5 s', severity: 'open' });
  // Long-open transactions stand out: their locks may block other sessions.
  assert.equal(txStatus({ open: true, changes: 2, since: at(LONG_OPEN_MS) }, now).severity, 'long');
  assert.equal(endQuestion({ changes: 2 }, 'Closing the tab ends it.'), 'This tab has an open transaction with 2 uncommitted changes. Closing the tab ends it.');
});
