// Data tab: recently used WHERE filters, per table. Pure functions (no DOM), unit-tested in tests/js.

export const MAX_PER_TABLE = 20;
export const MAX_TABLES = 200;

/** History key of a table; filters refer to its columns, so they are kept per database and table. */
export const whereKey = (db, table) => `${db}.${table}`;

/** Filters that differ only in spacing or line breaks are the same filter. */
const norm = w => String(w).replace(/\s+/g, ' ').trim();

/**
 * Remembers a filter that ran: most recent first, without duplicates, at most MAX_PER_TABLE per table. Tables used
 * least recently are dropped beyond MAX_TABLES. Returns a new store ({ key: [where, …] } in order of use).
 */
export function rememberWhere(store, key, where, { perTable = MAX_PER_TABLE, tables = MAX_TABLES } = {}) {
  const w = String(where ?? '').trim();
  if (!w) return store ?? {};
  const list = [w, ...(store?.[key] ?? []).filter(x => norm(x) !== norm(w))].slice(0, perTable);
  const { [key]: _, ...rest } = store ?? {};
  const keys = Object.keys(rest);
  const kept = keys.slice(Math.max(0, keys.length - (tables - 1)));
  return { ...Object.fromEntries(kept.map(k => [k, rest[k]])), [key]: list };
}

/** Removes one filter (or, without `where`, the table's whole history). */
export function forgetWhere(store, key, where) {
  if (!store?.[key]) return store ?? {};
  const { [key]: list, ...rest } = store;
  if (where == null) return rest;
  const left = list.filter(x => norm(x) !== norm(where));
  return left.length ? { ...rest, [key]: left } : rest;
}

/** A filter as one menu line: line breaks folded, long ones shortened (the full text goes in the tooltip). */
export function whereLabel(where, max = 90) {
  const one = norm(where);
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}
