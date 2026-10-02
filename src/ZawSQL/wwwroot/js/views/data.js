// "Data" tab: paged, sortable, filterable and editable table contents.
import { h, qi, sqlStr, fmtNum, parseEnum, isNumericKind } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { Grid } from '../grid.js';
import { contextMenu } from '../dialogs.js';
import { exportGridDialog, rowsToSql } from './tools.js';
import { RowEditor } from './editing.js';

export class DataView {
  constructor(app) {
    this.app = app;
    this.key = null;
    this.target = null;
    this.rows = [];
    this.cols = [];
    this.sort = null;
    this.where = '';
    this.showAll = false;

    this.info = h('span', { class: 'data-info' });
    const btn = (ic, label, title, fn) => h('button', { class: 'tbtn', title, html: icon(ic) + (label ? `<span>${label}</span>` : ''), onclick: fn });
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
    const toolbar = h('div', { class: 'viewbar' }, this.info, h('div', { class: 'grow' }),
      this.nextBtn, this.allBtn, h('span', { class: 'sep' }),
      ...this.editBtns,
      h('span', { class: 'sep' }),
      btn('filter', 'Filter', 'Show/hide row filter', () => this.toggleFilter()),
      this.search,
      btn('refresh', '', 'Refresh (F5)', () => this.load()));

    this.whereInput = h('textarea', { class: 'inp mono', rows: 2, spellcheck: false, placeholder: "WHERE clause, e.g.  name LIKE 'abc%' AND id > 10" });
    this.whereInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); this.applyFilter(); }
    });
    this.filterBox = h('div', { class: 'filter-box', style: { display: 'none' } },
      h('span', { class: 'filter-label', html: icon('filter') + ' WHERE' }), this.whereInput,
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
      onKey: e => this.editor.handleKey(e),
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
      this.sort = null;
      this.where = '';
      this.showAll = false;
      this.whereInput.value = '';
      this.search.value = '';
      this.cols = [];
      this.meta = null;
      this.load();
    }
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
      const sc = this.sort ? this.cols.findIndex(c => c.name === this.sort.col) : -1;
      this.grid.sort = sc >= 0 ? { c: sc, dir: this.sort.dir } : null;
      this.grid.setData(this.cols, this.rows, { keepWidths: sameCols, keepPos: append });
      this.updateInfo();
    } catch (e) {
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

  applyFilter() {
    this.where = this.whereInput.value.trim();
    this.load();
  }

  setFilter(where) {
    this.whereInput.value = where;
    this.toggleFilter(true);
    this.applyFilter();
  }

  quickSearch() {
    const q = this.search.value;
    if (!q) return this.setFilter('');
    const like = sqlStr('%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%');
    this.setFilter(this.cols.map(c => `${qi(c.name)} LIKE ${like}`).join(' OR '));
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
      ...this.editor.menuItems(p),
    ];
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
      { label: 'Export grid rows…', icon: 'export', onClick: () => exportGridDialog(this.app, { columns: this.cols, rows: this.rows, selected: this.grid.selectedRowIndexes(), name: this.target.table }) },
      { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => this.load() });
    contextMenu(e.clientX, e.clientY, items);
  }
}
