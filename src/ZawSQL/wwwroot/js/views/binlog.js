// Host tab › Binary log: the server's binary log files and each replica channel's relay log, browsed a page of events
// at a time (SHOW BINLOG EVENTS / SHOW RELAYLOG EVENTS). Events are grouped into transactions by their GTID, row events
// show their table, and the Replication view opens the relay log here at the transaction a replica stopped on.
import { h, debounce, fmtNum, fmtBytes } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { Grid } from '../grid.js';
import { contextMenu } from '../dialogs.js';
import { exportGridDialog } from './tools.js';
import { annotateEvents, filterEvents, eventIndexAt, nextFile, prevFile } from '../binloglogic.js';

const COLS = [{ name: 'Position' }, { name: 'Event' }, { name: 'Server id' }, { name: 'End position' }, { name: 'Transaction' }, { name: 'Table' }, { name: 'Info' }];
const LIMITS = [100, 500, 1000, 5000];
const toRow = e => [e.pos, e.type, e.serverId, e.endPos, e.gtid, e.table, e.info];

export class BinlogView {
  constructor(app) {
    this.app = app;
    this.sid = null;
    this.meta = null;
    this.page = null;
    this.history = [];
    this.target = null;
    this.limit = app.state.binlog?.limit ?? 500;
    this.source = h('select', { class: 'inp', title: 'Which log', onchange: () => { this.target = null; this.fillFiles(); this.open(this.fileSel.value, 0); } });
    this.fileSel = h('select', { class: 'inp bl-file', title: 'Log file', onchange: () => { this.target = null; this.open(this.fileSel.value, 0); } });
    this.posInp = h('input', { class: 'inp bl-pos', placeholder: 'Position', inputmode: 'numeric', title: 'Show events from this position (an event\'s start position; Enter)' });
    this.posInp.addEventListener('keydown', e => { if (e.key === 'Enter') this.goToPosition(); });
    const limitSel = h('select', { class: 'inp', title: 'Events per page' }, LIMITS.map(n => h('option', { value: n, selected: n === this.limit }, `${fmtNum(n)} per page`)));
    limitSel.addEventListener('change', () => {
      this.limit = +limitSel.value;
      this.app.state.binlog = { limit: this.limit };
      this.app.saveStateSoon();
      if (this.page) this.open(this.page.file, this.page.from);
    });
    const tb = (ic, title, onclick) => h('button', { class: 'tbtn', title, html: icon(ic), onclick });
    this.prevBtn = tb('up', 'Previous page', () => this.prevPage());
    this.nextBtn = tb('down', 'Next page', () => this.nextPage());
    this.changesOnly = h('input', { type: 'checkbox', onchange: () => this.render() });
    this.filter = h('input', { class: 'inp filter-inp', placeholder: 'Filter', oninput: debounce(() => this.render(), 120) });
    this.status = h('span', { class: 'muted' });
    this.hint = h('div', { class: 'muted bl-hint' });
    this.notice = h('div', { class: 'placeholder' });
    this.notice.style.display = 'none';
    this.grid = new Grid({ gutter: false, emptyText: 'No events.', onContextMenu: (e, p) => this.ctx(e, p) });
    this.el = h('div', { class: 'rp' },
      h('div', { class: 'viewbar small' }, h('b', null, 'Binary log'), this.source, this.fileSel, this.posInp, limitSel, this.prevBtn, this.nextBtn,
        h('label', { class: 'chk', title: 'Hide the log\'s own events (format description, rotate, previous GTIDs …)' }, this.changesOnly, ' Changes only'),
        h('div', { class: 'grow' }), this.status, this.filter,
        tb('refresh', 'Refresh', () => this.load())),
      this.hint, this.notice, this.grid.el);
  }

  start(sid) {
    if (sid !== this.sid) {
      this.sid = sid;
      this.meta = null;
      this.page = null;
      this.history = [];
      this.grid.setData([], []);
    }
    if (!this.meta || this.jump) this.load();
  }

  stop() {}

  /**
   * Opens a log at a position, from elsewhere (the Replication view):
   * { log: 'binary' | 'relay', channel, file, from, gtid } – the events of `gtid` (or from `from`) are highlighted.
   */
  show(target) {
    this.target = target;
    this.jump = true;
  }

  get isRelay() { return this.source.value.startsWith('relay:'); }
  get channel() { return this.isRelay ? this.source.value.slice(6) : null; }

  /** Reloads the file list, then the page shown (or the target, or the newest binary log). */
  async load() {
    const sid = this.sid;
    if (!sid) return;
    this.status.textContent = 'Loading…';
    let m;
    try {
      m = await get(`/s/${sid}/binlog/files`, null, { quiet: true });
    } catch (e) {
      this.status.textContent = e.message;
      return this.app.showError(e);
    }
    if (sid !== this.sid) return;
    this.meta = m;
    const prev = this.source.value;
    this.source.replaceChildren(
      ...(m.logBin ? [h('option', { value: 'binary' }, 'Binary log')] : []),
      ...m.relay.map(r => h('option', { value: 'relay:' + r.channel }, `Relay log${r.channel ? ` “${r.channel}”` : ''}`)));
    const t = this.jump ? this.target : null;
    this.jump = false;
    const want = t ? (t.log === 'relay' ? 'relay:' + (t.channel ?? '') : 'binary') : prev;
    if ([...this.source.options].some(o => o.value === want)) this.source.value = want;
    this.hint.textContent = m.format === 'ROW' || m.format === 'MIXED'
      ? `binlog_format is ${m.format}: row events name the table but not the changed values (mysqlbinlog -v decodes them).`
      : '';
    this.hint.style.display = this.hint.textContent ? '' : 'none';
    if (!this.source.options.length) {
      this.notice.textContent = m.reason || 'This server has no binary log and no relay log.';
      this.notice.style.display = '';
      this.grid.el.style.display = 'none';
      this.status.textContent = '';
      return;
    }
    this.notice.style.display = 'none';
    this.grid.el.style.display = '';
    this.fillFiles();
    if (t) return this.open(t.file || this.fileSel.value, t.from ?? 0);
    // Same file and page as before when it still exists; else the newest binary log / the channel's relay log.
    const keep = this.page && [...this.fileSel.options].some(o => o.value === this.page.file) && this.page.source === this.source.value;
    return this.open(keep ? this.page.file : this.fileSel.value, keep ? this.page.from : 0);
  }

  fillFiles() {
    const m = this.meta;
    if (this.isRelay) {
      const r = m.relay.find(x => x.channel === this.channel);
      const files = [r?.file, this.target?.log === 'relay' ? this.target.file : null].filter((f, i, a) => f && a.indexOf(f) === i);
      this.fileSel.replaceChildren(...files.map(f => h('option', { value: f }, f === r?.file ? `${f} (applying at ${fmtNum(r.position)})` : f)));
      this.fileSel.title = r?.sourceFile ? `Applied up to ${r.sourceFile} : ${fmtNum(r.sourcePosition)} on the source` : 'Relay log file';
    } else {
      this.fileSel.replaceChildren(...m.files.map(f => h('option', { value: f.name }, `${f.name}${f.size != null ? ` · ${fmtBytes(f.size)}` : ''}${f.encrypted ? ' · encrypted' : ''}`)));
      if (m.files.length) this.fileSel.value = m.files[m.files.length - 1].name;
      this.fileSel.title = m.current ? `Writing to ${m.current.file} at ${fmtNum(m.current.position)}` : 'Binary log file';
    }
  }

  /** Loads a page of events of `file` starting at `from`; `back` is set by Previous page (no history push). */
  async open(file, from, { back = false } = {}) {
    const sid = this.sid, source = this.source.value;
    if (!sid || !file) return;
    this.status.textContent = 'Loading…';
    let r;
    try {
      r = await get(`/s/${sid}/binlog/events`, { log: this.isRelay ? 'relay' : 'binary', channel: this.channel, file, from, limit: this.limit }, { quiet: true });
    } catch (e) {
      this.status.textContent = e.message;
      return this.app.showError(e);
    }
    if (sid !== this.sid || source !== this.source.value) return;
    if (!back && this.page && this.page.file === file && this.page.from !== from) this.history.push(this.page.from);
    if (this.page?.file !== file || source !== this.page?.source) this.history = [];
    this.page = { source, file, from, next: r.next, events: annotateEvents(r.events) };
    if ([...this.fileSel.options].some(o => o.value === file)) this.fileSel.value = file;
    this.posInp.value = '';
    this.render();
    this.reveal();
  }

  render() {
    const p = this.page;
    if (!p) return;
    const t = this.target;
    const rows = filterEvents(p.events, { text: this.filter.value, changesOnly: this.changesOnly.checked });
    this.rows = rows;
    this.grid.setData(COLS, rows.map(e => {
      const row = toRow(e);
      const target = t && (t.gtid ? e.gtid === t.gtid : t.from != null && e.pos === t.from);
      row.$cls = [`bl-${e.kind}`, e.tx != null && e.tx % 2 ? 'bl-odd' : '', target ? 'bl-target' : ''].filter(Boolean).join(' ');
      return row;
    }), { keepWidths: true });
    const first = p.events[0]?.pos, last = p.events.at(-1)?.pos;
    const files = this.isRelay ? [] : this.meta.files;
    const more = p.next != null ? 'more follow' : nextFile(files, p.file) ? `end of file; next file ${nextFile(files, p.file)}` : 'end of the log';
    this.status.textContent = p.events.length
      ? `${fmtNum(rows.length)}${rows.length !== p.events.length ? ` of ${fmtNum(p.events.length)}` : ''} events · positions ${fmtNum(first)}–${fmtNum(last)} · ${more}`
      : 'No events from this position.';
    this.prevBtn.disabled = !(this.history.length || p.from > 4 || prevFile(files, p.file));
    this.nextBtn.disabled = p.next == null && !nextFile(files, p.file);
    this.prevBtn.title = this.history.length || p.from > 4 ? 'Previous page' : 'Previous file';
    this.nextBtn.title = p.next != null ? 'Next page' : 'Next file';
  }

  /** Scrolls to the highlighted transaction (or position) of a jump. */
  reveal() {
    const t = this.target;
    if (!t || !this.rows?.length) return;
    let i = t.gtid ? this.rows.findIndex(e => e.gtid === t.gtid) : -1;
    if (i < 0) i = eventIndexAt(this.rows, t.from);
    if (i >= 0) requestAnimationFrame(() => this.grid.setCur(i, 0));
  }

  nextPage() {
    const p = this.page;
    if (!p) return;
    if (p.next != null) return this.open(p.file, p.next);
    const f = !this.isRelay && nextFile(this.meta.files, p.file);
    if (f) this.open(f, 0);
  }

  prevPage() {
    const p = this.page;
    if (!p) return;
    if (this.history.length) return this.open(p.file, this.history.pop(), { back: true });
    if (p.from > 4) return this.open(p.file, 0, { back: true });
    const f = !this.isRelay && prevFile(this.meta.files, p.file);
    if (f) this.open(f, 0);
  }

  goToPosition() {
    const v = this.posInp.value.replace(/[\s,_]/g, '');
    if (!/^\d+$/.test(v) || !this.page) return;
    this.target = { log: this.isRelay ? 'relay' : 'binary', channel: this.channel, file: this.page.file, from: +v };
    this.open(this.page.file, +v);
  }

  ctx(e, p) {
    const ev = this.rows?.[p?.r];
    contextMenu(e.clientX, e.clientY, [
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => this.grid.copy() },
      { label: 'Copy info', disabled: !ev?.info, onClick: () => navigator.clipboard.writeText(ev.info) },
      { label: 'Copy GTID', disabled: !ev?.gtid, onClick: () => navigator.clipboard.writeText(ev.gtid) },
      { label: 'Open statement in query tab', icon: 'query', disabled: !(ev?.type === 'Query' && ev.info && !/^\s*(BEGIN|COMMIT)\b/i.test(ev.info)), onClick: () => this.app.openQueryTab(ev.info + ';') },
      '-',
      { label: 'Show events from here', icon: 'next', disabled: !ev, onClick: () => { this.target = null; this.open(this.page.file, ev.pos); } },
      { label: 'Highlight this transaction', disabled: !ev?.gtid, onClick: () => { this.target = { gtid: ev.gtid }; this.render(); } },
      { label: 'Export rows…', icon: 'export', disabled: !this.rows?.length, onClick: () => exportGridDialog(this.app, { columns: COLS, rows: this.rows.map(toRow), selected: this.grid.selectedRowIndexes(), name: 'binlog_events' }) },
      '-',
      { label: 'Refresh', icon: 'refresh', onClick: () => this.load() },
    ]);
  }
}
