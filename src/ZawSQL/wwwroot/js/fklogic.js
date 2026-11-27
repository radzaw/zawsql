// Following foreign keys in the Data tab: from a row to the row it references, or to the rows referencing it.
// `rel` is what /relations returns: { outgoing: [{ name, columns, refDb, refTable, refColumns }], incoming: [{ name, db, table, columns, refColumns }] }.
import { qi, sqlStr, isNumericKind } from './util.js';

/** A grid value as an SQL literal comparable with its column (numbers and 0x… binary as they are, the rest quoted). */
export function sqlLiteral(v, kind) {
  if (v == null) return 'NULL';
  if (isNumericKind(kind) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return v;
  if ((kind === 'binary' || kind === 'spatial') && /^0x[0-9a-f]*$/i.test(v)) return v;
  return sqlStr(v);
}

/**
 * `a` = 1 AND `b` = 'x' for the given target columns and literals, or null when a value is NULL or unknown
 * (a NULL foreign key references nothing).
 */
export function matchWhere(targetCols, values) {
  if (!targetCols.length || targetCols.length !== values.length || values.some(v => v == null)) return null;
  return targetCols.map((c, i) => `${qi(c)} = ${values[i]}`).join(' AND ');
}

/** Names of the columns that are part of one of the table's own foreign keys (shown as links). */
export function linkColumns(rel) {
  return new Set((rel?.outgoing ?? []).flatMap(fk => fk.columns));
}

/**
 * The places a row leads to. `cols` are the grid columns ({ name, kind }), `row` the row's values in that order.
 * Each entry: { db, table, where (null when it can't be followed), label, fk, outgoing }.
 * `column` (optional) puts the foreign keys that contain that column first.
 */
export function rowLinks(rel, cols, row, column) {
  const idx = new Map(cols.map((c, i) => [c.name.toLowerCase(), i]));
  const lits = names => names.map(n => {
    const i = idx.get(n.toLowerCase());
    return i == null || row?.[i] == null ? null : sqlLiteral(row[i], cols[i].kind);
  });
  const desc = (table, names) => `${table} (${names.join(', ')})`;
  const outgoing = (rel?.outgoing ?? []).map(fk => ({
    outgoing: true, fk, db: fk.refDb, table: fk.refTable,
    where: matchWhere(fk.refColumns, lits(fk.columns)),
    label: desc(fk.refTable, fk.refColumns),
    has: column != null && fk.columns.some(c => c.toLowerCase() === column.toLowerCase()),
  }));
  const incoming = (rel?.incoming ?? []).map(fk => ({
    outgoing: false, fk, db: fk.db, table: fk.table,
    where: matchWhere(fk.columns, lits(fk.refColumns)),
    label: desc(fk.table, fk.columns),
    has: column != null && fk.refColumns.some(c => c.toLowerCase() === column.toLowerCase()),
  }));
  const first = list => [...list.filter(l => l.has), ...list.filter(l => !l.has)];
  return { outgoing: first(outgoing), incoming: first(incoming) };
}

/** Shows a table name with its database when that differs from the current one. */
export function tableLabel(link, currentDb) {
  return link.db && link.db !== currentDb ? `${link.db}.${link.label}` : link.label;
}
