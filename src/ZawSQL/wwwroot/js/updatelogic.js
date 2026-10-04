// Self-update: pure helpers (no DOM), unit-tested in tests/js.

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Whether to check for updates automatically now (at most once a day, unless switched off). */
export function shouldAutoCheck(prefs, updates, now = Date.now()) {
  if (prefs?.checkUpdates === false) return false;
  return !updates?.lastCheck || now - updates.lastCheck >= CHECK_EVERY_MS;
}

/** Whether a found release deserves a notice (newer, and not skipped by the user). */
export const worthTelling = (check, updates) => !!check?.newer && check.latest !== updates?.skipped;

/**
 * Release notes (GitHub Markdown) as safe HTML: headings, bullet lists, bold, inline code and links to http(s)
 * pages. Everything else stays text; nothing from the notes is inserted unescaped.
 */
export function renderNotes(md) {
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`);
  const out = [];
  let list = false;
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) out.push(`<h4>${inline(heading[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

const mb = n => (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1);

/** "12.3 of 52 MB (24%)" for a download in progress. */
export function progressText(received, total) {
  if (!total) return `${mb(received)} MB`;
  return `${mb(received)} of ${mb(total)} MB (${Math.floor((received / total) * 100)}%)`;
}

/** Compares versions like 1.2.3, v1.10.0, 2.0.0-beta.1 (a pre-release sorts before its release), as Updater.cs does. */
export function compareVersions(a, b) {
  const re = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/;
  const va = re.exec(String(a).trim()), vb = re.exec(String(b).trim());
  if (!va || !vb) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  for (let i = 1; i <= 4; i++) {
    const x = +(va[i] ?? 0), y = +(vb[i] ?? 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  const pa = va[5] ?? null, pb = vb[5] ?? null;
  if (pa === pb) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  return pa < pb ? -1 : 1;
}

/**
 * At startup: whether to show "What's new" (the running version is newer than the one seen last time) and which
 * version to remember. A first run (nothing seen yet) shows nothing, nor does running an older version.
 */
export function whatsNewPlan(updates, current, prefs) {
  if (!current) return { show: false, seen: null };
  const seen = updates?.seenVersion;
  if (!seen || compareVersions(current, seen) <= 0) return { show: false, seen: current };
  return { show: prefs?.showWhatsNew !== false, since: seen, seen: current };
}

/** The releases overview page from one release's page (…/releases/tag/v1.2.0 → …/releases). */
export const releasesPage = page => (page ? String(page).replace(/\/tag\/[^/]+\/?$/, '') : null);
