import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoCheck, worthTelling, renderNotes, progressText, CHECK_EVERY_MS } from '../../src/ZawSQL/wwwroot/js/updatelogic.js';

test('automatic checks happen at most once a day and can be switched off', () => {
  const now = 10 * CHECK_EVERY_MS;
  assert.equal(shouldAutoCheck({}, {}, now), true);
  assert.equal(shouldAutoCheck({}, { lastCheck: now - 1000 }, now), false);
  assert.equal(shouldAutoCheck({}, { lastCheck: now - CHECK_EVERY_MS }, now), true);
  assert.equal(shouldAutoCheck({ checkUpdates: false }, {}, now), false);
});

test('only newer, not skipped versions are announced', () => {
  assert.equal(worthTelling({ newer: true, latest: '1.2.0' }, {}), true);
  assert.equal(worthTelling({ newer: true, latest: '1.2.0' }, { skipped: '1.2.0' }), false);
  assert.equal(worthTelling({ newer: true, latest: '1.3.0' }, { skipped: '1.2.0' }), true);
  assert.equal(worthTelling({ newer: false, latest: '1.0.0' }, {}), false);
  assert.equal(worthTelling(null, {}), false);
});

test('release notes become safe HTML', () => {
  assert.equal(renderNotes('## What\'s new\n- **Replication** status\n- Fix `EXPLAIN`\n\nSee [the docs](https://example.com/x).'),
    "<h4>What&#39;s new</h4><ul><li><b>Replication</b> status</li><li>Fix <code>EXPLAIN</code></li></ul><p>See <a href=\"https://example.com/x\" target=\"_blank\" rel=\"noopener\">the docs</a>.</p>");
  // Markup and script URLs in the notes are never active.
  assert.equal(renderNotes('<img src=x onerror=alert(1)> [x](javascript:alert(1))'),
    '<p>&lt;img src=x onerror=alert(1)&gt; [x](javascript:alert(1))</p>');
  assert.equal(renderNotes(null), '');
});

test('download progress', () => {
  assert.equal(progressText(5 * 1048576, 52 * 1048576), '5.0 of 52 MB (9%)');
  assert.equal(progressText(1048576, 0), '1.0 MB');
});
