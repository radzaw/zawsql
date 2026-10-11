// Data tab: the sorting and filter last used on each table, restored when the table is opened again.
// Pure functions (no DOM), unit-tested in tests/js. Keys come from whereKey(db, table), like the filter history.

export const MAX_TABLES = 200;

/** A remembered view in its normal form, or null when it is the default (no sorting, no filter). */
export function cleanView(v) {
  const sort = v?.sort?.col ? { col: String(v.sort.col), dir: v.sort.dir === 'desc' ? 'desc' : 'asc' } : null;
  const where = String(v?.where ?? '').trim();
  const search = String(v?.search ?? '').trim();
  if (!sort && !where && !search) return null;
  return { ...(sort && { sort }), ...(where && { where }), ...(search && { search }) };
}

/**
 * Stores a table's view: most recently used last, tables used least recently dropped beyond MAX_TABLES. A default view
 * removes the entry. Returns a new store ({ key: { sort, where, search } }).
 */
export function rememberView(store, key, view, { tables = MAX_TABLES } = {}) {
  const v = cleanView(view);
  const { [key]: _, ...rest } = store ?? {};
  if (!v) return rest;
  const keys = Object.keys(rest);
  const kept = keys.slice(Math.max(0, keys.length - (tables - 1)));
  return { ...Object.fromEntries(kept.map(k => [k, rest[k]])), [key]: v };
}

/** The remembered view of a table, with defaults filled in. */
export function viewFor(store, key) {
  const v = cleanView(store?.[key]);
  return { sort: v?.sort ?? null, where: v?.where ?? '', search: v?.search ?? '' };
}

/** Drops a remembered sort column the table no longer has (it was renamed or dropped). */
export function withExistingSort(view, columnNames) {
  return view.sort && !columnNames.includes(view.sort.col) ? { ...view, sort: null } : view;
}
