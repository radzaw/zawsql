// Find / replace / go to line for the SQL editor: pure helpers (no DOM), unit-tested in tests/js.

/** More matches than this are not marked or counted (the editor stays responsive on huge scripts). */
export const MAX_MATCHES = 10000;

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The regular expression a search uses, or { error } for an invalid pattern.
 * Options: caseSensitive, wholeWord (not inside a longer name: letters, digits, _ and $), regex.
 */
export function searchRegex(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  if (!query) return { re: null };
  let src = regex ? query : escapeRe(query);
  if (wholeWord) src = `(?<![\\w$])(?:${src})(?![\\w$])`;
  try {
    return { re: new RegExp(src, 'gm' + (caseSensitive ? '' : 'i')) };
  } catch (e) {
    return { re: null, error: e.message.replace(/^Invalid regular expression: /, '') };
  }
}

/**
 * Every match of the query in the text: { matches: [{ start, end, groups? }], error?, capped? }.
 * Empty matches (a regex like ^ or a*) are left out, since there is nothing to show or replace.
 */
export function findMatches(text, query, opts = {}) {
  const { re, error } = searchRegex(query, opts);
  if (!re) return { matches: [], error };
  const matches = [];
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    matches.push(opts.regex ? { start: m.index, end: m.index + m[0].length, groups: [...m], named: m.groups } : { start: m.index, end: m.index + m[0].length });
    if (matches.length >= MAX_MATCHES) return { matches, capped: true };
  }
  return { matches };
}

/**
 * The replacement text for one match. Literal unless searching by regex; then $1…$99, $<name>, $& and $$ work as in
 * JavaScript, and \n, \t and \\ stand for a line break, a tab and a backslash.
 */
export function expandReplacement(template, match, { regex = false } = {}) {
  if (!regex) return template;
  const g = match.groups || [];
  return template.replace(/\$(\$|&|<([^>]*)>|\d{1,2})|\\([nt\\])/g, (all, d, name, esc) => {
    if (esc) return esc === 'n' ? '\n' : esc === 't' ? '\t' : '\\';
    if (d === '$') return '$';
    if (d === '&') return g[0] ?? '';
    if (name != null) return match.named?.[name] ?? all;
    // $12 is group 12 if there is one, else group 1 followed by "2".
    if (d.length === 2 && +d < g.length) return g[+d] ?? '';
    if (+d[0] > 0 && +d[0] < g.length) return (g[+d[0]] ?? '') + d.slice(1);
    return all;
  });
}

/** Replaces every match: { text, count }. */
export function replaceAll(text, query, template, opts = {}) {
  const { matches } = findMatches(text, query, opts);
  if (!matches.length) return { text, count: 0 };
  let out = '', at = 0;
  for (const m of matches) {
    out += text.slice(at, m.start) + expandReplacement(template, m, opts);
    at = m.end;
  }
  return { text: out + text.slice(at), count: matches.length };
}

/**
 * The match to go to from the caret: forward, the first one starting at or after `pos`; backward, the last one
 * starting before it. Wraps around; -1 without matches.
 */
export function matchIndexFrom(matches, pos, backward = false) {
  if (!matches.length) return -1;
  if (backward) {
    for (let i = matches.length - 1; i >= 0; i--) if (matches[i].start < pos) return i;
    return matches.length - 1;
  }
  for (let i = 0; i < matches.length; i++) if (matches[i].start >= pos) return i;
  return 0;
}

/** The index of the match exactly covering [start, end), or -1. */
export const matchAt = (matches, start, end) => matches.findIndex(m => m.start === start && m.end === end);

/** "3 of 17", "17 matches", "No results", or the pattern's error. */
export function matchSummary({ matches, error, capped }, cur) {
  if (error) return error;
  if (!matches.length) return 'No results';
  const n = capped ? `${MAX_MATCHES.toLocaleString('en-US')}+` : matches.length.toLocaleString('en-US');
  return cur >= 0 ? `${(cur + 1).toLocaleString('en-US')} of ${n}` : `${n} match${matches.length === 1 ? '' : 'es'}`;
}

/**
 * "12" or "12:5" (line, optionally column; both from 1) as an offset in the text, clamped to the text.
 * null when the input isn't a line number.
 */
export function lineColumnOffset(text, input) {
  const m = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(input ?? '');
  if (!m) return null;
  let line = Math.max(1, +m[1]);
  let start = 0;
  while (--line > 0) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) break;
    start = nl + 1;
  }
  let end = text.indexOf('\n', start);
  if (end < 0) end = text.length;
  return Math.min(start + Math.max(0, (m[2] ? +m[2] : 1) - 1), end);
}

/** The search text to start with: a selection on one line, else nothing (keep the previous query). */
export const initialQuery = selected => (selected && !selected.includes('\n') && selected.length <= 200 ? selected : null);
