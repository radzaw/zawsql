// "Host" tab: databases, variables, status and process list of the server.
import { h, debounce, fmtBytes, fmtNum, qi } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { Grid, sortRows } from '../grid.js';
import { contextMenu, confirmDlg } from '../dialogs.js';
import { exportGridDialog } from './tools.js';
import { MonitorView } from './monitor.js';
import { InsightView } from './insight.js';

const KINDS = [
  ['databases', 'Databases'],
  ['variables', 'Variables'],
  ['status', 'Status'],
  ['processes', 'Processes'],
  ['monitor', 'Monitor'],
  ['insight', 'Performance'],
];

export class HostView {
  constructor(app) {
    this.app = app;
    this.kind = 'databases';
    this.key = null;
    this.allRows = [];
    this.cols = [];
    this.sort = null;
    this.subtabs = h('div', { class: 'subtabs' }, KINDS.map(([k, label]) =>
      h('button', { class: 'subtab' + (k === this.kind ? ' active' : ''), 'data-k': k, onclick: () => this.switchKind(k) }, label)));
    this.filter = h('input', { class: 'inp filter-inp', placeholder: 'Filter', oninput: debounce(() => this.applyFilter(), 120) });
    this.autoSel = h('select', { class: 'inp', title: 'Auto refresh', onchange: () => this.setupAuto() },
      h('option', { value: '0' }, 'No auto refresh'), h('option', { value: '1' }, 'Every 1 s'), h('option', { value: '5' }, 'Every 5 s'), h('option', { value: '10' }, 'Every 10 s'));
    this.autoSel.style.display = 'none';
    this.countEl = h('span', { class: 'muted' });
    this.refreshBtn = h('button', { class: 'tbtn', title: 'Refresh (F5)', html: icon('refresh'), onclick: () => this.refresh() });
    const toolbar = h('div', { class: 'viewbar' }, this.subtabs, h('div', { class: 'grow' }), this.countEl, this.autoSel, this.filter, this.refreshBtn);
    this.grid = new Grid({
      gutter: false,
      emptyText: 'Not connected',
      onSort: c => this.toggleSort(c),
      onContextMenu: (e, p) => this.ctx(e, p),
      onActivate: r => this.activate(r),
    });
    this.monitor = new MonitorView(app);
    this.monitor.el.style.display = 'none';
    this.insight = new InsightView(app);
    this.insight.el.style.display = 'none';
    // Kinds shown by their own panel (with their own controls) instead of the grid.
    this.panels = { monitor: this.monitor, insight: this.insight };
    this.el = h('div', { class: 'view host-view' }, toolbar, this.grid.el, this.monitor.el, this.insight.el);
  }

  onShow() {
    const sid = this.app.sel.sid;
    if (!sid) {
      this.key = null;
      this.grid.setData([], []);
      this.stopPanels();
      return;
    }
    if (this.panels[this.kind]) {
      this.panels[this.kind].start(sid);
      return;
    }
    if (this.key !== sid + ':' + this.kind) this.load();
    this.setupAuto();
  }

  onHide() {
    clearInterval(this.timer);
    this.timer = null;
    this.stopPanels();
  }

  stopPanels() {
    for (const p of Object.values(this.panels)) p.stop();
  }

  refresh() {
    if (this.kind === 'monitor') return this.monitor.schedule(0);
    if (this.kind === 'insight') return this.insight.load();
    return this.load();
  }

  switchKind(k) {
    this.kind = k;
    this.sort = null;
    for (const b of this.subtabs.children) b.classList.toggle('active', b.dataset.k === k);
    this.autoSel.style.display = k === 'processes' ? '' : 'none';
    // The monitor and the performance panel replace the grid and have their own controls.
    const panel = this.panels[k];
    for (const [name, p] of Object.entries(this.panels)) p.el.style.display = name === k ? '' : 'none';
    this.grid.el.style.display = panel ? 'none' : '';
    for (const el of [this.filter, this.countEl]) el.style.display = panel ? 'none' : '';
    for (const [name, p] of Object.entries(this.panels)) if (name !== k) p.stop();
    if (panel) {
      clearInterval(this.timer);
      if (this.app.sel.sid) panel.start(this.app.sel.sid);
      return;
    }
    this.load();
    this.setupAuto();
  }

  setupAuto() {
    clearInterval(this.timer);
    this.timer = null;
    const s = +this.autoSel.value;
    if (this.kind === 'processes' && s > 0) this.timer = setInterval(() => this.load(true), s * 1000);
  }

  async load(quiet = false) {
    const sid = this.app.sel.sid;
    if (!sid) return;
    const kind = this.kind;
    this.key = sid + ':' + kind;
    try {
      const rs = await get(`/s/${sid}/host`, { kind }, { quiet });
      if (this.key !== sid + ':' + kind) return;
      this.cols = rs.columns.map(c => ({
        name: c.name,
        kind: c.name === 'Size' || c.name === 'Tables' || c.name === 'Id' || c.name === 'Time' ? 'int' : c.kind,
        fmt: c.name === 'Size' ? fmtBytes : null,
      }));
      if (kind === 'status') this.cols[1].fmt = v => (/^\d+$/.test(v) ? fmtNum(v) : v);
      this.allRows = rs.rows;
      this.applyFilter(quiet);
    } catch (e) {
      if (!quiet) this.app.showError(e);
    }
  }

  applyFilter(keep = false) {
    const q = this.filter.value.trim().toLowerCase();
    const rows = q ? this.allRows.filter(r => r.some(v => v != null && v.toLowerCase().includes(q))) : this.allRows.slice();
    if (this.sort) sortRows(rows, this.sort.c, this.sort.dir, this.cols[this.sort.c].kind === 'int');
    this.grid.sort = this.sort;
    this.grid.setData(this.cols, rows, { keepWidths: true, keepPos: keep });
    this.countEl.textContent = `${rows.length} of ${this.allRows.length}`;
  }

  toggleSort(c) {
    this.sort = this.sort?.c === c ? (this.sort.dir === 'asc' ? { c, dir: 'desc' } : null) : { c, dir: 'asc' };
    this.applyFilter(true);
  }

  activate(r) {
    if (this.kind === 'databases') this.app.selectDatabase(this.app.sel.sid, this.grid.rows[r][0]);
  }

  ctx(e, p) {
    const row = p.r >= 0 ? this.grid.rows[p.r] : null;
    const sid = this.app.sel.sid;
    const items = [{ label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => this.grid.copy() }];
    if (this.kind === 'databases' && row) {
      items.push('-',
        { label: `Open database ${row[0]}`, icon: 'database', onClick: () => this.activate(p.r) },
        { label: 'Drop database…', icon: 'trash', disabled: this.app.isReadOnly(sid), onClick: () => this.app.dropDatabase(sid, row[0]) });
    }
    if (this.kind === 'processes' && row) {
      items.push('-', { label: `Kill process ${row[0]}`, icon: 'stop', disabled: this.app.isReadOnly(sid), onClick: () => this.kill(row[0]) });
    }
    if (this.kind === 'variables' && row) {
      items.push('-', { label: 'Copy SET statement', onClick: () => this.grid.copy(`SET GLOBAL ${qi(row[0])} = ${row[2] == null ? 'NULL' : /^-?\d+(\.\d+)?$/.test(row[2]) ? row[2] : `'${row[2].replace(/'/g, "''")}'`};`) });
    }
    items.push('-', { label: 'Export grid rows…', icon: 'export', onClick: () => exportGridDialog(this.app, { columns: this.cols, rows: this.grid.rows, selected: this.grid.selectedRowIndexes(), name: this.kind }) },
      { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => this.load() });
    contextMenu(e.clientX, e.clientY, items);
  }

  async kill(id) {
    if (!(await confirmDlg(this.app.prodWarn(this.app.sel.sid) + `Kill process ${id}?`, { ok: 'Kill', danger: true }))) return;
    try {
      await post(`/s/${this.app.sel.sid}/kill`, { id: Number(id) });
      this.load();
    } catch (e) {
      this.app.showError(e);
    }
  }
}
