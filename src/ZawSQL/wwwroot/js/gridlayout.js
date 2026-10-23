// Column order and hidden columns of a grid, kept by column name so they survive reloads (Data tab: per table).
// Pure functions (no DOM), unit-tested in tests/js.

/**
 * The arrangement for `names` (the columns as the data has them): `seq` lists every column index in display order,
 * hidden ones included so showing one brings it back to its place; `hidden` holds the hidden indexes. Columns the
 * layout doesn't know (added to the table since) come last; names it has that are gone are dropped. At least one
 * column always stays visible.
 */
export function arrange(names, layout) {
  const index = new Map(names.map((n, i) => [n, i]));
  const seq = [];
  const seen = new Set();
  for (const n of layout?.order ?? []) {
    const i = index.get(n);
    if (i != null && !seen.has(i)) { seen.add(i); seq.push(i); }
  }
  names.forEach((_, i) => { if (!seen.has(i)) seq.push(i); });
  const hidden = new Set((layout?.hidden ?? []).map(n => index.get(n)).filter(i => i != null));
  if (hidden.size >= names.length) hidden.clear();
  return { seq, hidden };
}

/** The layout to remember for an arrangement, or null when it is the default (data order, nothing hidden). */
export function layoutOf(names, seq, hidden) {
  const natural = seq.every((c, i) => c === i);
  if (natural && !hidden.size) return null;
  return { order: seq.map(i => names[i]), hidden: seq.filter(i => hidden.has(i)).map(i => names[i]) };
}

/** A remembered layout in its normal form (names as strings), or null. */
export function cleanLayout(l) {
  const order = Array.isArray(l?.order) ? l.order.map(String) : [];
  const hidden = Array.isArray(l?.hidden) ? l.hidden.map(String) : [];
  return order.length || hidden.length ? { order, hidden } : null;
}

/**
 * Moves column `c` (a data index) in `seq` so it is shown just before column `before`, or last when `before` is
 * null. Returns a new seq.
 */
export function moveColumn(seq, c, before) {
  if (c === before) return seq.slice();
  const out = seq.filter(i => i !== c);
  const at = before == null ? out.length : out.indexOf(before);
  out.splice(at < 0 ? out.length : at, 0, c);
  return out;
}
