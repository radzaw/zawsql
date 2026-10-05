// Partition editor for the Table tab: model, SQL generation and UI, including subpartitions.
import { h, qi, sqlStr, fmtBytes, fmtNum } from '../util.js';
import { icon } from '../icons.js';

export const METHODS = ['RANGE', 'RANGE COLUMNS', 'LIST', 'LIST COLUMNS', 'HASH', 'LINEAR HASH', 'KEY', 'LINEAR KEY'];
/** Only RANGE and LIST partitions can be subpartitioned, and only by HASH or KEY. */
export const SUB_METHODS = ['HASH', 'LINEAR HASH', 'KEY', 'LINEAR KEY'];
const hasPartitionList = m => m.startsWith('RANGE') || m.startsWith('LIST');
const usesCount = m => m.endsWith('HASH') || m.endsWith('KEY');

const HINTS = {
  'RANGE': ['Expression:', 'e.g. YEAR(created_at)', 'Integer expression. Partition values: an integer, or MAXVALUE for the last partition.'],
  'RANGE COLUMNS': ['Columns:', 'e.g. `created_at` or `a`, `b`', 'Column list. Partition values: one literal per column, e.g. \'2025-01-01\' or MAXVALUE.'],
  'LIST': ['Expression:', 'e.g. region_id', 'Integer expression. Partition values: comma separated integers, e.g. 1, 2, 3.'],
  'LIST COLUMNS': ['Columns:', 'e.g. `country`', 'Column list. Partition values: literals, e.g. \'pl\', \'de\' – or (1, \'a\'), (2, \'b\') for several columns.'],
  'HASH': ['Expression:', 'e.g. id', 'Integer expression; rows are spread over the given number of partitions.'],
  'LINEAR HASH': ['Expression:', 'e.g. id', 'Integer expression; rows are spread over the given number of partitions.'],
  'KEY': ['Columns:', 'empty = primary key', 'Column list hashed by the server; leave empty to use the primary key.'],
  'LINEAR KEY': ['Columns:', 'empty = primary key', 'Column list hashed by the server; leave empty to use the primary key.'],
};

/** The name the server gives subpartition i of a partition when they aren't named explicitly. */
export const autoSubName = (part, i) => `${part}sp${i}`;
const names = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);
const isSubpartitioned = p => hasPartitionList(p.method) && !!p.sub?.method;

/**
 * How the subpartitions are laid out: named explicitly, or by the server (SUBPARTITIONS n). Names that are exactly
 * the ones the server would generate (p0sp0, p0sp1 …, same count everywhere) are the same as letting it name them.
 */
export function subLayout(p) {
  if (!p.sub.named) return { named: false, count: Math.max(1, parseInt(p.sub.count, 10) || 1) };
  const lists = p.parts.map(x => names(x.subs));
  const n = lists[0]?.length ?? 0;
  const auto = n > 0 && lists.every((l, i) => l.length === n && l.every((s, k) => s === autoSubName(p.parts[i].name, k)));
  return { named: !auto, count: n };
}

const subKey = p => {
  if (!isSubpartitioned(p)) return '';
  const l = subLayout(p);
  return JSON.stringify([p.sub.method, p.sub.expr.trim(), l.named ? 0 : l.count, l.named]);
};
const partKey = (p, x) => JSON.stringify([x.name, x.values.trim(), x.comment, isSubpartitioned(p) && subLayout(p).named ? names(x.subs).join(',') : '']);
const modelKey = p => JSON.stringify([p.method, p.expr.trim(), usesCount(p.method) ? +p.count : p.parts.map(x => partKey(p, x)), subKey(p)]);

function snapshot(p) {
  p.orig = modelKey(p);
  p.origMethod = p.method;
  p.origExpr = p.expr.trim();
  p.origParts = p.parts.map(x => partKey(p, x));
  p.origSub = subKey(p);
  return p;
}

/** Why the editor can't safely change this table's partitioning, or null. */
function lockReason(meta) {
  if (!METHODS.includes(meta.method)) return `Partitioning method ${meta.method} is not supported by the editor.`;
  if (!meta.subMethod) return null;
  if (!SUB_METHODS.includes(meta.subMethod)) return `Subpartitioning method ${meta.subMethod} is not supported by the editor.`;
  if (meta.partitions.some(x => new Set(x.subComments ?? []).size > 1)) {
    return 'Some subpartitions have their own comments. The editor doesn\'t model those, so editing is disabled to avoid losing them; use a query tab instead.';
  }
  if (new Set(meta.partitions.map(x => (x.subNames ?? []).length)).size > 1) return 'The partitions have different numbers of subpartitions, which the editor doesn\'t model.';
  return null;
}

/** Builds the editable model from the server's partitioning info (null = not partitioned). */
export function buildPartModel(meta) {
  if (!meta) return snapshot({ method: '', expr: '', count: 4, parts: [], locked: null, sub: { method: '', expr: '', count: 2, named: false } });
  const subs = !!meta.subMethod;
  const parts = meta.partitions.map(x => ({
    name: x.name,
    values: x.description ?? '',
    // A subpartition without a comment of its own reports the partition's.
    comment: (subs ? x.subComments?.[0] : null) ?? x.comment ?? '',
    subs: (x.subNames ?? []).join(', '),
    rows: x.rows, size: x.size, isNew: false,
  }));
  const named = subs && meta.partitions.some(x => (x.subNames ?? []).some((n, i) => n !== autoSubName(x.name, i)));
  return snapshot({
    method: meta.method,
    expr: meta.expression,
    count: meta.partitions.length,
    locked: lockReason(meta),
    parts,
    sub: { method: meta.subMethod ?? '', expr: meta.subExpression ?? '', count: meta.partitions[0]?.subNames?.length || 2, named },
  });
}

export const partChanged = p => !p.locked && modelKey(p) !== p.orig;

function partDef(p, x) {
  const v = x.values.trim();
  const vals = p.method.startsWith('RANGE')
    ? `VALUES LESS THAN ${p.method === 'RANGE' && /^maxvalue$/i.test(v) ? 'MAXVALUE' : `(${v})`}`
    : `VALUES IN (${v})`;
  const subs = isSubpartitioned(p) && subLayout(p).named ? ` (${names(x.subs).map(n => `SUBPARTITION ${qi(n)}`).join(', ')})` : '';
  return `PARTITION ${qi(x.name)} ${vals}${x.comment ? ' COMMENT = ' + sqlStr(x.comment) : ''}${subs}`;
}

/** SUBPARTITION BY … (and SUBPARTITIONS n when the server names them), or ''. */
function subClause(p) {
  if (!isSubpartitioned(p)) return '';
  const s = `SUBPARTITION BY ${p.sub.method} (${p.sub.expr.trim()})`;
  const l = subLayout(p);
  return l.named ? s : `${s}\nSUBPARTITIONS ${l.count}`;
}

/** The PARTITION BY clause for CREATE TABLE / ALTER TABLE, or '' when not partitioned. */
export function partitionClause(p) {
  if (!p.method) return '';
  const s = `PARTITION BY ${p.method} (${p.expr.trim()})`;
  if (usesCount(p.method)) return `${s} PARTITIONS ${Math.max(1, parseInt(p.count, 10) || 1)}`;
  const sub = subClause(p);
  return `${s}${sub ? '\n' + sub : ''} (\n\t${p.parts.map(x => partDef(p, x)).join(',\n\t')}\n)`;
}

/** What has to be fixed before the partitioning can be saved (the server would refuse it otherwise). */
export function partitionProblems(p) {
  if (p.locked || !isSubpartitioned(p)) return [];
  const out = [];
  if (!p.sub.expr.trim()) out.push(p.sub.method.endsWith('KEY') ? 'Subpartitioning by KEY needs one or more columns.' : 'Enter the expression to subpartition by.');
  if (!p.sub.named) {
    if (!(parseInt(p.sub.count, 10) >= 1)) out.push('Each partition needs at least one subpartition.');
    return out;
  }
  // Named subpartitions: the same number in every partition, every name unique (partition names included).
  const counts = p.parts.map(x => names(x.subs).length);
  if (counts.some(c => c === 0)) out.push(`Name the subpartitions of every partition (${p.parts.filter((x, i) => !counts[i]).map(x => x.name).join(', ')} has none).`);
  else if (new Set(counts).size > 1) out.push('Every partition needs the same number of subpartitions.');
  const seen = new Set(p.parts.map(x => x.name.toLowerCase()));
  for (const n of p.parts.flatMap(x => names(x.subs))) {
    if (seen.has(n.toLowerCase())) { out.push(`The name ${n} is used twice; partition and subpartition names must all differ.`); break; }
    seen.add(n.toLowerCase());
  }
  return out;
}

/**
 * Statements applying partitioning changes to an existing table. Appending RANGE/LIST partitions uses
 * ADD PARTITION (new partitions get their subpartitions too); anything else redefines the partitioning, which the
 * server refuses if rows would no longer fit any partition (so removing a partition never silently deletes data,
 * unlike DROP PARTITION). Subpartitioning can only change by redefining.
 */
export function partitionAlter(p, tbl) {
  if (!partChanged(p)) return [];
  if (!p.method) return p.origMethod ? [`ALTER TABLE ${tbl} REMOVE PARTITIONING`] : [];
  const appendOnly = p.origMethod === p.method && p.origExpr === p.expr.trim() && hasPartitionList(p.method) && p.origSub === subKey(p)
    && p.parts.length > p.origParts.length && p.origParts.every((k, i) => k === partKey(p, p.parts[i]));
  if (appendOnly) {
    const added = p.parts.slice(p.origParts.length);
    return [`ALTER TABLE ${tbl} ADD PARTITION (\n\t${added.map(x => partDef(p, x)).join(',\n\t')}\n)`];
  }
  return [`ALTER TABLE ${tbl}\n${partitionClause(p)}`];
}

/** Renders the Partitions subtab. `view` is the TableView (for change notification). */
export function renderPartitions(view, p) {
  const locked = !!p.locked;
  p.sub ??= { method: '', expr: '', count: 2, named: false };
  const method = h('select', { class: 'inp', disabled: locked },
    h('option', { value: '' }, '(not partitioned)'), METHODS.map(m => h('option', { value: m, selected: m === p.method }, m)));
  const expr = h('input', { class: 'inp mono', value: p.expr, spellcheck: false, disabled: locked });
  const count = h('input', { class: 'inp', type: 'number', min: 1, max: 8192, value: p.count, disabled: locked });
  const exprLabel = h('span');
  const hint = h('div', { class: 'muted part-hint' });
  const exprRow = h('label', { class: 'frow' }, exprLabel, expr);
  const countRow = h('label', { class: 'frow' }, h('span', null, 'Partitions:'), count);

  // Subpartitioning (RANGE / LIST only).
  const subMethod = h('select', { class: 'inp', disabled: locked },
    h('option', { value: '' }, '(none)'), SUB_METHODS.map(m => h('option', { value: m, selected: m === p.sub.method }, m)));
  const subExpr = h('input', { class: 'inp mono', value: p.sub.expr, spellcheck: false, disabled: locked });
  const subCount = h('input', { class: 'inp', type: 'number', min: 1, max: 1024, value: p.sub.count, disabled: locked });
  const subNamed = h('input', { type: 'checkbox', checked: !!p.sub.named, disabled: locked });
  const subExprLabel = h('span');
  // Part of the same compact form as the partitioning (the pane above the columns is short).
  const subMethodRow = h('label', { class: 'frow part-sub-method' }, h('span', null, 'Subpartition by:'), subMethod);
  const subExprRow = h('label', { class: 'frow part-sub-expr' }, subExprLabel, subExpr);
  const subCountRow = h('label', { class: 'frow part-sub-count' }, h('span', null, 'Subpartitions:'), subCount);
  const subNamedRow = h('label', { class: 'frow part-sub-named' }, h('span', null, ''), h('label', { class: 'chk', title: 'Otherwise the server names them <partition>sp0, <partition>sp1, …' }, subNamed, ' Name the subpartitions myself'));
  const problems = h('div', { class: 'part-problems' });

  const tbody = h('tbody');
  let sel = 0;

  const notify = () => { view.changed(); view.renderSubtabs(); showProblems(); };
  const btn = (ic, label, fn) => h('button', { class: 'tbtn', disabled: locked, html: icon(ic) + `<span>${label}</span>`, onclick: fn });
  const listBar = h('div', { class: 'viewbar small' },
    btn('plus', 'Add partition', () => {
      let n = p.parts.length;
      while (p.parts.some(x => x.name === 'p' + n)) n++;
      const name = 'p' + n;
      // Named subpartitions: start the new partition with names of its own.
      const subs = isSubpartitioned(p) && p.sub.named ? Array.from({ length: Math.max(1, names(p.parts[sel]?.subs).length || +p.sub.count || 1) }, (_, i) => autoSubName(name, i)).join(', ') : '';
      p.parts.splice(sel + 1, 0, { name, values: '', comment: '', subs, isNew: true });
      sel = Math.min(sel + 1, p.parts.length - 1);
      drawList();
      notify();
      tbody.children[sel]?.querySelectorAll('input')[1]?.focus();
    }),
    btn('minus', 'Remove', () => {
      if (!p.parts.length) return;
      p.parts.splice(sel, 1);
      sel = Math.max(0, Math.min(sel, p.parts.length - 1));
      drawList();
      notify();
    }),
    btn('up', 'Up', () => move(-1)),
    btn('down', 'Down', () => move(1)));
  const table = h('table', { class: 'edit-table' });
  const listBox = h('div', { class: 'tv-list' }, listBar, table);

  function move(d) {
    const j = sel + d;
    if (j < 0 || j >= p.parts.length) return;
    [p.parts[sel], p.parts[j]] = [p.parts[j], p.parts[sel]];
    sel = j;
    drawList();
    notify();
  }

  function showProblems() {
    const list = partitionProblems(p);
    problems.replaceChildren(...list.map(t => h('div', null, h('span', { html: icon('warning') }), h('span', null, t))));
    problems.style.display = list.length ? '' : 'none';
  }

  function drawList() {
    const valuesLabel = p.method.startsWith('RANGE') ? 'VALUES LESS THAN' : 'VALUES IN';
    const subs = isSubpartitioned(p);
    const heads = ['#', 'Name', valuesLabel, 'Comment', ...(subs ? ['Subpartitions'] : []), 'Rows', 'Size'];
    table.replaceChildren(h('thead', null, h('tr', null, heads.map(t => h('th', null, t)))), tbody);
    tbody.replaceChildren(...p.parts.map((x, i) => {
      const inp = (key, ph = '') => {
        const el = h('input', { class: 'cell-inp' + (key === 'values' || key === 'subs' ? ' mono' : ''), value: x[key] ?? '', spellcheck: false, placeholder: ph, disabled: locked });
        el.addEventListener('input', () => {
          x[key] = el.value;
          view.changed();
          if (key === 'subs' || key === 'name') showProblems();
          if (key === 'name' && subs && !p.sub.named) subCell.textContent = autoNames(x);
        });
        return el;
      };
      const autoNames = row => Array.from({ length: Math.max(1, parseInt(p.sub.count, 10) || 1) }, (_, k) => autoSubName(row.name, k)).join(', ');
      // Named: editable list of names; otherwise the names the server will give them.
      const subCell = !subs ? null : p.sub.named ? inp('subs', 's0, s1') : h('span', { class: 'muted mono', title: 'Named by the server' }, autoNames(x));
      const ph = p.method === 'RANGE' ? '100 or MAXVALUE' : p.method === 'RANGE COLUMNS' ? "'2025-01-01' or MAXVALUE" : "1, 2 or 'a', 'b'";
      const tr = h('tr', { class: (i === sel ? 'sel' : '') + (x.isNew ? ' new' : '') },
        h('td', { class: 'num' }, i + 1), h('td', null, inp('name')), h('td', null, inp('values', ph)), h('td', null, inp('comment')),
        subs ? h('td', null, subCell) : null,
        h('td', { class: 'num' }, x.isNew ? '' : fmtNum(x.rows)), h('td', { class: 'num' }, x.isNew ? '' : fmtBytes(x.size)));
      tr.addEventListener('mousedown', () => {
        sel = i;
        for (const r of tbody.children) r.classList.remove('sel');
        tr.classList.add('sel');
      });
      return tr;
    }));
  }

  function draw() {
    const m = p.method;
    const [label, placeholder, text] = HINTS[m] || ['Expression:', '', ''];
    exprLabel.textContent = label;
    expr.placeholder = placeholder;
    hint.textContent = m ? text + ' Every unique key, including the primary key, must contain all columns used for partitioning (and subpartitioning).' : 'The table is not partitioned.';
    exprRow.style.display = m ? '' : 'none';
    countRow.style.display = usesCount(m) ? '' : 'none';
    listBox.style.display = hasPartitionList(m) ? '' : 'none';
    const sm = hasPartitionList(m) ? p.sub.method : '';
    subMethodRow.style.display = hasPartitionList(m) ? '' : 'none';
    subExprLabel.textContent = sm.endsWith('KEY') ? 'Columns:' : 'Expression:';
    subExpr.placeholder = sm.endsWith('KEY') ? 'e.g. `id` (required)' : 'e.g. id or TO_DAYS(created_at)';
    for (const r of [subExprRow, subNamedRow]) r.style.display = sm ? '' : 'none';
    subCountRow.style.display = sm && !p.sub.named ? '' : 'none';
    drawList();
    showProblems();
  }

  method.addEventListener('change', () => {
    p.method = method.value;
    if (hasPartitionList(p.method) && !p.parts.length) p.parts.push({ name: 'p0', values: '', comment: '', subs: '', isNew: true });
    draw();
    notify();
  });
  expr.addEventListener('input', () => { p.expr = expr.value; view.changed(); });
  count.addEventListener('input', () => { p.count = count.value; view.changed(); notify(); });
  subMethod.addEventListener('change', () => { p.sub.method = subMethod.value; draw(); notify(); });
  subExpr.addEventListener('input', () => { p.sub.expr = subExpr.value; view.changed(); showProblems(); });
  subCount.addEventListener('input', () => { p.sub.count = subCount.value; drawList(); notify(); });
  subNamed.addEventListener('change', () => {
    p.sub.named = subNamed.checked;
    // Switching to names: start from the names the server would have given (or has given) them.
    if (p.sub.named) {
      for (const x of p.parts) {
        if (!names(x.subs).length) x.subs = Array.from({ length: Math.max(1, parseInt(p.sub.count, 10) || 1) }, (_, k) => autoSubName(x.name, k)).join(', ');
      }
    } else {
      p.sub.count = Math.max(1, ...p.parts.map(x => names(x.subs).length));
      subCount.value = p.sub.count;
    }
    draw();
    notify();
  });

  draw();
  return h('div', { class: 'part-editor' },
    locked ? h('div', { class: 'part-locked' }, p.locked) : null,
    h('div', { class: 'form2 cols2' }, h('label', { class: 'frow' }, h('span', null, 'Method:'), method), exprRow, countRow,
      subMethodRow, subExprRow, subCountRow, subNamedRow),
    problems,
    listBox,
    hint);
}

/** Number of partitions shown in the subtab label. */
export function partitionCount(p) {
  if (!p.method) return 0;
  return usesCount(p.method) ? Math.max(1, parseInt(p.count, 10) || 1) : p.parts.length;
}
