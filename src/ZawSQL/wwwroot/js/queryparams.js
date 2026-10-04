// Query parameters: ":name" placeholders in a query tab, filled in before the statements run.
// Pure functions (no DOM), unit-tested in tests/js.
import { sqlStr } from './util.js';

/** How a value is written into the SQL. */
export const PARAM_TYPES = [
  ['text', 'Text'],
  ['number', 'Number'],
  ['null', 'NULL'],
  ['sql', 'SQL as written'],
];

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * The :name parameters of one statement, outside strings, quoted names and comments. A colon right after a name
 * (a label, "lbl:"), a second colon ("::") or "=" (":=" assignments) is not a parameter.
 */
export function findParams(sql) {
  const out = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n && sql[i] !== c) i += sql[i] === '\\' && c !== '`' ? 2 : 1;
      i++; // a doubled quote ('it''s') simply starts the next part of the string
      continue;
    }
    if (c === '#' || (c === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2])))) {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '') && !/[\w$`)\]:]/.test(sql[i - 1] ?? '')) {
      let e = i + 1;
      while (e < n && /\w/.test(sql[e])) e++;
      out.push({ name: sql.slice(i + 1, e), start: i, end: e });
      i = e;
      continue;
    }
    i++;
  }
  return out;
}

/** The distinct parameter names of the statements, in order of first appearance. */
export function paramNames(statements) {
  const names = [];
  for (const s of statements) for (const p of findParams(s)) if (!names.includes(p.name)) names.push(p.name);
  return names;
}

/** A value as SQL. Throws for a value that isn't a number when "number" is chosen. */
export function literal(type, value) {
  const v = value ?? '';
  switch (type) {
    case 'null': return 'NULL';
    case 'sql':
      if (!String(v).trim()) throw new Error('Enter the SQL to insert.');
      return String(v);
    case 'number':
      if (!NUMBER_RE.test(String(v).trim())) throw new Error(`"${v}" isn't a number.`);
      return String(v).trim();
    default: return sqlStr(v);
  }
}

/** The statement with every :name replaced by its value. `values`: { name: { type, value } }. */
export function bindParams(sql, values) {
  let out = sql;
  for (const p of findParams(sql).reverse()) {
    const v = values[p.name];
    if (!v) throw new Error(`No value for :${p.name}.`);
    out = out.slice(0, p.start) + literal(v.type, v.value) + out.slice(p.end);
  }
  return out;
}

/** The type to offer first: the one used last time, else Number where only a number fits (LIMIT, OFFSET), else Text. */
export function guessType(statements, name, remembered) {
  if (remembered?.type) return remembered.type;
  for (const s of statements) {
    for (const p of findParams(s)) {
      if (p.name !== name) continue;
      const before = s.slice(0, p.start);
      if (/\b(LIMIT|OFFSET)\s*$/i.test(before) || /\bLIMIT\s+(\d+|:\w+)\s*,\s*$/i.test(before)) return 'number';
    }
  }
  return 'text';
}

/** Remembers the values used (per name, across tabs) with the last few distinct values for suggestions. */
export function rememberParams(store, values, keep = 8) {
  const next = { ...store };
  for (const [name, { type, value }] of Object.entries(values)) {
    const recent = [value, ...(next[name]?.recent ?? []).filter(x => x !== value)].filter(x => x !== '' && x != null).slice(0, keep);
    next[name] = { type, value, recent };
  }
  return next;
}
