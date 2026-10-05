// Partition editor for the Table tab: model, SQL generation and UI, including subpartitions and the options of
// each partition and subpartition (comment, DATA/INDEX DIRECTORY, MAX_ROWS, MIN_ROWS, TABLESPACE).
import { h, qi, sqlStr, fmtBytes, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { modal } from '../dialogs.js';
import { parsePartitionDefs, splitInherited, emptyOptions, normDir, hasOptions } from '../partdefs.js';

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

/** Options besides the comment (which has its own column in the partition list). */
const OPT_FIELDS = [
  ['dataDir', 'Data directory', '/data/mysql/archive'],
  ['indexDir', 'Index directory', 'MyISAM only'],
  ['maxRows', 'Max rows', ''],
  ['minRows', 'Min rows', ''],
  ['tablespace', 'Tablespace', 'MySQL: innodb_file_per_table'],
];
const blankOpts = () => { const o = emptyOptions(); delete o.comment; return o; };
const withoutComment = o => { const { comment, ...rest } = o; return rest; };

/** The name the server gives subpartition i of a partition when they aren't named explicitly. */
export const autoSubName = (part, i) => `${part}sp${i}`;
const splitNames = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);
const subNames = x => (x.subs ?? []).map(s => s.name);
const isSubpartitioned = p => hasPartitionList(p.method) && !!p.sub?.method;
const subHasOwn = s => !!s.comment || hasOptions(s.opts);

/**
 * How the subpartitions are laid out: defined explicitly, or named by the server (SUBPARTITIONS n). Explicit names
 * that are exactly the server's (p0sp0, p0sp1 …) without options of their own are the same as letting it name them.
 */
export function subLayout(p) {
  if (!p.sub.named) return { named: false, count: Math.max(1, parseInt(p.sub.count, 10) || 1) };
  const lists = p.parts.map(subNames);
  const n = lists[0]?.length ?? 0;
  const auto = n > 0 && lists.every((l, i) => l.length === n && l.every((s, k) => s === autoSubName(p.parts[i].name, k)))
    && p.parts.every(x => !(x.subs ?? []).some(subHasOwn));
  return { named: !auto, count: n };
}

const optKey = o => JSON.stringify([o.comment ?? '', normDir(String(o.dataDir ?? '')), normDir(String(o.indexDir ?? '')), String(o.maxRows ?? ''), String(o.minRows ?? ''), String(o.tablespace ?? '')]);
const optsOf = x => ({ comment: x.comment ?? '', ...(x.opts ?? blankOpts()) });
const subKey = p => {
  if (!isSubpartitioned(p)) return '';
  const l = subLayout(p);
  return JSON.stringify([p.sub.method, p.sub.expr.trim(), l.named ? 0 : l.count, l.named]);
};
const structKey = x => JSON.stringify([x.name, x.values.trim()]);
const partKey = (p, x) => JSON.stringify([x.name, x.values.trim(), optKey(optsOf(x)),
  isSubpartitioned(p) && subLayout(p).named ? (x.subs ?? []).map(s => [s.name, optKey({ comment: s.comment, ...s.opts })]) : '']);
const modelKey = p => JSON.stringify([p.method, p.expr.trim(), usesCount(p.method) ? +p.count : p.parts.map(x => partKey(p, x)), subKey(p)]);

function snapshot(p) {
  p.orig = modelKey(p);
  p.origMethod = p.method;
  p.origExpr = p.expr.trim();
  p.origParts = p.parts.map(x => partKey(p, x));
  p.origStruct = p.parts.map(structKey);
  p.origSub = subKey(p);
  return p;
}

/** Why the editor can't safely change this table's partitioning, or null. */
function lockReason(meta, defs, defsError) {
  if (!METHODS.includes(meta.method)) return `Partitioning method ${meta.method} is not supported by the editor.`;
  if (defsError) return `The partition definitions could not be read (${defsError}), so editing is disabled to avoid losing their options; use a query tab instead.`;
  if (usesCount(meta.method) && defs) {
    const plain = defs.partitions.every((d, i) => d.name === `p${i}` && !hasOptions(d.opts));
    if (!plain) return 'These HASH/KEY partitions have names or options of their own, which the editor doesn\'t model; use a query tab instead.';
  }
  if (!meta.subMethod) return null;
  if (!SUB_METHODS.includes(meta.subMethod)) return `Subpartitioning method ${meta.subMethod} is not supported by the editor.`;
  if (new Set(meta.partitions.map(x => (x.subNames ?? []).length)).size > 1) return 'The partitions have different numbers of subpartitions, which the editor doesn\'t model.';
  // Without the definitions (no CREATE TABLE to read), subpartition comments can't be told apart from the partition's.
  if (!defs && meta.partitions.some(x => new Set(x.subComments ?? []).size > 1)) {
    return 'Some subpartitions have their own comments, which can\'t be read here; editing is disabled to avoid losing them.';
  }
  return null;
}

/**
 * Builds the editable model from the server's partitioning info (null = not partitioned). `create` is SHOW CREATE
 * TABLE, the only place the server reports partition options; `engine` is the table's engine.
 */
export function buildPartModel(meta, { create = null, engine = '' } = {}) {
  const sub0 = { method: '', expr: '', count: 2, named: false };
  if (!meta) return snapshot({ method: '', expr: '', count: 4, parts: [], locked: null, sub: sub0, engine });
  let defs = null, defsError = null;
  try { defs = create ? parsePartitionDefs(create) : null; } catch (e) { defsError = e.message; }
  const subs = !!meta.subMethod;
  const parts = meta.partitions.map(x => {
    const def = defs?.partitions.find(d => d.name === x.name);
    const names = x.subNames ?? [];
    const base = { name: x.name, values: x.description ?? '', rows: x.rows, size: x.size, isNew: false };
    if (!subs) {
      const o = def?.opts ?? { ...emptyOptions(), comment: x.comment ?? '' };
      return { ...base, comment: o.comment, opts: withoutComment(o), subs: [] };
    }
    if (!def) {
      // No definitions: a comment every subpartition shares is the partition's.
      const comment = new Set(x.subComments ?? []).size === 1 ? x.subComments[0] : x.comment ?? '';
      return { ...base, comment, opts: blankOpts(), subs: names.map(n => ({ name: n, comment: '', opts: blankOpts() })) };
    }
    // Server-named subpartitions keep options on the partition; named ones on each subpartition.
    const { common, own } = def.subs.length
      ? splitInherited(def.opts, def.subs)
      : { common: def.opts, own: names.map(() => emptyOptions()) };
    return {
      ...base, comment: common.comment, opts: withoutComment(common),
      subs: names.map((n, i) => ({ name: n, comment: own[i]?.comment ?? '', opts: withoutComment(own[i] ?? emptyOptions()) })),
    };
  });
  const named = subs && parts.some(x => x.subs.some((s, i) => s.name !== autoSubName(x.name, i) || subHasOwn(s)));
  return snapshot({
    method: meta.method,
    expr: meta.expression,
    count: meta.partitions.length,
    locked: lockReason(meta, defs, defsError),
    parts,
    engine,
    sub: { method: meta.subMethod ?? '', expr: meta.subExpression ?? '', count: meta.partitions[0]?.subNames?.length || 2, named },
  });
}

export const partChanged = p => !p.locked && modelKey(p) !== p.orig;

/** Option clauses in a fixed order: COMMENT, DATA DIRECTORY, INDEX DIRECTORY, MAX_ROWS, MIN_ROWS, TABLESPACE. */
function optSql(o) {
  const s = [];
  if (o.comment) s.push(`COMMENT = ${sqlStr(o.comment)}`);
  if (o.dataDir) s.push(`DATA DIRECTORY = ${sqlStr(o.dataDir)}`);
  if (o.indexDir) s.push(`INDEX DIRECTORY = ${sqlStr(o.indexDir)}`);
  if (String(o.maxRows ?? '') !== '') s.push(`MAX_ROWS = ${parseInt(o.maxRows, 10)}`);
  if (String(o.minRows ?? '') !== '') s.push(`MIN_ROWS = ${parseInt(o.minRows, 10)}`);
  if (o.tablespace) s.push(`TABLESPACE = ${qi(o.tablespace)}`);
  return s.length ? ' ' + s.join(' ') : '';
}

function partDef(p, x) {
  const v = x.values.trim();
  const vals = p.method.startsWith('RANGE')
    ? `VALUES LESS THAN ${p.method === 'RANGE' && /^maxvalue$/i.test(v) ? 'MAXVALUE' : `(${v})`}`
    : `VALUES IN (${v})`;
  // Partition options; with named subpartitions they are the defaults the server copies into each subpartition.
  const subs = isSubpartitioned(p) && subLayout(p).named
    ? ` (${(x.subs ?? []).map(s => `SUBPARTITION ${qi(s.name)}${optSql({ comment: s.comment, ...s.opts })}`).join(', ')})`
    : '';
  return `PARTITION ${qi(x.name)} ${vals}${optSql(optsOf(x))}${subs}`;
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

/** Problems with one set of options: rows must be whole numbers; INDEX DIRECTORY needs MyISAM or Aria. */
function optionProblems(o, where, engine) {
  const out = [];
  for (const key of ['maxRows', 'minRows']) {
    const v = String(o[key] ?? '').trim();
    if (v && !/^\d+$/.test(v)) out.push(`${where}: ${key === 'maxRows' ? 'Max rows' : 'Min rows'} must be a whole number.`);
  }
  if (o.indexDir && engine && !/^(MyISAM|Aria)$/i.test(engine)) out.push(`${where}: INDEX DIRECTORY only works for MyISAM and Aria tables; ${engine} refuses it.`);
  return out;
}

/** What has to be fixed before the partitioning can be saved (the server would refuse it otherwise). */
export function partitionProblems(p, engine = p.engine) {
  if (p.locked || !p.method) return [];
  const out = [];
  if (hasPartitionList(p.method)) {
    for (const x of p.parts) {
      out.push(...optionProblems(optsOf(x), `Partition ${x.name}`, engine));
      for (const s of x.subs ?? []) out.push(...optionProblems({ comment: s.comment, ...s.opts }, `Subpartition ${s.name}`, engine));
    }
  }
  if (!isSubpartitioned(p)) return out;
  if (!p.sub.expr.trim()) out.push(p.sub.method.endsWith('KEY') ? 'Subpartitioning by KEY needs one or more columns.' : 'Enter the expression to subpartition by.');
  if (!p.sub.named) {
    if (!(parseInt(p.sub.count, 10) >= 1)) out.push('Each partition needs at least one subpartition.');
    return out;
  }
  // Named subpartitions: the same number in every partition, every name unique (partition names included).
  const counts = p.parts.map(x => subNames(x).length);
  if (counts.some(c => c === 0)) out.push(`Name the subpartitions of every partition (${p.parts.filter((x, i) => !counts[i]).map(x => x.name).join(', ')} has none).`);
  else if (new Set(counts).size > 1) out.push('Every partition needs the same number of subpartitions.');
  const seen = new Set(p.parts.map(x => x.name.toLowerCase()));
  for (const n of p.parts.flatMap(subNames)) {
    if (seen.has(n.toLowerCase())) { out.push(`The name ${n} is used twice; partition and subpartition names must all differ.`); break; }
    seen.add(n.toLowerCase());
  }
  return out;
}

/**
 * Statements applying partitioning changes to an existing table:
 * - partitions added at the end: ADD PARTITION (they get their subpartitions too);
 * - options, comments or subpartitions of existing partitions changed: REORGANIZE PARTITION, one partition at a time,
 *   which rebuilds only that partition;
 * - anything else redefines the partitioning, which the server refuses if rows would no longer fit any partition (so
 *   removing a partition never silently deletes data, unlike DROP PARTITION).
 */
export function partitionAlter(p, tbl) {
  if (!partChanged(p)) return [];
  if (!p.method) return p.origMethod ? [`ALTER TABLE ${tbl} REMOVE PARTITIONING`] : [];
  const n = p.origStruct.length;
  const sameShape = p.origMethod === p.method && p.origExpr === p.expr.trim() && hasPartitionList(p.method) && p.origSub === subKey(p)
    && p.parts.length >= n && p.origStruct.every((k, i) => k === structKey(p.parts[i]));
  if (sameShape) {
    const out = [];
    p.parts.slice(0, n).forEach((x, i) => {
      if (partKey(p, x) !== p.origParts[i]) out.push(`ALTER TABLE ${tbl} REORGANIZE PARTITION ${qi(x.name)} INTO (\n\t${partDef(p, x)}\n)`);
    });
    const added = p.parts.slice(n);
    if (added.length) out.push(`ALTER TABLE ${tbl} ADD PARTITION (\n\t${added.map(x => partDef(p, x)).join(',\n\t')}\n)`);
    return out;
  }
  return [`ALTER TABLE ${tbl}\n${partitionClause(p)}`];
}

/** Short summary of a partition's options for the list (partition and subpartition options). */
function optionSummary(p, x) {
  const parts = [];
  const o = x.opts ?? {};
  if (o.dataDir) parts.push(`DATA DIRECTORY ${o.dataDir}`);
  if (o.indexDir) parts.push(`INDEX DIRECTORY ${o.indexDir}`);
  if (String(o.maxRows ?? '') !== '') parts.push(`MAX_ROWS ${o.maxRows}`);
  if (String(o.minRows ?? '') !== '') parts.push(`MIN_ROWS ${o.minRows}`);
  if (o.tablespace) parts.push(`TABLESPACE ${o.tablespace}`);
  const own = isSubpartitioned(p) ? (x.subs ?? []).filter(subHasOwn).length : 0;
  if (own) parts.push(`${own} subpartition${own === 1 ? '' : 's'} with own options`);
  return parts.join(' · ');
}

/** The options of one partition and its subpartitions. Resolves to true when applied. */
async function partitionOptionsDialog(p, x, engine) {
  const subbed = isSubpartitioned(p);
  const named = subbed && p.sub.named;
  const draft = { comment: x.comment ?? '', opts: { ...blankOpts(), ...x.opts }, subs: (x.subs ?? []).map(s => ({ ...s, opts: { ...blankOpts(), ...s.opts } })) };
  const field = (obj, key, ph = '') => {
    const el = h('input', { class: 'inp' + (key.endsWith('Dir') || key === 'tablespace' ? ' mono' : ''), value: obj[key] ?? '', placeholder: ph, spellcheck: false });
    el.addEventListener('input', () => { obj[key] = el.value; });
    return el;
  };
  const row = (label, input) => h('label', { class: 'frow' }, h('span', null, label), input);
  const subTable = !named ? null : h('table', { class: 'edit-table po-subs' },
    h('thead', null, h('tr', null, ['Subpartition', 'Comment', ...OPT_FIELDS.map(f => f[1])].map(t => h('th', null, t)))),
    h('tbody', null, draft.subs.map(s => {
      // Empty = inherits the partition's value (shown as the placeholder).
      const cell = (obj, key, inherit) => {
        const el = h('input', { class: 'cell-inp' + (key.endsWith('Dir') || key === 'tablespace' || key === 'name' ? ' mono' : ''), value: obj[key] ?? '', spellcheck: false });
        el.placeholder = inherit() || '';
        el.addEventListener('input', () => { obj[key] = el.value; });
        return h('td', null, el);
      };
      return h('tr', null, cell(s, 'name', () => ''), cell(s, 'comment', () => draft.comment), ...OPT_FIELDS.map(([key]) => cell(s.opts, key, () => draft.opts[key])));
    })));
  const ok = await modal({
    title: `Partition ${x.name}`,
    width: named ? 980 : 520,
    className: 'po-dialog',
    body: h('div', { class: 'po' },
      h('div', { class: 'muted po-engine' }, `Engine: ${engine || 'the table\'s'}. Every partition uses the table's engine; MySQL and MariaDB don't allow mixing engines.`),
      subbed ? h('div', { class: 'sm-sep' }, 'Partition options – the default for its subpartitions') : '',
      h('div', { class: 'form2 cols2' },
        row('Comment:', field(draft, 'comment')),
        ...OPT_FIELDS.map(([key, label, ph]) => row(label + ':', field(draft.opts, key, ph)))),
      h('div', { class: 'muted po-hint' }, 'DATA DIRECTORY must be a location the server allows (for InnoDB: innodb_directories). INDEX DIRECTORY only works for MyISAM and Aria tables. MariaDB ignores TABLESPACE for partitions.'),
      subbed ? h('div', { class: 'sm-sep' }, 'Subpartitions') : '',
      named ? h('div', { class: 'muted po-hint' }, 'Empty fields use the partition\'s value (shown in grey).') : '',
      named ? h('div', { class: 'po-subs-wrap' }, subTable) : '',
      subbed && !named ? h('div', { class: 'muted po-hint' }, 'The server names these subpartitions, and they all use the partition\'s options. To give one its own options, tick "Name the subpartitions myself".') : ''),
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
  });
  if (!ok) return false;
  x.comment = draft.comment;
  x.opts = draft.opts;
  if (named) x.subs = draft.subs.map(s => ({ ...s, name: s.name.trim() }));
  return true;
}

/** Renders the Partitions subtab. `view` is the TableView (for change notification). */
export function renderPartitions(view, p) {
  const locked = !!p.locked;
  p.sub ??= { method: '', expr: '', count: 2, named: false };
  const engine = () => view.m?.opts?.engine || p.engine || '';
  const method = h('select', { class: 'inp', disabled: locked },
    h('option', { value: '' }, '(not partitioned)'), METHODS.map(m => h('option', { value: m, selected: m === p.method }, m)));
  const expr = h('input', { class: 'inp mono', value: p.expr, spellcheck: false, disabled: locked });
  const count = h('input', { class: 'inp', type: 'number', min: 1, max: 8192, value: p.count, disabled: locked });
  const exprLabel = h('span');
  const hint = h('div', { class: 'muted part-hint' });
  const exprRow = h('label', { class: 'frow' }, exprLabel, expr);
  const countRow = h('label', { class: 'frow' }, h('span', null, 'Partitions:'), count);

  // Subpartitioning (RANGE / LIST only), part of the same compact form (the pane above the columns is short).
  const subMethod = h('select', { class: 'inp', disabled: locked },
    h('option', { value: '' }, '(none)'), SUB_METHODS.map(m => h('option', { value: m, selected: m === p.sub.method }, m)));
  const subExpr = h('input', { class: 'inp mono', value: p.sub.expr, spellcheck: false, disabled: locked });
  const subCount = h('input', { class: 'inp', type: 'number', min: 1, max: 1024, value: p.sub.count, disabled: locked });
  const subNamed = h('input', { type: 'checkbox', checked: !!p.sub.named, disabled: locked });
  const subExprLabel = h('span');
  const subMethodRow = h('label', { class: 'frow part-sub-method' }, h('span', null, 'Subpartition by:'), subMethod);
  const subExprRow = h('label', { class: 'frow part-sub-expr' }, subExprLabel, subExpr);
  const subCountRow = h('label', { class: 'frow part-sub-count' }, h('span', null, 'Subpartitions:'), subCount);
  const subNamedRow = h('label', { class: 'frow part-sub-named' }, h('span', null, ''), h('label', { class: 'chk', title: 'Otherwise the server names them <partition>sp0, <partition>sp1, …' }, subNamed, ' Name the subpartitions myself'));
  const problems = h('div', { class: 'part-problems' });

  const tbody = h('tbody');
  let sel = 0;
  const autoSubs = (name, n) => Array.from({ length: Math.max(1, n) }, (_, k) => ({ name: autoSubName(name, k), comment: '', opts: blankOpts() }));

  const notify = () => { view.changed(); view.renderSubtabs(); showProblems(); };
  const btn = (ic, label, fn) => h('button', { class: 'tbtn', disabled: locked, html: icon(ic) + `<span>${label}</span>`, onclick: fn });
  const listBar = h('div', { class: 'viewbar small' },
    btn('plus', 'Add partition', () => {
      let n = p.parts.length;
      while (p.parts.some(x => x.name === 'p' + n)) n++;
      const name = 'p' + n;
      // Named subpartitions: start the new partition with names of its own.
      const subs = isSubpartitioned(p) && p.sub.named ? autoSubs(name, subNames(p.parts[sel] ?? {}).length || +p.sub.count || 1) : [];
      p.parts.splice(sel + 1, 0, { name, values: '', comment: '', opts: blankOpts(), subs, isNew: true });
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
    const list = partitionProblems(p, engine());
    problems.replaceChildren(...list.map(t => h('div', null, h('span', { html: icon('warning') }), h('span', null, t))));
    problems.style.display = list.length ? '' : 'none';
  }

  function drawList() {
    const valuesLabel = p.method.startsWith('RANGE') ? 'VALUES LESS THAN' : 'VALUES IN';
    const subs = isSubpartitioned(p);
    const heads = ['#', 'Name', valuesLabel, 'Comment', ...(subs ? ['Subpartitions'] : []), 'Options', 'Rows', 'Size'];
    table.replaceChildren(h('thead', null, h('tr', null, heads.map(t => h('th', null, t)))), tbody);
    tbody.replaceChildren(...p.parts.map((x, i) => {
      x.opts ??= blankOpts();
      x.subs ??= [];
      const inp = (key, ph = '') => {
        const el = h('input', { class: 'cell-inp' + (key === 'values' ? ' mono' : ''), value: x[key] ?? '', spellcheck: false, placeholder: ph, disabled: locked });
        el.addEventListener('input', () => {
          x[key] = el.value;
          view.changed();
          if (key === 'name') {
            showProblems();
            if (subs && !p.sub.named) subCell.textContent = autoNames();
          }
        });
        return el;
      };
      const autoNames = () => Array.from({ length: Math.max(1, parseInt(p.sub.count, 10) || 1) }, (_, k) => autoSubName(x.name, k)).join(', ');
      let subCell = null;
      if (subs && p.sub.named) {
        // Names typed here keep each subpartition's comment and options by position.
        subCell = h('input', { class: 'cell-inp mono', value: subNames(x).join(', '), spellcheck: false, placeholder: 's0, s1', disabled: locked });
        subCell.addEventListener('input', () => {
          const names = splitNames(subCell.value);
          x.subs = names.map((n, k) => ({ ...(x.subs[k] ?? { comment: '', opts: blankOpts() }), name: n }));
          view.changed();
          showProblems();
          refreshOptions();
        });
      } else if (subs) {
        subCell = h('span', { class: 'muted mono', title: 'Named by the server' }, autoNames());
      }
      const optsBtn = h('button', { class: 'tbtn part-opts-btn', disabled: locked });
      const refreshOptions = () => {
        const summary = optionSummary(p, x);
        optsBtn.innerHTML = `${icon('settings')}<span>${summary ? 'Edit…' : 'Set…'}</span>`;
        optsBtn.classList.toggle('has-opts', !!summary);
        optsBtn.title = summary || 'DATA DIRECTORY, MAX_ROWS, MIN_ROWS, TABLESPACE' + (subs ? ', and options per subpartition' : '');
      };
      optsBtn.addEventListener('click', async () => {
        if (await partitionOptionsDialog(p, x, engine())) { drawList(); notify(); }
      });
      refreshOptions();
      const ph = p.method === 'RANGE' ? '100 or MAXVALUE' : p.method === 'RANGE COLUMNS' ? "'2025-01-01' or MAXVALUE" : "1, 2 or 'a', 'b'";
      const tr = h('tr', { class: (i === sel ? 'sel' : '') + (x.isNew ? ' new' : '') },
        h('td', { class: 'num' }, i + 1), h('td', null, inp('name')), h('td', null, inp('values', ph)), h('td', null, inp('comment')),
        subs ? h('td', null, subCell) : null,
        h('td', null, optsBtn),
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
    if (hasPartitionList(p.method) && !p.parts.length) p.parts.push({ name: 'p0', values: '', comment: '', opts: blankOpts(), subs: [], isNew: true });
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
    if (p.sub.named) {
      // Start from the names the server would give (or has given) them.
      for (const x of p.parts) if (!subNames(x).length) x.subs = autoSubs(x.name, parseInt(p.sub.count, 10) || 1);
    } else {
      // The server names them again; subpartition options can't be kept that way.
      p.sub.count = Math.max(1, ...p.parts.map(x => subNames(x).length));
      subCount.value = p.sub.count;
      for (const x of p.parts) x.subs = autoSubs(x.name, p.sub.count);
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
