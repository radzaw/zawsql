// Slow query and lock insight: pure helpers (no DOM), unit-tested in tests/js.

export const SORTS = [
  ['totalMs', 'Total time'], ['avgMs', 'Average time'], ['maxMs', 'Slowest run'], ['count', 'Executions'],
  ['rowsExamined', 'Rows examined'], ['errors', 'Errors'],
];

const COUNTERS = ['count', 'totalMs', 'lockMs', 'errors', 'warnings', 'rowsAffected', 'rowsSent', 'rowsExamined', 'tmpDisk', 'tmpTables',
  'fullJoins', 'scans', 'sortRows', 'noIndex', 'noGoodIndex'];

export const digestKey = r => `${r.schema ?? ''}|${r.digest}`;

/** Milliseconds as "0.35 ms", "12.3 ms", "1.24 s", "2 min 5 s", "1 h 2 min". */
export function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return '–';
  if (ms < 1) return ms.toFixed(2) + ' ms';
  if (ms < 100) return ms.toFixed(1) + ' ms';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 2 : 1) + ' s';
  return fmtSeconds(ms / 1000);
}

/** Seconds as "45 s", "2 min 5 s", "1 h 2 min", "3 d 4 h". */
export function fmtSeconds(s) {
  if (s == null || !isFinite(s)) return '–';
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

/** A snapshot of the digest counters, to measure what runs from now on. */
export function snapshot(rows, at = Date.now()) {
  const map = new Map();
  for (const r of rows) map.set(digestKey(r), Object.fromEntries(COUNTERS.map(k => [k, r[k]])));
  return { at, map };
}

/**
 * Rows relative to a snapshot: counters minus their value then; digests that didn't run since are dropped.
 * Counters that went backwards (statistics reset) count from zero. The slowest run stays the all-time maximum.
 */
export function sinceSnapshot(rows, snap) {
  if (!snap) return rows;
  const out = [];
  for (const r of rows) {
    const base = snap.map.get(digestKey(r));
    if (base && r.count < base.count) { out.push({ ...r, isNew: false }); continue; }
    const d = { ...r, isNew: !base };
    if (base) for (const k of COUNTERS) d[k] = Math.max(0, r[k] - base[k]);
    if (d.count > 0) out.push(d);
  }
  return out;
}

/** Derived per-call values and the warning flags shown in the Notes column. */
export function derive(r) {
  const n = r.count || 0;
  const avgMs = n ? r.totalMs / n : 0;
  const examinedPerCall = n ? r.rowsExamined / n : 0;
  const sentPerCall = n ? (r.rowsSent + r.rowsAffected) / n : 0;
  const flags = [];
  if (r.noIndex > 0) flags.push('no index used');
  else if (r.noGoodIndex > 0) flags.push('no good index');
  if (r.fullJoins > 0) flags.push('join without index');
  if (r.tmpDisk > 0) flags.push('temp table on disk');
  if (examinedPerCall >= 1000 && examinedPerCall > 100 * Math.max(1, sentPerCall)) flags.push(`examines ${Math.round(examinedPerCall / Math.max(1, sentPerCall))}× the rows it returns`);
  if (r.errors > 0) flags.push(`${r.errors} error${r.errors === 1 ? '' : 's'}`);
  return { ...r, avgMs, examinedPerCall, sentPerCall, flags };
}

export function sortRows(rows, key, dir = 'desc') {
  const m = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => ((a[key] ?? 0) - (b[key] ?? 0)) * m);
}

const SYSTEM_RE = /^\s*(SHOW|SET|USE|KILL)\b|`?(information_schema|performance_schema|mysql|sys)`?\s*\.|^\s*SELECT\s+(@@|VERSION\s*\(|DATABASE\s*\(|CONNECTION_ID\s*\()/i;

/** Statements about the server itself (metadata, SHOW, SET …) – including the ones ZawSQL runs to browse. */
export const isSystemQuery = r => SYSTEM_RE.test(r.text || '');

/** Text filter over query, sample and schema (all terms must match), optionally without system statements. */
export function filterRows(rows, text, schema, { hideSystem = false } = {}) {
  const terms = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(r => (!schema || r.schema === schema) && !(hideSystem && isSystemQuery(r))
    && terms.every(t => `${r.text}\n${r.sample ?? ''}\n${r.schema ?? ''}`.toLowerCase().includes(t)));
}

/** SQL for a query tab: the sample when the server keeps one (runnable), else the normalized digest text. */
export function querySql(r, { explain = false } = {}) {
  const sql = r.sample || r.text || '';
  return explain ? `EXPLAIN ${sql.replace(/;\s*$/, '')};` : sql.replace(/;?\s*$/, ';');
}

/** What a lock holder is doing: its statement, or how long it has sat idle inside the transaction. */
export function holderActivity(b) {
  if (!b) return 'unknown';
  if (b.query) return b.query;
  if (b.command === 'Sleep') return `idle in transaction for ${fmtSeconds(b.time ?? 0)}`;
  return b.command || 'no statement running';
}

/** Open transactions that are idle while holding locks: the usual cause of lock waits. */
export function isIdleHolder(t, minSeconds = 10) {
  return !t.query && t.command === 'Sleep' && (t.rowsLocked > 0 || t.tablesLocked > 0) && (t.time ?? 0) >= minSeconds;
}

export function lockSummary(r) {
  const parts = [`${r.waits.length} row lock wait${r.waits.length === 1 ? '' : 's'}`, `${r.metadata.length} metadata lock wait${r.metadata.length === 1 ? '' : 's'}`];
  const oldest = r.transactions.reduce((m, t) => Math.max(m, t.age ?? 0), 0);
  parts.push(`${r.transactions.length} open transaction${r.transactions.length === 1 ? '' : 's'}${r.transactions.length ? ` (oldest ${fmtSeconds(oldest)})` : ''}`);
  return parts.join(' · ');
}
