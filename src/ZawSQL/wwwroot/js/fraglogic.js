// Host tab › Fragmentation: which tables have enough free (allocated but unused) space to be worth rebuilding with
// OPTIMIZE TABLE, and the totals shown above the list. Pure functions, unit-tested without a server.

const MIB = 1024 * 1024;

/** Thresholds offered in the toolbar: [value, label]. */
export const MIN_FREE = [[0, 'Any free space'], [MIB, '≥ 1 MiB free'], [10 * MIB, '≥ 10 MiB free'], [100 * MIB, '≥ 100 MiB free'], [1024 * MIB, '≥ 1 GiB free']];
export const MIN_PCT = [[0, 'Any share'], [5, '≥ 5 %'], [10, '≥ 10 %'], [20, '≥ 20 %'], [50, '≥ 50 %']];
export const DEFAULT_MIN_FREE = 10 * MIB;
export const DEFAULT_MIN_PCT = 10;

/** Engines whose tables OPTIMIZE TABLE can rebuild to give the space back. */
const OPTIMIZABLE = new Set(['innodb', 'myisam', 'aria', 'archive', 'rocksdb', 'tokudb']);

/** Identifies a table across reloads. */
export const fragKey = t => `${t.schema}\u0000${t.name}`;

/** Free space as a share (0–100) of everything the table occupies (data + indexes + free). */
export function fragPct(t) {
  const total = (t.dataBytes || 0) + (t.indexBytes || 0) + (t.freeBytes || 0);
  return total > 0 ? ((t.freeBytes || 0) / total) * 100 : 0;
}

/**
 * Why a table is listed but can't usefully be optimized, or null when it can. With innodb_file_per_table off, an
 * InnoDB table's DATA_FREE is the free space of the shared system tablespace, which a rebuild never returns.
 */
export function skipReason(t, filePerTable) {
  const engine = (t.engine || '').toLowerCase();
  if (!OPTIMIZABLE.has(engine)) return `${t.engine || 'This engine'} doesn't support OPTIMIZE TABLE`;
  if (engine === 'innodb' && filePerTable === false) return 'Stored in the shared system tablespace (innodb_file_per_table is off): the free space is the tablespace\'s, and rebuilding doesn\'t return it';
  return null;
}

/**
 * The tables over both thresholds (free bytes and share of the table), optionally in one database or matching a
 * text, largest free space first. Each gets pct and skip (see skipReason). Tables in keep (a Set or Map of
 * fragKey()s, e.g. the ones just optimized) stay listed whatever the thresholds.
 */
export function fragmented(tables, { minFree = DEFAULT_MIN_FREE, minPct = DEFAULT_MIN_PCT, schema = '', text = '', filePerTable = null, keep = null } = {}) {
  const q = text.trim().toLowerCase();
  return tables
    .map(t => ({ ...t, pct: fragPct(t), skip: skipReason(t, filePerTable) }))
    .filter(t => keep?.has(fragKey(t)) || (t.freeBytes > 0 && t.freeBytes >= minFree && t.pct >= minPct))
    .filter(t => !schema || t.schema === schema)
    .filter(t => !q || `${t.schema}.${t.name}`.toLowerCase().includes(q) || (t.engine || '').toLowerCase().includes(q))
    .sort((a, b) => b.freeBytes - a.freeBytes || a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
}

/** Totals for the tiles: tables listed, free space in them, and what optimizing the optimizable ones would reclaim. */
export function fragSummary(rows) {
  const todo = rows.filter(r => !r.skip);
  return {
    tables: rows.length,
    freeBytes: rows.reduce((s, r) => s + r.freeBytes, 0),
    optimizable: todo.length,
    reclaimBytes: todo.reduce((s, r) => s + r.freeBytes, 0),
    sizeBytes: todo.reduce((s, r) => s + r.dataBytes + r.indexBytes, 0),
  };
}

/** The databases present in the list, sorted, for the database filter. */
export const fragSchemas = tables => [...new Set(tables.map(t => t.schema))].sort();

/**
 * The outcome of one OPTIMIZE TABLE from its result rows ([Table, Op, Msg_type, Msg_text] each). InnoDB answers
 * with a note "Table does not support optimize, doing recreate + analyze instead" followed by "status OK": that's
 * success, not a problem.
 */
export function optimizeOutcome(rows) {
  const err = rows.find(r => /^error$/i.test(r[2] ?? ''));
  if (err) return { ok: false, text: err[3] || 'Error' };
  const status = rows.filter(r => /^status$/i.test(r[2] ?? '')).pop();
  const warn = rows.find(r => /^warning$/i.test(r[2] ?? ''));
  if (status && /^(ok|table is already up to date)$/i.test(status[3] ?? '')) return { ok: true, text: warn ? `OK (${warn[3]})` : status[3] };
  const last = rows[rows.length - 1];
  return { ok: !!status && !warn, text: (warn || status || last)?.[3] || 'No result' };
}

/** "cached up to 24 h" for the statistics age caption (information_schema_stats_expiry in seconds). */
export function expiryText(seconds) {
  if (seconds == null) return '';
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
