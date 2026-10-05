// SQL log panel at the bottom of the window, like HeidiSQL's: a timestamp (date, time, milliseconds) per line,
// markers on slow statements, actions on a statement (open, explain, copy), a find bar with filters, and export.
import { h, fmtLogTime, saveTextFile } from './util.js';
import { icon } from './icons.js';
import { highlightSql } from './editor.js';
import { contextMenu } from './dialogs.js';
import { SLOW_CHOICES, fmtDuration, slowLevel, thresholdLabel, nextSlow } from './logslow.js';
import { isStatement, useDb, explainable, filterEntries, isFiltering, exportSql, exportFileName } from './loglogic.js';

const MAX_LINES = 3000;
const MAX_KEPT = 1_000_000; // characters of a statement kept for its actions; the display is cut at 3000

export class LogPanel {
  /**
   * opts.timestamps / setTimestamps(on): whether timestamps are shown.
   * opts.slowMs / setSlowMs(ms): slow statement threshold (0 = no markers).
   * opts.sessionName(sid): label of a session, or null once it is gone.
   * opts.openInTab(sql): opens a statement in a new query tab.
   * opts.explain(sql, sid, db): EXPLAIN a statement on the session it ran on; opts.canExplain(sid) says whether it can.
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.o = {
      timestamps: () => true, setTimestamps: () => {}, slowMs: () => 0, setSlowMs: () => {},
      sessionName: () => null, openInTab: () => {}, explain: () => {}, canExplain: () => false, ...opts,
    };
    this.count = 0;
    this.cursor = -1; // line "Next slow statement" stopped at
    this.dbOf = new Map(); // sid -> database of its last USE
    this.sids = new Set(); // sessions seen in the log
    this.filter = { text: '', errors: false, slow: false, sid: '' };
    el.classList.add('logpanel');
    el.tabIndex = 0;
    this.buildFindBar();
    this.syncTimestamps();
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, this.menu(e.target.closest?.('.log-line')));
    });
    el.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); this.save(); }
      else if (e.key === 'Escape' && this.bar.style.display !== 'none') this.closeFind();
    });
  }

  // ---------- context menu and line actions ----------

  menu(line) {
    const entry = line?.$e;
    const items = [];
    if (entry && isStatement(entry.text)) {
      const canExplain = explainable(entry.text) && entry.sid != null && this.o.canExplain(entry.sid);
      items.push(
        { label: 'Open in new query tab', icon: 'newtab', onClick: () => this.o.openInTab(entry.text) },
        { label: 'Explain', icon: 'explain', disabled: !canExplain, onClick: () => this.o.explain(entry.text, entry.sid, entry.db),
          title: canExplain ? `EXPLAIN on ${this.o.sessionName(entry.sid)}${entry.db ? ' › ' + entry.db : ''}`
            : !explainable(entry.text) ? 'Only SELECT, UPDATE, DELETE, INSERT, REPLACE, WITH and TABLE statements can be explained.'
              : 'The session it ran on is no longer connected.' },
        { label: 'Copy statement', icon: 'copy', onClick: () => navigator.clipboard.writeText(entry.text) },
      );
      if (entry.sid != null && this.o.sessionName(entry.sid)) {
        items.push({ label: `Show only "${this.o.sessionName(entry.sid)}"`, icon: 'filter', onClick: () => { this.openFind(); this.setFilter({ sid: entry.sid }); } });
      }
      items.push('-');
    }
    const filtering = isFiltering(this.filter);
    const cur = this.o.slowMs();
    items.push(
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => navigator.clipboard.writeText(getSelection().toString() || this.text({ visibleOnly: true })) },
      { label: filtering ? 'Copy shown lines' : 'Copy all', onClick: () => navigator.clipboard.writeText(this.text({ visibleOnly: true })) },
      { label: 'Find…', icon: 'filter', shortcut: 'Ctrl+F', onClick: () => this.openFind() },
      { label: filtering ? 'Save shown lines…' : 'Save log…', icon: 'save', shortcut: 'Ctrl+S', disabled: !this.count, onClick: () => this.save() },
      '-',
      { label: 'Show timestamps', checked: this.o.timestamps(), onClick: () => { this.o.setTimestamps(!this.o.timestamps()); this.syncTimestamps(); } },
      { label: 'Mark slow statements', submenu: SLOW_CHOICES.map(ms => ({ label: thresholdLabel(ms), checked: ms === cur, onClick: () => this.setThreshold(ms) })) },
      { label: 'Next slow statement', disabled: !this.slowCount(), onClick: () => this.nextSlow() },
      { label: 'Clear', icon: 'trash', onClick: () => this.clear() },
    );
    return items;
  }

  // ---------- find bar ----------

  buildFindBar() {
    this.q = h('input', { class: 'inp log-q', type: 'search', placeholder: 'Find in log', spellcheck: false, 'aria-label': 'Find in log' });
    this.q.addEventListener('input', () => this.setFilter({ text: this.q.value }));
    const toggle = (label, key, title) => {
      const b = h('button', { class: 'log-tg', title, 'aria-pressed': 'false' }, label);
      b.addEventListener('click', () => this.setFilter({ [key]: !this.filter[key] }));
      return b;
    };
    this.errBtn = toggle('Errors', 'errors', 'Only errors, with the statements that caused them');
    this.slowBtn = toggle('Slow', 'slow', 'Only statements marked as slow');
    this.sesSel = h('select', { class: 'inp log-ses', title: 'Only the lines of one session' });
    this.sesSel.addEventListener('change', () => this.setFilter({ sid: this.sesSel.value }));
    this.countEl = h('span', { class: 'log-count muted' });
    const saveBtn = h('button', { class: 'log-tg icon', title: 'Save the shown lines as a .sql file (Ctrl+S)', html: icon('save') });
    saveBtn.addEventListener('click', () => this.save());
    const closeBtn = h('button', { class: 'log-tg icon', title: 'Close (Esc) – shows all lines again', html: icon('close') });
    closeBtn.addEventListener('click', () => this.closeFind());
    this.bar = h('div', { class: 'log-find', role: 'search' }, this.q, this.errBtn, this.slowBtn, this.sesSel, this.countEl, saveBtn, closeBtn);
    this.bar.style.display = 'none';
    this.bar.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); this.el.focus(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); this.save(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.q.select(); }
    });
    // The bar floats over the top right of the log, so opening it doesn't change the layout.
    const wrap = h('div', { class: 'log-wrap' });
    this.el.replaceWith(wrap);
    wrap.append(this.el, this.bar);
  }

  openFind() {
    this.fillSessions();
    this.bar.style.display = '';
    this.q.focus();
    this.q.select();
  }

  closeFind() {
    this.bar.style.display = 'none';
    this.q.value = '';
    this.setFilter({ text: '', errors: false, slow: false, sid: '' });
  }

  fillSessions() {
    const cur = this.filter.sid;
    const opts = [h('option', { value: '' }, 'All sessions')];
    for (const sid of this.sids) {
      opts.push(h('option', { value: sid, selected: sid === cur }, this.o.sessionName(sid) || 'Disconnected session'));
    }
    this.sesSel.replaceChildren(...opts);
    this.sesSel.value = cur;
    this.sesSel.style.display = this.sids.size > 1 || cur ? '' : 'none';
  }

  setFilter(change) {
    Object.assign(this.filter, change);
    if ('text' in change && this.q.value !== change.text) this.q.value = change.text;
    if ('sid' in change) this.fillSessions();
    this.errBtn.classList.toggle('on', this.filter.errors);
    this.errBtn.setAttribute('aria-pressed', String(this.filter.errors));
    this.slowBtn.classList.toggle('on', this.filter.slow);
    this.slowBtn.setAttribute('aria-pressed', String(this.filter.slow));
    this.applyFilter();
  }

  applyFilter() {
    const lines = [...this.el.children];
    const filtering = isFiltering(this.filter);
    if (!filtering) {
      for (const l of lines) l.classList.remove('log-hidden');
      this.countEl.textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
      return;
    }
    const show = filterEntries(lines.map(l => ({ ...l.$e, slow: l.classList.contains('log-slow') })), this.filter);
    let n = 0;
    lines.forEach((l, i) => { l.classList.toggle('log-hidden', !show[i]); if (show[i]) n++; });
    this.countEl.textContent = `${n} of ${lines.length} line${lines.length === 1 ? '' : 's'}`;
  }

  // ---------- export ----------

  visibleLines() {
    return [...this.el.children].filter(l => !l.classList.contains('log-hidden'));
  }

  async save() {
    const lines = this.visibleLines();
    if (!lines.length) return;
    const text = exportSql(lines.map(l => l.$e), { timestamps: this.o.timestamps(), sessionName: sid => this.o.sessionName(sid) });
    await saveTextFile(exportFileName(), text, 'SQL files', '.sql');
  }

  // ---------- timestamps and slow markers ----------

  syncTimestamps() {
    this.el.classList.toggle('no-ts', !this.o.timestamps());
  }

  setThreshold(ms) {
    this.o.setSlowMs(ms);
    this.markAll();
  }

  /** Marks (or unmarks) every line against the current threshold. */
  markAll() {
    for (const line of this.el.children) this.mark(line);
    if (isFiltering(this.filter)) this.applyFilter();
  }

  mark(line) {
    const ms = line.$e?.ms ?? null;
    const level = slowLevel(ms, this.o.slowMs());
    line.classList.toggle('log-slow', !!level);
    line.classList.toggle('log-very-slow', level === 'very');
    line.querySelector('.log-dur')?.remove();
    if (level) line.append(h('span', { class: 'log-dur' }, fmtDuration(ms)));
  }

  slowCount() {
    return this.el.querySelectorAll('.log-slow:not(.log-hidden)').length;
  }

  /** Scrolls to the next slow statement after the last one shown (or the top of the view) and highlights it. */
  nextSlow() {
    const lines = [...this.el.children];
    if (this.cursor < 0 || this.cursor >= lines.length || !lines[this.cursor].classList.contains('log-hit')) {
      // Start from the first line in view.
      const top = this.el.scrollTop;
      this.cursor = Math.max(-1, lines.findIndex(l => l.offsetTop + l.offsetHeight > top) - 1);
    }
    const i = nextSlow(lines.map(l => l.classList.contains('log-slow') && !l.classList.contains('log-hidden')), this.cursor);
    if (i < 0) return;
    for (const l of this.el.querySelectorAll('.log-hit')) l.classList.remove('log-hit');
    this.cursor = i;
    lines[i].classList.add('log-hit');
    lines[i].scrollIntoView({ block: 'nearest' });
  }

  // ---------- content ----------

  /** The log as text; timestamps are included when they are shown, and slow statements say how long they took. */
  text({ visibleOnly = false } = {}) {
    const ts = this.o.timestamps();
    return (visibleOnly ? this.visibleLines() : [...this.el.children]).map(c => {
      const t = c.querySelector('.log-ts')?.textContent;
      let body = c.querySelector('.log-text')?.textContent ?? c.textContent;
      const dur = c.querySelector('.log-dur')?.textContent;
      if (dur) body += ` /* took ${dur} */`;
      return ts && t ? `${t} ${body}` : body;
    }).join('\n');
  }

  clear() {
    this.el.innerHTML = '';
    this.count = 0;
    this.cursor = -1;
    this.sids.clear();
    this.applyFilter();
  }

  /**
   * times: when each line was logged (Unix ms, from the server); lines without one get the current time.
   * durations: how long each statement took (ms), null for comments and unmeasured lines.
   * meta.sid: the session the lines belong to, for the line actions and the session filter.
   */
  add(lines, cls = '', times = null, durations = null, meta = {}) {
    const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 6;
    const frag = document.createDocumentFragment();
    const now = Date.now();
    const sid = meta.sid ?? null;
    if (sid != null && !this.sids.has(sid)) { this.sids.add(sid); if (this.bar.style.display !== 'none') this.fillSessions(); }
    lines.forEach((full, i) => {
      const db = useDb(full);
      if (db != null && sid != null) this.dbOf.set(sid, db);
      const line = full.length > 3000 ? full.slice(0, 3000) + ' …' : full;
      const err = /^\/\* (SQL )?Error/.test(line) || cls.includes('err');
      const ms = durations?.[i] ?? null;
      const time = times?.[i] ?? now;
      const el = h('div', { class: 'log-line' + (err ? ' err' : '') + (cls ? ' ' + cls : ''), title: ms != null ? `Took ${fmtDuration(ms)}` : null },
        h('span', { class: 'log-ts' }, fmtLogTime(time)),
        h('span', { class: 'log-text', html: highlightSql(line) }));
      el.$e = { text: full.length > MAX_KEPT ? full.slice(0, MAX_KEPT) : full, time, ms, sid, db: sid != null ? this.dbOf.get(sid) ?? null : null, err };
      if (ms != null) this.mark(el);
      frag.append(el);
      this.count++;
    });
    this.el.append(frag);
    while (this.count > MAX_LINES) {
      this.el.firstChild.remove();
      this.count--;
      this.cursor--;
    }
    if (isFiltering(this.filter) || this.bar.style.display !== 'none') this.applyFilter();
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  info(msg) { this.add([`/* ${msg} */`]); }
  error(msg) { this.add([`/* Error: ${msg} */`], 'err'); }
}
