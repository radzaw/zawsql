// ZawSQL main module: layout, menus, toolbar, tabs and the glue between tree and views.
import { get, post, put, setLogSink, startHeartbeat, ApiError, SSH_HOSTKEY_UNKNOWN } from './api.js';
import { h, qi, debounce, makeSplitter, fmtElapsed } from './util.js';
import { icon } from './icons.js';
import { Tree } from './tree.js';
import { LogPanel } from './log.js';
import { KEYWORDS, FUNCTIONS } from './editor.js';
import { isReadOnlyStatement, lacksWhere } from './sqlcheck.js';
import { contextMenu, closeMenus, menuIsOpen, alertError, confirmDlg, promptDlg, modal } from './dialogs.js';
import { HostView } from './views/host.js';
import { DatabaseView } from './views/database.js';
import { TableView } from './views/table.js';
import { DataView } from './views/data.js';
import { QueryView } from './views/query.js';
import { userManager } from './views/users.js';
import { maintenanceDialog } from './views/maintenance.js';
import { importDialog } from './views/import.js';
import { updateDialog, autoCheckUpdates, whatsNewAfterUpdate, whatsNewDialog } from './views/update.js';
import { LibraryStore, editSnippetDialog } from './views/library.js';
import { snippetVars } from './library.js';
import { formatSql } from './sqlformat.js';
import { DEFAULT_SLOW_MS, slowThreshold } from './logslow.js';
import { sessionManager, confirmHostKey, exportDumpDialog, runSqlFile, createDatabaseDialog, preferencesDialog, aboutDialog } from './views/tools.js';

const TYPE_LABEL = { table: 'Table', view: 'View', procedure: 'Procedure', function: 'Function', trigger: 'Trigger', event: 'Event' };
const DEFAULT_PREFS = { rowsPerPage: 1000, maxResultRows: 10000, theme: 'system', editorFontSize: 13, confirmNoWhere: true, formatKeywordCase: 'upper', formatIndent: '2', checkUpdates: true, showWhatsNew: true, txDefault: 'auto', logTimestamps: true, slowLogMs: DEFAULT_SLOW_MS };

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
  setFlag(id, cls, on) { this.tabs.get(id)?.el.classList.toggle(cls, !!on); }
  activeView() { return this.tabs.get(this.active)?.view; }
}

// ---------------------------------------------------------------- app

class App {
  constructor() {
    this.sel = { sid: null, db: null, obj: null };
    this.conns = new Map();
    this.colCache = new Map();
    this.hostCache = new Map();
    this.prodAllowed = new Set(); // production sessions where the user chose not to be asked again
    this.queryViews = [];
    this.queryCounter = 0;
    this.saveStateSoon = debounce(() => this.saveState(), 800);
    this.refreshViewSoon = debounce((target, from) => this.showTarget(target, from), 120);
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

    this.log = new LogPanel(document.getElementById('log'), {
      timestamps: () => this.prefs.logTimestamps !== false,
      setTimestamps: on => { this.prefs.logTimestamps = on; this.saveStateSoon(); },
      slowMs: () => slowThreshold(this.prefs.slowLogMs),
      setSlowMs: ms => { this.prefs.slowLogMs = ms; this.saveStateSoon(); },
    });
    setLogSink((lines, times, durations) => this.log.add(lines, '', times, durations));
    try { this.version = await get('/version', null, { quiet: true }); } catch { this.version = null; }
    this.library = new LibraryStore();
    await this.library.load();
    if (this.library.loadError) this.log.error(`Saved queries and snippets could not be loaded: ${this.library.loadError.message}`);
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
    for (const q of saved) this.openQueryTab(q.sql, q.title, { activate: false, savedId: q.savedId });
    this.updateTabs();
    this.tabs.activate('host');

    document.getElementById('db-filter').addEventListener('input', e => { this.tree.dbFilter = e.target.value; this.tree.render(); });
    document.getElementById('tbl-filter').addEventListener('input', e => { this.tree.tblFilter = e.target.value; this.tree.render(); });
    document.addEventListener('keydown', e => this.globalKey(e));
    window.addEventListener('beforeunload', e => {
      this.saveState();
      // Closing the window closes the connections, which rolls back open transactions: let the browser ask.
      if (this.queryViews.some(v => v.tx?.open)) e.preventDefault();
    });

    startHeartbeat();
    setTimeout(() => autoCheckUpdates(this), 15_000);
    this.log.info(`ZawSQL started. Configuration is stored on the local machine.`);
    sessionManager(this);
    // After an update: what changed since the version that ran last time (on top of the session manager).
    whatsNewAfterUpdate(this);
  }

  applyPrefs() {
    const p = this.prefs;
    const dark = p.theme === 'dark' || (p.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--ed-font-size', p.editorFontSize + 'px');
    this.log?.markAll(); // the slow statement threshold may have changed
    // The app window's title bar follows theme-color in Chromium app windows.
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#2b2d30' : '#f0f0f0');
    try { sessionStorage.setItem('zawsql-theme', p.theme); } catch { /* storage unavailable */ }
    if (this.themeBtn) {
      this.themeBtn.innerHTML = icon(dark ? 'sun' : 'moon');
      this.themeBtn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }

  /** Toolbar toggle: flips between explicit light and dark (Tools › Theme also offers "Follow system"). */
  toggleTheme() {
    this.prefs.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    this.applyPrefs();
    this.saveStateSoon();
  }

  async saveState() {
    if (!this.state) return;
    this.state.queryTabs = this.queryViews.map(v => ({ title: v.title, sql: v.sql, savedId: v.savedId || undefined }));
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
    this.sbProd = h('div', { class: 'sb-cell sb-prod', style: { display: 'none' }, title: 'Production server: every change asks for confirmation.' }, 'PRODUCTION');
    this.sbUpdate = h('button', { class: 'sb-cell sb-update', style: { display: 'none' }, title: 'Show what is new and update' });
    sb.append(this.sbMsg, this.sbUpdate, this.sbProd, this.sbRo, this.sbSel, this.sbConn, this.sbVer);
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
    this.sbProd.style.display = info?.production ? '' : 'none';
    this.sbSel.style.boxShadow = info?.color ? `inset 4px 0 0 ${info.color}` : '';
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
        { label: 'Import CSV / Excel…', icon: 'import', disabled: !s.sid || ro, onClick: () => importDialog(this, s.sid, s.db, s.obj?.type === 'table' ? s.obj.name : null) },
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
        { label: 'Run on several servers…', icon: 'server', shortcut: 'Ctrl+Alt+F9', onClick: () => this.queryForRun()?.runMulti() },
        { label: 'Stop', icon: 'stop', disabled: !s.sid, onClick: () => this.activeQuery()?.stop() },
        '-',
        { label: 'Query history…', icon: 'history', onClick: () => this.queryForRun()?.showHistory() },
        { label: 'Explain current statement', icon: 'explain', shortcut: 'Ctrl+Shift+E', disabled: !s.sid, onClick: () => this.queryForRun()?.explain() },
        { label: 'Format SQL', icon: 'format', shortcut: 'Ctrl+Shift+F', onClick: () => { const v = this.queryForRun(); if (v) this.formatEditor(v.editor); } },
        '-',
        { label: 'Manual commit (transaction)', icon: 'txmanual', checked: !!this.activeQuery()?.tx, disabled: !s.sid, onClick: () => this.queryForRun()?.toggleManual() },
        { label: 'Commit', icon: 'check', disabled: !this.activeQuery()?.tx?.open, onClick: () => this.activeQuery()?.commit() },
        { label: 'Rollback', icon: 'cancel', disabled: !this.activeQuery()?.tx?.open, onClick: () => this.activeQuery()?.rollback() },
        '-',
        { label: 'Save to library…', icon: 'bookmark', shortcut: 'Ctrl+S', onClick: () => this.queryForRun()?.saveToLibrary() },
        { label: 'Save to library as new…', shortcut: 'Ctrl+Shift+S', onClick: () => this.queryForRun()?.saveToLibrary({ asNew: true }) },
        { label: 'New snippet…', icon: 'snippet', onClick: () => editSnippetDialog(this, { body: this.activeQuery()?.editor.selection().text ?? '' }) },
        { label: 'Saved queries and snippets', icon: 'library', checked: !!this.state.layout?.libraryOpen, onClick: () => { this.queryForRun(); this.toggleLibrary(); } },
      ]],
      ['Tools', () => [
        { label: 'Create database…', icon: 'database', disabled: !s.sid || ro, onClick: () => createDatabaseDialog(this, s.sid) },
        { label: 'Create table…', icon: 'plus', disabled: !s.db || ro, onClick: () => this.newTable(s.sid, s.db) },
        '-',
        { label: 'User manager…', icon: 'user', disabled: !s.sid, onClick: () => userManager(this, s.sid) },
        { label: 'Table maintenance…', icon: 'maintenance', disabled: !s.db, onClick: () => maintenanceDialog(this, s.sid, s.db, s.obj?.type === 'table' ? [s.obj.name] : null) },
        { label: 'Server health report', icon: 'check', disabled: !s.sid, onClick: () => this.showHealth(s.sid) },
        '-',
        { label: 'Export database as SQL…', icon: 'export', disabled: !s.db, onClick: () => exportDumpDialog(this, s.sid, s.db) },
        { label: 'Run SQL file…', icon: 'import', disabled: !s.sid || ro, onClick: () => runSqlFile(this) },
        { label: 'Import CSV / Excel…', icon: 'import', disabled: !s.sid || ro, onClick: () => importDialog(this, s.sid, s.db, s.obj?.type === 'table' ? s.obj.name : null) },
        '-',
        { label: 'Theme', submenu: [['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => ({ label: l, checked: this.prefs.theme === v, onClick: () => { this.prefs.theme = v; this.applyPrefs(); this.saveStateSoon(); } })) },
        { label: 'Preferences…', icon: 'settings', onClick: () => preferencesDialog(this) },
      ]],
      ['Help', () => [
        { label: 'Keyboard shortcuts', icon: 'info', onClick: () => this.shortcutsDialog() },
        { label: "What's new…", icon: 'info', onClick: () => whatsNewDialog(this) },
        { label: 'Check for updates…', icon: 'next', onClick: () => updateDialog(this) },
        { label: 'About ZawSQL', icon: 'question', onClick: () => aboutDialog(this.version) },
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
      (this.themeBtn = b('moon', 'Switch to dark mode', () => this.toggleTheme())),
    );
    this.applyPrefs();
  }

  shortcutsDialog() {
    const rows = [
      ['F5', 'Refresh tree / current tab'], ['F9', 'Execute all SQL in the query tab'], ['Ctrl+F9', 'Execute selection'],
      ['Ctrl+Shift+F9 / Ctrl+Enter', 'Execute statement at the caret'], ['Ctrl+Space', 'Autocomplete'], ['Ctrl+/', 'Toggle line comment'],
      ['Tab / Shift+Tab', 'Indent / outdent'], ['Tab after a trigger', 'Expand snippet (then Tab: next field)'],
      ['Ctrl+Shift+E', 'Visual EXPLAIN of the statement at the cursor'], ['Ctrl+Shift+F', 'Format SQL (selection or all)'], ['Ctrl+S', 'Save query to library'], ['Ctrl+Shift+S', 'Save query to library as new'], ['Ctrl+T', 'New query tab'], ['F2 / Enter / typing', 'Edit grid cell'],
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
    } else if (ctrl && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault(); // never the browser's "Save page"; query tabs handle Ctrl+S themselves
      this.activeQuery()?.saveToLibrary({ asNew: e.shiftKey });
    } else if (e.key === 'F9' && !this.activeQuery()) {
      e.preventDefault();
      this.queryForRun()?.run(e.ctrlKey && e.shiftKey ? 'current' : e.ctrlKey ? 'selection' : 'all');
    }
  }

  // ---------- connections ----------

  /** Connects a saved session. Resolves to false when the user declined an unknown SSH host key. */
  async connect(profileId, password, sshSecret) {
    this.setStatus('Connecting…');
    let info;
    for (;;) {
      try {
        info = await post('/connect', { sessionId: profileId, password, sshSecret });
        break;
      } catch (e) {
        if (e.code !== SSH_HOSTKEY_UNKNOWN) throw e;
        if (!(await confirmHostKey(e.data))) {
          this.setStatus('Connection cancelled.');
          return false;
        }
        await post(`/sessions/${profileId}/hostkey`, { fingerprint: e.data.fingerprint });
      }
    }
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
    const open = this.queryViews.filter(v => v.tx?.sid === sid && v.tx.open);
    if (open.length) {
      const n = open.reduce((s, v) => s + v.tx.changes, 0);
      const msg = `${open.length === 1 ? 'A query tab has' : `${open.length} query tabs have`} an open transaction on this session (${n} uncommitted change${n === 1 ? '' : 's'}). Disconnecting rolls ${open.length === 1 ? 'it' : 'them'} back.`;
      if (!(await confirmDlg(msg, { ok: 'Disconnect and roll back', danger: true }))) return;
    }
    try { await post(`/s/${sid}/disconnect`); } catch { /* already gone */ }
    for (const v of this.queryViews) if (v.tx?.sid === sid) { v.tx = null; v.renderTx(); }
    this.conns.delete(sid);
    this.prodAllowed.delete(sid);
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
    this.refreshViewSoon(target, this.tabs.active);
  }

  /** `from`: the tab active when the switch was requested; if the user has picked another tab since, that choice wins. */
  showTarget(target, from) {
    if (from !== undefined && this.tabs.active !== from) return;
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
    this.applySessionLook(info);
    for (const q of this.queryViews) if (this.tabs.active === q.id) q.onShow();
  }

  /** Host tab › Health for a session (selecting the session first). */
  showHealth(sid) {
    if (this.sel.sid !== sid || this.sel.db) {
      const node = this.tree.sessionNode(sid);
      if (node) this.tree.select(node);
    }
    this.views.host.switchKind('health');
    this.tabs.activate('host');
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

  openQueryTab(sql = '', title, { activate = true, savedId = null } = {}) {
    this.queryCounter++;
    const id = 'q' + this.queryCounter;
    const t = title || (this.queryCounter === 1 ? 'Query' : `Query #${this.queryCounter}`);
    const v = new QueryView(this, { id, sql, title: t, savedId });
    this.queryViews.push(v);
    this.tabs.add({
      id, title: t, iconName: 'query', view: v, closable: true,
      onClose: () => {
        if (this.queryViews.length === 1) {
          v.editor.value = '';
          v.linkSaved(null);
          this.saveStateSoon();
          return false;
        }
        // An open transaction is committed or rolled back first; then the tab closes for real.
        if (v.tx?.open) {
          v.endTransaction('Closing the tab ends it.').then(ok => { if (ok) this.tabs.close(id); });
          return false;
        }
        if (v.tx) v.endTransaction(''); // nothing open: just closes its connection
        this.queryViews.splice(this.queryViews.indexOf(v), 1);
        v.dispose();
        this.saveStateSoon();
      },
    });
    v.updateSavedState();
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

  // ---------- saved queries and snippets ----------

  /** Shows or hides the library panel in all query tabs (one shared setting). */
  toggleLibrary(open = !this.state.layout?.libraryOpen) {
    this.state.layout = { ...this.state.layout, libraryOpen: open };
    for (const v of this.queryViews) v.syncLibrary();
    this.saveStateSoon();
    if (open) this.queryForRun()?.libPanel?.filter.focus();
  }

  /**
   * Opens a saved query: activates a tab already showing it, else loads it into the active query tab
   * when that is empty, else into a new tab. `newTab` always opens a new tab; `run` executes it.
   */
  openSavedQuery(q, { newTab = false, run = false } = {}) {
    let v = newTab ? null : this.queryViews.find(x => x.savedId === q.id);
    if (!v) {
      const cur = this.activeQuery();
      if (!newTab && cur && !cur.sql.trim()) {
        v = cur;
        v.editor.value = q.sql;
        v.linkSaved(q);
      } else v = this.openQueryTab(q.sql, q.name, { savedId: q.id });
    }
    this.tabs.activate(v.id);
    if (run) v.run('all');
    return v;
  }

  formatOptions() {
    return { keywordCase: this.prefs.formatKeywordCase, indent: this.prefs.formatIndent === 'tab' ? 'tab' : Number(this.prefs.formatIndent) || 2 };
  }

  /**
   * Formats the editor's selection, or all of it. Only whitespace and keyword case change, so the caret is
   * kept on the same character; undo restores the original.
   */
  formatEditor(editor) {
    if (editor.ta.readOnly) return;
    const ta = editor.ta;
    const sel = editor.selection();
    const whole = sel.start === sel.end;
    const src = whole ? editor.value : sel.text;
    if (!src.trim()) return;
    let out;
    try {
      out = formatSql(src, this.formatOptions());
    } catch (e) {
      this.showError(new Error(`This SQL could not be formatted safely, so it was left unchanged.\n\n${e.message}`));
      return;
    }
    if (out === src) { this.setStatus('The SQL is already formatted.'); return; }
    const nonWs = whole ? src.slice(0, sel.start).replace(/\s+/g, '').length : 0;
    const top = ta.scrollTop;
    if (whole) ta.setSelectionRange(0, src.length);
    editor.insert(out);
    if (whole) {
      let p = 0;
      for (let c = 0; p < out.length && c < nonWs; p++) if (!/\s/.test(out[p])) c++;
      ta.setSelectionRange(p, p);
      ta.scrollTop = top;
    } else ta.setSelectionRange(sel.start, sel.start + out.length);
    editor.update();
    this.setStatus(whole ? 'SQL formatted.' : 'Selection formatted.');
  }

  snippetVars() {
    const { db, obj } = this.sel;
    const table = obj && (obj.type === 'table' || obj.type === 'view') ? obj.name : null;
    return snippetVars({ db, table, ident });
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

  /** Prefix for existing confirmation messages on production sessions. */
  prodWarn(sid) {
    const info = this.conns.get(sid);
    return info?.production ? `⚠ PRODUCTION SERVER: ${info.name}\n\n` : '';
  }

  /**
   * Safety confirmation before changing anything. On production sessions every change asks (unless
   * the user opted out until reconnect); with `checkWhere`, UPDATE/DELETE without WHERE asks on any session.
   * `statements` omitted means a change that isn't plain SQL (e.g. a grid edit).
   * Resolves to true when the change may go ahead.
   */
  async confirmChanges(sid, { action, statements, checkWhere = false }) {
    const info = this.conns.get(sid);
    if (!info) return true;
    const list = statements || [];
    const noWhere = checkWhere && this.prefs.confirmNoWhere ? list.filter(lacksWhere) : [];
    const prod = info.production && !this.prodAllowed.has(sid);
    const changing = prod ? (statements ? list.filter(s => !isReadOnlyStatement(s)) : [null]) : [];
    if (!noWhere.length && !changing.length) return true;

    const shown = (prod ? changing.filter(Boolean) : noWhere).slice(0, 8);
    const optOut = h('input', { type: 'checkbox' });
    const body = h('div', { class: 'form confirm-changes' },
      prod ? h('div', { class: 'prod-banner', style: { borderColor: info.color || '#c42b1c' } },
        h('b', null, 'PRODUCTION SERVER'), ` – ${info.name} (${info.user} @ ${info.host})`) : null,
      h('div', null, action + (shown.length ? ':' : '.')),
      shown.map(s => h('div', { class: 'confirm-stmt' },
        lacksWhere(s) ? h('span', { class: 'ro-badge' }, 'no WHERE') : null,
        h('code', null, s.length > 300 ? s.slice(0, 300) + ' …' : s))),
      (prod ? changing.filter(Boolean).length : noWhere.length) > shown.length ? h('div', { class: 'muted' }, `… and ${(prod ? changing.filter(Boolean).length : noWhere.length) - shown.length} more`) : null,
      noWhere.length ? h('div', { class: 'warn-text' }, `${noWhere.length} UPDATE/DELETE statement(s) have no WHERE clause and will affect every row of the table.`) : null,
      prod ? h('label', { class: 'chk' }, optOut, " Don't ask again for this session until I reconnect") : null);
    const ok = await modal({
      title: prod ? 'Confirm changes on production' : 'Confirm UPDATE/DELETE without WHERE',
      width: 620,
      body,
      buttons: [{ label: 'Execute', value: true, primary: true, danger: true }, { label: 'Cancel', value: false }],
    });
    if (ok && prod && optOut.checked) this.prodAllowed.add(sid);
    return ok === true;
  }

  /** Session color under the tab bar, window title. */
  applySessionLook(info) {
    document.documentElement.style.setProperty('--session-color', info?.color || 'transparent');
    document.title = info ? `${info.name}${info.production ? ' [PRODUCTION]' : ''} – ZawSQL` : 'ZawSQL';
  }

  newTable(sid, db) {
    if (!sid || !db || !this.canModify(sid)) return;
    this.views.table.startCreate(sid, db);
    this.updateTabs();
    this.tabs.activate('table');
  }

  async dropDatabase(sid, db) {
    if (!this.canModify(sid)) return;
    if (!(await confirmDlg(this.prodWarn(sid) + `Drop database "${db}" and everything in it?\n\nThis cannot be undone.`, { ok: 'Drop', danger: true, kind: 'warning' }))) return;
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
    if (!(await confirmDlg(this.prodWarn(sid) + `Drop ${objs.length} object(s)?\n\n${list}`, { ok: 'Drop', danger: true, kind: 'warning' }))) return;
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
    if (!(await confirmDlg(this.prodWarn(sid) + `Delete ALL rows from ${names.length === 1 ? 'table ' + names[0] : names.length + ' tables'}?\n\n${names.join('\n')}`, { ok: 'Empty', danger: true, kind: 'warning' }))) return;
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
    if (!(await this.confirmChanges(sid, { action: `Rename table ${name}`, statements: [`RENAME TABLE ${qi(db)}.${qi(name)} TO ${qi(db)}.${qi(nn)}`] }))) return;
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
      tables.length && { label: 'Maintenance…', icon: 'maintenance', onClick: () => maintenanceDialog(this, sid, db, tables) },
      o.type === 'table' && objs.length === 1 && { label: 'Import CSV / Excel…', icon: 'import', disabled: ro, onClick: () => importDialog(this, sid, db, o.name) },
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
        { label: 'Server health report', icon: 'check', onClick: () => this.showHealth(node.sid) },
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
        { label: 'Table maintenance…', icon: 'maintenance', onClick: () => maintenanceDialog(this, node.sid, node.db) },
        { label: 'Run SQL file…', icon: 'import', disabled: this.isReadOnly(node.sid), onClick: () => runSqlFile(this) },
        { label: 'Import CSV / Excel…', icon: 'import', disabled: this.isReadOnly(node.sid), onClick: () => importDialog(this, node.sid, node.db) },
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

  // ---------- autocompletion ----------

  async complete({ text, prefix, qualifier }) {
    const { sid, db } = this.sel;
    const items = [];
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
      for (const sn of this.library.snippets) if (sn.trigger) items.push({ label: sn.trigger, icon: 'snippet', detail: sn.name, snippet: sn.body });
      for (const k of FUNCTIONS) items.push({ label: k, icon: 'function', detail: 'function', insert: k + '(' });
      for (const k of KEYWORDS) if (!FUNCTIONS.has(k)) items.push({ label: k, detail: 'keyword' });
    }
    return items;
  }
}

/** An identifier as typed: bare when safe, else backquoted. */
const ident = n => (/^[A-Za-z_$][\w$]*$/.test(n) && !KEYWORDS.has(n.toUpperCase()) ? n : qi(n));

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
