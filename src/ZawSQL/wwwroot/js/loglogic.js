// SQL log: which lines are statements, what can be done with them, filtering and export.
import { fmtLogTime } from './util.js';
import { fmtDuration } from './logslow.js';

/** The session a request belongs to, from its API path (/s/<sid>/...), or null. */
export function sidFromPath(path) {
  const m = /^\/s\/([^/?#]+)/.exec(path || '');
  return m ? decodeURIComponent(m[1]) : null;
}

/** Comments (/* … *\/ lines: connects, errors, notes) aren't statements. */
export function isStatement(line) {
  const t = (line || '').trim();
  return t.length > 0 && !t.startsWith('/*') && !t.startsWith('--') && !t.startsWith('#');
}

/** The database a "USE `db`" line switches to, or null. */
export function useDb(line) {
  const m = /^\s*USE\s+(`(?:[^`]|``)+`|[A-Za-z0-9_$]+)\s*;?\s*$/i.exec(line || '');
  if (!m) return null;
  const n = m[1];
  return n.startsWith('`') ? n.slice(1, -1).replace(/``/g, '`') : n;
}

function stripLeadingComments(sql) {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('/*') && !t.startsWith('/*!')) {
      const end = t.indexOf('*/');
      if (end < 0) return '';
      s = t.slice(end + 2);
    } else if (t.startsWith('--') || t.startsWith('#')) {
      const nl = t.indexOf('\n');
      if (nl < 0) return '';
      s = t.slice(nl + 1);
    } else return t;
  }
}

/** Statements EXPLAIN accepts: SELECT, WITH, TABLE, UPDATE, DELETE, INSERT and REPLACE. */
export function explainable(sql) {
  return /^(select|with|table|update|delete|insert|replace)\b/i.test(stripLeadingComments(sql || ''));
}

/**
 * Which log entries a filter shows. entry: { text, err, slow, sid }; filter: { text, errors, slow, sid }.
 * Matching text ignores case. With "errors", the statement each error belongs to (the line before it) is shown too.
 */
export function filterEntries(entries, filter = {}) {
  const q = (filter.text || '').trim().toLowerCase();
  const show = entries.map(e =>
    (!q || e.text.toLowerCase().includes(q)) &&
    (!filter.slow || !!e.slow) &&
    (filter.sid == null || filter.sid === '' || e.sid === filter.sid) &&
    (!filter.errors || !!e.err));
  if (filter.errors) {
    entries.forEach((e, i) => {
      if (show[i] && i > 0 && isStatement(entries[i - 1].text) && entries[i - 1].sid === e.sid &&
        (filter.sid == null || filter.sid === '' || entries[i - 1].sid === filter.sid)) show[i - 1] = true;
    });
  }
  return show;
}

export function isFiltering(filter = {}) {
  return !!((filter.text || '').trim() || filter.errors || filter.slow || (filter.sid != null && filter.sid !== ''));
}

/**
 * The log as a .sql file that can be run again: statements end with ";", times and durations are comments.
 * entry: { text, time, ms, sid }; sessionName(sid) labels lines of different sessions.
 */
export function exportSql(entries, { timestamps = true, durations = true, sessionName = () => null, now = Date.now() } = {}) {
  const out = [`/* ZawSQL SQL log, saved ${fmtLogTime(now)} – ${entries.length} line${entries.length === 1 ? '' : 's'} */`];
  let lastSid;
  for (const e of entries) {
    if (e.sid !== lastSid && e.sid != null) {
      const name = sessionName(e.sid);
      if (name) out.push(`/* Session: ${name.replace(/\*\//g, '* /')} */`);
    }
    if (e.sid != null) lastSid = e.sid;
    const pre = timestamps && e.time != null ? `/* ${fmtLogTime(e.time)} */ ` : '';
    let body = e.text;
    if (isStatement(body) && !/;\s*$/.test(body)) body += ';';
    const post = durations && e.ms != null ? ` /* ${fmtDuration(e.ms)} */` : '';
    out.push(pre + body + post);
  }
  return out.join('\n') + '\n';
}

/** "zawsql-log-2026-10-05-1430.sql" */
export function exportFileName(now = Date.now()) {
  const d = new Date(now);
  const p = n => String(n).padStart(2, '0');
  return `zawsql-log-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.sql`;
}
