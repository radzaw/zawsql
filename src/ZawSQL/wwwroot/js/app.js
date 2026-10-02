// ZawSQL main module: layout, menus, toolbar, tabs and the glue between tree and views.
import { get, post, put, setLogSink, startHeartbeat, ApiError } from './api.js';
import { h, qi, debounce, makeSplitter, fmtElapsed } from './util.js';
import { icon } from './icons.js';
import { Tree } from './tree.js';
import { LogPanel } from './log.js';
import { KEYWORDS, FUNCTIONS } from './editor.js';
import { contextMenu, closeMenus, menuIsOpen, alertError, confirmDlg, promptDlg, modal } from './dialogs.js';
import { HostView } from './views/host.js';
import { DatabaseView } from './views/database.js';
import { TableView } from './views/table.js';
import { DataView } from './views/data.js';
import { QueryView } from './views/query.js';
import { userManager } from './views/users.js';
import { sessionManager, exportDumpDialog, runSqlFile, createDatabaseDialog, preferencesDialog, aboutDialog } from './views/tools.js';

const TYPE_LABEL = { table: 'Table', view: 'View', procedure: 'Procedure', function: 'Function', trigger: 'Trigger', event: 'Event' };
const DEFAULT_PREFS = { rowsPerPage: 1000, maxResultRows: 10000, theme: 'system', editorFontSize: 13 };

// ---------------------------------------------------------------- tabs

class Tabs {
  constructor(app, bar, content) {
    this.app = app;
    this.bar = bar;
    this.content = content;
    this.tabs = new Map();
    this.active = null;
    this.addBtn = h('button', { class: 'tab-add', title: 'New query tab (Ctrl+T)', html: icon('plus'), onclick: () => app.openQueryTab() });
    bar.append(this.addBtn);
    bar.addEventListener('wheel', e => { bar.scrollLeft += e.deltaY; }, { passive: true });
  }

  add({ id, title, iconName, view, closable = false, onClose }) {
    const tab = { id, view, closable, onClose, disabled: false };
    tab.titleEl = h('span', { class: 'tab-title' }, title);
    tab.el = h('div', { class: 'tab', title }, h('span', { class: 'tab-ic', html: icon(iconName) }), tab.titleEl,
      closable ? h('span', { class: 'tab-x', title: 'Close (middle click)', html: '×' }) : null);
    tab.el.addEventListener('mousedown', e => {
      if (e.button === 1 && closable) { e.preventDefault(); this.close(id); }
      else if (e.button === 0 && !e.target.closest('.tab-x')) this.activate(id);
    });
    tab.el.querySelector('.tab-x')?.addEventListener('click', e => { e.stopPropagation(); this.close(id); });
    tab.pane = h('div', { class: 'tab-pane' }, view.el);
    this.bar.insertBefore(tab.el, this.addBtn);
    this.content.append(tab.pane);
    this.tabs.set(id, tab);
    return tab;
  }

  activate(id) {
    const t = this.tabs.get(id);
    if (!t || t.disabled) return;
    if (this.active && this.active !== id) {
      const p = this.tabs.get(this.active);
      if (p) {
        p.el.classList.remove('active');
        p.pane.classList.remove('active');
        p.view.onHide?.();
      }
    }
    this.active = id;
    t.el.classList.add('active');
    t.pane.classList.add('active');
    t.el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    t.view.onShow?.();
  }

  close(id) {
    const t = this.tabs.get(id);
    if (!t?.closable) return;
    if (t.onClose?.() === false) return;
    const ids = [...this.tabs.keys()];
    const i = ids.indexOf(id);
    t.el.remove();
    t.pane.remove();
    this.tabs.delete(id);
    if (this.active === id) {
      this.active = null;
      this.activate(ids[i + 1] && this.tabs.has(ids[i + 1]) ? ids[i + 1] : ids[i - 1]);
    }
  }

  setTitle(id, title) {
    const t = this.tabs.get(id);
    if (!t) return;
    t.titleEl.textContent = title;
    t.el.title = title;
  }

  setDisabled(id, disabled) {
    const t = this.tabs.get(id);
    if (!t) return;
    t.disabled = disabled;
    t.el.classList.toggle('disabled', disabled);
  }

  setModified(id, on) { this.tabs.get(id)?.el.classList.toggle('modified', !!on); }
  setBusy(id, on) { this.tabs.get(id)?.el.classList.toggle('busy', !!on); }
  activeView() { return this.tabs.get(this.active)?.view; }
}

// ---------------------------------------------------------------- app

class App {
  constructor() {
    this.sel = { sid: null, db: null, obj: null };
    this.conns = new Map();
    this.colCache = new Map();
    this.hostCache = new Map();
    this.queryViews = [];
    this.queryCounter = 0;
    this.saveStateSoon = debounce(() => this.saveState(), 800);
    this.refreshViewSoon = debounce(target => this.showTarget(target), 120);
  }

  async init() {
    try {
      this.state = (await get('/state')) || {};
    } catch (e) {
      this.state = {};
      document.body.textContent = e.message;
      return;
    }
    this.prefs = Object.assign({}, DEFAULT_PREFS, this.state.prefs);
    this.state.prefs = this.prefs;
    this.applyPrefs();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyPrefs());

    this.log = new LogPanel(document.getElementById('log'));
    setLogSink(lines => this.log.add(lines));
    this.buildMenu();
    this.buildToolbar();
    this.buildLayout();
    this.buildStatusbar();

    this.tree = new Tree(this, document.getElementById('tree-host'));
    this.tabs = new Tabs(this, document.getElementById('tabbar'), document.getElementById('tabcontent'));
    this.views = {
      host: new HostView(this),
      database: new DatabaseView(this),
      table: new TableView(this),
      data: new DataView(this),
    };
    this.tabs.add({ id: 'host', title: 'Host', iconName: 'host', view: this.views.host });
    this.tabs.add({ id: 'database', title: 'Database', iconName: 'database', view: this.views.database });
    this.tabs.add({ id: 'table', title: 'Table', iconName: 'table', view: this.views.table });
    this.tabs.add({ id: 'data', title: 'Data', iconName: 'columns', view: this.views.data });
    const saved = this.state.queryTabs?.length ? this.state.queryTabs : [{ title: 'Query', sql: '' }];
    for (const q of saved) this.openQueryTab(q.sql, q.title, { activate: false });
    this.updateTabs();
    this.tabs.activate('host');

    document.getElementById('db-filter').addEventListener('input', e => { this.tree.dbFilter = e.target.value; this.tree.render(); });
    document.getElementById('tbl-filter').addEventListener('input', e => { this.tree.tblFilter = e.target.value; this.tree.render(); });
    document.addEventListener('keydown', e => this.globalKey(e));
    window.addEventListener('beforeunload', () => this.saveState());

    startHeartbeat();
    this.log.info(`ZawSQL started. Configuration is stored on the local machine.`);
    sessionManager(this);
  }

  applyPrefs() {
    const p = this.prefs;
    const dark = p.theme === 'dark' || (p.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--ed-font-size', p.editorFontSize + 'px');
  }

  async saveState() {
    if (!this.state) return;
    this.state.queryTabs = this.queryViews.map(v => ({ title: v.title, sql: v.sql }));
    try { await put('/state', this.state, { quiet: true }); } catch { /* backend gone */ }
  }

  // ---------- layout ----------

  buildLayout() {
    const left = document.getElementById('left');
    const logEl = document.getElementById('log');
    const layout = this.state.layout || {};
    left.style.width = (layout.leftWidth || 260) + 'px';
    logEl.style.height = (layout.logHeight || 110) + 'px';
    makeSplitter(document.getElementById('split-left'), {
      axis: 'x',
      get: () => left.offsetWidth,
      set: v => { left.style.width = Math.max(140, Math.min(v, innerWidth - 300)) + 'px'; },
      onEnd: () => { this.state.layout = { ...this.state.layout, leftWidth: left.offsetWidth }; this.saveStateSoon(); },
    });
    makeSplitter(document.getElementById('split-log'), {
      axis: 'y',
      // Dragging down shrinks the log, so track the negated height.
      get: () => -logEl.offsetHeight,
      set: v => { logEl.style.height = Math.max(24, Math.min(-v, innerHeight - 200)) + 'px'; },
      onEnd: () => { this.state.layout = { ...this.state.layout, logHeight: logEl.offsetHeight }; this.saveStateSoon(); },
    });
  }

  buildStatusbar() {
    const sb = document.getElementById('statusbar');
    this.sbMsg = h('div', { class: 'sb-cell grow' }, 'Idle.');
    this.sbConn = h('div', { class: 'sb-cell' });
    this.sbVer = h('div', { class: 'sb-cell' });
    this.sbSel = h('div', { class: 'sb-cell' });
    this.sbRo = h('div', { class: 'sb-cell sb-ro', style: { display: 'none' }, title: 'This session is in read-only mode; changes are blocked.' }, 'READ-ONLY');
    sb.append(this.sbMsg, this.sbRo, this.sbSel, this.sbConn, this.sbVer);
    setInterval(() => this.updateStatus(), 1000);
  }

  setStatus(msg) {
    this.sbMsg.textContent = msg;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => { this.sbMsg.textContent = 'Idle.'; }, 8000);
  }

  updateStatus() {
    const info = this.sel.sid ? this.conns.get(this.sel.sid) : null;
    this.sbConn.textContent = info ? `Connected: ${fmtElapsed(Date.now() - info.connectedAt)}` : 'Disconnected';
    this.sbVer.textContent = info ? `${info.isMariaDb ? 'MariaDB' : 'MySQL'} ${info.version.replace(/-MariaDB.*$/, '')}` : '';
    this.sbSel.textContent = info ? `${info.user}${this.sel.db ? ' › ' + this.sel.db : ''}` : '';
    this.sbRo.style.display = info?.readOnly ? '' : 'none';
  }

  // ---------- menus & toolbar ----------

  menuDefs() {
    const s = this.sel;
    const ro = this.isReadOnly(s.sid);
    return [
      ['File', () => [
        { label: 'Session manager…', icon: 'sessions', onClick: () => sessionManager(this) },
        { label: 'Disconnect', icon: 'disconnect', disabled: !s.sid, onClick: () => this.disconnect(s.sid) },
        '-',
        { label: 'New query tab', icon: 'newtab', shortcut: 'Ctrl+T', onClick: () => this.openQueryTab() },
        { label: 'Close query tab', shortcut: 'Ctrl+W', disabled: !this.activeQuery(), onClick: () => this.tabs.close(this.tabs.active) },
        '-',
        { label: 'Load SQL file…', icon: 'open', onClick: () => this.queryForFile().loadFile() },
        { label: 'Save SQL file…', icon: 'save', disabled: !this.activeQuery(), onClick: () => this.activeQuery().saveFile() },
        { label: 'Run SQL file…', icon: 'import', disabled: !s.sid || ro, onClick: () => runSqlFile(this) },
        '-',
        { label: 'Exit', onClick: () => this.exit() },
      ]],
      ['Edit', () => [
        { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => this.refresh() },
        { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => document.execCommand('copy') },
        '-',
        { label: 'Preferences…', icon: 'settings', onClick: () => preferencesDialog(this) },
      ]],
      ['Query', () => [
        { label: 'Execute SQL', icon: 'play', shortcut: 'F9', disabled: !s.sid, onClick: () => this.queryForRun()?.run('all') },
        { label: 'Execute selection', icon: 'playsel', shortcut: 'Ctrl+F9', disabled: !s.sid, onClick: () => this.queryForRun()?.run('selection') },
        { label: 'Execute current query', icon: 'playline', shortcut: 'Ctrl+Shift+F9', disabled: !s.sid, onClick: () => this.queryForRun()?.run('current') },
        { label: 'Stop', icon: 'stop', disabled: !s.sid, onClick: () => this.activeQuery()?.stop() },
        '-',
        { label: 'Query history…', icon: 'history', onClick: () => this.queryForRun()?.showHistory() },
      ]],
      ['Tools', () => [
        { label: 'Create database…', icon: 'database', disabled: !s.sid || ro, onClick: () => createDatabaseDialog(this, s.sid) },
        { label: 'Create table…', icon: 'plus', disabled: !s.db || ro, onClick: () => this.newTable(s.sid, s.db) },
        '-',
        { label: 'User manager…', icon: 'user', disabled: !s.sid, onClick: () => userManager(this, s.sid) },
        '-',
        { label: 'Export database as SQL…', icon: 'export', disabled: !s.db, onClick: () => exportDumpDialog(this, s.sid, s.db) },
        { label: 'Run SQL file…', icon: 'import', disabled: !s.sid || ro, onClick: () => runSqlFile(this) },
        '-',
        { label: 'Theme', submenu: [['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => ({ label: l, checked: this.prefs.theme === v, onClick: () => { this.prefs.theme = v; this.applyPrefs(); this.saveStateSoon(); } })) },
        { label: 'Preferences…', icon: 'settings', onClick: () => preferencesDialog(this) },
      ]],
      ['Help', () => [
        { label: 'Keyboard shortcuts', icon: 'info', onClick: () => this.shortcutsDialog() },
        { label: 'About ZawSQL', icon: 'question', onClick: () => aboutDialog() },
      ]],
    ];
  }

  buildMenu() {
    const bar = document.getElementById('menubar');
    const defs = this.menuDefs();
    const open = (el, i) => {
      for (const x of bar.children) x.classList.remove('open');
      el.classList.add('open');
      const r = el.getBoundingClientRect();
      contextMenu(r.left, r.bottom, this.menuDefs()[i][1](), { onClose: () => el.classList.remove('open') });
    };
    defs.forEach(([label], i) => {
      const el = h('div', { class: 'menubar-item' }, label);
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        if (el.classList.contains('open')) closeMenus();
        else open(el, i);
      });
      el.addEventListener('mouseenter', () => {
        if (menuIsOpen() && bar.querySelector('.open') && !el.classList.contains('open')) open(el, i);
      });
      bar.append(el);
    });
  }

  buildToolbar() {
    const tb = document.getElementById('toolbar');
    const b = (ic, title, fn) => h('button', { class: 'tbtn', title, html: icon(ic), onclick: fn });
    tb.append(
      b('sessions', 'Session manager', () => sessionManager(this)),
      b('disconnect', 'Disconnect', () => this.sel.sid && this.disconnect(this.sel.sid)),
      h('span', { class: 'sep' }),
      b('refresh', 'Refresh (F5)', () => this.refresh()),
      b('newtab', 'New query tab (Ctrl+T)', () => this.openQueryTab()),
      h('span', { class: 'sep' }),
      b('play', 'Execute SQL (F9)', () => this.queryForRun()?.run('all')),
      b('playsel', 'Execute selection (Ctrl+F9)', () => this.queryForRun()?.run('selection')),
      b('playline', 'Execute current query (Ctrl+Shift+F9)', () => this.queryForRun()?.run('current')),
      b('stop', 'Stop running query', () => this.activeQuery()?.stop()),
      h('span', { class: 'sep' }),
      b('database', 'Create database', () => this.sel.sid && createDatabaseDialog(this, this.sel.sid)),
      b('plus', 'Create table', () => this.sel.db && this.newTable(this.sel.sid, this.sel.db)),
      b('export', 'Export database as SQL', () => this.sel.db && exportDumpDialog(this, this.sel.sid, this.sel.db)),
      b('import', 'Run SQL file', () => runSqlFile(this)),
      b('user', 'User manager', () => this.sel.sid && userManager(this, this.sel.sid)),
      h('span', { class: 'sep' }),
      b('settings', 'Preferences', () => preferencesDialog(this)),
    );
  }

  shortcutsDialog() {
    const rows = [
      ['F5', 'Refresh tree / current tab'], ['F9', 'Execute all SQL in the query tab'], ['Ctrl+F9', 'Execute selection'],
      ['Ctrl+Shift+F9 / Ctrl+Enter', 'Execute statement at the caret'], ['Ctrl+Space', 'Autocomplete'], ['Ctrl+/', 'Toggle line comment'],
      ['Tab / Shift+Tab', 'Indent / outdent'], ['Ctrl+T', 'New query tab'], ['F2 / Enter / typing', 'Edit grid cell'],
      ['Ctrl+Enter', 'Apply multi-line cell edit'], ['Insert', 'Insert row'], ['Ctrl+Delete', 'Delete selected rows'],
      ['Ctrl+Shift+N', 'Set cell to NULL'], ['Esc', 'Cancel editing'], ['Ctrl+C', 'Copy selected cells'],
    ];
    return modal({ title: 'Keyboard shortcuts', width: 480, body: h('table', { class: 'kbd-table' }, rows.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d)))) });
  }

  globalKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      this.refresh();
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      this.openQueryTab();
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'w' && this.activeQuery()) {
      e.preventDefault();
      this.tabs.close(this.tabs.active);
    } else if (e.key === 'F9' && !this.activeQuery()) {
      e.preventDefault();
      this.queryForRun()?.run(e.ctrlKey && e.shiftKey ? 'current' : e.ctrlKey ? 'selection' : 'all');
    }
  }

  // ---------- connections ----------

  async connect(profileId, password) {
    this.setStatus('Connecting…');
    const info = await post('/connect', { sessionId: profileId, password });
    info.connectedAt = Date.now();
    this.conns.set(info.sid, info);
    const node = this.tree.addSession(info);
    this.tree.select(node);
    await this.tree.expand(node);
    this.tree.el.focus();
    this.setStatus(`Connected to ${info.name}.`);
  }

  async disconnect(sid) {
    if (!sid) return;
    try { await post(`/s/${sid}/disconnect`); } catch { /* already gone */ }
    this.conns.delete(sid);
    this.tree.removeSession(sid);
    for (const k of [...this.colCache.keys()]) if (k.startsWith(sid + '|')) this.colCache.delete(k);
    const next = this.tree.roots[0];
    if (next) this.tree.select(next);
    else {
      this.sel = { sid: null, db: null, obj: null };
      this.updateTabs();
      this.showTarget('host');
    }
  }

  async exit() {
    await this.saveState();
    try { await post('/exit'); } catch { /* ignore */ }
    window.close();
    document.body.innerHTML = '<div class="placeholder">ZawSQL has exited. You can close this window.</div>';
  }

  showError(e) {
    const msg = e?.message || String(e);
    this.log.error(msg);
    return alertError(msg);
  }

  /** Executes statements on the session's main connection; throws on the first SQL error. */
  async exec(sid, statements, database) {
    const r = await post(`/s/${sid}/exec`, { statements, database: database || null, maxRows: 0, stopOnError: true });
    if (r.errors?.length) {
      const er = r.errors[0];
      throw new ApiError(er.code ? `SQL Error (${er.code}): ${er.message}` : er.message, er.code);
    }
    return r;
  }

  // ---------- selection & tabs ----------

  async onTreeSelect(node) {
    if (this.views.table.isDirty() && !(this.sel.obj && node.depth === 2 && node.name === this.sel.obj.name && node.db === this.sel.db)) {
      const prev = this.prevNode;
      if (!(await confirmDlg('The table editor has unsaved changes. Discard them?', { ok: 'Discard' }))) {
        if (prev) this.tree.select(prev, { silent: true });
        return;
      }
      this.tabs.setModified('table', false);
    }
    this.prevNode = node;
    this.sel = { sid: node.sid, db: node.db ?? null, obj: node.depth === 2 ? { type: node.type, name: node.name } : null };
    this.views.table.createKey = null;
    this.updateTabs();
    let target = this.tabs.active;
    const isQuery = target?.startsWith('q');
    if (node.type === 'session') { if (['database', 'table', 'data'].includes(target)) target = 'host'; }
    else if (node.type === 'db') { if (['host', 'table', 'data'].includes(target)) target = 'database'; }
    else if (node.type === 'table' || node.type === 'view') { if (['host', 'database'].includes(target)) target = 'data'; }
    else if (['host', 'database', 'data'].includes(target)) target = 'table';
    if (isQuery) target = this.tabs.active;
    this.updateStatus();
    this.refreshViewSoon(target);
  }

  showTarget(target) {
    if (this.tabs.active === target) this.tabs.activeView()?.onShow?.();
    else this.tabs.activate(target);
  }

  updateTabs() {
    const { sid, db, obj } = this.sel;
    const info = sid ? this.conns.get(sid) : null;
    const t = this.tabs;
    t.setTitle('host', info ? `Host: ${info.host}` : 'Host');
    t.setTitle('database', db ? `Database: ${db}` : 'Database');
    const creating = !!this.views.table.createKey;
    t.setTitle('table', creating ? 'Table: (new)' : obj ? `${TYPE_LABEL[obj.type]}: ${obj.name}` : 'Table');
    t.setDisabled('database', !db);
    t.setDisabled('table', !obj && !creating);
    t.setDisabled('data', !obj || !['table', 'view'].includes(obj.type));
    for (const q of this.queryViews) if (this.tabs.active === q.id) q.onShow();
  }

  async selectDatabase(sid, db, { quiet = false } = {}) {
    const s = this.tree.sessionNode(sid);
    if (!s) return;
    await this.tree.expand(s);
    const node = this.tree.findDb(sid, db);
    if (!node) return;
    if (quiet) {
      this.tree.select(node, { silent: true });
      this.prevNode = node;
      this.sel = { sid, db, obj: null };
      this.updateTabs();
      this.updateStatus();
    } else this.tree.select(node);
  }

  async selectObject(sid, db, name, type, { tab } = {}) {
    const s = this.tree.sessionNode(sid);
    if (!s) return;
    await this.tree.expand(s);
    const dbNode = this.tree.findDb(sid, db);
    if (!dbNode) return;
    await this.tree.expand(dbNode);
    const node = this.tree.findObj(sid, db, name, type);
    if (!node) return;
    this.tree.select(node);
    if (tab) setTimeout(() => this.tabs.activate(tab), 130);
  }

  async refreshDb(sid, db) {
    for (const k of [...this.colCache.keys()]) if (k.startsWith(`${sid}|${db}|`)) this.colCache.delete(k);
    const node = this.tree.findDb(sid, db);
    if (node?.children) await this.tree.load(node);
    if (this.tabs.active === 'database') this.views.database.load();
  }

  /** Called after DDL ran in a query tab or SQL file. */
  async afterDdl(sid, db) {
    try {
      const s = this.tree.sessionNode(sid);
      if (s?.children) await this.tree.load(s);
      if (db) await this.refreshDb(sid, db);
    } catch { /* tree refresh is best effort */ }
  }

  async refresh() {
    const n = this.tree.sel;
    if (document.activeElement === this.tree.el || !this.tabs.activeView()?.refresh) {
      if (n) {
        try { await this.tree.refresh(n.depth === 2 ? n.parent : n); } catch (e) { this.showError(e); }
      }
      if (n?.type === 'db' || n?.depth === 2) this.colCache.clear();
    }
    await this.tabs.activeView()?.refresh?.();
  }

  // ---------- query tabs ----------

  openQueryTab(sql = '', title, { activate = true } = {}) {
    this.queryCounter++;
    const id = 'q' + this.queryCounter;
    const t = title || (this.queryCounter === 1 ? 'Query' : `Query #${this.queryCounter}`);
    const v = new QueryView(this, { id, sql, title: t });
    this.queryViews.push(v);
    this.tabs.add({
      id, title: t, iconName: 'query', view: v, closable: true,
      onClose: () => {
        if (this.queryViews.length === 1) {
          v.editor.value = '';
          this.saveStateSoon();
          return false;
        }
        this.queryViews.splice(this.queryViews.indexOf(v), 1);
        this.saveStateSoon();
      },
    });
    if (activate) this.tabs.activate(id);
    this.saveStateSoon();
    return v;
  }

  activeQuery() {
    return this.queryViews.find(v => v.id === this.tabs.active) || null;
  }

  /** The active query tab, or the first one (activated) when another tab is shown. */
  queryForRun() {
    let v = this.activeQuery();
    if (!v) {
      v = this.queryViews[0];
      if (v) this.tabs.activate(v.id);
    }
    return v;
  }

  /** Query tab to load a file into: the active one if empty, else a new tab. */
  queryForFile() {
    const v = this.activeQuery();
    return v && !v.sql.trim() ? v : this.openQueryTab();
  }

  addHistory(sql, db) {
    const hist = (this.state.history ||= []);
    sql = sql.trim();
    if (!sql) return;
    const i = hist.findIndex(x => x.sql === sql);
    if (i >= 0) hist.splice(i, 1);
    hist.unshift({ sql: sql.length > 50000 ? sql.slice(0, 50000) : sql, db, ts: Date.now() });
    hist.length = Math.min(hist.length, 500);
    this.saveStateSoon();
  }

  // ---------- object actions ----------

  isReadOnly(sid) {
    return !!this.conns.get(sid)?.readOnly;
  }

  /** False (after telling the user) when the session is read-only. The backend enforces this too. */
  canModify(sid) {
    if (!this.isReadOnly(sid)) return true;
    this.showError(new Error(`Session "${this.conns.get(sid).name}" is in read-only mode; changes are not allowed.`));
    return false;
  }

  newTable(sid, db) {
    if (!sid || !db || !this.canModify(sid)) return;
    this.views.table.startCreate(sid, db);
    this.updateTabs();
    this.tabs.activate('table');
  }

  async dropDatabase(sid, db) {
    if (!this.canModify(sid)) return;
    if (!(await confirmDlg(`Drop database "${db}" and everything in it?\n\nThis cannot be undone.`, { ok: 'Drop', danger: true, kind: 'warning' }))) return;
    try {
      await this.exec(sid, [`DROP DATABASE ${qi(db)}`]);
    } catch (e) {
      return this.showError(e);
    }
    const s = this.tree.sessionNode(sid);
    await this.tree.load(s);
    this.tree.select(s);
    this.setStatus(`Database ${db} dropped.`);
  }

  async dropObjects(sid, db, objs) {
    if (!this.canModify(sid)) return;
    const list = objs.map(o => `${o.type} ${o.name}`).join('\n');
    if (!(await confirmDlg(`Drop ${objs.length} object(s)?\n\n${list}`, { ok: 'Drop', danger: true, kind: 'warning' }))) return;
    try {
      await this.exec(sid, objs.map(o => `DROP ${o.type.toUpperCase()} ${qi(db)}.${qi(o.name)}`), db);
    } catch (e) {
      this.showError(e);
    }
    await this.refreshDb(sid, db);
    if (this.sel.obj && objs.some(o => o.name === this.sel.obj.name)) this.selectDatabase(sid, db);
  }

  async truncateTables(sid, db, names) {
    if (!this.canModify(sid)) return;
    if (!(await confirmDlg(`Delete ALL rows from ${names.length === 1 ? 'table ' + names[0] : names.length + ' tables'}?\n\n${names.join('\n')}`, { ok: 'Empty', danger: true, kind: 'warning' }))) return;
    try {
      await this.exec(sid, names.map(n => `TRUNCATE TABLE ${qi(db)}.${qi(n)}`), db);
    } catch (e) {
      this.showError(e);
    }
    await this.refreshDb(sid, db);
    this.views.data.key = null;
    if (this.tabs.active === 'data') this.views.data.onShow();
  }

  async renameTable(sid, db, name) {
    if (!this.canModify(sid)) return;
    const nn = await promptDlg('Rename table', `New name for ${name}:`, name);
    if (!nn || nn === name) return;
    try {
      await this.exec(sid, [`RENAME TABLE ${qi(db)}.${qi(name)} TO ${qi(db)}.${qi(nn)}`], db);
    } catch (e) {
      return this.showError(e);
    }
    await this.refreshDb(sid, db);
    this.selectObject(sid, db, nn, 'table');
  }

  createTemplate(sid, db, type) {
    if (!this.canModify(sid)) return;
    if (type === 'table') return this.newTable(sid, db);
    const d = qi(db);
    const t = {
      view: `CREATE VIEW ${d}.\`new_view\` AS\nSELECT 1 AS x;\n`,
      procedure: `DELIMITER //\nCREATE PROCEDURE ${d}.\`new_procedure\`()\nBEGIN\n  SELECT 1;\nEND//\nDELIMITER ;\n`,
      function: `DELIMITER //\nCREATE FUNCTION ${d}.\`new_function\`(x INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN x * 2;\nEND//\nDELIMITER ;\n`,
      trigger: `DELIMITER //\nCREATE TRIGGER ${d}.\`new_trigger\`\nBEFORE INSERT ON ${d}.\`table_name\`\nFOR EACH ROW\nBEGIN\n  -- SET NEW.created_at = NOW();\nEND//\nDELIMITER ;\n`,
      event: `CREATE EVENT ${d}.\`new_event\`\nON SCHEDULE EVERY 1 DAY\nDO\n  SELECT 1;\n`,
    }[type];
    this.openQueryTab(t, `New ${type}`);
  }

  objectMenuItems(sid, db, o, objs = [o]) {
    const tables = objs.filter(x => x.type === 'table').map(x => x.name);
    const exportable = objs.filter(x => x.type === 'table' || x.type === 'view').map(x => x.name);
    const ro = this.isReadOnly(sid);
    return [
      (o.type === 'table' || o.type === 'view') && { label: 'Open data', icon: 'columns', onClick: () => this.selectObject(sid, db, o.name, o.type, { tab: 'data' }) },
      { label: o.type === 'table' ? 'Edit structure' : `Edit ${o.type}`, icon: o.type, onClick: () => this.selectObject(sid, db, o.name, o.type, { tab: 'table' }) },
      (o.type === 'table' || o.type === 'view') && { label: 'Generate SELECT in new query tab', icon: 'query', onClick: () => this.openQueryTab(`SELECT * FROM ${qi(db)}.${qi(o.name)} LIMIT 1000;`, o.name) },
      '-',
      exportable.length && { label: 'Export as SQL…', icon: 'export', onClick: () => exportDumpDialog(this, sid, db, exportable) },
      o.type === 'table' && objs.length === 1 && { label: 'Rename…', disabled: ro, onClick: () => this.renameTable(sid, db, o.name) },
      tables.length && { label: tables.length > 1 ? `Empty ${tables.length} tables…` : 'Empty table (TRUNCATE)…', icon: 'empty', disabled: ro, onClick: () => this.truncateTables(sid, db, tables) },
      { label: objs.length > 1 ? `Drop ${objs.length} objects…` : `Drop ${o.type}…`, icon: 'trash', disabled: ro, onClick: () => this.dropObjects(sid, db, objs) },
      '-',
      { label: 'Copy name', icon: 'copy', onClick: () => navigator.clipboard.writeText(objs.map(x => x.name).join(', ')) },
    ];
  }

  treeContextMenu(e, node) {
    let items;
    if (!node) {
      items = [{ label: 'Session manager…', icon: 'sessions', onClick: () => sessionManager(this) }];
    } else if (node.type === 'session') {
      items = [
        { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => this.tree.refresh(node).catch(err => this.showError(err)) },
        { label: 'Create database…', icon: 'database', disabled: this.isReadOnly(node.sid), onClick: () => createDatabaseDialog(this, node.sid) },
        { label: 'New query tab', icon: 'newtab', onClick: () => this.openQueryTab() },
        { label: 'Run SQL file…', icon: 'import', disabled: this.isReadOnly(node.sid), onClick: () => runSqlFile(this) },
        { label: 'User manager…', icon: 'user', onClick: () => userManager(this, node.sid) },
        '-',
        { label: 'Disconnect', icon: 'disconnect', onClick: () => this.disconnect(node.sid) },
      ];
    } else if (node.type === 'db') {
      items = [
        { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => this.tree.refresh(node).catch(err => this.showError(err)) },
        { label: 'Create new', icon: 'plus', disabled: this.isReadOnly(node.sid), submenu: ['table', 'view', 'procedure', 'function', 'trigger', 'event'].map(t => ({ label: TYPE_LABEL[t], icon: t, onClick: () => this.createTemplate(node.sid, node.db, t) })) },
        { label: 'New query tab', icon: 'newtab', onClick: () => this.openQueryTab() },
        '-',
        { label: 'Export database as SQL…', icon: 'export', onClick: () => exportDumpDialog(this, node.sid, node.db) },
        { label: 'Run SQL file…', icon: 'import', disabled: this.isReadOnly(node.sid), onClick: () => runSqlFile(this) },
        '-',
        { label: 'Drop database…', icon: 'trash', disabled: this.isReadOnly(node.sid), onClick: () => this.dropDatabase(node.sid, node.db) },
        { label: 'Copy name', icon: 'copy', onClick: () => navigator.clipboard.writeText(node.db) },
      ];
    } else {
      items = this.objectMenuItems(node.sid, node.db, node.obj);
      items.push('-', { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => this.tree.refresh(node).catch(err => this.showError(err)) });
    }
    contextMenu(e.clientX, e.clientY, items);
  }

  // ---------- server metadata caches ----------

  async hostList(sid, kind) {
    const k = sid + '|' + kind;
    if (!this.hostCache.has(k)) {
      this.hostCache.set(k, get(`/s/${sid}/host`, { kind }, { quiet: true }).catch(e => { this.hostCache.delete(k); throw e; }));
    }
    return this.hostCache.get(k);
  }

  async getEngines(sid) {
    const rs = await this.hostList(sid, 'engines');
    const support = rs.columns.findIndex(c => c.name === 'Support');
    return rs.rows.filter(r => support < 0 || !/^NO$/i.test(r[support])).map(r => r[0]);
  }

  async fillCollationList(sid) {
    let dl = document.getElementById('dl-collations');
    if (!dl) {
      dl = h('datalist', { id: 'dl-collations' });
      document.body.append(dl);
    }
    if (dl.dataset.sid === sid) return;
    dl.dataset.sid = sid;
    try {
      const rs = await this.hostList(sid, 'collations');
      dl.replaceChildren(...rs.rows.map(r => h('option', { value: r[0] })));
    } catch { /* no privilege */ }
  }

  async getDatabases(sid) {
    const s = this.tree.sessionNode(sid);
    if (!s) return [];
    if (!s.children) await this.tree.load(s);
    return s.children.map(c => c.db);
  }

  async getObjects(sid, db) {
    const node = this.tree.findDb(sid, db);
    if (!node) return [];
    if (!node.children) await this.tree.load(node);
    return node.objects || [];
  }

  async getColumns(sid, db, table) {
    const k = `${sid}|${db}|${table}`;
    if (!this.colCache.has(k)) {
      this.colCache.set(k, get(`/s/${sid}/columns`, { db, table }, { quiet: true }).catch(() => { this.colCache.delete(k); return []; }));
    }
    return this.colCache.get(k);
  }

  isKeyword(w) {
    const u = w.toUpperCase();
    return KEYWORDS.has(u) || FUNCTIONS.has(u);
  }

  // ---------- autocompletion ----------

  async complete({ text, prefix, qualifier }) {
    const { sid, db } = this.sel;
    const items = [];
    const ident = n => (/^[A-Za-z_$][\w$]*$/.test(n) && !KEYWORDS.has(n.toUpperCase()) ? n : qi(n));
    if (sid) {
      const aliases = parseAliases(text, db);
      if (qualifier) {
        const ql = qualifier.toLowerCase();
        const ref = aliases.get(ql);
        if (!ref) {
          const dbs = await this.getDatabases(sid);
          const dbMatch = dbs.find(d => d.toLowerCase() === ql);
          if (dbMatch) {
            for (const o of await this.getObjects(sid, dbMatch)) items.push({ label: o.name, icon: o.type, detail: o.type, insert: ident(o.name) });
            return items;
          }
        }
        const r = ref || { db, table: qualifier };
        if (r.db) for (const c of await this.getColumns(sid, r.db, r.table)) items.push({ label: c.name, icon: 'columns', detail: c.type, insert: ident(c.name) });
        return items;
      }
      const seen = new Set();
      for (const r of aliases.values()) {
        const k = r.db + '.' + r.table;
        if (seen.has(k) || !r.db) continue;
        seen.add(k);
        for (const c of await this.getColumns(sid, r.db, r.table)) items.push({ label: c.name, icon: 'columns', detail: `${r.table}.${c.type}`, insert: ident(c.name) });
      }
      if (db) for (const o of await this.getObjects(sid, db)) items.push({ label: o.name, icon: o.type, detail: o.type, insert: ident(o.name) });
      for (const d of await this.getDatabases(sid)) items.push({ label: d, icon: 'database', detail: 'database', insert: ident(d) });
    }
    if (prefix) {
      for (const k of FUNCTIONS) items.push({ label: k, icon: 'function', detail: 'function', insert: k + '(' });
      for (const k of KEYWORDS) if (!FUNCTIONS.has(k)) items.push({ label: k, detail: 'keyword' });
    }
    return items;
  }
}

const ALIAS_RE = /\b(?:from|join|update|into|table|describe|desc)\s+((?:`(?:[^`]|``)+`|[\w$]+)(?:\s*\.\s*(?:`(?:[^`]|``)+`|[\w$]+))?)(?:\s+(?:as\s+)?(`(?:[^`]|``)+`|[\w$]+))?/gi;
const unquote = s => (s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s);

/** Maps table names and aliases used in FROM/JOIN/UPDATE clauses to {db, table}. */
function parseAliases(text, currentDb) {
  const map = new Map();
  let m;
  ALIAS_RE.lastIndex = 0;
  while ((m = ALIAS_RE.exec(text))) {
    const parts = /^(`(?:[^`]|``)+`|[\w$]+)\s*\.\s*(`(?:[^`]|``)+`|[\w$]+)$/.exec(m[1]);
    const ref = parts ? { db: unquote(parts[1]), table: unquote(parts[2]) } : { db: currentDb, table: unquote(m[1]) };
    map.set(ref.table.toLowerCase(), ref);
    const alias = m[2] && unquote(m[2]);
    if (alias && !KEYWORDS.has(alias.toUpperCase())) map.set(alias.toLowerCase(), ref);
  }
  return map;
}

const app = new App();
window.zawsql = app;
app.init().catch(e => {
  console.error(e);
  alertError(e.message);
});
