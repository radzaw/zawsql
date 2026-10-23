// Statement statistics: what each statement did on the server, from the session's status counters before and after it
// (QueryStats.cs). Pure functions (no DOM), unit-tested in tests/js.

const n = (c, k) => c?.[k] ?? 0;
const fmt = v => Math.round(v).toLocaleString('en-US');
const plural = (v, one, many = one + 's') => `${fmt(v)} ${v === 1 ? one : many}`;

/** The counters people care about. Handler_write also counts rows written to internal temporary tables. */
export function summarize(c) {
  const byIndex = n(c, 'Handler_read_key') + n(c, 'Handler_read_next') + n(c, 'Handler_read_prev') + n(c, 'Handler_read_first') + n(c, 'Handler_read_last');
  const scanned = n(c, 'Handler_read_rnd_next');
  return {
    read: byIndex + scanned + n(c, 'Handler_read_rnd'),
    byIndex,
    scanned,
    written: n(c, 'Handler_write'),
    updated: n(c, 'Handler_update'),
    deleted: n(c, 'Handler_delete'),
    tmpTables: n(c, 'Created_tmp_tables'),
    tmpDisk: n(c, 'Created_tmp_disk_tables'),
    sorted: n(c, 'Sort_rows'),
    mergePasses: n(c, 'Sort_merge_passes'),
    fullJoins: n(c, 'Select_full_join') + n(c, 'Select_full_range_join'),
    tableScans: n(c, 'Select_scan'),
  };
}

/** What stands out, as short sentences; `returned` is the number of rows the statement returned (null if none). */
export function findings(s, returned = null) {
  const out = [];
  if (s.scanned >= 1000 && s.scanned > s.byIndex) out.push(`read ${plural(s.scanned, 'row')} by scanning a table or index`);
  if (returned != null && s.read >= 10_000 && s.read >= 100 * Math.max(1, returned)) out.push(`read ${plural(s.read, 'row')} to return ${plural(returned, 'row')}`);
  if (s.fullJoins) out.push(`${plural(s.fullJoins, 'join')} without an index`);
  if (s.tmpDisk) out.push(`${plural(s.tmpDisk, 'temporary table')} on disk`);
  if (s.mergePasses) out.push(`the sort needed ${plural(s.mergePasses, 'merge pass', 'merge passes')} (sort_buffer_size is too small for it)`);
  return out;
}

/** One line for the message bar: the totals of all measured statements and what stands out. */
export function statsLine(stats, returnedByStatement = {}) {
  if (!stats?.length) return '';
  const t = stats.map(x => summarize(x.counters)).reduce((a, s) => {
    for (const k of Object.keys(s)) a[k] = (a[k] || 0) + s[k];
    return a;
  }, {});
  const parts = [`Rows read: ${fmt(t.read)}${t.read ? ` (${fmt(t.byIndex)} by index, ${fmt(t.scanned)} by scan)` : ''}`];
  const changed = t.updated + t.deleted;
  if (changed) parts.push(`changed: ${fmt(changed)}`);
  if (t.tmpTables) parts.push(`temporary tables: ${fmt(t.tmpTables)}${t.tmpDisk ? ` (${fmt(t.tmpDisk)} on disk)` : ''}`);
  if (t.sorted) parts.push(`sorted: ${fmt(t.sorted)}`);
  const notes = stats.flatMap(x => findings(summarize(x.counters), returnedByStatement[x.statement] ?? null));
  return parts.join(', ') + (notes.length ? ` – ${notes[0]}${notes.length > 1 ? ` (+${notes.length - 1} more)` : ''}` : '');
}

const COLS = [
  ['#', 'int'], ['Statement', 'text'], ['Rows read', 'int'], ['By index', 'int'], ['By scan', 'int'], ['Written', 'int'],
  ['Updated', 'int'], ['Deleted', 'int'], ['Temp tables', 'int'], ['On disk', 'int'], ['Sorted rows', 'int'], ['Full joins', 'int'], ['Notes', 'text'],
];
const TITLES = {
  'Rows read': 'Every row the storage engine handed to the server (Handler_read_*)',
  'By index': 'Rows found through an index (Handler_read_key, _next, _prev, _first, _last)',
  'By scan': 'Rows read one after the other in a full table or index scan (Handler_read_rnd_next)',
  Written: 'Rows inserted, including rows written to internal temporary tables (Handler_write)',
  'Full joins': 'Joins that scanned the joined table for every row, because no index fits (Select_full_join, Select_full_range_join)',
};

/** A read-only result set for the "Statistics" result tab; `returnedByStatement` maps a statement to its rows. */
export function statsSet(stats, sqls, returnedByStatement = {}) {
  return {
    statement: -1,
    sql: 'Statement statistics',
    stats: true,
    truncated: false,
    columns: COLS.map(([name, kind]) => ({ name, kind, type: kind === 'int' ? 'BIGINT' : 'VARCHAR', title: TITLES[name] })),
    rows: stats.map(x => {
      const s = summarize(x.counters);
      const sql = String(sqls[x.statement] ?? '').replace(/\s+/g, ' ').trim();
      return [String(x.statement + 1), sql.length > 200 ? sql.slice(0, 199) + '…' : sql,
        ...[s.read, s.byIndex, s.scanned, s.written, s.updated, s.deleted, s.tmpTables, s.tmpDisk, s.sorted, s.fullJoins].map(String),
        findings(s, returnedByStatement[x.statement] ?? null).join('; ') || null];
    }),
  };
}

/** Rows returned by each statement (all its result sets), for the "read N to return M" finding; not known when cut off. */
export function returnedRows(sets) {
  const out = {}, cut = new Set();
  for (const s of sets || []) {
    if (s.statement < 0) continue;
    if (s.truncated) cut.add(s.statement);
    out[s.statement] = (out[s.statement] || 0) + s.rows.length;
  }
  for (const i of cut) delete out[i];
  return out;
}
