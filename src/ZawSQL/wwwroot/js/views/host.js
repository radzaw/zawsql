// "Host" tab: databases, variables (with an editor), status and process list of the server, and the panels.
import { h, debounce, fmtBytes, fmtNum, qi, sqlStr } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { Grid, sortRows } from '../grid.js';
import { contextMenu, confirmDlg, modal } from '../dialogs.js';
import { exportGridDialog } from './tools.js';
import { MonitorView } from './monitor.js';
import { InsightView } from './insight.js';
import { ReplicationView } from './replication.js';
import { HealthView } from './health.js';
import { EventsView } from './events.js';

const KINDS = [
  ['databases', 'Databases'],
  ['variables', 'Variables'],
  ['status', 'Status'],
  ['processes', 'Processes'],
  ['events', 'Events'],
  ['monitor', 'Monitor'],
  ['insight', 'Performance'],
  ['replication', 'Replication'],
  ['health', 'Health'],
];

/** A variables row ([name, session, global, set by, …]) whose global value isn't the built-in default. */
export const variableChanged = r => r[3] != null && r[3] !== 'default' && r[3] !== 'automatic';

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
    this.changedOnly = h('input', { type: 'checkbox', onchange: () => this.applyFilter() });
    this.changedEl = h('label', { class: 'chk', title: 'Variables whose global value was set in the configuration, on the command line or with SET GLOBAL / SET PERSIST' }, this.changedOnly, ' Changed only');
    this.changedEl.style.display = 'none';
    this.countEl = h('span', { class: 'muted' });
    this.refreshBtn = h('button', { class: 'tbtn', title: 'Refresh (F5)', html: icon('refresh'), onclick: () => this.refresh() });
    const toolbar = h('div', { class: 'viewbar' }, this.subtabs, h('div', { class: 'grow' }), this.countEl, this.changedEl, this.autoSel, this.filter, this.refreshBtn);
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
    this.replication = new ReplicationView(app);
    this.replication.el.style.display = 'none';
    this.health = new HealthView(app);
    this.health.el.style.display = 'none';
    this.events = new EventsView(app);
    this.events.el.style.display = 'none';
    // Kinds shown by their own panel (with their own controls) instead of the grid.
    this.panels = { events: this.events, monitor: this.monitor, insight: this.insight, replication: this.replication, health: this.health };
    this.el = h('div', { class: 'view host-view' }, toolbar, this.grid.el, this.events.el, this.monitor.el, this.insight.el, this.replication.el, this.health.el);
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
    if (this.kind === 'replication') return this.replication.load();
    if (this.kind === 'health') return this.health.load();
    if (this.kind === 'events') return this.events.load();
    return this.load();
  }

  switchKind(k) {
    this.kind = k;
    this.sort = null;
    for (const b of this.subtabs.children) b.classList.toggle('active', b.dataset.k === k);
    this.autoSel.style.display = k === 'processes' ? '' : 'none';
    this.changedEl.style.display = k === 'variables' ? '' : 'none';
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
    // A tick while the last list is still loading is skipped: on a busy server the requests would pile up.
    if (this.kind === 'processes' && s > 0) this.timer = setInterval(() => { if (!this.loading) this.load(true); }, s * 1000);
  }

  async load(quiet = false) {
    const sid = this.app.sel.sid;
    if (!sid) return;
    const kind = this.kind;
    this.key = sid + ':' + kind;
    const seq = this.loadSeq = (this.loadSeq || 0) + 1;
    this.loading = true;
    try {
      const rs = await get(`/s/${sid}/host`, { kind }, { quiet });
      // Only the latest request counts (a manual refresh can overtake a slow automatic one).
      if (seq !== this.loadSeq || this.key !== sid + ':' + kind) return;
      this.cols = rs.columns.map(c => ({
        name: c.name,
        kind: c.name === 'Size' || c.name === 'Tables' || c.name === 'Id' || c.name === 'Time' ? 'int' : c.kind,
        fmt: c.name === 'Size' ? fmtBytes : null,
      }));
      if (kind === 'status') this.cols[1].fmt = v => (/^\d+$/.test(v) ? fmtNum(v) : v);
      // Variables not at their default (set in the configuration, on the command line, with SET) stand out.
      if (kind === 'variables') for (const r of rs.rows) if (variableChanged(r)) r.$cls = 'var-changed';
      this.allRows = rs.rows;
      this.applyFilter(quiet);
    } catch (e) {
      if (!quiet && seq === this.loadSeq) this.app.showError(e);
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  applyFilter(keep = false) {
    const q = this.filter.value.trim().toLowerCase();
    const changed = this.kind === 'variables' && this.changedOnly.checked;
    const rows = this.allRows.filter(r => (!q || r.some(v => v != null && v.toLowerCase().includes(q))) && (!changed || variableChanged(r)));
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
    if (this.kind === 'variables') this.editVariable(this.grid.rows[r]);
  }

  /**
   * Changes a variable's global value: SET GLOBAL (until the server restarts), SET PERSIST (also after a restart,
   * MySQL 8) or SET PERSIST_ONLY (only from the next start, for variables that can't change while running). DEFAULT
   * resets it; a persisted value can also be removed (RESET PERSIST).
   */
  async editVariable(row) {
    const sid = this.app.sel.sid;
    if (!row || !sid || !this.app.canModify(sid)) return;
    const [name, session, global, setBy, def, range, note] = row;
    if (global == null) return this.app.showError(new Error(`${name} is a session variable; it has no global value to change.`));
    const info = this.app.conns.get(sid);
    const persist = !info?.isMariaDb && parseInt(info?.version, 10) >= 8;
    const value = h('input', { class: 'inp mono', value: global, spellcheck: false });
    const toDefault = h('input', { type: 'checkbox' });
    const scopes = [['global', 'SET GLOBAL', 'until the server restarts'], ...(persist ? [
      ['persist', 'SET PERSIST', 'now and after restarts (stored in mysqld-auto.cnf)'],
      ['persist_only', 'SET PERSIST_ONLY', 'from the next restart only (for variables that are read-only while running)'],
    ] : [])];
    const radios = scopes.map(([k], i) => h('input', { type: 'radio', name: 'var-scope', value: k, checked: note === 'read-only' && persist ? k === 'persist_only' : i === 0 }));
    const preview = h('pre', { class: 'code-preview' });
    const statement = () => {
      const scope = radios.find(r => r.checked).value;
      const v = value.value;
      const lit = toDefault.checked ? 'DEFAULT' : /^-?\d+(\.\d+)?$/.test(v) ? v : sqlStr(v);
      return `SET ${scope.toUpperCase()} ${name} = ${lit};`;
    };
    const sync = () => { value.disabled = toDefault.checked; preview.textContent = statement(); };
    for (const el of [value, toDefault, ...radios]) el.addEventListener('input', sync);
    sync();
    const fact = (label, v) => (v != null && v !== '' ? h('div', { class: 'frow' }, h('span', null, label), h('span', { class: 'mono var-fact' }, v)) : null);
    const r = await modal({
      title: `Variable ${name}`,
      width: 560,
      body: h('div', { class: 'form2' },
        fact('Global value:', global), fact('This session:', session), fact('Set by:', setBy), fact('Default:', def), fact('Allowed:', range),
        note === 'read-only' ? h('div', { class: 'warn-text' }, persist ? 'Read-only while the server runs: use SET PERSIST_ONLY, effective after a restart.' : 'Read-only while the server runs: change it in the server configuration.') : null,
        h('label', { class: 'frow' }, h('span', null, 'New value:'), value),
        h('label', { class: 'frow' }, h('span', null, ''), h('label', { class: 'chk' }, toDefault, ' Reset to the default value')),
        h('div', { class: 'frow' }, h('span', null, 'Change:'), h('div', { class: 'var-scopes' },
          scopes.map(([, label, what], i) => h('label', { class: 'chk' }, radios[i], ' ', h('b', null, label), h('span', { class: 'muted' }, ` – ${what}`))))),
        preview,
        h('div', { class: 'muted' }, 'Query tabs that are already connected keep their session value.')),
      onOpen: () => { value.focus(); value.select(); },
      buttons: [
        ...(setBy === 'SET PERSIST' ? [{ label: 'Remove persisted value', value: 'reset', align: 'left' }] : []),
        { label: 'Apply', value: 'apply', primary: true }, { label: 'Cancel', value: null },
      ],
    });
    if (!r) return;
    const req = r === 'reset'
      ? { name, scope: 'reset_persist', value: null, default: false }
      : { name, scope: radios.find(x => x.checked).value, value: value.value, default: toDefault.checked };
    const sql = r === 'reset' ? `RESET PERSIST IF EXISTS ${name};` : statement();
    if (!(await this.app.confirmChanges(sid, { action: `Change ${name}`, statements: [sql] }))) return;
    try {
      await post(`/s/${sid}/variables/set`, req);
      this.app.setStatus(r === 'reset' ? `${name}: persisted value removed` : `${name} changed`);
    } catch (e) {
      this.app.showError(e);
    }
    this.load(true);
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
      items.push('-', { label: 'Edit value…', icon: 'settings', disabled: this.app.isReadOnly(sid) || row[2] == null, onClick: () => this.editVariable(row) },
        { label: 'Copy SET statement', onClick: () => this.grid.copy(`SET GLOBAL ${qi(row[0])} = ${row[2] == null ? 'NULL' : /^-?\d+(\.\d+)?$/.test(row[2]) ? row[2] : `'${row[2].replace(/'/g, "''")}'`};`) });
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
