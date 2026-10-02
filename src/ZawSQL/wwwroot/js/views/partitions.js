// Partition editor for the Table tab: model, SQL generation and UI.
import { h, qi, sqlStr, fmtBytes, fmtNum } from '../util.js';
import { icon } from '../icons.js';

export const METHODS = ['RANGE', 'RANGE COLUMNS', 'LIST', 'LIST COLUMNS', 'HASH', 'LINEAR HASH', 'KEY', 'LINEAR KEY'];
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

const partKey = x => JSON.stringify([x.name, x.values.trim(), x.comment]);
const modelKey = p => JSON.stringify([p.method, p.expr.trim(), usesCount(p.method) ? +p.count : p.parts.map(partKey)]);

function snapshot(p) {
  p.orig = modelKey(p);
  p.origMethod = p.method;
  p.origExpr = p.expr.trim();
  p.origParts = p.parts.map(partKey);
  return p;
}

/** Builds the editable model from the server's partitioning info (null = not partitioned). */
export function buildPartModel(meta) {
  if (!meta) return snapshot({ method: '', expr: '', count: 4, parts: [], locked: null });
  const locked = meta.subMethod
    ? `This table uses subpartitions (${meta.subMethod}). The editor doesn't model them, so editing is disabled to avoid losing them; use a query tab instead.`
    : !METHODS.includes(meta.method) ? `Partitioning method ${meta.method} is not supported by the editor.` : null;
  return snapshot({
    method: meta.method,
    expr: meta.expression,
    count: meta.partitions.length,
    locked,
    subMethod: meta.subMethod,
    parts: meta.partitions.map(x => ({ name: x.name, values: x.description ?? '', comment: x.comment ?? '', rows: x.rows, size: x.size, isNew: false })),
  });
}

export const partChanged = p => !p.locked && modelKey(p) !== p.orig;

function partDef(method, x) {
  const v = x.values.trim();
  const vals = method.startsWith('RANGE')
    ? `VALUES LESS THAN ${method === 'RANGE' && /^maxvalue$/i.test(v) ? 'MAXVALUE' : `(${v})`}`
    : `VALUES IN (${v})`;
  return `PARTITION ${qi(x.name)} ${vals}${x.comment ? ' COMMENT = ' + sqlStr(x.comment) : ''}`;
}

/** The PARTITION BY clause for CREATE TABLE / ALTER TABLE, or '' when not partitioned. */
export function partitionClause(p) {
  if (!p.method) return '';
  const s = `PARTITION BY ${p.method} (${p.expr.trim()})`;
  if (usesCount(p.method)) return `${s} PARTITIONS ${Math.max(1, parseInt(p.count, 10) || 1)}`;
  return `${s} (\n\t${p.parts.map(x => partDef(p.method, x)).join(',\n\t')}\n)`;
}

/**
 * Statements applying partitioning changes to an existing table. Appending RANGE/LIST partitions uses
 * ADD PARTITION; anything else redefines the partitioning, which the server refuses if rows would no
 * longer fit any partition (so removing a partition never silently deletes data, unlike DROP PARTITION).
 */
export function partitionAlter(p, tbl) {
  if (!partChanged(p)) return [];
  if (!p.method) return p.origMethod ? [`ALTER TABLE ${tbl} REMOVE PARTITIONING`] : [];
  const appendOnly = p.origMethod === p.method && p.origExpr === p.expr.trim() && hasPartitionList(p.method)
    && p.parts.length > p.origParts.length && p.origParts.every((k, i) => k === partKey(p.parts[i]));
  if (appendOnly) {
    const added = p.parts.slice(p.origParts.length);
    return [`ALTER TABLE ${tbl} ADD PARTITION (\n\t${added.map(x => partDef(p.method, x)).join(',\n\t')}\n)`];
  }
  return [`ALTER TABLE ${tbl}\n${partitionClause(p)}`];
}

/** Renders the Partitions subtab. `view` is the TableView (for change notification). */
export function renderPartitions(view, p) {
  const locked = !!p.locked;
  const method = h('select', { class: 'inp', disabled: locked },
    h('option', { value: '' }, '(not partitioned)'), METHODS.map(m => h('option', { value: m, selected: m === p.method }, m)));
  const expr = h('input', { class: 'inp mono', value: p.expr, spellcheck: false, disabled: locked });
  const count = h('input', { class: 'inp', type: 'number', min: 1, max: 8192, value: p.count, disabled: locked });
  const exprLabel = h('span');
  const hint = h('div', { class: 'muted part-hint' });
  const exprRow = h('label', { class: 'frow' }, exprLabel, expr);
  const countRow = h('label', { class: 'frow' }, h('span', null, 'Partitions:'), count);
  const tbody = h('tbody');
  let sel = 0;

  const notify = () => { view.changed(); view.renderSubtabs(); };
  const btn = (ic, label, fn) => h('button', { class: 'tbtn', disabled: locked, html: icon(ic) + `<span>${label}</span>`, onclick: fn });
  const listBar = h('div', { class: 'viewbar small' },
    btn('plus', 'Add partition', () => {
      let n = p.parts.length;
      while (p.parts.some(x => x.name === 'p' + n)) n++;
      p.parts.splice(sel + 1, 0, { name: 'p' + n, values: '', comment: '', isNew: true });
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

  function drawList() {
    const valuesLabel = p.method.startsWith('RANGE') ? 'VALUES LESS THAN' : 'VALUES IN';
    table.replaceChildren(h('thead', null, h('tr', null, ['#', 'Name', valuesLabel, 'Comment', 'Rows', 'Size'].map(t => h('th', null, t)))), tbody);
    tbody.replaceChildren(...p.parts.map((x, i) => {
      const inp = (key, ph = '') => {
        const el = h('input', { class: 'cell-inp' + (key === 'values' ? ' mono' : ''), value: x[key], spellcheck: false, placeholder: ph, disabled: locked });
        el.addEventListener('input', () => { x[key] = el.value; view.changed(); });
        return el;
      };
      const ph = p.method === 'RANGE' ? '100 or MAXVALUE' : p.method === 'RANGE COLUMNS' ? "'2025-01-01' or MAXVALUE" : "1, 2 or 'a', 'b'";
      const tr = h('tr', { class: (i === sel ? 'sel' : '') + (x.isNew ? ' new' : '') },
        h('td', { class: 'num' }, i + 1), h('td', null, inp('name')), h('td', null, inp('values', ph)), h('td', null, inp('comment')),
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
    hint.textContent = m ? text + ' Every unique key, including the primary key, must contain all columns used for partitioning.' : 'The table is not partitioned.';
    exprRow.style.display = m ? '' : 'none';
    countRow.style.display = usesCount(m) ? '' : 'none';
    listBox.style.display = hasPartitionList(m) ? '' : 'none';
    drawList();
  }

  method.addEventListener('change', () => {
    p.method = method.value;
    if (hasPartitionList(p.method) && !p.parts.length) p.parts.push({ name: 'p0', values: '', comment: '', isNew: true });
    draw();
    notify();
  });
  expr.addEventListener('input', () => { p.expr = expr.value; view.changed(); });
  count.addEventListener('input', () => { p.count = count.value; view.changed(); notify(); });

  draw();
  return h('div', { class: 'part-editor' },
    locked ? h('div', { class: 'part-locked' }, p.locked) : null,
    h('div', { class: 'form2 cols2' }, h('label', { class: 'frow' }, h('span', null, 'Method:'), method), exprRow, countRow),
    hint,
    listBox);
}

/** Number of partitions shown in the subtab label. */
export function partitionCount(p) {
  if (!p.method) return 0;
  return usesCount(p.method) ? Math.max(1, parseInt(p.count, 10) || 1) : p.parts.length;
}
