// Saved queries and snippets: the library store (library.json on the backend), the side panel shown in
// query tabs, and the edit dialogs.
import { h, esc, makeSplitter, pickFile, saveTextFile } from '../util.js';
import { icon } from '../icons.js';
import { get, put } from '../api.js';
import { SqlEditor } from '../editor.js';
import { modal, contextMenu, confirmDlg, alertError, alertInfo } from '../dialogs.js';
import {
  normalizeLibrary, makeQuery, makeSnippet, groupByFolder, folders, matches, findSnippet, mergeLibrary,
  restoreDefaultSnippets, isValidTrigger, normalizeFolder, suggestName, uniqueName, expandSnippet, LIBRARY_VERSION,
} from '../library.js';

export class LibraryStore {
  constructor() {
    this.lib = normalizeLibrary(null);
    this.listeners = new Set();
    this.loaded = false;
  }

  async load() {
    try {
      this.lib = normalizeLibrary(await get('/library', null, { quiet: true }));
      this.loaded = true;
    } catch (e) {
      this.loadError = e;
    }
  }

  get queries() { return this.lib.queries; }
  get snippets() { return this.lib.snippets; }
  query(id) { return this.lib.queries.find(q => q.id === id) || null; }
  snippet(id) { return this.lib.snippets.find(s => s.id === id) || null; }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Saves the whole library and notifies the panels and query tabs. */
  async commit() {
    // A library that failed to load is never written back: that would replace the user's saved queries.
    if (!this.loaded) throw new Error(`The library could not be loaded, so changes are not saved: ${this.loadError?.message ?? ''}`);
    await put('/library', this.lib, { quiet: true });
    for (const fn of this.listeners) fn();
  }

  async addQuery(fields) {
    const q = makeQuery(fields);
    this.lib.queries.push(q);
    await this.commit();
    return q;
  }

  async updateQuery(id, fields) {
    const q = this.query(id);
    if (!q) throw new Error('This saved query no longer exists.');
    Object.assign(q, fields, { folder: normalizeFolder(fields.folder ?? q.folder), updated: Date.now() });
    await this.commit();
    return q;
  }

  async addSnippet(fields) {
    const s = makeSnippet(fields);
    this.lib.snippets.push(s);
    await this.commit();
    return s;
  }

  async updateSnippet(id, fields) {
    const s = this.snippet(id);
    if (!s) throw new Error('This snippet no longer exists.');
    Object.assign(s, fields, { updated: Date.now() });
    await this.commit();
    return s;
  }

  async remove(kind, id) {
    const list = kind === 'query' ? this.lib.queries : this.lib.snippets;
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) list.splice(i, 1);
    await this.commit();
  }
}

// ---------------------------------------------------------------- dialogs

/** Edits (or creates) a saved query. Resolves to the saved query, or null when cancelled. */
export async function editQueryDialog(app, { query = null, sql = '', name = '', folder = null } = {}) {
  const store = app.library;
  const nameInp = h('input', { class: 'inp wide', value: query?.name ?? (name || suggestName(sql)), spellcheck: false, autofocus: true });
  const folderInp = h('input', { class: 'inp wide', value: query?.folder ?? folder ?? app.state.lastLibraryFolder ?? '', spellcheck: false, list: 'lib-folders', placeholder: 'e.g. Reports/Monthly' });
  const folderList = h('datalist', { id: 'lib-folders' }, folders(store.queries).map(f => h('option', { value: f })));
  const descInp = h('input', { class: 'inp wide', value: query?.description ?? '', placeholder: 'Optional' });
  const ed = new SqlEditor({ value: query?.sql ?? sql });
  const row = (label, el) => h('label', { class: 'frow' }, h('span', null, label), el);
  const r = await modal({
    title: query ? 'Edit saved query' : 'Save query to library',
    width: 640,
    className: 'lib-dialog',
    body: h('div', { class: 'form2' },
      row('Name:', nameInp), row('Folder:', h('div', null, folderInp, folderList)), row('Description:', descInp),
      h('div', { class: 'lib-ed no-enter' }, ed.el)),
    buttons: [
      {
        label: 'Save', primary: true, onClick: async () => {
          const fields = { name: nameInp.value.trim(), folder: normalizeFolder(folderInp.value), description: descInp.value.trim(), sql: ed.value };
          if (!fields.name) { await alertError('Enter a name for the query.'); return false; }
          if (store.queries.some(q => q.id !== query?.id && q.folder === fields.folder && q.name.toLowerCase() === fields.name.toLowerCase())) {
            await alertError(`A query named "${fields.name}" already exists in ${fields.folder ? `folder "${fields.folder}"` : 'the library'}.`);
            return false;
          }
          app.state.lastLibraryFolder = fields.folder;
          return query ? store.updateQuery(query.id, fields) : store.addQuery(fields);
        },
      },
      { label: 'Cancel', value: null },
    ],
  });
  return r || null;
}

export const SNIPPET_HELP = [
  ['$1, ${1:text}', 'tab stops, visited in order; the text is preselected'],
  ['$0', 'where the caret ends up'],
  ['${SELECTION}', 'the selected text (when inserted from the panel)'],
  ['${TABLE:x}, ${DB:x}', 'selected table / database in the tree, else x'],
  ['${DATE}', "today's date (YYYY-MM-DD)"],
];

/** Edits (or creates) a snippet. Resolves to the saved snippet, or null when cancelled. */
export async function editSnippetDialog(app, { snippet = null, body = '' } = {}) {
  const store = app.library;
  const nameInp = h('input', { class: 'inp wide', value: snippet?.name ?? '', spellcheck: false, autofocus: true });
  const trigInp = h('input', { class: 'inp', value: snippet?.trigger ?? '', spellcheck: false, placeholder: 'e.g. sel', style: { width: '140px' } });
  const descInp = h('input', { class: 'inp wide', value: snippet?.description ?? '', placeholder: 'Optional' });
  const ed = new SqlEditor({ value: snippet?.body ?? body });
  const row = (label, el) => h('label', { class: 'frow' }, h('span', null, label), el);
  const help = h('table', { class: 'lib-help' }, SNIPPET_HELP.map(([k, d]) => h('tr', null, h('td', null, h('code', null, k)), h('td', null, d))));
  const r = await modal({
    title: snippet ? 'Edit snippet' : 'New snippet',
    width: 640,
    className: 'lib-dialog',
    body: h('div', { class: 'form2' },
      row('Name:', nameInp),
      row('Trigger:', h('div', { class: 'lib-trig-row' }, trigInp, h('span', { class: 'muted' }, 'Type it in the editor and press Tab'))),
      row('Description:', descInp),
      h('div', { class: 'lib-ed no-enter' }, ed.el), help),
    buttons: [
      {
        label: 'Save', primary: true, onClick: async () => {
          const fields = { name: nameInp.value.trim(), trigger: trigInp.value.trim(), description: descInp.value.trim(), body: ed.value };
          if (!fields.name && !fields.trigger) { await alertError('Enter a name or a trigger for the snippet.'); return false; }
          fields.name ||= fields.trigger;
          if (fields.trigger && !isValidTrigger(fields.trigger)) { await alertError('A trigger is one word of letters, digits, _ or $ (at most 40 characters).'); return false; }
          const clash = fields.trigger && findSnippet(store.snippets.filter(s => s.id !== snippet?.id), fields.trigger);
          if (clash) { await alertError(`The trigger "${fields.trigger}" is already used by snippet "${clash.name}".`); return false; }
          return snippet ? store.updateSnippet(snippet.id, fields) : store.addSnippet(fields);
        },
      },
      { label: 'Cancel', value: null },
    ],
  });
  return r || null;
}

export async function exportLibrary(app) {
  const { queries, snippets } = app.library.lib;
  const name = await saveTextFile('zawsql-library.json', JSON.stringify({ version: LIBRARY_VERSION, queries, snippets }, null, 2), 'JSON files', '.json');
  if (name) app.setStatus(`Exported ${queries.length} queries and ${snippets.length} snippets to ${name}.`);
}

export async function importLibrary(app) {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  let data;
  try {
    data = JSON.parse(await f.text());
  } catch {
    return alertError(`${f.name} is not a JSON file.`);
  }
  if (!data || !Array.isArray(data.queries) || !Array.isArray(data.snippets)) return alertError(`${f.name} is not a ZawSQL library export.`);
  const res = mergeLibrary(app.library.lib, data);
  await app.library.commit();
  alertInfo(`Imported from ${f.name}:\n${res.added} added, ${res.updated} updated, ${res.skipped} already present.`, 'Import library');
}

// ---------------------------------------------------------------- side panel

/** The "Saved queries / Snippets" panel at the right of a query tab. */
export class LibraryPanel {
  constructor(app, view) {
    this.app = app;
    this.view = view;
    this.selId = null;
    this.filter = h('input', { class: 'inp lib-filter', type: 'search', spellcheck: false });
    this.filter.addEventListener('input', () => { this.selId = null; this.render(); });
    this.filter.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.list.focus(); this.move(1); }
      else if (e.key === 'Enter') { e.preventDefault(); this.move(0); this.activate(); }
    });
    this.tabBtns = { queries: h('button', { class: 'subtab' }), snippets: h('button', { class: 'subtab' }) };
    for (const [k, b] of Object.entries(this.tabBtns)) b.addEventListener('click', () => this.setTab(k));
    const menuBtn = h('button', { class: 'tbtn', title: 'Library options', html: icon('settings'), onclick: e => this.optionsMenu(e.currentTarget) });
    const closeBtn = h('button', { class: 'tbtn', title: 'Hide panel', html: icon('close'), onclick: () => app.toggleLibrary(false) });
    this.list = h('div', { class: 'lib-list', tabindex: 0, role: 'listbox' });
    this.list.addEventListener('click', e => this.onClick(e));
    this.list.addEventListener('dblclick', e => { const it = e.target.closest('.lib-item'); if (it) { this.select(it.dataset.id); this.activate(); } });
    this.list.addEventListener('contextmenu', e => this.onContext(e));
    this.list.addEventListener('keydown', e => this.onKey(e));
    this.addBtn = h('button', { class: 'btn lib-add' });
    this.addBtn.addEventListener('click', () => (this.tab === 'queries' ? this.view.saveToLibrary({ asNew: true }) : this.newSnippet()));
    this.el = h('div', { class: 'lib-panel' },
      h('div', { class: 'lib-head' }, h('div', { class: 'subtabs' }, this.tabBtns.queries, this.tabBtns.snippets), h('div', { class: 'grow' }), menuBtn, closeBtn),
      this.filter, this.list, h('div', { class: 'lib-foot' }, this.addBtn));
    this.unsubscribe = app.library.onChange(() => this.render());
  }

  get tab() { return this.app.state.layout?.libraryTab === 'snippets' ? 'snippets' : 'queries'; }

  setTab(k) {
    this.app.state.layout = { ...this.app.state.layout, libraryTab: k };
    this.app.saveStateSoon();
    this.selId = null;
    this.render();
  }

  get collapsed() { return new Set(this.app.state.layout?.libraryCollapsed || []); }

  toggleFolder(folder) {
    const c = this.collapsed;
    if (c.has(folder)) c.delete(folder); else c.add(folder);
    this.app.state.layout = { ...this.app.state.layout, libraryCollapsed: [...c] };
    this.app.saveStateSoon();
    this.render();
  }

  dispose() { this.unsubscribe(); }

  render() {
    const store = this.app.library;
    const tab = this.tab;
    for (const [k, b] of Object.entries(this.tabBtns)) b.classList.toggle('active', k === tab);
    this.tabBtns.queries.textContent = `Saved queries (${store.queries.length})`;
    this.tabBtns.snippets.textContent = `Snippets (${store.snippets.length})`;
    this.filter.placeholder = tab === 'queries' ? 'Filter saved queries' : 'Filter snippets';
    this.addBtn.innerHTML = tab === 'queries' ? icon('bookmark') + '<span>Save current query…</span>' : icon('plus') + '<span>New snippet…</span>';
    const f = this.filter.value;
    let html = '';
    if (tab === 'queries') {
      const groups = groupByFolder(store.queries, f);
      const collapsed = f ? new Set() : this.collapsed;
      for (const g of groups) {
        const closed = collapsed.has(g.folder);
        if (g.folder) {
          html += `<div class="lib-folder${closed ? ' closed' : ''}" data-folder="${esc(g.folder)}"><span class="lib-chev">${closed ? '▸' : '▾'}</span>${icon('folder')}<span class="lib-name">${esc(g.folder)}</span><span class="lib-count">${g.items.length}</span></div>`;
        }
        if (closed) continue;
        for (const q of g.items) {
          const sub = q.description || q.sql.trim().split('\n')[0];
          const linked = this.view.savedId === q.id;
          html += `<div class="lib-item${g.folder ? ' nested' : ''}${q.id === this.selId ? ' sel' : ''}${linked ? ' linked' : ''}" role="option" data-id="${esc(q.id)}" title="${esc(q.sql.slice(0, 800))}">${icon('bookmark')}<div class="lib-text"><div class="lib-name">${esc(q.name)}</div><div class="lib-sub">${esc(sub.slice(0, 200))}</div></div></div>`;
        }
      }
      if (!html) html = `<div class="lib-empty">${f ? 'No saved query matches the filter.' : 'No saved queries yet.<br>Press <kbd>Ctrl+S</kbd> in a query tab to save its SQL here.'}</div>`;
    } else {
      const items = store.snippets.filter(s => matches(s, f))
        .sort((a, b) => (a.trigger || '~' + a.name).localeCompare(b.trigger || '~' + b.name, undefined, { sensitivity: 'base' }));
      for (const s of items) {
        const sub = s.description || expandSnippet(s.body).text.trim().split('\n')[0];
        html += `<div class="lib-item${s.id === this.selId ? ' sel' : ''}" role="option" data-id="${esc(s.id)}" title="${esc(s.body.slice(0, 800))}">${icon('snippet')}<div class="lib-text"><div class="lib-name">${s.trigger ? `<span class="lib-trig">${esc(s.trigger)}</span>` : ''}${esc(s.name)}</div><div class="lib-sub">${esc(sub.slice(0, 200))}</div></div></div>`;
      }
      if (!html) html = `<div class="lib-empty">${f ? 'No snippet matches the filter.' : 'No snippets.'}</div>`;
    }
    this.list.innerHTML = html;
    this.list.querySelector('.lib-item.sel')?.scrollIntoView({ block: 'nearest' });
  }

  selected() {
    return this.tab === 'queries' ? this.app.library.query(this.selId) : this.app.library.snippet(this.selId);
  }

  select(id) {
    this.selId = id;
    for (const el of this.list.querySelectorAll('.lib-item')) el.classList.toggle('sel', el.dataset.id === id);
    this.list.querySelector('.lib-item.sel')?.scrollIntoView({ block: 'nearest' });
  }

  move(d) {
    const ids = [...this.list.querySelectorAll('.lib-item')].map(el => el.dataset.id);
    if (!ids.length) return;
    const i = ids.indexOf(this.selId);
    this.select(ids[i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + d))]);
  }

  onClick(e) {
    const folder = e.target.closest('.lib-folder');
    if (folder) return this.toggleFolder(folder.dataset.folder);
    const it = e.target.closest('.lib-item');
    if (it) this.select(it.dataset.id);
  }

  onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); this.selId = null; this.move(0); }
    else if (e.key === 'End') { e.preventDefault(); this.move(1e9); }
    else if (e.key === 'Enter') { e.preventDefault(); this.activate(); }
    else if (e.key === 'F2') { e.preventDefault(); this.edit(); }
    else if (e.key === 'Delete') { e.preventDefault(); this.remove(); }
  }

  /** Double-click / Enter: open a saved query, insert a snippet. */
  activate() {
    const it = this.selected();
    if (!it) return;
    if (this.tab === 'queries') this.app.openSavedQuery(it);
    else this.view.editor.insertSnippet(it.body);
  }

  onContext(e) {
    e.preventDefault();
    const it = e.target.closest('.lib-item');
    if (it) this.select(it.dataset.id);
    const x = this.selected();
    const items = !it || !x
      ? [this.tab === 'queries'
        ? { label: 'Save current query…', icon: 'bookmark', onClick: () => this.view.saveToLibrary({ asNew: true }) }
        : { label: 'New snippet…', icon: 'plus', onClick: () => this.newSnippet() }]
      : this.tab === 'queries'
        ? [
          { label: 'Open', icon: 'open', onClick: () => this.app.openSavedQuery(x) },
          { label: 'Open in new tab', icon: 'newtab', onClick: () => this.app.openSavedQuery(x, { newTab: true }) },
          { label: 'Open and run', icon: 'play', disabled: !this.app.sel.sid, onClick: () => this.app.openSavedQuery(x, { run: true }) },
          { label: 'Insert at cursor', onClick: () => this.view.editor.insert(x.sql) },
          '-',
          { label: 'Edit…', shortcut: 'F2', onClick: () => this.edit() },
          { label: 'Duplicate', icon: 'copy', onClick: () => this.duplicate() },
          { label: 'Delete', icon: 'trash', shortcut: 'Del', onClick: () => this.remove() },
        ]
        : [
          { label: 'Insert', icon: 'snippet', onClick: () => this.view.editor.insertSnippet(x.body) },
          '-',
          { label: 'Edit…', shortcut: 'F2', onClick: () => this.edit() },
          { label: 'Duplicate', icon: 'copy', onClick: () => this.duplicate() },
          { label: 'Delete', icon: 'trash', shortcut: 'Del', onClick: () => this.remove() },
        ];
    contextMenu(e.clientX, e.clientY, items);
  }

  async edit() {
    const x = this.selected();
    if (!x) return;
    const r = this.tab === 'queries' ? await editQueryDialog(this.app, { query: x }) : await editSnippetDialog(this.app, { snippet: x });
    if (r) this.select(r.id);
  }

  async duplicate() {
    const x = this.selected();
    if (!x) return;
    const store = this.app.library;
    try {
      const copy = this.tab === 'queries'
        ? await store.addQuery({ ...x, name: uniqueName(x.name, store.queries.filter(q => q.folder === x.folder).map(q => q.name)) })
        : await store.addSnippet({ ...x, trigger: '', name: uniqueName(x.name, store.snippets.map(s => s.name)) });
      this.select(copy.id);
    } catch (e) { this.app.showError(e); }
  }

  async remove() {
    const x = this.selected();
    if (!x) return;
    const what = this.tab === 'queries' ? 'saved query' : 'snippet';
    if (!(await confirmDlg(`Delete ${what} "${x.name}"?`, { title: 'Delete', ok: 'Delete', danger: true }))) return;
    try {
      await this.app.library.remove(this.tab === 'queries' ? 'query' : 'snippet', x.id);
      this.selId = null;
      this.render();
      this.list.focus();
    } catch (e) { this.app.showError(e); }
  }

  async newSnippet() {
    const r = await editSnippetDialog(this.app, { body: this.view.editor.selection().text });
    if (r) this.select(r.id);
  }

  optionsMenu(btn) {
    const r = btn.getBoundingClientRect();
    contextMenu(r.left, r.bottom, [
      { label: 'Import library…', icon: 'import', onClick: () => importLibrary(this.app).catch(e => this.app.showError(e)) },
      { label: 'Export library…', icon: 'export', onClick: () => exportLibrary(this.app) },
      '-',
      {
        label: 'Restore default snippets', onClick: async () => {
          const n = restoreDefaultSnippets(this.app.library.lib);
          if (n) await this.app.library.commit().catch(e => this.app.showError(e));
          this.app.setStatus(n ? `Restored ${n} default snippet(s).` : 'All default snippets are present.');
        },
      },
    ]);
  }
}

/** Adds the resizable library panel to a query view's body. */
export function attachLibraryPanel(app, view, body) {
  const panel = new LibraryPanel(app, view);
  const split = h('div', { class: 'splitter-v lib-split' });
  const host = h('div', { class: 'lib-host' }, panel.el);
  host.style.width = (app.state.layout?.libraryWidth || 270) + 'px';
  makeSplitter(split, {
    axis: 'x',
    get: () => -host.offsetWidth,
    set: v => { host.style.width = Math.max(180, Math.min(-v, body.clientWidth - 300)) + 'px'; },
    onEnd: () => { app.state.layout = { ...app.state.layout, libraryWidth: host.offsetWidth }; app.saveStateSoon(); },
  });
  body.append(split, host);
  return { panel, split, host };
}
