// Visual EXPLAIN: turns MySQL's and MariaDB's JSON plans (and MySQL's EXPLAIN ANALYZE tree) into one tree of
// steps, and finds what deserves attention. Pure functions (no DOM), unit-tested in tests/js.

/** Access types: label for people, and how good they are. */
export const ACCESS = {
  system: ['Single row (system table)', 'good'],
  const: ['Single row (constant)', 'good'],
  eq_ref: ['Unique key lookup', 'good'],
  ref: ['Key lookup', 'good'],
  ref_or_null: ['Key lookup (or NULL)', 'good'],
  fulltext: ['Full-text index', 'good'],
  unique_subquery: ['Unique key lookup (subquery)', 'good'],
  index_subquery: ['Key lookup (subquery)', 'good'],
  index_merge: ['Index merge', 'ok'],
  range: ['Index range scan', 'ok'],
  hash_ALL: ['Hash join', 'warning'],
  hash_index: ['Hash join (index)', 'ok'],
  index: ['Full index scan', 'warning'],
  ALL: ['Full table scan', 'critical'],
};

const SUBQUERY_KEYS = {
  attached_subqueries: 'in WHERE',
  select_list_subqueries: 'in SELECT list',
  having_subqueries: 'in HAVING',
  order_by_subqueries: 'in ORDER BY',
  group_by_subqueries: 'in GROUP BY',
  optimized_away_subqueries: 'optimized away',
  subqueries: '',
};

const num = v => (v == null || v === '' ? null : Number(v));
let seq = 0;
const node = (kind, title, extra = {}) => ({ id: ++seq, kind, title, flags: [], children: [], ...extra });

/** Label and severity of a table access; a full scan of a few rows is no concern. */
export function accessInfo(access, rows) {
  const [label, sev] = ACCESS[access] || [access || 'Unknown access', 'ok'];
  if (access === 'ALL' || access === 'index') {
    if (rows != null && rows < 100) return { label, severity: 'ok' };
    if (rows != null && rows < 10_000) return { label, severity: 'warning' };
  }
  return { label, severity: sev };
}

/** A friendlier name for the optimizer's internal tables (<derived2>, <union1,2>, <subquery3>). */
export function tableTitle(name) {
  let m;
  if ((m = /^<derived(\d+)>$/.exec(name))) return `derived table #${m[1]}`;
  if ((m = /^<union([\d,]+)>$/.exec(name))) return `union of #${m[1].split(',').join(', #')}`;
  if ((m = /^<subquery(\d+)>$/.exec(name))) return `materialized subquery #${m[1]}`;
  if (name === '<temporary>') return 'temporary table';
  return name;
}

// ---------------------------------------------------------------- JSON plans

/** The plan as a tree: blocks (SELECTs), operations (join, sort, group …), tables and subqueries. */
export function parsePlan(json) {
  const doc = typeof json === 'string' ? JSON.parse(json) : json;
  seq = 0;
  const root = doc.query_block ? block(doc.query_block) : node('message', 'Empty plan');
  if (doc.query_optimization?.r_total_time_ms != null) root.optimizeMs = num(doc.query_optimization.r_total_time_ms);
  return root;
}

function block(qb) {
  const n = node('block', `${qb.operation ? qb.operation + ' ' : ''}SELECT #${qb.select_id ?? '?'}`);
  n.cost = num(qb.cost_info?.query_cost ?? qb.cost);
  if (qb.r_total_time_ms != null) n.actual = { timeMs: num(qb.r_total_time_ms), loops: num(qb.r_loops) };
  if (qb.having_condition) n.condition = 'HAVING ' + qb.having_condition;
  n.children = content(qb);
  return n;
}

function content(o) {
  const out = [];
  if (o.message) out.push(node('message', o.message));
  if (o.table) out.push(table(o.table));
  if (o['block-nl-join']) out.push(bufferedJoin(o['block-nl-join']));
  if (o.nested_loop) {
    const items = o.nested_loop.flatMap(content);
    out.push(items.length === 1 ? items[0] : node('op', 'Nested loop join', { children: items, sub: 'tables are read in this order, left to right' }));
  }
  const ops = [
    ['ordering_operation', 'Sort (ORDER BY)'], ['grouping_operation', 'Group (GROUP BY)'], ['duplicates_removal', 'Remove duplicates (DISTINCT)'],
    ['windowing', 'Window functions'], ['buffer_result', 'Buffer result'],
  ];
  for (const [k, title] of ops) if (o[k]) out.push(operation(title, o[k]));
  if (o.filesort) {
    const f = o.filesort;
    const n = node('op', 'Sort', { sub: f.sort_key, children: content(f) });
    n.flags.push('filesort');
    if (f.r_total_time_ms != null) n.actual = { timeMs: num(f.r_total_time_ms), loops: num(f.r_loops), rows: num(f.r_output_rows) };
    out.push(n);
  }
  if (o.temporary_table) {
    const n = node('op', 'Temporary table', { children: content(o.temporary_table) });
    n.flags.push('temporary table');
    out.push(n);
  }
  if (o.read_sorted_file) out.push(...content(o.read_sorted_file));
  if (o.union_result) {
    const u = o.union_result;
    const n = node('union', u.using_temporary_table === false ? 'UNION ALL' : 'UNION', {
      sub: u.table_name ? tableTitle(u.table_name) : null,
      children: (u.query_specifications || []).map(q => block(q.query_block)),
    });
    if (u.using_temporary_table) n.flags.push('temporary table');
    out.push(n);
  }
  out.push(...subqueries(o));
  return out;
}

function operation(title, inner) {
  const n = node('op', title, { children: content(inner) });
  if (inner.using_filesort) n.flags.push('filesort');
  if (inner.using_temporary_table) n.flags.push('temporary table');
  if (inner.windows) n.sub = `${inner.windows.length} window${inner.windows.length === 1 ? '' : 's'}`;
  return n;
}

/** MariaDB's block nested loop / hash join: a table matched through a join buffer. */
function bufferedJoin(j) {
  const t = table(j.table);
  t.flags.push(`join buffer (${j.join_type || 'BNL'})`);
  t.joinBuffer = j.join_type || 'BNL';
  if (j.attached_condition) t.joinCondition = j.attached_condition;
  return t;
}

function subqueries(o) {
  const out = [];
  for (const [key, where] of Object.entries(SUBQUERY_KEYS)) {
    for (const sq of o[key] || []) {
      const cache = sq.subquery_cache || sq.expression_cache;
      const q = sq.query_block || cache?.query_block;
      if (!q) continue;
      // MariaDB caches only correlated subqueries, so a cache means "dependent".
      const dependent = sq.dependent ?? !!cache;
      const n = node('subquery', `${dependent ? 'Dependent subquery' : 'Subquery'}${where ? ' ' + where : ''}`, { children: [block(q)], dependent });
      if (dependent) n.flags.push('runs per outer row');
      if (sq.cacheable === false) n.flags.push('not cacheable');
      out.push(n);
    }
  }
  return out;
}

function table(t) {
  if (t.message && !t.table_name) return node('message', t.message);
  const rows = num(t.rows_examined_per_scan ?? t.rows);
  const { label, severity } = accessInfo(t.access_type, rows);
  const n = node('table', tableTitle(t.table_name), {
    table: t.table_name, access: t.access_type, accessLabel: label, severity,
    key: t.key ?? null, possibleKeys: t.possible_keys || [], keyParts: t.used_key_parts || [], keyLength: t.key_length ?? null,
    ref: t.ref || [], rows, produced: num(t.rows_produced_per_join), loops: num(t.loops), filtered: num(t.filtered),
    cost: num(t.cost_info?.prefix_cost ?? t.cost),
    selfCost: t.cost_info ? (num(t.cost_info.read_cost) ?? 0) + (num(t.cost_info.eval_cost) ?? 0) : num(t.cost),
    condition: t.attached_condition ?? null, indexCondition: t.index_condition ?? null,
  });
  if (t.update) n.statement = 'UPDATE';
  if (t.delete) n.statement = 'DELETE';
  if (t.insert) n.statement = 'INSERT';
  if (t.using_index) n.flags.push('covering index');
  if (t.using_index_condition || t.index_condition) n.flags.push('index condition pushdown');
  if (t.using_join_buffer) { n.flags.push(`join buffer (${t.using_join_buffer})`); n.joinBuffer = t.using_join_buffer; }
  if (t.using_MRR) n.flags.push('multi-range read');
  if (t.using_filesort) n.flags.push('filesort');
  if (t.using_temporary_table) n.flags.push('temporary table');
  if (t.distinct) n.flags.push('distinct');
  if (t.first_match) n.flags.push(`first match (${t.first_match})`);
  if (t.loose_scan) n.flags.push('loose scan');
  if (t.r_rows != null || t.r_loops != null) {
    n.actual = {
      rows: num(t.r_rows), loops: num(t.r_loops), filtered: num(t.r_filtered),
      timeMs: t.r_total_time_ms != null ? num(t.r_total_time_ms) : t.r_table_time_ms != null ? num(t.r_table_time_ms) + (num(t.r_other_time_ms) ?? 0) : null,
    };
  }
  const mat = t.materialized_from_subquery || t.materialized;
  if (mat?.query_block) {
    const m = node('subquery', mat.dependent ? 'Dependent derived table' : 'Materialized from', { children: [block(mat.query_block)], dependent: !!mat.dependent });
    if (mat.using_temporary_table !== false) m.flags.push('temporary table');
    n.children.push(m);
  }
  n.children.push(...subqueries(t));
  return n;
}

/** Every node of the tree, depth first. */
export function walk(root, fn, parent = null) {
  fn(root, parent);
  for (const c of root.children) walk(c, fn, root);
}

// ---------------------------------------------------------------- what to look at

const fmt = n => Math.round(n).toLocaleString('en-US');

/** Findings, most severe first: { severity: 'critical'|'warning'|'info', text, hint, nodeId }. */
export function findIssues(root) {
  const issues = [];
  const add = (severity, text, hint, n) => issues.push({ severity, text, hint, nodeId: n?.id ?? null });
  walk(root, n => {
    if (n.kind === 'table') {
      const name = n.title;
      if (n.access === 'ALL' && n.severity !== 'ok') {
        add(n.severity === 'critical' ? 'critical' : 'warning', `Full table scan of ${name} (${fmt(n.rows ?? 0)} rows per scan)`,
          n.possibleKeys.length ? `Indexes exist (${n.possibleKeys.join(', ')}) but the optimizer reads the whole table – the condition may not be selective, or doesn't match the index.`
            : 'No index fits its condition. An index on the columns used in WHERE or JOIN for this table could avoid reading every row.', n);
      } else if (n.access === 'index' && n.severity !== 'ok') {
        add('warning', `Full index scan of ${name} (${fmt(n.rows ?? 0)} rows)`, 'Reads every entry of an index: cheaper than the table, but still everything.', n);
      }
      if (n.joinBuffer) {
        add('warning', `${name} is joined without an index (${n.joinBuffer})`, 'Rows are matched in a join buffer. An index on its join column makes this a key lookup.', n);
      }
      if (n.filtered != null && n.filtered < 10 && (n.rows ?? 0) >= 1000 && !['ALL', 'index'].includes(n.access)) {
        add('warning', `${name}: reads ${fmt(n.rows)} rows but keeps only ${n.filtered}%`, 'A more selective index (covering the filtered columns) could read fewer rows.', n);
      }
      if (n.actual?.rows != null && n.rows != null) {
        const est = Math.max(1, n.rows), real = Math.max(1, n.actual.rows);
        if ((real / est >= 10 || est / real >= 10) && Math.max(est, real) >= 100) {
          add('warning', `${name}: estimated ${fmt(n.rows)} rows, actually ${fmt(n.actual.rows)}`, 'Stale statistics mislead the optimizer: running ANALYZE TABLE on this table may produce a better plan.', n);
        }
      }
    }
    if (n.flags.includes('filesort') && n.kind !== 'table') add('info', n.title === 'Sort' ? 'Rows are sorted with a filesort' : `${n.title} sorts rows (filesort)`, 'An index whose columns match the ORDER BY / GROUP BY could deliver rows already sorted.', n);
    if (n.flags.includes('temporary table')) add('info', n.title === 'Temporary table' ? 'Rows go through a temporary table' : `${n.title} uses a temporary table`, 'Large temporary tables spill to disk; check GROUP BY, DISTINCT and UNION columns.', n);
    if (n.kind === 'subquery' && n.dependent) add('warning', `${n.title} runs once for every row of the outer query`, 'Rewriting it as a JOIN (or making it non-correlated) often helps a lot.', n);
    if (n.kind === 'message' && /impossible/i.test(n.title)) add('info', n.title, 'The optimizer proved that no row can match.', n);
  });
  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Total estimated cost of the plan (the root block's), for cost shares of tables. */
export function totalCost(root) {
  if (root.cost != null) return root.cost;
  let sum = 0;
  walk(root, n => { if (n.kind === 'table' && n.selfCost) sum += n.selfCost; });
  return sum || null;
}

/** Tables in the plan, for the summary line. */
export function tables(root) {
  const out = [];
  walk(root, n => { if (n.kind === 'table') out.push(n); });
  return out;
}

// ---------------------------------------------------------------- MySQL EXPLAIN ANALYZE (tree)

const COST_RE = /\s*\(cost=([\d.e+-]+)(?:\.\.([\d.e+-]+))? rows=([\d.e+-]+)\)/;
const ACTUAL_RE = /\s*\(actual time=([\d.e+-]+)\.\.([\d.e+-]+) rows=([\d.e+-]+) loops=(\d+)\)/;

/**
 * MySQL's EXPLAIN ANALYZE output as steps: { label, depth, estimate: {cost, rows}, actual: {firstMs, lastMs, rows, loops,
 * totalMs}, neverExecuted, children }. Times are per loop as MySQL reports them; totalMs multiplies by loops.
 */
export function parseAnalyzeTree(text) {
  const roots = [], stack = [];
  for (const line of String(text).split('\n')) {
    const m = /^(\s*)-> (.*)$/.exec(line);
    if (!m) continue;
    let rest = m[2];
    const step = { label: '', depth: Math.floor(m[1].length / 4), estimate: null, actual: null, neverExecuted: false, children: [] };
    const c = COST_RE.exec(rest);
    if (c) { step.estimate = { cost: Number(c[2] ?? c[1]), rows: Number(c[3]) }; rest = rest.replace(COST_RE, ''); }
    const a = ACTUAL_RE.exec(rest);
    if (a) {
      const loops = Number(a[4]);
      step.actual = { firstMs: Number(a[1]), lastMs: Number(a[2]), rows: Number(a[3]), loops, totalMs: Number(a[2]) * loops };
      rest = rest.replace(ACTUAL_RE, '');
    }
    if (/\(never executed\)/.test(rest)) { step.neverExecuted = true; rest = rest.replace(/\s*\(never executed\)/, ''); }
    step.label = rest.trim();
    while (stack.length && stack[stack.length - 1].depth >= step.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(step);
    stack.push(step);
  }
  return roots;
}

/** Flattens the analyze tree for an indented table, with the time share of the slowest step. */
export function flattenSteps(roots) {
  const out = [];
  const visit = s => { out.push(s); s.children.forEach(visit); };
  roots.forEach(visit);
  return out;
}

/** Steps whose row estimate was off by 10× or more (with enough rows to matter). */
export function misestimates(steps) {
  return steps.filter(s => s.estimate && s.actual && Math.max(s.estimate.rows, s.actual.rows * s.actual.loops) >= 100
    && (Math.max(1, s.actual.rows) / Math.max(1, s.estimate.rows) >= 10 || Math.max(1, s.estimate.rows) / Math.max(1, s.actual.rows) >= 10));
}
