// "Database" tab: list of all objects in the selected database.
import { h, debounce, fmtBytes, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { Grid, sortRows } from '../grid.js';
import { contextMenu } from '../dialogs.js';

const COLS = [
  { name: 'Name' },
  { name: 'Rows', kind: 'int', fmt: fmtNum },
  { name: 'Size', kind: 'int', fmt: fmtBytes },
  { name: 'Created', kind: 'date' },
  { name: 'Updated', kind: 'date' },
  { name: 'Engine' },
  { name: 'Collation' },
  { name: 'Comment' },
  { name: 'Type' },
];

export class DatabaseView {
  constructor(app) {
    this.app = app;
    this.key = null;
    this.objs = [];
    this.sort = null;
    this.title = h('span', { class: 'viewtitle' });
    this.filter = h('input', { class: 'inp filter-inp', placeholder: 'Filter', oninput: debounce(() => this.render(true), 120) });
    const toolbar = h('div', { class: 'viewbar' }, this.title, h('div', { class: 'grow' }),
      h('button', { class: 'tbtn', title: 'Create new table', html: icon('plus') + '<span>New table</span>', onclick: () => this.app.newTable(this.app.sel.sid, this.app.sel.db) }),
      this.filter,
      h('button', { class: 'tbtn', title: 'Refresh (F5)', html: icon('refresh'), onclick: () => this.refresh() }));
    this.grid = new Grid({
      gutter: false,
      emptyText: 'No objects',
      onSort: c => {
        this.sort = this.sort?.c === c ? (this.sort.dir === 'asc' ? { c, dir: 'desc' } : null) : { c, dir: 'asc' };
        this.render(true);
      },
      onActivate: r => this.open(r),
      onContextMenu: (e, p) => this.ctx(e, p),
    });
    this.el = h('div', { class: 'view db-view' }, toolbar, this.grid.el);
  }

  onShow() {
    const { sid, db } = this.app.sel;
    const key = sid && db ? sid + '|' + db : null;
    if (key !== this.key) {
      this.key = key;
      this.load();
    }
  }

  async load(force = false) {
    const { sid, db } = this.app.sel;
    if (!sid || !db) {
      this.objs = [];
      this.title.textContent = '';
      this.render();
      return;
    }
    const node = this.app.tree.findDb(sid, db);
    if (!node) return;
    try {
      if (!node.children || force) await this.app.tree.load(node);
    } catch (e) {
      this.app.showError(e);
      return;
    }
    this.objs = node.objects || [];
    this.title.innerHTML = icon('database') + ` <b></b>`;
    this.title.querySelector('b').textContent = `${db}: ${this.objs.length} objects, ${fmtBytes(node.size)}`;
    this.render();
  }

  refresh() { return this.load(true); }

  render(keep = false) {
    const q = this.filter.value.trim().toLowerCase();
    const rows = this.objs
      .filter(o => !q || o.name.toLowerCase().includes(q))
      .map(o => {
        const r = [o.name, o.rows ?? null, o.size ?? null, o.created ?? null, o.updated ?? null, o.engine ?? null, o.collation ?? null, o.type === 'view' ? '' : o.comment ?? '', o.type];
        r.$obj = o;
        return r;
      });
    if (this.sort) sortRows(rows, this.sort.c, this.sort.dir, COLS[this.sort.c].kind === 'int');
    this.grid.sort = this.sort;
    this.grid.setData(COLS, rows, { keepWidths: keep, keepPos: keep });
  }

  open(r) {
    const o = this.grid.rows[r]?.$obj;
    if (o) this.app.selectObject(this.app.sel.sid, this.app.sel.db, o.name, o.type);
  }

  ctx(e, p) {
    const { sid, db } = this.app.sel;
    if (!sid || !db) return;
    const rows = this.grid.selectedRowIndexes().map(i => this.grid.rows[i]?.$obj).filter(Boolean);
    const o = p.r >= 0 ? this.grid.rows[p.r]?.$obj : null;
    const items = o
      ? this.app.objectMenuItems(sid, db, o, rows.length > 1 ? rows : [o])
      : [{ label: 'Create new table', icon: 'plus', onClick: () => this.app.newTable(sid, db) }];
    items.push('-', { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => this.refresh() });
    contextMenu(e.clientX, e.clientY, items);
  }
}
