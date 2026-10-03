// "Query" tabs: SQL editor with multiple result sets.
import { h, esc, fmtNum, fmtSecs, fmtElapsed, makeSplitter, pickFile, saveTextFile, isNumericKind, parseEnum } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { RowEditor } from './editing.js';
import { SqlEditor } from '../editor.js';
import { splitSql, statementAt } from '../sqlsplit.js';
import { Grid, sortRows } from '../grid.js';
import { contextMenu, modal } from '../dialogs.js';
import { exportGridDialog } from './tools.js';
import { attachLibraryPanel, editQueryDialog } from './library.js';
import { findSnippet } from '../library.js';

const DDL_RE = /^\s*(?:\/\*.*?\*\/\s*)*(create|drop|alter|rename|truncate)\b/is;

export class QueryView {
  constructor(app, { id, sql = '', title = 'Query', savedId = null }) {
    this.app = app;
    this.id = id;
    this.title = title;
    this.savedId = savedId && app.library.query(savedId) ? savedId : null; // linked saved query (Ctrl+S updates it)
    this.running = false;
    this.sets = [];
    this.active = 0;

    this.editor = new SqlEditor({
      value: sql,
      completer: o => this.app.complete(o),
      onChange: () => { this.app.saveStateSoon(); this.updateSavedState(); },
      snippets: { lookup: t => findSnippet(app.library.snippets, t), vars: () => app.snippetVars() },
    });
    const btn = (ic, label, title, fn) => h('button', { class: 'tbtn', title, html: icon(ic) + (label ? `<span>${label}</span>` : ''), onclick: fn });
    this.runBtn = btn('play', 'Run', 'Execute SQL (F9)', () => this.run('all'));
    this.runSelBtn = btn('playsel', '', 'Execute selection (Ctrl+F9)', () => this.run('selection'));
    this.runCurBtn = btn('playline', '', 'Execute current query (Ctrl+Shift+F9)', () => this.run('current'));
    this.stopBtn = btn('stop', '', 'Stop running query', () => this.stop());
    this.stopBtn.disabled = true;
    this.dbLabel = h('span', { class: 'muted' });
    const toolbar = h('div', { class: 'viewbar' }, this.runBtn, this.runSelBtn, this.runCurBtn, this.stopBtn, h('span', { class: 'sep' }),
      btn('open', '', 'Load SQL file', () => this.loadFile()),
      btn('save', '', 'Save SQL file', () => this.saveFile()),
      btn('history', '', 'Query history', () => this.showHistory()),
      btn('bookmark', '', 'Save to library (Ctrl+S)', () => this.saveToLibrary()),
      (this.libBtn = btn('library', '', 'Saved queries and snippets', () => app.toggleLibrary())),
      btn('format', '', 'Reformat (uppercase keywords)', () => this.reformat()),
      h('div', { class: 'grow' }), this.dbLabel);

    this.edWrap = h('div', { class: 'q-editor' }, this.editor.el);
    this.edWrap.style.height = (app.state.layout?.queryEditorHeight || 220) + 'px';
    const split = h('div', { class: 'splitter-h' });
    makeSplitter(split, {
      axis: 'y',
      get: () => this.edWrap.offsetHeight,
      set: v => { this.edWrap.style.height = Math.max(60, Math.min(v, this.el.clientHeight - 90)) + 'px'; },
      onEnd: () => { app.state.layout = { ...app.state.layout, queryEditorHeight: this.edWrap.offsetHeight }; app.saveStateSoon(); },
    });

    this.resTabList = h('div', { class: 'res-tab-list' });
    this.editInfo = h('span', { class: 'res-edit-info muted' });
    this.resTabs = h('div', { class: 'res-tabs' }, this.resTabList, this.editInfo);
    this.grid = new Grid({
      emptyText: '',
      onSort: c => this.sortBy(c),
      onContextMenu: (e, p) => this.ctx(e, p),
      onCellEdit: (r, c, v) => this.rowEditor.cellEdit(r, c, v),
      onRowChange: prev => this.rowEditor.rowLeft(prev),
      onKey: e => this.rowEditor.handleKey(e),
    });
    // Results from a single table that include its key can be edited in place (see prepareEditing).
    this.rowEditor = new RowEditor(app, {
      grid: this.grid,
      target: () => this.editTarget,
      colName: c => this.editCols?.[c] ?? null,
      applyServerRow: (row, sr) => this.editTableCols.forEach((name, i) => {
        this.editCols.forEach((n, j) => { if (n === name) row[j] = sr[i]; });
      }),
      onRowsChanged: () => { if (this.sets[this.active]) this.sets[this.active].rows = this.rows.slice(); },
    });
    this.msg = h('div', { class: 'q-msg' });
    this.results = h('div', { class: 'q-results' }, this.resTabs, this.grid.el, this.msg);
    this.body = h('div', { class: 'q-body' }, h('div', { class: 'q-main' }, this.edWrap, split, this.results));
    this.el = h('div', { class: 'view query-view' }, toolbar, this.body);
    this.offLibrary = app.library.onChange(() => this.onLibraryChange());
    this.syncLibrary();

    this.el.addEventListener('keydown', e => {
      if (e.key === 'F9') {
        e.preventDefault();
        this.run(e.ctrlKey && e.shiftKey ? 'current' : e.ctrlKey ? 'selection' : 'all');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        this.saveToLibrary({ asNew: e.shiftKey });
      } else if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey && e.target === this.editor.ta) {
        e.preventDefault();
        this.run('current');
      }
    });
  }

  onShow() {
    const { sid, db } = this.app.sel;
    const info = sid ? this.app.conns.get(sid) : null;
    this.dbLabel.textContent = info ? `${info.name}${db ? ' › ' + db : ''}` : 'Not connected';
    if (this.libPanel && this.app.state.layout?.libraryOpen) this.libPanel.render();
    setTimeout(() => this.editor.focus(), 0);
  }

  dispose() {
    this.offLibrary();
    this.libPanel?.dispose();
  }

  // ---------- library ----------

  /** Shows or hides the library panel to match the shared setting. */
  syncLibrary() {
    const open = !!this.app.state.layout?.libraryOpen;
    if (open && !this.libPanel) {
      const { panel, split, host } = attachLibraryPanel(this.app, this, this.body);
      this.libPanel = panel;
      this.libParts = [split, host];
    }
    this.libParts?.forEach(el => { el.style.display = open ? '' : 'none'; });
    this.libBtn.classList.toggle('active', open);
    if (open) this.libPanel.render();
  }

  get savedQuery() { return this.savedId ? this.app.library.query(this.savedId) : null; }

  linkSaved(q) {
    this.savedId = q?.id ?? null;
    if (q) this.setTitle(q.name);
    this.updateSavedState();
    this.libPanel?.render();
    this.app.saveStateSoon();
  }

  setTitle(title) {
    this.title = title;
    this.app.tabs?.setTitle(this.id, title);
  }

  /** The tab shows "modified" while the editor differs from the linked saved query. */
  updateSavedState() {
    const q = this.savedQuery;
    this.app.tabs?.setModified(this.id, !!q && q.sql !== this.editor.value);
    const tab = this.app.tabs?.tabs.get(this.id);
    if (tab) tab.el.title = q ? `Saved query: ${q.folder ? q.folder + '/' : ''}${q.name}` : '';
  }

  onLibraryChange() {
    const q = this.savedQuery;
    if (this.savedId && !q) this.savedId = null; // deleted from the library: the tab keeps its text
    else if (q && q.name !== this.title) this.setTitle(q.name);
    this.updateSavedState();
  }

  /** Ctrl+S: updates the linked saved query, or asks for a name (always with `asNew`, Ctrl+Shift+S). */
  async saveToLibrary({ asNew = false } = {}) {
    const sql = this.editor.value;
    const q = this.savedQuery;
    try {
      if (q && !asNew) {
        await this.app.library.updateQuery(q.id, { sql });
        this.app.setStatus(`Saved "${q.name}" to the library.`);
      } else {
        if (!sql.trim()) return this.app.showError(new Error('The editor is empty; there is nothing to save.'));
        const isDefault = /^Query( #\d+)?$/.test(this.title) || /\.sql$/i.test(this.title);
        const r = await editQueryDialog(this.app, { sql, name: isDefault ? '' : this.title, folder: q?.folder });
        if (!r) return;
        this.linkSaved(r);
        this.app.setStatus(`Saved "${r.name}" to the library.`);
      }
      this.updateSavedState();
    } catch (e) {
      this.app.showError(e);
    }
  }

  get sql() { return this.editor.value; }

  async run(mode) {
    if (this.running) return;
    const { sid, db } = this.app.sel;
    if (!sid) return this.app.showError(new Error('Not connected. Open a session first.'));
    let text = this.editor.value;
    let base = 0;
    const sel = this.editor.selection();
    if (mode === 'selection') {
      if (sel.start === sel.end) mode = 'current';
      else { text = sel.text; base = sel.start; }
    }
    let stmts = splitSql(text);
    if (mode === 'current') {
      const st = statementAt(stmts, sel.start);
      stmts = st ? [st] : [];
    }
    if (!stmts.length) return;
    if (!(await this.app.confirmChanges(sid, { action: 'Execute SQL', statements: stmts.map(s => s.sql), checkWhere: true }))) {
      this.msg.className = 'q-msg';
      this.msg.textContent = 'Execution cancelled – nothing was run.';
      return;
    }

    this.running = true;
    this.setRunning(true);
    const t0 = Date.now();
    this.msg.className = 'q-msg';
    this.msg.textContent = `Executing ${stmts.length} quer${stmts.length === 1 ? 'y' : 'ies'}…`;
    this.timer = setInterval(() => { this.msg.textContent = `Executing… ${fmtElapsed(Date.now() - t0)}`; }, 500);
    this.app.setStatus('Executing query…');
    try {
      this.resultSid = sid;
      const r = await post(`/s/${sid}/exec`, { statements: stmts.map(s => s.sql), database: db, maxRows: this.app.prefs.maxResultRows });
      this.app.addHistory(mode === 'all' ? text : stmts.map(s => s.sql).join(';\n'), db);
      this.showResults(r);
      if (r.errors.length) {
        const er = r.errors[0];
        const st = stmts[er.statement];
        if (st) this.editor.selectRange(base + st.start, base + st.end);
        this.app.showError(new Error(er.code ? `SQL Error (${er.code}): ${er.message}` : `Blocked in read-only mode: ${er.message}`));
      }
      if (r.database && r.database !== db) this.app.selectDatabase(sid, r.database, { quiet: true });
      if (stmts.slice(0, r.executed + 1).some(s => DDL_RE.test(s.sql))) this.app.afterDdl(sid, r.database || db);
      this.app.setStatus('Query finished.');
    } catch (e) {
      this.msg.className = 'q-msg err';
      this.msg.textContent = e.message;
      this.app.showError(e);
    } finally {
      clearInterval(this.timer);
      this.running = false;
      this.setRunning(false);
    }
  }

  setRunning(on) {
    for (const b of [this.runBtn, this.runSelBtn, this.runCurBtn]) b.disabled = on;
    this.stopBtn.disabled = !on;
    this.app.tabs.setBusy(this.id, on);
  }

  async stop() {
    const { sid } = this.app.sel;
    if (!sid) return;
    try { await post(`/s/${sid}/cancel`); } catch (e) { this.app.showError(e); }
  }

  showResults(r) {
    this.sets = r.resultSets;
    this.active = 0;
    this.sort = null;
    this.resTabList.replaceChildren(...this.sets.map((s, i) => {
      const b = h('button', { class: 'res-tab' + (i === 0 ? ' active' : ''), title: s.sql },
        `Result #${i + 1} (${fmtNum(s.rows.length)}${s.truncated ? '+' : ''}r × ${s.columns.length}c)`);
      b.addEventListener('click', () => this.showSet(i));
      return b;
    }));
    this.resTabs.style.display = this.sets.length ? '' : 'none';
    if (this.sets.length) this.showSet(0);
    else {
      this.resetEditing();
      this.grid.setData([], []);
    }
    const last = this.sets[this.sets.length - 1];
    const parts = [];
    if (r.affected) parts.push(`Affected rows: ${fmtNum(r.affected)}`);
    if (last) parts.push(`Found rows: ${fmtNum(last.rows.length)}${last.truncated ? ` (limited to ${fmtNum(this.app.prefs.maxResultRows)})` : ''}`);
    if (r.insertId) parts.push(`Last insert id: ${r.insertId}`);
    parts.push(`Duration for ${r.executed} of ${r.statements} quer${r.statements === 1 ? 'y' : 'ies'}: ${fmtSecs(r.ms)}`);
    this.msg.className = 'q-msg' + (r.errors.length ? ' err' : '');
    this.msg.textContent = (r.errors.length ? `Error: ${r.errors[0].message}   ` : '') + parts.join('   ');
  }

  showSet(i) {
    this.active = i;
    this.sort = null;
    [...this.resTabList.children].forEach((b, j) => b.classList.toggle('active', j === i));
    const s = this.sets[i];
    this.cols = s.columns.map(c => ({ name: c.name, kind: c.kind, type: c.type, readOnly: true, title: `${c.name}: ${c.type}${c.table ? ' (' + c.table + ')' : ''}` }));
    this.rows = s.rows.slice();
    this.grid.sort = null;
    this.resetEditing();
    this.grid.setData(this.cols, this.rows);
    this.prepareEditing(s, i);
  }

  resetEditing(info = '') {
    this.editTarget = null;
    this.editCols = null;
    this.editTableCols = null;
    this.grid.o.editable = false;
    this.editInfo.textContent = info;
    this.editInfo.title = '';
  }

  /**
   * Enables in-place editing when every table column of the result comes from one base table
   * whose primary/unique key columns are all part of the result.
   */
  async prepareEditing(set, idx) {
    const sid = this.resultSid;
    const based = set.columns.filter(c => c.table && c.baseName);
    const readOnly = why => {
      this.editInfo.textContent = 'Read-only';
      this.editInfo.title = why;
    };
    if (sid && this.app.isReadOnly(sid)) return readOnly('The session is in read-only mode.');
    if (!sid || !this.app.conns.has(sid) || !based.length) return readOnly('The result has no columns from a table.');
    if (new Set(based.map(c => c.schema + '.' + c.table)).size > 1) return readOnly('The result combines columns from several tables.');
    const { schema: db, table } = based[0];
    if (!db) return readOnly('The result comes from a derived or temporary table.');
    let info;
    try {
      info = await get(`/s/${sid}/table`, { db, table }, { quiet: true });
    } catch {
      return readOnly(`Table ${db}.${table} could not be read.`);
    }
    if (this.sets[idx] !== set || this.active !== idx) return;
    if (info.isView) return readOnly(`${db}.${table} is a view.`);
    if (!info.keyColumns.length) return readOnly(`${db}.${table} has no primary or unique key.`);
    const present = new Set(based.map(c => c.baseName));
    const missing = info.keyColumns.filter(k => !present.has(k));
    if (missing.length) return readOnly(`Key column(s) ${missing.join(', ')} of ${db}.${table} are not part of the result.`);

    const tcols = new Map(info.columns.map(c => [c.name, c]));
    this.editCols = set.columns.map(c => (c.table && c.baseName && tcols.has(c.baseName) ? c.baseName : null));
    this.editTableCols = info.columns.map(c => c.name);
    this.editTarget = { sid, db, table };
    this.cols.forEach((col, j) => {
      const tc = this.editCols[j] && tcols.get(this.editCols[j]);
      col.readOnly = !tc || /\b(VIRTUAL|STORED|PERSISTENT)\b/i.test(tc.extra || '');
      if (!tc) return;
      col.type = tc.type;
      col.enumValues = parseEnum(tc.type);
      col.key = info.keyColumns.includes(tc.name) ? 'pri' : null;
      col.title = `${tc.name}: ${tc.type} (${db}.${table})`;
      if (col.key) this.grid.widths[j] = Math.max(this.grid.widths[j], this.grid.measureCol(j));
    });
    this.grid.o.editable = true;
    this.grid.renderHeader();
    this.editInfo.textContent = `Editable: ${db}.${table}`;
    this.editInfo.title = 'Edit cells in place: F2, Enter or typing. Insert / Ctrl+Delete add or remove rows.';
  }

  sortBy(c) {
    if (!this.sets.length) return;
    this.sort = this.sort?.c === c ? (this.sort.dir === 'asc' ? { c, dir: 'desc' } : null) : { c, dir: 'asc' };
    this.rows = this.sets[this.active].rows.slice();
    if (this.sort) sortRows(this.rows, c, this.sort.dir, isNumericKind(this.cols[c].kind));
    this.grid.sort = this.sort;
    this.grid.setData(this.cols, this.rows, { keepWidths: true });
  }

  ctx(e, p) {
    if (!this.sets.length) return;
    contextMenu(e.clientX, e.clientY, [
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => this.grid.copy() },
      { label: 'Copy with column names', onClick: () => this.grid.copy(this.cols.slice(this.grid.selRect().c1, this.grid.selRect().c2 + 1).map(c => c.name).join('\t') + '\n' + this.grid.selectedText()) },
      '-',
      ...(this.editTarget ? [...this.rowEditor.menuItems(p), '-'] : []),
      { label: 'Export grid rows…', icon: 'export', onClick: () => exportGridDialog(this.app, { columns: this.cols, rows: this.rows, selected: this.grid.selectedRowIndexes(), name: this.sets[this.active].columns[0]?.table || 'result' }) },
    ]);
  }

  async loadFile() {
    const f = await pickFile('.sql,.txt,text/plain');
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) {
      this.app.showError(new Error('This file is large. Use File › Run SQL file… to execute it without loading it into the editor.'));
      return;
    }
    this.editor.value = await f.text();
    this.savedId = null;
    this.setTitle(f.name);
    this.updateSavedState();
    this.app.saveStateSoon();
  }

  async saveFile() {
    const name = await saveTextFile(/\.sql$/i.test(this.title) ? this.title : 'query.sql', this.editor.value);
    if (name) {
      this.app.tabs.setTitle(this.id, name);
      this.title = name;
      this.app.setStatus(`Saved ${name}.`);
      this.app.saveStateSoon();
    }
  }

  reformat() {
    // Conservative reformat: uppercase keywords outside strings/comments/identifiers.
    const v = this.editor.value;
    const out = v.replace(/(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)|\b([A-Za-z_]+)\b/g, (m, skip, word) => {
      if (skip) return m;
      return this.app.isKeyword(word) ? word.toUpperCase() : m;
    });
    if (out !== v) {
      this.editor.ta.select();
      this.editor.insert(out);
    }
  }

  async showHistory() {
    const hist = this.app.state.history || [];
    const filter = h('input', { class: 'inp wide', placeholder: 'Filter history' });
    const list = h('div', { class: 'hist-list' });
    let sel = 0, shown = [];
    const draw = () => {
      const q = filter.value.toLowerCase();
      shown = hist.filter(x => !q || x.sql.toLowerCase().includes(q)).slice(0, 300);
      sel = Math.min(sel, shown.length - 1);
      list.innerHTML = shown.map((x, i) => `<div class="hist-item${i === sel ? ' sel' : ''}" data-i="${i}"><div class="hist-meta">${esc(new Date(x.ts).toLocaleString())}${x.db ? ' · ' + esc(x.db) : ''}</div><div class="hist-sql">${esc(x.sql.slice(0, 400))}</div></div>`).join('') || '<div class="muted pad">No queries yet.</div>';
    };
    filter.addEventListener('input', () => { sel = 0; draw(); });
    draw();
    let ctxRef;
    list.addEventListener('click', e => { const it = e.target.closest('.hist-item'); if (it) { sel = +it.dataset.i; draw(); } });
    list.addEventListener('dblclick', e => { const it = e.target.closest('.hist-item'); if (it) { sel = +it.dataset.i; ctxRef.close('load'); } });
    const r = await modal({
      title: 'Query history',
      width: 700,
      body: c => { ctxRef = c; return h('div', { class: 'hist' }, filter, list); },
      buttons: [
        { label: 'Save to library…', value: 'save', align: 'left' },
        { label: 'Load into editor', value: 'load', primary: true }, { label: 'Close', value: null },
      ],
    });
    if (r === 'save' && shown[sel]) {
      const saved = await editQueryDialog(this.app, { sql: shown[sel].sql });
      if (saved) this.app.setStatus(`Saved "${saved.name}" to the library.`);
    }
    if (r === 'load' && shown[sel]) {
      this.editor.ta.select();
      this.editor.insert(shown[sel].sql);
    }
  }
}
