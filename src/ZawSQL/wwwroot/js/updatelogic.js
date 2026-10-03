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
