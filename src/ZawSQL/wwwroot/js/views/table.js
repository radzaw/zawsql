// "Table" tab: structure editor for tables (columns, indexes, foreign keys, options) generating
// CREATE / ALTER statements, and a code editor for views, routines, triggers and events.
import { h, qi, sqlStr, splitTopLevel, makeSplitter } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { SqlEditor } from '../editor.js';
import { confirmDlg } from '../dialogs.js';
import { buildPartModel, partitionClause, partitionAlter, renderPartitions, partitionCount } from './partitions.js';

const TYPES = ['int', 'int unsigned', 'bigint', 'bigint unsigned', 'tinyint', 'smallint', 'mediumint', 'decimal(10,2)', 'float', 'double', 'bit(1)',
  'varchar(255)', 'char(36)', 'tinytext', 'text', 'mediumtext', 'longtext', 'json', "enum('a','b')", "set('a','b')",
  'date', 'datetime', 'timestamp', 'time', 'year', 'binary(16)', 'varbinary(255)', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'geometry', 'point'];
const INDEX_TYPES = ['PRIMARY', 'KEY', 'UNIQUE', 'FULLTEXT', 'SPATIAL'];
const FK_RULES = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];
const ROW_FORMATS = ['', 'DEFAULT', 'DYNAMIC', 'COMPACT', 'COMPRESSED', 'REDUNDANT', 'FIXED'];
const COL_FIELDS = ['name', 'type', 'nullable', 'def', 'extra', 'collation', 'comment'];
const TYPE_LABEL = { table: 'Table', view: 'View', procedure: 'Procedure', function: 'Function', trigger: 'Trigger', event: 'Event' };

let uid = 0;
const nextId = () => ++uid;

const cleanExtra = x => (x || '').replace(/DEFAULT_GENERATED/i, '').replace(/\s+/g, ' ').trim();
const isGenerated = x => /\b(VIRTUAL|STORED|PERSISTENT)\b/i.test(x || '');
const isStringType = t => /^\s*((var)?char|(tiny|medium|long)?text|enum|set)\b/i.test(t || '');

/** How a column default from SHOW COLUMNS is shown in the editor. */
function displayDefault(c) {
  if (c.default == null) return c.nullable && !/auto_increment/i.test(c.extra || '') ? 'NULL' : '';
  if (/DEFAULT_GENERATED/i.test(c.extra || '') && !/^(current_timestamp|now)\b/i.test(c.default)) return '(' + c.default + ')';
  return c.default;
}

/** Converts the editor's default text into SQL: blank = none, NULL, expressions and functions raw, else quoted. */
function defaultClause(d) {
  d = (d ?? '').trim();
  if (!d) return null;
  if (/^null$/i.test(d)) return 'NULL';
  if (/^(current_timestamp|now|localtime|localtimestamp|curdate|curtime|uuid)(\(\d*\))?$/i.test(d)) return d;
  if (/^\(.*\)$/s.test(d) || /^'.*'$/s.test(d) || /^b'[01]*'$/i.test(d) || /^[a-z_][a-z0-9_]*\(.*\)$/i.test(d) || /^-?\d+(\.\d+)?$/.test(d)) return d;
  return sqlStr(d);
}

function colDef(c) {
  let s = qi(c.name) + ' ' + c.type.trim();
  if (c.collation && isStringType(c.type)) s += ' COLLATE ' + c.collation;
  s += c.nullable ? ' NULL' : ' NOT NULL';
  const d = defaultClause(c.def);
  if (d) s += ' DEFAULT ' + d;
  const extra = cleanExtra(c.extra);
  if (extra) s += ' ' + extra.replace(/auto_increment/i, 'AUTO_INCREMENT');
  if (c.comment) s += ' COMMENT ' + sqlStr(c.comment);
  return s;
}

function idxColsSql(text) {
  return splitTopLevel(text).map(p => {
    if (p.startsWith('(')) return p;
    const m = /^`?([^`(]+?)`?\s*(\(\d+\))?\s*(ASC|DESC)?$/i.exec(p);
    return m ? qi(m[1].trim()) + (m[2] || '') + (m[3] ? ' ' + m[3].toUpperCase() : '') : p;
  }).join(', ');
}

function idxColsText(cols) {
  return cols.map(c => (c.name == null ? `(${c.expression})` : c.name + (c.subPart ? `(${c.subPart})` : '') + (c.desc ? ' DESC' : ''))).join(', ');
}

function idxDef(i) {
  const cols = `(${idxColsSql(i.cols)})`;
  switch (i.type) {
    case 'PRIMARY': return 'PRIMARY KEY ' + cols;
    case 'UNIQUE': return `UNIQUE INDEX ${qi(i.name)} ${cols}`;
    case 'FULLTEXT': return `FULLTEXT INDEX ${qi(i.name)} ${cols}`;
    case 'SPATIAL': return `SPATIAL INDEX ${qi(i.name)} ${cols}`;
    default: return `INDEX ${qi(i.name)} ${cols}`;
  }
}

const identList = text => splitTopLevel(text).map(x => qi(x.replace(/^`|`$/g, ''))).join(', ');

function fkDef(f) {
  const [refDb, refTable] = f.refTable.includes('.') ? f.refTable.split('.', 2) : [null, f.refTable];
  const ref = (refDb ? qi(refDb) + '.' : '') + qi(refTable.replace(/^`|`$/g, ''));
  let s = (f.name ? `CONSTRAINT ${qi(f.name)} ` : '') + `FOREIGN KEY (${identList(f.cols)}) REFERENCES ${ref} (${identList(f.refCols)})`;
  if (f.onUpdate) s += ' ON UPDATE ' + f.onUpdate;
  if (f.onDelete) s += ' ON DELETE ' + f.onDelete;
  return s;
}

const sameFields = (a, b, fields) => fields.every(f => (a[f] ?? '') === (b[f] ?? ''));

export class TableView {
  constructor(app) {
    this.app = app;
    this.key = null;
    this.createKey = null;
    this.el = h('div', { class: 'view table-view' });
    this.subtab = 'basic';
  }

  selKey() {
    const s = this.app.sel;
    return s.sid && s.obj ? `${s.sid}|${s.db}|${s.obj.type}|${s.obj.name}` : null;
  }

  onShow() {
    if (this.createKey) return;
    const k = this.selKey();
    if (k !== this.key) this.load();
  }

  refresh() {
    if (this.createKey) return;
    return this.load();
  }

  readOnly() {
    return !!this.m && this.app.isReadOnly(this.m.sid);
  }

  roNote() {
    return this.readOnly() ? h('span', { class: 'ro-note', title: 'Structure changes cannot be saved in a read-only session.' }, 'Read-only session') : null;
  }

  /** True when there are unsaved structure changes. */
  isDirty() {
    // Edits in a read-only session can't be saved, so never prompt to discard them.
    if (!this.m || this.readOnly()) return false;
    if (this.m.code) return this.editor && this.editor.value !== this.m.origCode;
    return this.m.creating || this.genAlter().length > 0;
  }

  async load() {
    const s = this.app.sel;
    this.key = this.selKey();
    this.createKey = null;
    this.m = null;
    if (!this.key) {
      this.el.replaceChildren(h('div', { class: 'placeholder' }, 'Select a table or other object in the tree.'));
      return;
    }
    const { sid, db } = s;
    const { type, name } = s.obj;
    this.el.replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'));
    try {
      if (type === 'table') {
        const info = await get(`/s/${sid}/table`, { db, table: name });
        if (this.key !== `${sid}|${db}|${type}|${name}`) return;
        this.m = this.buildModel(sid, db, info);
        this.renderTableEditor();
      } else {
        const r = await get(`/s/${sid}/create`, { db, type, name });
        if (this.key !== `${sid}|${db}|${type}|${name}`) return;
        this.m = { code: true, sid, db, type, name, origCode: r.code ?? '' };
        this.renderCodeEditor();
      }
    } catch (e) {
      this.el.replaceChildren(h('div', { class: 'placeholder error' }, e.message));
    }
  }

  startCreate(sid, db) {
    this.createKey = sid + '|' + db;
    this.key = null;
    this.m = this.buildModel(sid, db, null);
    this.subtab = 'basic';
    this.renderTableEditor();
  }

  buildModel(sid, db, info) {
    const m = { sid, db, creating: !info };
    const o = info?.options || {};
    m.opts = { name: info ? this.app.sel.obj.name : 'new_table', comment: o.comment || '', engine: o.engine || '', collation: o.collation || '', autoIncrement: o.autoIncrement || '', rowFormat: '' };
    m.origOpts = { ...m.opts };
    if (!info) {
      m.opts.engine = 'InnoDB';
      m.cols = [{ id: nextId(), name: 'id', type: 'int unsigned', nullable: false, def: '', extra: 'auto_increment', collation: '', comment: '', orig: null }];
      m.idx = [{ id: nextId(), name: 'PRIMARY', type: 'PRIMARY', cols: 'id', orig: null }];
      m.fks = [];
      m.create = '';
      m.part = buildPartModel(null);
      return m;
    }
    m.cols = info.columns.map(c => {
      const col = { id: nextId(), name: c.name, type: c.type, nullable: c.nullable, def: displayDefault(c), extra: cleanExtra(c.extra), collation: c.collation || '', comment: c.comment || '', generated: isGenerated(c.extra) };
      col.orig = { ...col };
      return col;
    });
    m.origCols = m.cols.map(c => c.orig);
    m.idx = info.indexes.map(i => {
      const x = { id: nextId(), name: i.name, type: i.type, cols: idxColsText(i.columns) };
      x.orig = { ...x };
      return x;
    });
    m.origIdx = m.idx.map(i => i.orig);
    m.fks = info.foreignKeys.map(f => {
      const x = { id: nextId(), name: f.name, cols: f.columns.join(', '), refTable: f.refDb === db ? f.refTable : `${f.refDb}.${f.refTable}`, refCols: f.refColumns.join(', '), onUpdate: f.onUpdate || '', onDelete: f.onDelete || '' };
      x.orig = { ...x };
      return x;
    });
    m.origFks = m.fks.map(f => f.orig);
    m.create = info.create || '';
    m.part = buildPartModel(info.partitions);
    return m;
  }

  // ---------- SQL generation ----------

  genCreate() {
    const m = this.m;
    const defs = [...m.cols.map(colDef), ...m.idx.map(idxDef), ...m.fks.map(fkDef)];
    let s = `CREATE TABLE ${qi(m.db)}.${qi(m.opts.name)} (\n\t${defs.join(',\n\t')}\n)`;
    if (m.opts.comment) s += `\nCOMMENT=${sqlStr(m.opts.comment)}`;
    if (m.opts.collation) s += `\nCOLLATE=${sqlStr(m.opts.collation)}`;
    if (m.opts.engine) s += `\nENGINE=${m.opts.engine}`;
    if (m.opts.autoIncrement) s += `\nAUTO_INCREMENT=${parseInt(m.opts.autoIncrement, 10) || 1}`;
    if (m.opts.rowFormat) s += `\nROW_FORMAT=${m.opts.rowFormat}`;
    const pc = partitionClause(m.part);
    if (pc) s += '\n' + pc;
    return s;
  }

  genAlter() {
    const m = this.m;
    if (!m || m.creating) return [];
    const tbl = `${qi(m.db)}.${qi(m.origOpts.name)}`;
    const stmts = [];
    const idxFields = ['name', 'type', 'cols'];
    const fkFields = ['name', 'cols', 'refTable', 'refCols', 'onUpdate', 'onDelete'];

    // Foreign keys must be dropped in a separate statement before being re-added under the same name.
    const fkDrops = m.origFks.filter(o => { const cur = m.fks.find(f => f.orig === o); return !cur || !sameFields(cur, o, fkFields); });
    if (fkDrops.length) stmts.push(`ALTER TABLE ${tbl}\n\t${fkDrops.map(f => 'DROP FOREIGN KEY ' + qi(f.name)).join(',\n\t')}`);

    const parts = [];
    for (const o of m.origIdx) {
      const cur = m.idx.find(i => i.orig === o);
      if (!cur || !sameFields(cur, o, idxFields)) parts.push(o.type === 'PRIMARY' ? 'DROP PRIMARY KEY' : 'DROP INDEX ' + qi(o.name));
    }
    for (const o of m.origCols) if (!m.cols.some(c => c.orig === o)) parts.push('DROP COLUMN ' + qi(o.name));

    // Relative order of surviving original columns, to detect moved ones.
    const survivors = m.origCols.filter(o => m.cols.some(c => c.orig === o));
    const origPred = new Map(survivors.map((o, i) => [o, survivors[i - 1] || null]));
    const existing = m.cols.filter(c => c.orig);
    const newPred = new Map(existing.map((c, i) => [c.orig, existing[i - 1]?.orig || null]));

    m.cols.forEach((c, i) => {
      const pos = i === 0 ? 'FIRST' : 'AFTER ' + qi(m.cols[i - 1].name);
      if (!c.orig) parts.push(`ADD COLUMN ${colDef(c)} ${pos}`);
      else if (!c.generated) {
        const changed = !sameFields(c, c.orig, COL_FIELDS);
        const moved = origPred.get(c.orig) !== newPred.get(c.orig);
        if (changed || moved) parts.push(`CHANGE COLUMN ${qi(c.orig.name)} ${colDef(c)}${moved ? ' ' + pos : ''}`);
      }
    });

    for (const i of m.idx) if (!i.orig || !sameFields(i, i.orig, idxFields)) parts.push('ADD ' + idxDef(i));
    for (const f of m.fks) if (!f.orig || !sameFields(f, f.orig, fkFields)) parts.push('ADD ' + fkDef(f));

    const o = m.opts, oo = m.origOpts;
    if (o.comment !== oo.comment) parts.push('COMMENT=' + sqlStr(o.comment));
    if (o.engine && o.engine !== oo.engine) parts.push('ENGINE=' + o.engine);
    if (o.collation && o.collation !== oo.collation) parts.push('COLLATE=' + sqlStr(o.collation));
    if (o.autoIncrement && o.autoIncrement !== oo.autoIncrement) parts.push('AUTO_INCREMENT=' + (parseInt(o.autoIncrement, 10) || 1));
    if (o.rowFormat) parts.push('ROW_FORMAT=' + o.rowFormat);
    if (o.name !== oo.name) parts.push(`RENAME TO ${qi(m.db)}.${qi(o.name)}`);

    if (parts.length) stmts.push(`ALTER TABLE ${tbl}\n\t${parts.join(',\n\t')}`);
    // Partitioning goes last, on its own, addressing the table by its (possibly new) name.
    stmts.push(...partitionAlter(m.part, `${qi(m.db)}.${qi(o.name)}`));
    return stmts;
  }

  // ---------- table editor UI ----------

  renderTableEditor() {
    const m = this.m;
    this.saveBtn = h('button', { class: 'btn primary', onclick: () => this.save() }, 'Save');
    this.discardBtn = h('button', { class: 'btn', onclick: () => this.discard() }, 'Discard');
    const title = h('span', { class: 'viewtitle', html: icon('table') + ' ' });
    title.append(h('b', null, m.creating ? `New table in ${m.db}` : `${m.db}.${m.origOpts.name}`));
    const bar = h('div', { class: 'viewbar' }, title, this.roNote(), h('div', { class: 'grow' }), this.discardBtn, this.saveBtn);

    this.subtabsEl = h('div', { class: 'subtabs' });
    this.paneEl = h('div', { class: 'tv-pane' });
    const top = h('div', { class: 'tv-top' }, this.subtabsEl, this.paneEl);
    top.style.height = (this.app.state.layout?.tableTopHeight || 230) + 'px';
    const split = h('div', { class: 'splitter-h' });
    makeSplitter(split, {
      axis: 'y',
      get: () => top.offsetHeight,
      set: v => { top.style.height = Math.max(110, Math.min(v, this.el.clientHeight - 120)) + 'px'; },
      onEnd: () => { this.app.state.layout = { ...this.app.state.layout, tableTopHeight: top.offsetHeight }; this.app.saveStateSoon(); },
    });

    const colBar = h('div', { class: 'viewbar small' }, h('b', null, 'Columns:'),
      h('button', { class: 'tbtn', html: icon('plus') + '<span>Add</span>', title: 'Add column', onclick: () => this.addColumn() }),
      h('button', { class: 'tbtn', html: icon('minus') + '<span>Remove</span>', title: 'Remove column', onclick: () => this.removeColumn() }),
      h('button', { class: 'tbtn', html: icon('up') + '<span>Up</span>', title: 'Move up', onclick: () => this.moveColumn(-1) }),
      h('button', { class: 'tbtn', html: icon('down') + '<span>Down</span>', title: 'Move down', onclick: () => this.moveColumn(1) }));
    this.colsEl = h('div', { class: 'tv-cols' });
    this.el.replaceChildren(bar, top, split, colBar, this.colsEl);
    this.selCol = 0;
    this.renderSubtabs();
    this.renderPane();
    this.renderColumns();
    this.changed();
  }

  renderSubtabs() {
    const m = this.m;
    const tabs = [['basic', 'Basic'], ['options', 'Options'], ['indexes', `Indexes (${m.idx.length})`], ['fks', `Foreign keys (${m.fks.length})`], ['partitions', `Partitions (${partitionCount(m.part)})`], ['create', 'CREATE code']];
    if (!m.creating) tabs.push(['alter', 'ALTER code']);
    this.subtabsEl.replaceChildren(...tabs.map(([k, label]) =>
      h('button', { class: 'subtab' + (k === this.subtab ? ' active' : ''), onclick: () => { this.subtab = k; this.renderSubtabs(); this.renderPane(); } }, label)));
  }

  field(label, input) {
    return h('label', { class: 'frow' }, h('span', null, label), input);
  }

  renderPane() {
    const m = this.m;
    const o = m.opts;
    const bind = (key, el, prop = 'value') => {
      el[prop] = o[key] ?? '';
      el.addEventListener('input', () => { o[key] = el[prop]; this.changed(); });
      return el;
    };
    let content;
    switch (this.subtab) {
      case 'basic':
        content = h('div', { class: 'form2' },
          this.field('Name:', bind('name', h('input', { class: 'inp', spellcheck: false }))),
          this.field('Comment:', bind('comment', h('textarea', { class: 'inp', rows: 3 }))));
        break;
      case 'options': {
        const engine = h('select', { class: 'inp' }, h('option', { value: o.engine }, o.engine || '(default)'));
        this.app.getEngines(m.sid).then(list => {
          const names = new Set(list);
          if (o.engine) names.add(o.engine);
          engine.replaceChildren(h('option', { value: '' }, '(default)'), ...[...names].map(n => h('option', { value: n, selected: n === o.engine }, n)));
        }).catch(() => {});
        engine.addEventListener('change', () => { o.engine = engine.value; this.changed(); });
        const coll = bind('collation', h('input', { class: 'inp', list: 'dl-collations', spellcheck: false, placeholder: '(server default)' }));
        this.app.fillCollationList(m.sid);
        const rf = h('select', { class: 'inp' }, ROW_FORMATS.map(r => h('option', { value: r }, r || '(unchanged)')));
        rf.value = o.rowFormat;
        rf.addEventListener('change', () => { o.rowFormat = rf.value; this.changed(); });
        content = h('div', { class: 'form2 cols2' },
          this.field('Engine:', engine),
          this.field('Default collation:', coll),
          this.field('Auto increment:', bind('autoIncrement', h('input', { class: 'inp', type: 'number', min: 1 }))),
          this.field('Row format:', rf));
        break;
      }
      case 'indexes': content = this.renderIndexes(); break;
      case 'fks': content = this.renderFks(); break;
      case 'partitions': content = renderPartitions(this, m.part); break;
      case 'create': {
        const ed = new SqlEditor({ value: m.creating ? this.genCreate() + ';' : m.create + ';', readOnly: true });
        this.codeEd = ed;
        content = ed.el;
        break;
      }
      case 'alter': {
        const ed = new SqlEditor({ readOnly: true });
        this.alterEd = ed;
        content = ed.el;
        break;
      }
    }
    this.paneEl.replaceChildren(content);
    this.updateCode();
  }

  updateCode() {
    if (this.subtab === 'alter' && this.alterEd) {
      const s = this.genAlter();
      this.alterEd.value = s.length ? s.join(';\n\n') + ';' : '/* No changes */';
    }
    if (this.subtab === 'create' && this.codeEd && this.m.creating) this.codeEd.value = this.genCreate() + ';';
  }

  changed() {
    this.updateCode();
    const dirty = this.isDirty();
    if (this.saveBtn) this.saveBtn.disabled = !dirty || this.readOnly();
    if (this.discardBtn) this.discardBtn.disabled = !dirty || this.m.creating;
    this.app.tabs.setModified('table', dirty);
  }

  renderColumns() {
    const m = this.m;
    const keyIcons = name => {
      let out = '';
      for (const i of m.idx) {
        if (!splitTopLevel(i.cols).some(c => c.replace(/`/g, '').replace(/\(\d+\)|\s+(ASC|DESC)$/gi, '').trim() === name)) continue;
        out += icon(i.type === 'PRIMARY' ? 'key' : i.type === 'UNIQUE' ? 'keyu' : 'keyi');
      }
      return out;
    };
    const tbody = h('tbody');
    m.cols.forEach((c, i) => {
      const ro = c.generated;
      const inp = (key, attrs = {}) => {
        const el = h('input', { class: 'cell-inp', spellcheck: false, value: c[key] ?? '', disabled: ro, ...attrs });
        el.addEventListener('input', () => {
          c[key] = el.value;
          if (key === 'name') this.renderSubtabs();
          this.changed();
        });
        return el;
      };
      const nul = h('input', { type: 'checkbox', checked: c.nullable, disabled: ro });
      nul.addEventListener('change', () => { c.nullable = nul.checked; this.changed(); });
      const tr = h('tr', { class: (i === this.selCol ? 'sel' : '') + (c.orig ? '' : ' new') + (ro ? ' ro' : '') },
        h('td', { class: 'num', html: `${i + 1}${keyIcons(c.name)}` }),
        h('td', null, inp('name')),
        h('td', null, inp('type', { list: 'dl-types' })),
        h('td', { class: 'center' }, nul),
        h('td', null, inp('def', { placeholder: c.nullable ? '' : 'No default' })),
        h('td', null, inp('extra', { list: 'dl-extra' })),
        h('td', null, inp('collation', { list: 'dl-collations' })),
        h('td', null, inp('comment')));
      tr.addEventListener('mousedown', () => {
        this.selCol = i;
        for (const r of tbody.children) r.classList.remove('sel');
        tr.classList.add('sel');
      });
      tbody.append(tr);
    });
    const table = h('table', { class: 'edit-table' },
      h('thead', null, h('tr', null, ['#', 'Name', 'Datatype', 'Allow NULL', 'Default', 'Extra', 'Collation', 'Comment'].map(t => h('th', null, t)))),
      tbody);
    this.colsEl.replaceChildren(table,
      h('datalist', { id: 'dl-types' }, TYPES.map(t => h('option', { value: t }))),
      h('datalist', { id: 'dl-extra' }, ['auto_increment', 'on update CURRENT_TIMESTAMP', 'INVISIBLE'].map(t => h('option', { value: t }))));
    this.app.fillCollationList(m.sid);
  }

  addColumn() {
    const m = this.m;
    let n = 1;
    while (m.cols.some(c => c.name === 'column_' + n)) n++;
    const at = Math.min(this.selCol + 1, m.cols.length);
    m.cols.splice(at, 0, { id: nextId(), name: 'column_' + n, type: 'varchar(255)', nullable: true, def: 'NULL', extra: '', collation: '', comment: '', orig: null });
    this.selCol = at;
    this.renderColumns();
    this.changed();
    this.colsEl.querySelectorAll('tbody tr')[at]?.querySelector('input')?.select();
  }

  removeColumn() {
    const m = this.m;
    if (!m.cols.length) return;
    m.cols.splice(this.selCol, 1);
    this.selCol = Math.max(0, Math.min(this.selCol, m.cols.length - 1));
    this.renderColumns();
    this.changed();
  }

  moveColumn(d) {
    const m = this.m;
    const i = this.selCol, j = i + d;
    if (j < 0 || j >= m.cols.length) return;
    if (m.cols[i].generated) return;
    [m.cols[i], m.cols[j]] = [m.cols[j], m.cols[i]];
    this.selCol = j;
    this.renderColumns();
    this.changed();
  }

  renderIndexes() {
    const m = this.m;
    let sel = 0;
    const tbody = h('tbody');
    const draw = () => {
      tbody.replaceChildren(...m.idx.map((x, i) => {
        const name = h('input', { class: 'cell-inp', value: x.name, spellcheck: false, disabled: x.type === 'PRIMARY' });
        name.addEventListener('input', () => { x.name = name.value; this.changed(); });
        const type = h('select', { class: 'cell-inp' }, INDEX_TYPES.map(t => h('option', { value: t, selected: t === x.type }, t)));
        type.addEventListener('change', () => {
          x.type = type.value;
          if (x.type === 'PRIMARY') x.name = 'PRIMARY';
          else if (x.name === 'PRIMARY') x.name = 'idx_' + (splitTopLevel(x.cols)[0] || 'new').replace(/\W/g, '');
          draw();
          this.renderColumns();
          this.changed();
        });
        const cols = h('input', { class: 'cell-inp', value: x.cols, spellcheck: false, placeholder: 'col1, col2(10), ...' });
        cols.addEventListener('input', () => { x.cols = cols.value; this.changed(); });
        cols.addEventListener('change', () => this.renderColumns());
        const tr = h('tr', { class: (i === sel ? 'sel' : '') + (x.orig ? '' : ' new') }, h('td', { class: 'num' }, i + 1), h('td', null, name), h('td', null, type), h('td', null, cols));
        tr.addEventListener('mousedown', () => { sel = i; for (const r of tbody.children) r.classList.remove('sel'); tr.classList.add('sel'); });
        return tr;
      }));
    };
    draw();
    const colNames = m.cols.map(c => c.name);
    const addBtn = h('button', {
      class: 'tbtn', html: icon('plus') + '<span>Add index</span>', onclick: () => {
        const first = colNames[this.selCol] || colNames[0] || '';
        const hasPk = m.idx.some(i => i.type === 'PRIMARY');
        m.idx.push({ id: nextId(), name: hasPk ? 'idx_' + first.replace(/\W/g, '') : 'PRIMARY', type: hasPk ? 'KEY' : 'PRIMARY', cols: first, orig: null });
        sel = m.idx.length - 1;
        draw();
        this.renderSubtabs();
        this.renderColumns();
        this.changed();
      },
    });
    const rmBtn = h('button', {
      class: 'tbtn', html: icon('minus') + '<span>Remove</span>', onclick: () => {
        if (!m.idx.length) return;
        m.idx.splice(sel, 1);
        sel = Math.max(0, sel - 1);
        draw();
        this.renderSubtabs();
        this.renderColumns();
        this.changed();
      },
    });
    return h('div', { class: 'tv-list' }, h('div', { class: 'viewbar small' }, addBtn, rmBtn, h('span', { class: 'muted' }, 'Columns as a comma separated list; use name(n) for prefix length, (expr) for functional parts.')),
      h('table', { class: 'edit-table' }, h('thead', null, h('tr', null, ['#', 'Name', 'Type', 'Columns'].map(t => h('th', null, t)))), tbody));
  }

  renderFks() {
    const m = this.m;
    let sel = 0;
    const tbody = h('tbody');
    const draw = () => {
      tbody.replaceChildren(...m.fks.map((f, i) => {
        const inp = (key, ph = '') => {
          const el = h('input', { class: 'cell-inp', value: f[key], spellcheck: false, placeholder: ph });
          el.addEventListener('input', () => { f[key] = el.value; this.changed(); });
          return el;
        };
        const rule = key => {
          const el = h('select', { class: 'cell-inp' }, h('option', { value: '' }, ''), FK_RULES.map(r => h('option', { value: r, selected: r === f[key] }, r)));
          el.addEventListener('change', () => { f[key] = el.value; this.changed(); });
          return el;
        };
        const tr = h('tr', { class: (i === sel ? 'sel' : '') + (f.orig ? '' : ' new') },
          h('td', { class: 'num' }, i + 1), h('td', null, inp('name')), h('td', null, inp('cols', 'col1, col2')),
          h('td', null, inp('refTable', 'table or db.table')), h('td', null, inp('refCols', 'id')), h('td', null, rule('onUpdate')), h('td', null, rule('onDelete')));
        tr.addEventListener('mousedown', () => { sel = i; for (const r of tbody.children) r.classList.remove('sel'); tr.classList.add('sel'); });
        return tr;
      }));
    };
    draw();
    const add = () => {
      const col = m.cols[this.selCol]?.name || '';
      m.fks.push({ id: nextId(), name: `fk_${m.opts.name}_${col}`.slice(0, 64), cols: col, refTable: '', refCols: 'id', onUpdate: 'RESTRICT', onDelete: 'RESTRICT', orig: null });
      sel = m.fks.length - 1;
      draw();
      this.renderSubtabs();
      this.changed();
    };
    const remove = () => {
      if (!m.fks.length) return;
      m.fks.splice(sel, 1);
      sel = Math.max(0, sel - 1);
      draw();
      this.renderSubtabs();
      this.changed();
    };
    return h('div', { class: 'tv-list' },
      h('div', { class: 'viewbar small' },
        h('button', { class: 'tbtn', html: icon('plus') + '<span>Add foreign key</span>', onclick: add }),
        h('button', { class: 'tbtn', html: icon('minus') + '<span>Remove</span>', onclick: remove })),
      h('table', { class: 'edit-table' }, h('thead', null, h('tr', null, ['#', 'Name', 'Columns', 'Reference table', 'Foreign columns', 'On UPDATE', 'On DELETE'].map(t => h('th', null, t)))), tbody));
  }

  async discard() {
    if (this.m?.creating) return;
    if (this.isDirty() && !(await confirmDlg('Discard all unsaved changes?'))) return;
    this.load();
  }

  async save() {
    const m = this.m;
    if (m.code) return this.saveCode();
    const stmts = m.creating ? [this.genCreate()] : this.genAlter();
    if (!stmts.length) return;
    if (!(await this.app.confirmChanges(m.sid, { action: m.creating ? `Create table ${m.opts.name}` : `Alter table ${m.origOpts.name}`, statements: stmts }))) return;
    try {
      await this.app.exec(m.sid, stmts, m.db);
    } catch (e) {
      this.app.showError(e);
      return;
    }
    this.app.setStatus(m.creating ? `Table ${m.opts.name} created.` : `Table ${m.opts.name} altered.`);
    const name = m.opts.name;
    // The model is stale now; drop it so selecting the (possibly renamed) table doesn't ask to discard changes.
    this.m = null;
    this.createKey = null;
    this.key = null;
    this.app.tabs.setModified('table', false);
    await this.app.refreshDb(m.sid, m.db);
    await this.app.selectObject(m.sid, m.db, name, 'table', { tab: 'table' });
    this.load();
  }

  // ---------- code editor for views / routines / triggers / events ----------

  renderCodeEditor() {
    const m = this.m;
    this.editor = new SqlEditor({ value: m.origCode, onChange: () => this.codeChanged(), completer: o => this.app.complete(o), readOnly: this.readOnly() });
    this.saveBtn = h('button', { class: 'btn primary', onclick: () => this.saveCode() }, 'Save');
    this.discardBtn = h('button', { class: 'btn', onclick: () => { this.editor.value = m.origCode; this.codeChanged(); } }, 'Discard');
    const title = h('span', { class: 'viewtitle', html: icon(m.type) + ' ' });
    title.append(h('b', null, `${TYPE_LABEL[m.type]}: ${m.db}.${m.name}`));
    const hint = h('span', { class: 'muted' }, m.type === 'view' ? 'Saved with CREATE OR REPLACE.' : `Saving drops and re-creates the ${m.type}.`);
    this.el.replaceChildren(h('div', { class: 'viewbar' }, title, this.readOnly() ? this.roNote() : hint, h('div', { class: 'grow' }), this.discardBtn, this.saveBtn), h('div', { class: 'tv-code' }, this.editor.el));
    this.codeChanged();
  }

  codeChanged() {
    const dirty = this.editor.value !== this.m.origCode;
    this.saveBtn.disabled = !dirty || this.readOnly();
    this.discardBtn.disabled = !dirty;
    this.app.tabs.setModified('table', dirty);
  }

  async saveCode() {
    const m = this.m;
    const code = this.editor.value.trim().replace(/;\s*$/, '');
    if (!code) return;
    const kw = m.type.toUpperCase();
    const stmts = m.type === 'view'
      ? [code.replace(/^\s*CREATE\s+(OR\s+REPLACE\s+)?/i, 'CREATE OR REPLACE ')]
      : [`DROP ${kw} IF EXISTS ${qi(m.db)}.${qi(m.name)}`, code];
    if (!(await this.app.confirmChanges(m.sid, { action: `Save ${m.type} ${m.name}`, statements: stmts }))) return;
    try {
      await this.app.exec(m.sid, stmts, m.db);
    } catch (e) {
      this.app.showError(e);
      return;
    }
    this.app.setStatus(`${TYPE_LABEL[m.type]} ${m.name} saved.`);
    m.origCode = this.editor.value;
    this.codeChanged();
    const nm = /\b(?:VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT)\s+(?:(?:`[^`]+`|\w+)\.)?(`[^`]+`|\w+)/i.exec(code);
    const newName = nm ? nm[1].replace(/^`|`$/g, '').replace(/``/g, '`') : m.name;
    await this.app.refreshDb(m.sid, m.db);
    if (newName !== m.name) await this.app.selectObject(m.sid, m.db, newName, m.type, { tab: 'table' });
  }
}
