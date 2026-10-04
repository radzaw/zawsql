import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoCheck, worthTelling, renderNotes, progressText, CHECK_EVERY_MS, compareVersions, whatsNewPlan, releasesPage } from '../../src/ZawSQL/wwwroot/js/updatelogic.js';

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

test('versions compare like the backend does', () => {
  const sign = (a, b) => Math.sign(compareVersions(a, b));
  assert.equal(sign('1.2.3', '1.2.3'), 0);
  assert.equal(sign('v1.10.0', '1.9.9'), 1);
  assert.equal(sign('1.2', '1.2.0'), 0);
  assert.equal(sign('2.0.0-beta.1', '2.0.0'), -1);
  assert.equal(sign('2.0.0-beta.2', '2.0.0-beta.1'), 1);
  assert.equal(sign('1.0.0', '1.0.1'), -1);
});

test("what's new shows once, after moving to a newer version", () => {
  // A fresh installation remembers its version and shows nothing.
  assert.deepEqual(whatsNewPlan({}, '1.2.0', {}), { show: false, seen: '1.2.0' });
  // Updated (by the updater or by hand, skipping versions too): everything since the last version seen.
  assert.deepEqual(whatsNewPlan({ seenVersion: '1.0.0' }, '1.2.0', {}), { show: true, since: '1.0.0', seen: '1.2.0' });
  // Same version again, or an older one started: nothing to tell.
  assert.deepEqual(whatsNewPlan({ seenVersion: '1.2.0' }, '1.2.0', {}), { show: false, seen: '1.2.0' });
  assert.deepEqual(whatsNewPlan({ seenVersion: '1.3.0' }, '1.2.0', {}), { show: false, seen: '1.2.0' });
  // Switched off in Preferences: still remembered, so switching it back on doesn't replay old notes.
  assert.deepEqual(whatsNewPlan({ seenVersion: '1.0.0' }, '1.2.0', { showWhatsNew: false }), { show: false, since: '1.0.0', seen: '1.2.0' });
  assert.deepEqual(whatsNewPlan({ seenVersion: '1.0.0' }, null, {}), { show: false, seen: null });
  assert.equal(releasesPage('https://github.com/radzaw/zawsql/releases/tag/v1.2.0'), 'https://github.com/radzaw/zawsql/releases');
  assert.equal(releasesPage(null), null);
});
