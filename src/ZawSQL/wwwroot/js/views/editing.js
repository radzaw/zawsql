// Row editing shared by the Data tab and editable query results: posts cell edits, inserts and deletes
// for a grid whose columns map onto one table.
import { post } from '../api.js';
import { confirmDlg } from '../dialogs.js';

export class RowEditor {
  /**
   * @param app
   * @param opts.grid            the Grid being edited
   * @param opts.target          () => {sid, db, table} or null when editing is not possible
   * @param opts.colName         (c) => table column name of grid column c, or null if not a table column
   * @param opts.applyServerRow  (row, serverRow) => void; copies the re-read table row (table column order) into the grid row
   * @param opts.onRowsChanged   optional () => void after rows were inserted or removed
   */
  constructor(app, opts) {
    this.app = app;
    this.onRowsChanged = () => {};
    Object.assign(this, opts);
  }

  get rows() { return this.grid.rows; }

  enabled() { return !!this.target(); }

  /** Values of all table columns of a row, keyed by table column name. */
  rowObj(row) {
    const o = {};
    this.grid.columns.forEach((_, i) => {
      const n = this.colName(i);
      if (n != null) o[n] = row[i];
    });
    return o;
  }

  async cellEdit(r, c, v) {
    const row = this.rows[r];
    if (!row || this.colName(c) == null) return;
    if (row.$new) {
      row[c] = v;
      (row.$set ??= new Set()).add(c);
      row.$dirty = true;
      this.grid.render();
      return;
    }
    if (!row.$orig) row.$orig = row.slice();
    row[c] = v;
    (row.$changed ??= new Set()).add(c);
    row.$dirty = true;
    this.grid.render();
    await this.postRow(row);
  }

  async postRow(row) {
    if (!row?.$dirty || row.$posting) return true;
    const t = this.target();
    if (!t) return false;
    row.$posting = true;
    const action = `${row.$new ? 'Insert a row into' : 'Update a row in'} ${t.db}.${t.table}`;
    if (!(await this.app.confirmChanges(t.sid, { action }))) {
      row.$posting = false;
      if (!row.$new) this.revert(row);
      return false;
    }
    const values = {};
    for (const c of (row.$new ? row.$set : row.$changed) || []) values[this.colName(c)] = row[c];
    const op = row.$new ? { op: 'insert', values } : { op: 'update', original: this.rowObj(row.$orig), values };
    try {
      const [res] = await post(`/s/${t.sid}/rows`, { db: t.db, table: t.table, ops: [op] });
      if (res.row) this.applyServerRow(row, res.row);
      delete row.$orig; delete row.$changed; delete row.$set; delete row.$new; delete row.$dirty;
      this.grid.render();
      this.app.setStatus(op.op === 'insert' ? 'Row inserted.' : 'Row updated.');
      return true;
    } catch (e) {
      await this.app.showError(e);
      return false;
    } finally {
      row.$posting = false;
    }
  }

  postCurrent() {
    return this.postRow(this.rows[this.grid.cur.r]);
  }

  /** Grid row-change hook: a finished new row is inserted when the cursor leaves it. */
  rowLeft(prev) {
    const row = this.rows[prev];
    if (row?.$new && row.$dirty) this.postRow(row);
  }

  refreshGrid() {
    this.grid.setData(this.grid.columns, this.rows, { keepWidths: true, keepPos: true });
  }

  revert(row) {
    if (!row.$orig) return;
    row.$orig.forEach((v, i) => { row[i] = v; });
    delete row.$orig; delete row.$changed; delete row.$dirty;
    this.grid.render();
  }

  cancelRow() {
    const r = this.grid.cur.r;
    const row = this.rows[r];
    if (!row) return;
    if (row.$new) {
      this.rows.splice(r, 1);
      this.onRowsChanged();
    } else this.revert(row);
    this.refreshGrid();
  }

  insertRow() {
    if (!this.enabled()) return;
    const row = new Array(this.grid.columns.length).fill(null);
    row.$new = true;
    row.$set = new Set();
    const at = this.grid.cur.r >= 0 ? this.grid.cur.r + 1 : this.rows.length;
    this.rows.splice(at, 0, row);
    this.onRowsChanged();
    this.refreshGrid();
    const first = this.grid.columns.findIndex((col, i) => !col.readOnly && this.colName(i) != null);
    this.grid.setCur(at, Math.max(0, first));
    this.grid.focus();
  }

  async deleteRows() {
    const t = this.target();
    if (!t) return;
    const idx = this.grid.selectedRowIndexes();
    if (!idx.length) return;
    if (!(await confirmDlg(this.app.prodWarn(t.sid) + `Delete ${idx.length} selected row(s) from ${t.table}?`, { ok: 'Delete', danger: true, kind: 'warning' }))) return;
    const ops = idx.map(i => this.rows[i]).filter(r => !r.$new).map(r => ({ op: 'delete', original: this.rowObj(r.$orig || r) }));
    try {
      if (ops.length) await post(`/s/${t.sid}/rows`, { db: t.db, table: t.table, ops });
    } catch (e) {
      this.app.showError(e);
      return;
    }
    for (const i of idx.sort((a, b) => b - a)) this.rows.splice(i, 1);
    this.onRowsChanged();
    const r = Math.min(idx[idx.length - 1], this.rows.length - 1);
    this.grid.cur = { r, c: this.grid.cur.c };
    this.grid.anchor = { ...this.grid.cur };
    this.refreshGrid();
    this.app.setStatus(`${idx.length} row(s) deleted.`);
  }

  setNull() {
    const { r, c } = this.grid.cur;
    if (r < 0 || !this.enabled() || this.grid.columns[c]?.readOnly || this.colName(c) == null) return;
    const row = this.rows[r];
    if (row.$new) {
      row[c] = null;
      (row.$set ??= new Set()).add(c);
      row.$dirty = true;
      this.grid.render();
    } else if (row[c] !== null) this.cellEdit(r, c, null);
  }

  /** Editing shortcuts for the grid's onKey hook. Returns true when handled. */
  handleKey(e) {
    if (e.key === 'Insert') { e.preventDefault(); this.insertRow(); }
    else if (e.key === 'Delete' && e.ctrlKey) { e.preventDefault(); this.deleteRows(); }
    else if (e.key.toLowerCase() === 'n' && e.ctrlKey && e.shiftKey) { e.preventDefault(); this.setNull(); }
    else if (e.key === 'Escape') this.cancelRow();
    else return false;
    return true;
  }

  /** Context menu entries for editing. */
  menuItems(p) {
    const on = this.enabled();
    const curDirty = !!this.rows[this.grid.cur.r]?.$dirty;
    return [
      { label: 'Set NULL', shortcut: 'Ctrl+Shift+N', disabled: !on || p.r < 0 || this.colName(p.c) == null || this.grid.columns[p.c]?.readOnly, onClick: () => this.setNull() },
      { label: 'Insert row', icon: 'plus', shortcut: 'Ins', disabled: !on, onClick: () => this.insertRow() },
      { label: 'Delete selected row(s)', icon: 'minus', shortcut: 'Ctrl+Del', disabled: !on || p.r < 0, onClick: () => this.deleteRows() },
      { label: 'Post row', icon: 'check', disabled: !curDirty, onClick: () => this.postCurrent() },
      { label: 'Cancel editing', icon: 'cancel', shortcut: 'Esc', disabled: !curDirty, onClick: () => this.cancelRow() },
    ];
  }
}
