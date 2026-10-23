// Index suggestions for Visual EXPLAIN: for a table the plan reads by scanning (or joins through a join buffer),
// a candidate index from the columns its condition compares – equality columns first, then one range column, or the
// ORDER BY columns – checked against the table's real columns and indexes. Pure functions (no DOM), unit-tested in
// tests/js. A suggestion is a starting point to review, never run by itself.
import { walk } from './explainlogic.js';

const MAX_COLUMNS = 4;
const PREFIX = 64; // index prefix for TEXT / BLOB columns, which can't be indexed whole

const PART = String.raw`(?:\`(?:[^\`]|\`\`)+\`|[A-Za-z_$][\w$]*)`;
const TOKEN_RE = new RegExp(String.raw`\s+|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|\d+(?:\.\d+)?(?:e[+-]?\d+)?|${PART}(?:\.${PART})*|<=>|<=|>=|<>|!=|\|\||&&|.`, 'giy');
const KEYWORDS = new Set(['and', 'or', 'xor', 'not', 'like', 'between', 'in', 'is', 'null', 'true', 'false', 'regexp', 'rlike', 'escape', 'collate', 'sounds', 'binary', 'interval', 'case', 'when', 'then', 'else', 'end', 'exists', 'unknown']);
const COMPARE = new Set(['=', '<=>', '<', '>', '<=', '>=']);
const unquote = p => (p.startsWith('`') ? p.slice(1, -1).replace(/``/g, '`') : p);
const splitRef = text => text.match(new RegExp(PART, 'g')).map(unquote);
const lc = s => String(s).toLowerCase();

function tokenize(text) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while (TOKEN_RE.lastIndex < text.length && (m = TOKEN_RE.exec(text))) {
    const t = m[0];
    if (/^\s/.test(t)) continue;
    if (t[0] === "'" || t[0] === '"') out.push({ k: 'str', t });
    else if (/^\d/.test(t)) out.push({ k: 'num', t });
    else if (/^[`A-Za-z_$]/.test(t)) {
      const parts = splitRef(t);
      out.push(parts.length === 1 && !t.startsWith('`') && KEYWORDS.has(lc(t)) ? { k: 'kw', t: lc(t) } : { k: 'ref', t, parts });
    } else out.push({ k: 'op', t });
  }
  return out;
}

/**
 * The columns a condition compares, with how: 'eq' (=, <=>, IN, IS NULL) or 'range' (<, >, BETWEEN, LIKE 'abc%').
 * Columns inside a function, under an OR, or compared with <>, NOT … or a leading wildcard are left out, since an
 * index can't serve them, and so is IS NOT NULL. `other` is the qualifier of the other side when it's a column (a join).
 */
export function conditionColumns(text) {
  if (!text) return [];
  const toks = tokenize(String(text));
  const groups = [{ fn: false, or: false }];
  const found = [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.k === 'op' && tk.t === '(') {
      // A function's arguments, NOT ( … ), IN ( … ), EXISTS ( … ): nothing in there is a plain comparison.
      const prev = toks[i - 1];
      groups.push({ fn: prev?.k === 'ref' && prev.parts.length === 1 || prev?.k === 'kw' && !['and', 'or', 'xor'].includes(prev.t), or: false });
      continue;
    }
    if (tk.k === 'op' && tk.t === ')') { if (groups.length > 1) groups.pop(); continue; }
    if ((tk.k === 'kw' && (tk.t === 'or' || tk.t === 'xor')) || (tk.k === 'op' && tk.t === '||')) { groups[groups.length - 1].or = true; continue; }
    if (tk.k !== 'ref' || toks[i + 1]?.t === '(') continue; // a function name
    if (toks[i + 1]?.k === 'str' && tk.parts.length === 1) continue; // a literal's prefix: _utf8mb4'abc', TIMESTAMP'…', X'…'
    found.push({ i, tk, chain: groups.slice() });
  }
  const out = [];
  for (const { i, tk, chain } of found) {
    if (chain.some(g => g.fn || g.or)) continue;
    const use = usage(toks, i);
    if (!use) continue;
    const col = { column: tk.parts[tk.parts.length - 1], qualifier: tk.parts.length > 1 ? tk.parts[tk.parts.length - 2] : null, use: use.use };
    if (use.other) col.other = use.other;
    out.push(col);
  }
  return out;
}

function usage(toks, i) {
  const next = toks[i + 1], prev = toks[i - 1];
  const operand = t => t && (t.k === 'str' || t.k === 'num' || t.k === 'ref' || (t.k === 'kw' && ['null', 'true', 'false'].includes(t.t)) || t.t === '(' || t.t === '-');
  const otherOf = t => (t?.k === 'ref' && t.parts.length > 1 ? t.parts[t.parts.length - 2] : t?.k === 'ref' ? '' : null);
  const arith = t => t && t.k === 'op' && /^[-+*/%]$/.test(t.t);
  if (next?.k === 'op' && COMPARE.has(next.t)) {
    if (arith(toks[i + 3]) || arith(prev)) return null; // compared with an expression, or part of one: left out to keep it simple
    const rhs = toks[i + 2];
    if (!operand(rhs)) return null;
    return { use: next.t === '=' || next.t === '<=>' ? 'eq' : 'range', other: otherOf(rhs) };
  }
  if (prev?.k === 'op' && COMPARE.has(prev.t)) {
    const lhs = toks[i - 2];
    if (!operand(lhs) || arith(toks[i - 3]) || arith(next)) return null;
    return { use: prev.t === '=' || prev.t === '<=>' ? 'eq' : 'range', other: otherOf(lhs) };
  }
  if (arith(prev)) return null;
  if (next?.k === 'kw') {
    if (next.t === 'between') return { use: 'range' };
    if (next.t === 'in' && toks[i + 2]?.t === '(') return { use: 'eq' };
    if (next.t === 'like') {
      const pat = toks[i + 2]?.k === 'ref' && toks[i + 3]?.k === 'str' ? toks[i + 3] : toks[i + 2]; // _utf8mb4'abc%'
      if (pat?.k !== 'str') return null;
      const body = pat.t.slice(1);
      return /^[%_]/.test(body) ? null : { use: 'range' };
    }
    if (next.t === 'is') {
      if (toks[i + 2]?.t === 'null') return { use: 'eq' };
      // IS NOT NULL is left out: the optimizer adds it to join columns, and it rarely narrows much.
    }
  }
  return null;
}

/** ORDER BY columns of a statement's outermost query, when they are plain columns (optionally qualified). */
export function orderByColumns(sql) {
  const toks = tokenize(String(sql));
  let depth = 0, at = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === '(') depth++;
    else if (t.t === ')') depth--;
    else if (depth === 0 && t.k === 'ref' && lc(t.t) === 'order' && toks[i + 1]?.k === 'ref' && lc(toks[i + 1].t) === 'by') at = i + 2;
  }
  if (at < 0) return [];
  const out = [];
  for (let i = at; i < toks.length;) {
    const t = toks[i];
    if (t.k !== 'ref' || ['limit', 'for', 'lock', 'into', 'union'].includes(lc(t.t))) break;
    if (toks[i + 1]?.t === '(') return out; // an expression: stop here
    const col = { column: t.parts[t.parts.length - 1], qualifier: t.parts.length > 1 ? t.parts[t.parts.length - 2] : null, desc: false };
    i++;
    if (toks[i]?.k === 'ref' && ['asc', 'desc'].includes(lc(toks[i].t))) { col.desc = lc(toks[i].t) === 'desc'; i++; }
    out.push(col);
    if (toks[i]?.t !== ',') break;
    i++;
  }
  return out;
}

const NOT_ALIAS = new Set(['where', 'join', 'inner', 'left', 'right', 'cross', 'natural', 'straight_join', 'outer', 'on', 'using', 'set', 'group', 'order', 'limit',
  'union', 'having', 'window', 'for', 'lock', 'partition', 'force', 'use', 'ignore', 'values', 'value', 'select', 'as', 'into', 'returning', 'full', 'except', 'intersect']);

/**
 * Which table each alias in the plan stands for: { alias(lower case): { db, table } }. The optimizer's rewritten query
 * (Note 1003, MySQL) names every table fully; otherwise the statement's FROM / JOIN / UPDATE / INTO clauses are read.
 */
export function resolveTables(statement, notes, defaultDb) {
  const map = {};
  const put = (alias, db, table) => { if (table && !map[lc(alias)]) map[lc(alias)] = { db: db || defaultDb || null, table }; };
  const rewritten = (notes || []).find(n => String(n.code) === '1003')?.message;
  if (rewritten) {
    const re = /(?:\bfrom|\bjoin|\bupdate|\binto|,)\s*\(*\s*(`(?:[^`]|``)+`)\.(`(?:[^`]|``)+`)(?!\.)(?:\s+(?:as\s+)?(`(?:[^`]|``)+`))?/gi;
    let m;
    while ((m = re.exec(rewritten))) put(unquote(m[3] || m[2]), unquote(m[1]), unquote(m[2]));
  }
  const toks = tokenize(String(statement)).filter(t => t.k !== 'str');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'ref' || !['from', 'join', 'straight_join', 'update', 'into'].includes(lc(t.t))) continue;
    for (let j = i + 1; j < toks.length;) {
      while (toks[j]?.t === '(') j++;
      const name = toks[j];
      if (name?.k !== 'ref' || NOT_ALIAS.has(lc(name.t)) || toks[j + 1]?.t === '(') break;
      const parts = name.parts;
      j++;
      let alias = parts[parts.length - 1];
      if (toks[j]?.k === 'ref' && lc(toks[j].t) === 'as') j++;
      if (toks[j]?.k === 'ref' && !NOT_ALIAS.has(lc(toks[j].t))) { alias = toks[j].parts[0]; j++; }
      put(alias, parts.length > 1 ? parts[parts.length - 2] : null, parts[parts.length - 1]);
      if (toks[j]?.t !== ',') break;
      j++;
    }
  }
  return map;
}

/** Plan tables worth an index: scans that matter, joins through a join buffer, and indexes that keep few of the rows read. */
function needsIndex(n) {
  if (n.kind !== 'table' || !n.table || n.table.startsWith('<')) return null;
  if (n.joinBuffer) return 'join';
  if ((n.access === 'ALL' || n.access === 'index') && n.severity !== 'ok') return 'scan';
  if (n.filtered != null && n.filtered < 10 && (n.rows ?? 0) >= 1000) return 'filter';
  return null;
}

/**
 * Candidate indexes, one per plan table that needs one: { nodeId, alias, db, table, columns: [{ name, use }], reason }.
 * `r` is the /explain response, `root` its parsed plan.
 */
export function suggestIndexes(r, root) {
  if (!root) return [];
  const map = resolveTables(r.statement, r.notes, r.database);
  const planTables = [];
  walk(root, n => { if (n.kind === 'table') planTables.push(n); });
  const single = planTables.length === 1;
  const order = orderByColumns(r.statement);
  const out = [];
  const seen = new Set();
  for (const n of planTables) {
    const why = needsIndex(n);
    if (!why) continue;
    const alias = n.table;
    const mine = c => (c.qualifier == null ? single : lc(c.qualifier) === lc(alias));
    const cond = [n.condition, n.joinCondition].filter(Boolean).flatMap(conditionColumns)
      .filter(c => mine(c) && (c.other == null || c.other === '' ? true : lc(c.other) !== lc(alias)));
    const eq = [], range = [];
    for (const c of cond) {
      const list = c.use === 'eq' ? eq : range;
      if (!eq.some(x => lc(x) === lc(c.column)) && !list.some(x => lc(x) === lc(c.column))) list.push(c.column);
    }
    const cols = eq.map(name => ({ name, use: 'eq' }));
    // Join columns another table looks up by ("ref": ["shop.o.customer_id"]): indexed, the join could start there.
    for (const other of planTables) {
      if (other === n) continue;
      for (const ref of other.ref) {
        const parts = String(ref).split('.');
        const col = parts[parts.length - 1];
        if (parts.length >= 2 && lc(parts[parts.length - 2]) === lc(alias) && !cols.some(c => lc(c.name) === lc(col))) cols.push({ name: col, use: 'join' });
      }
    }
    const rangeCol = range.find(x => !cols.some(e => lc(e.name) === lc(x)));
    if (rangeCol) cols.push({ name: rangeCol, use: 'range' });
    else if (order.length && order.every(mine) && order.every(o => o.desc === order[0].desc)) {
      for (const o of order) if (!cols.some(c => lc(c.name) === lc(o.column))) cols.push({ name: o.column, use: 'order' });
    }
    if (!cols.length) continue;
    const target = map[lc(alias)] || { db: r.database || null, table: alias };
    const key = lc(`${target.db}.${target.table}:${cols.map(c => c.name).join(',')}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ nodeId: n.id, alias, db: target.db, table: target.table, columns: cols.slice(0, MAX_COLUMNS), reason: why });
  }
  return out;
}

const q = s => '`' + String(s).replace(/`/g, '``') + '`';

/**
 * A candidate checked against the table (an /table response): unknown columns dropped, TEXT / BLOB columns given a
 * prefix, and an existing index with the same leading columns reported instead of a duplicate.
 * Returns null when nothing indexable is left, or { …candidate, columns, existing, name, sql }.
 */
export function finishSuggestion(cand, meta) {
  if (!meta || meta.isView) return null;
  const byName = new Map((meta.columns || []).map(c => [lc(c.name), c]));
  const cols = [];
  for (const c of cand.columns) {
    const m = byName.get(lc(c.name));
    if (!m || /^(json|geometry|point|linestring|polygon|multi\w+|geometrycollection)\b/i.test(m.type)) continue;
    cols.push({ ...c, name: m.name, prefix: /text|blob/i.test(m.type) ? PREFIX : null });
  }
  if (!cols.length) return null;
  const want = cols.map(c => lc(c.name));
  const existing = (meta.indexes || []).find(ix => {
    const have = (ix.columns || []).map(c => lc(c.name ?? ''));
    return want.every((w, i) => have[i] === w);
  });
  const names = new Set((meta.indexes || []).map(ix => lc(ix.name)));
  let name = ('idx_' + cols.map(c => c.name).join('_')).replace(/[^\w$]/g, '_').slice(0, 60);
  for (let i = 2; names.has(lc(name)); i++) name = name.slice(0, 57) + '_' + i;
  const list = cols.map(c => q(c.name) + (c.prefix ? `(${c.prefix})` : '')).join(', ');
  const table = cand.db ? `${q(cand.db)}.${q(cand.table)}` : q(cand.table);
  return { ...cand, columns: cols, existing: existing?.name ?? null, name, sql: `ALTER TABLE ${table} ADD INDEX ${q(name)} (${list})` };
}

/** "status = …, customer_id = …, then created as a range" – how the index would be used, for the suggestion's text. */
export function describeColumns(cols) {
  const eq = cols.filter(c => c.use === 'eq').map(c => c.name);
  const range = cols.filter(c => c.use === 'range').map(c => c.name);
  const join = cols.filter(c => c.use === 'join').map(c => c.name);
  const order = cols.filter(c => c.use === 'order').map(c => c.name);
  const parts = [];
  if (eq.length) parts.push(`looks up ${eq.join(', ')}`);
  if (join.length) parts.push(`${parts.length ? 'then ' : ''}finds the rows matching the joined table by ${join.join(', ')}`);
  if (range.length) parts.push(`${parts.length ? 'then ' : ''}narrows ${range.join(', ')} to a range`);
  if (order.length) parts.push(`${parts.length ? 'then ' : ''}returns rows already sorted by ${order.join(', ')}`);
  return parts.join(', ');
}
