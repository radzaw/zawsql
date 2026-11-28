// "Data" tab: paged, sortable, filterable and editable table contents.
import { h, qi, sqlStr, fmtNum, parseEnum, isNumericKind } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { Grid } from '../grid.js';
import { contextMenu } from '../dialogs.js';
import { exportGridDialog, rowsToSql } from './tools.js';
import { RowEditor } from './editing.js';
import { whereKey, rememberWhere, forgetWhere, whereLabel } from '../wherehistory.js';
import { rememberView, viewFor, withExistingSort } from '../dataviewstate.js';
import { rowLinks, linkColumns, tableLabel } from '../fklogic.js';
import { dataGenDialog } from './datagen.js';

const BACK_LIMIT = 50;

export class DataView {
  constructor(app) {
    this.app = app;
    this.key = null;
    this.target = null;
    this.rows = [];
    this.cols = [];
    this.sort = null;
    this.where = '';
    this.searched = null; // the quick search behind the current filter: { q, where }
    this.showAll = false;
    this.rel = null; // the table's foreign keys and those pointing at it (/relations)
    this.relKey = null;
    this.backStack = []; // tables left by following a foreign key: { sid, db, table }
    this.pending = null; // the filter to open the next table with: { key, where }

    this.info = h('span', { class: 'data-info' });
    const btn = (ic, label, title, fn) => h('button', { class: 'tbtn', title, html: icon(ic) + (label ? `<span>${label}</span>` : ''), onclick: fn });
    this.backBtn = btn('back', 'Back', 'Back to the table you came from (Alt+←)', () => this.back());
    this.backBtn.style.display = 'none';
    this.nextBtn = btn('next', 'Next', 'Load next rows', () => this.load(true));
    this.allBtn = btn('all', 'Show all', 'Load all rows', () => { this.showAll = true; this.load(); });
    this.search = h('input', { class: 'inp filter-inp', placeholder: 'Quick search (Enter)', title: 'Searches all columns with LIKE' });
    this.search.addEventListener('keydown', e => { if (e.key === 'Enter') this.quickSearch(); });
    this.editBtns = [
      btn('plus', '', 'Insert row (Insert)', () => this.editor.insertRow()),
      btn('minus', '', 'Delete selected rows (Ctrl+Delete)', () => this.editor.deleteRows()),
      btn('check', '', 'Post row', () => this.editor.postCurrent()),
      btn('cancel', '', 'Cancel editing', () => this.editor.cancelRow()),
    ];
    const toolbar = h('div', { class: 'viewbar' }, this.backBtn, this.info, h('div', { class: 'grow' }),
      this.nextBtn, this.allBtn, h('span', { class: 'sep' }),
      ...this.editBtns,
      h('span', { class: 'sep' }),
      btn('filter', 'Filter', 'Show/hide row filter', () => this.toggleFilter()),
      this.search,
      btn('refresh', '', 'Refresh (F5)', () => this.load()));

    this.whereInput = h('textarea', { class: 'inp mono', rows: 2, spellcheck: false, placeholder: "WHERE clause, e.g.  name LIKE 'abc%' AND id > 10" });
    this.whereInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); this.applyFilter(); }
      else if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); this.showWhereHistory(); }
    });
    // Recently used filters of this table, to pick again from a drop-down.
    this.histBtn = h('button', { class: 'btn filter-hist', title: 'Recent filters on this table (Alt+↓ in the filter box)', onclick: () => this.showWhereHistory() },
      h('span', { html: icon('history') }), h('span', null, 'Recent'), h('span', { class: 'filter-hist-arrow' }, '▾'));
    this.filterBox = h('div', { class: 'filter-box', style: { display: 'none' } },
      h('div', { class: 'filter-side' }, h('span', { class: 'filter-label', html: icon('filter') + ' WHERE' }), this.histBtn), this.whereInput,
      h('div', { class: 'filter-btns' },
        h('button', { class: 'btn primary', onclick: () => this.applyFilter() }, 'Apply filter'),
        h('button', { class: 'btn', onclick: () => { this.whereInput.value = ''; this.applyFilter(); } }, 'Clear')));

    this.grid = new Grid({
      editable: true,
      emptyText: '',
      onCellEdit: (r, c, v) => this.editor.cellEdit(r, c, v),
      onSort: c => this.toggleSort(c),
      onContextMenu: (e, p) => this.ctx(e, p),
      onRowChange: prev => this.editor.rowLeft(prev),
      onKey: e => {
        if (e.altKey && e.key === 'ArrowLeft' && this.backStack.length) { e.preventDefault(); this.back(); return; }
        this.editor.handleKey(e);
      },
      onLinkClick: (r, c) => this.followCell(r, c),
      arrange: true,
      onLayout: l => { this.colLayout = l; this.rememberView(); },
    });
    // SELECT * returns the table's columns in table order, so grid columns map 1:1 to the re-read row.
    this.editor = new RowEditor(app, {
      grid: this.grid,
      target: () => (this.target && this.meta && !this.meta.isView && !app.isReadOnly(this.target.sid) ? this.target : null),
      colName: c => this.cols[c]?.name ?? null,
      applyServerRow: (row, sr) => sr.forEach((v, i) => { row[i] = v; }),
    });
    this.el = h('div', { class: 'view data-view' }, toolbar, this.filterBox, this.grid.el);
  }

  onShow() {
    const s = this.app.sel;
    if (!s.obj || !['table', 'view'].includes(s.obj.type)) {
      this.key = null;
      this.target = null;
      this.info.textContent = '';
      this.grid.setData([], []);
      return;
    }
    const k = `${s.sid}|${s.db}|${s.obj.name}`;
    if (k !== this.key) {
      this.key = k;
      this.target = { sid: s.sid, db: s.db, table: s.obj.name };
      // Back on a table: the sorting and filter it had last time.
      const v = viewFor(this.app.state.dataViews, this.viewKey);
      this.sort = v.sort;
      this.where = v.where;
      this.colLayout = v.cols;
      this.showAll = false;
      this.whereInput.value = v.where;
      this.search.value = v.search;
      this.searched = v.search && v.where ? { q: v.search, where: v.where } : null;
      // Opened by following a foreign key: its filter instead of the remembered one. Opened any other way: Back is forgotten.
      const p = this.pending;
      this.pending = null;
      if (p && p.key.toLowerCase() === k.toLowerCase()) {
        this.where = p.where;
        this.whereInput.value = p.where;
        this.search.value = '';
        this.searched = null;
      } else if (!p?.back) this.backStack = [];
      this.updateBack();
      if (this.where) this.filterBox.style.display = '';
      this.cols = [];
      this.meta = null;
      this.load();
      this.loadRelations();
    }
  }

  // ---------- following foreign keys ----------

  async loadRelations() {
    const t = this.target, key = this.key;
    if (this.relKey === key) return;
    this.rel = null;
    this.relKey = key;
    try {
      const rel = await get(`/s/${t.sid}/relations`, { db: t.db, table: t.table }, { quiet: true });
      if (key !== this.key) return;
      this.rel = rel;
      this.markLinks();
    } catch {
      // Without them the grid simply has no links; the table itself still works.
      if (key === this.key) this.relKey = null;
    }
  }

  /** Marks the foreign key columns as links in the grid (once both the columns and the relations are known). */
  markLinks() {
    if (!this.rel || !this.cols.length) return;
    const links = new Set([...linkColumns(this.rel)].map(n => n.toLowerCase()));
    for (const c of this.cols) {
      const fks = this.rel.outgoing.filter(fk => fk.columns.some(n => n.toLowerCase() === c.name.toLowerCase()));
      c.link = links.has(c.name.toLowerCase());
      if (c.link && !c.title.includes('\n→')) c.title += fks.map(fk => `\n→ ${tableLabel({ db: fk.refDb, label: `${fk.refTable} (${fk.refColumns.join(', ')})` }, this.target.db)}`).join('') + '\nCtrl+click a value to open the row it references';
    }
    this.grid.renderHeader();
    this.grid.render();
  }

  linksAt(r, c) {
    const row = this.rows[r];
    if (!this.rel || !row || row.$new) return null;
    return rowLinks(this.rel, this.cols, row, this.cols[c]?.name);
  }

  /** Ctrl+click on a foreign key value: the referenced row (the first key containing that column). */
  followCell(r, c) {
    const l = this.linksAt(r, c)?.outgoing.find(x => x.has && x.where);
    if (l) this.follow(l);
  }

  async follow(link) {
    const t = this.target;
    if (!t || !link.where) return;
    const from = { sid: t.sid, db: t.db, table: t.table };
    // A key pointing at its own table (parent_id → id): same tab, just the filter.
    if (link.db.toLowerCase() === t.db.toLowerCase() && link.table.toLowerCase() === t.table.toLowerCase()) {
      this.pushBack(from);
      this.updateBack();
      this.setFilter(link.where, { record: false });
      return;
    }
    this.pending = { key: `${t.sid}|${link.db}|${link.table}`, where: link.where };
    const prevStack = this.backStack;
    this.pushBack(from);
    if (!(await this.app.selectObject(t.sid, link.db, link.table, 'table', { tab: 'data' }))) {
      this.pending = null;
      this.backStack = prevStack;
      this.app.showError(new Error(`${link.db}.${link.table} isn't in the object tree (check the session's database filter).`));
    }
  }

  pushBack(from) {
    this.backStack = [...this.backStack, from].slice(-BACK_LIMIT);
  }

  async back() {
    const prev = this.backStack.at(-1);
    if (!prev) return;
    this.backStack = this.backStack.slice(0, -1);
    const t = this.target;
    if (t && prev.sid === t.sid && prev.db === t.db && prev.table === t.table) {
      // Back within a self-referencing table: the filter it had before isn't known, so show the table unfiltered.
      this.updateBack();
      this.setFilter('', { record: false });
      return;
    }
    this.pending = { back: true, key: '' };
    if (!(await this.app.selectObject(prev.sid, prev.db, prev.table, 'table', { tab: 'data' }))) {
      this.pending = null;
      this.updateBack();
    }
  }

  updateBack() {
    const prev = this.backStack.at(-1);
    this.backBtn.style.display = prev ? '' : 'none';
    if (prev) this.backBtn.title = `Back to ${prev.table} (Alt+←)`;
  }

  refresh() { return this.target && this.load(); }

  async load(append = false) {
    const t = this.target;
    if (!t) return;
    const key = this.key;
    const limit = this.showAll ? 0 : this.app.prefs.rowsPerPage;
    this.info.textContent = 'Loading…';
    try {
      const r = await get(`/s/${t.sid}/data`, {
        db: t.db, table: t.table,
        offset: append ? this.rows.length : 0, limit,
        order: this.sort?.col, dir: this.sort?.dir, where: this.where,
      });
      if (key !== this.key) return;
      const sameCols = this.cols.length === r.columns.length && this.cols.every((c, i) => c.name === r.columns[i].name);
      this.meta = r;
      this.cols = r.columns.map(c => ({
        name: c.name,
        kind: c.kind,
        type: c.type,
        title: `${c.name}: ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.extra ? ' ' + c.extra : ''}${c.comment ? '\n' + c.comment : ''}`,
        key: r.keyColumns.includes(c.name) ? (r.keySource === 'primary' ? 'pri' : 'uni') : null,
        enumValues: parseEnum(c.type),
        readOnly: r.isView || c.generated,
      }));
      this.rows = append ? this.rows.concat(r.rows) : r.rows;
      this.hasMore = limit > 0 && r.rows.length === limit;
      this.grid.o.editable = this.editor.enabled();
      this.sort = withExistingSort({ sort: this.sort }, this.cols.map(c => c.name)).sort;
      const sc = this.sort ? this.cols.findIndex(c => c.name === this.sort.col) : -1;
      this.grid.sort = sc >= 0 ? { c: sc, dir: this.sort.dir } : null;
      this.grid.setData(this.cols, this.rows, { keepWidths: sameCols, keepPos: append, layout: this.colLayout });
      this.markLinks();
      this.updateInfo();
      // Only views that loaded are remembered, so a broken filter isn't brought back next time.
      if (!append) this.rememberView();
      // The filter worked: offer it again next time.
      if (this.recordWhere && this.recordWhere === this.where) this.rememberFilter(this.where);
      this.recordWhere = null;
    } catch (e) {
      this.recordWhere = null;
      if (key !== this.key) return;
      this.info.textContent = 'Error';
      this.app.showError(e);
    }
  }

  updateInfo() {
    const t = this.target;
    const est = this.meta?.estimatedRows;
    let s = `${t.db}.${t.table}: `;
    s += est != null ? `${fmtNum(est)} rows total (approximately)` : 'view';
    s += this.where ? `, ${fmtNum(this.rows.length)} matching filter` : `, ${fmtNum(this.rows.length)} shown`;
    if (this.app.isReadOnly(t.sid)) s += ' – read-only session';
    else if (this.meta?.isView) s += ' – read only';
    else if (this.meta?.keySource === 'none') s += ' – no unique key, edits use all columns';
    this.info.textContent = s;
    for (const b of this.editBtns) b.disabled = !this.editor.enabled();
    this.nextBtn.disabled = !this.hasMore;
    this.allBtn.disabled = !this.hasMore;
  }

  toggleSort(c) {
    const col = this.cols[c].name;
    this.sort = this.sort?.col === col ? (this.sort.dir === 'asc' ? { col, dir: 'desc' } : null) : { col, dir: 'asc' };
    this.load();
  }

  toggleFilter(show) {
    const vis = show ?? this.filterBox.style.display === 'none';
    this.filterBox.style.display = vis ? '' : 'none';
    if (vis) this.whereInput.focus();
  }

  /** record: remember the filter in the table's history once it has run without an error. */
  applyFilter({ record = true } = {}) {
    this.where = this.whereInput.value.trim();
    this.recordWhere = record && this.where ? this.where : null;
    this.load();
  }

  setFilter(where, opts) {
    this.whereInput.value = where;
    this.toggleFilter(true);
    this.applyFilter(opts);
  }

  quickSearch() {
    const q = this.search.value;
    if (!q) return this.setFilter('');
    const like = sqlStr('%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%');
    const where = this.cols.map(c => `${qi(c.name)} LIKE ${like}`).join(' OR ');
    this.searched = { q, where };
    // A generated search over every column would only clutter the history.
    this.setFilter(where, { record: false });
  }

  // ---------- remembered sorting and filter, filter history ----------

  get viewKey() { return this.target ? whereKey(this.target.db, this.target.table) : null; }
  get whereHistoryKey() { return this.viewKey; }

  rememberView() {
    const key = this.viewKey;
    if (!key) return;
    const prev = this.app.state.dataViews;
    // The search text only while its filter is the one applied (not typed without Enter, not replaced since).
    const search = this.where && this.searched?.where === this.where ? this.searched.q : '';
    const next = rememberView(prev, key, { sort: this.sort, where: this.where, search, cols: this.colLayout });
    if (JSON.stringify(next) === JSON.stringify(prev ?? {})) return;
    this.app.state.dataViews = next;
    this.app.saveStateSoon();
  }

  rememberFilter(where) {
    this.app.state.whereHistory = rememberWhere(this.app.state.whereHistory, this.whereHistoryKey, where);
    this.app.saveStateSoon();
  }

  showWhereHistory() {
    const key = this.whereHistoryKey;
    if (!key) return;
    const list = this.app.state.whereHistory?.[key] ?? [];
    const forget = where => { this.app.state.whereHistory = forgetWhere(this.app.state.whereHistory, key, where); this.app.saveStateSoon(); };
    const r = this.histBtn.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 2, list.length ? [
      ...list.map(w => ({ label: whereLabel(w), title: w, checked: w === this.where, onClick: () => this.setFilter(w) })),
      '-',
      { label: 'Remove the current filter from the list', disabled: !this.where || !list.includes(this.where), onClick: () => forget(this.where) },
      { label: `Clear the list for ${this.target.table}`, icon: 'trash', onClick: () => forget() },
    ] : [{ label: `No filters used on ${this.target.table} yet`, disabled: true }]);
  }

  // ---------- context menu ----------

  ctx(e, p) {
    if (!this.target) return;
    const col = this.cols[p.c];
    const v = p.r >= 0 ? this.rows[p.r]?.[p.c] : undefined;
    const items = [
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => this.grid.copy() },
      { label: 'Copy rows as INSERT', onClick: () => this.grid.copy(rowsToSql(this.target.table, this.cols, this.grid.selectedRowIndexes().map(i => this.rows[i]))) },
      '-',
      { label: 'Choose columns…', icon: 'columns', onClick: () => this.grid.chooseColumns() },
      col && { label: `Hide column ${col.name}`, disabled: this.grid.order.length <= 1, onClick: () => this.grid.setHidden(p.c, true) },
      { label: 'Show all columns', disabled: !this.grid.hidden.size, onClick: () => this.grid.setArrangement(this.grid.seq, new Set(), true) },
      '-',
      ...this.editor.menuItems(p),
    ];
    const links = p.r >= 0 ? this.linksAt(p.r, p.c) : null;
    if (links && (links.outgoing.length || links.incoming.length)) {
      const db = this.target.db;
      const entry = l => ({ label: tableLabel(l, db), title: l.where ?? 'The key is NULL in this row', disabled: !l.where, onClick: () => this.follow(l) });
      const go = links.outgoing.map(l => ({ ...entry(l), label: `Go to ${tableLabel(l, db)}`, icon: 'fk', shortcut: l === links.outgoing.find(x => x.has) ? 'Ctrl+click' : undefined }));
      items.push('-', ...go);
      if (links.incoming.length) items.push({ label: 'Rows referencing this row', icon: 'fk', submenu: links.incoming.map(entry) });
    }
    if (col && v !== undefined) {
      const name = qi(col.name);
      const lit = v == null ? null : isNumericKind(col.kind) ? v : sqlStr(v);
      const short = v == null ? 'NULL' : v.length > 30 ? v.slice(0, 30) + '…' : v;
      items.push('-', {
        label: 'Quick filter', icon: 'filter', submenu: [
          lit != null && { label: `= ${short}`, onClick: () => this.setFilter(`${name} = ${lit}`) },
          lit != null && { label: `!= ${short}`, onClick: () => this.setFilter(`${name} != ${lit}`) },
          lit != null && { label: `> ${short}`, onClick: () => this.setFilter(`${name} > ${lit}`) },
          lit != null && { label: `< ${short}`, onClick: () => this.setFilter(`${name} < ${lit}`) },
          lit != null && { label: `LIKE '%${short}%'`, onClick: () => this.setFilter(`${name} LIKE ${sqlStr('%' + v + '%')}`) },
          { label: 'IS NULL', onClick: () => this.setFilter(`${name} IS NULL`) },
          { label: 'IS NOT NULL', onClick: () => this.setFilter(`${name} IS NOT NULL`) },
          '-',
          { label: 'Reset filter', disabled: !this.where, onClick: () => this.setFilter('') },
        ],
      });
    }
    items.push('-',
      !this.meta?.isView && { label: 'Generate test data…', icon: 'sparkle', disabled: this.app.isReadOnly(this.target.sid), onClick: () => dataGenDialog(this.app, this.target.sid, this.target.db, this.target.table) },
      { label: 'Export grid rows…', icon: 'export', onClick: () => exportGridDialog(this.app, { columns: this.cols, rows: this.rows, selected: this.grid.selectedRowIndexes(), name: this.target.table }) },
      { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => this.load() });
    contextMenu(e.clientX, e.clientY, items);
  }
}
