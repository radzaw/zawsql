// Host tab › Error log: the server's error log as MySQL 8.0.22+ keeps it in performance_schema.error_log, newest first,
// filtered by priority, period and text. Where it can't be read through SQL (MariaDB, older MySQL, no privilege),
// the panel says why and where the log file is.
import { h, debounce, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { Grid } from '../grid.js';
import { contextMenu } from '../dialogs.js';
import { exportGridDialog } from './tools.js';
import { PRIOS, SINCE, filterLog, countByPrio } from '../serverlogslogic.js';

const COLS = [{ name: 'Time' }, { name: 'Priority' }, { name: 'Code' }, { name: 'Subsystem' }, { name: 'Message' }];
const PRIO_CLASS = { Error: 'log-error', Warning: 'log-warning', System: 'log-system' };

export class ErrorLogView {
  constructor(app) {
    this.app = app;
    this.sid = null;
    this.data = null;
    this.rows = [];
    this.prios = new Set(['System', 'Error', 'Warning']);
    this.prioBoxes = PRIOS.map(p => {
      const box = h('input', { type: 'checkbox', checked: this.prios.has(p), onchange: () => { box.checked ? this.prios.add(p) : this.prios.delete(p); this.render(); } });
      const count = h('span', { class: 'muted' });
      return { p, count, el: h('label', { class: 'chk' }, box, ` ${p} `, count) };
    });
    this.since = h('select', { class: 'inp', onchange: () => this.render() }, SINCE.map(([v, l]) => h('option', { value: v }, l)));
    this.filter = h('input', { class: 'inp filter-inp', placeholder: 'Filter', oninput: debounce(() => this.render(), 120) });
    this.status = h('span', { class: 'muted' });
    this.notice = h('div', { class: 'placeholder' });
    this.notice.style.display = 'none';
    this.grid = new Grid({
      gutter: false,
      emptyText: 'No entries match.',
      onContextMenu: e => this.ctx(e),
    });
    this.el = h('div', { class: 'rp' },
      h('div', { class: 'viewbar small' }, h('b', null, 'Error log'), ...this.prioBoxes.map(b => b.el), this.since,
        h('div', { class: 'grow' }), this.status, this.filter,
        h('button', { class: 'tbtn', title: 'Refresh', html: icon('refresh'), onclick: () => this.load() })),
      this.notice, this.grid.el);
  }

  start(sid) {
    if (sid !== this.sid) {
      this.sid = sid;
      this.data = null;
      this.grid.setData([], []);
    }
    this.load();
  }

  stop() {}

  async load() {
    const sid = this.sid;
    if (!sid) return;
    this.status.textContent = 'Loading…';
    try {
      const r = await get(`/s/${sid}/errorlog`, { limit: 5000 }, { quiet: true });
      if (sid !== this.sid) return;
      this.data = r;
      this.render();
    } catch (e) {
      this.status.textContent = e.message;
      this.app.showError(e);
    }
  }

  render() {
    const r = this.data;
    if (!r) return;
    const where = [r.file && `File: ${r.file}`, r.verbosity && `${r.server === 'mariadb' ? 'log_warnings' : 'log_error_verbosity'} = ${r.verbosity}`].filter(Boolean).join('   ·   ');
    if (!r.available) {
      this.notice.replaceChildren(h('div', null, r.reason), where ? h('div', { class: 'muted', style: { marginTop: '8px' } }, where) : '');
      this.notice.style.display = '';
      this.grid.el.style.display = 'none';
      this.status.textContent = '';
      return;
    }
    this.notice.style.display = 'none';
    this.grid.el.style.display = '';
    const counts = countByPrio(r.rows);
    for (const b of this.prioBoxes) b.count.textContent = `(${fmtNum(counts[b.p] || 0)})`;
    this.rows = filterLog(r.rows, { prios: [...this.prios], since: this.since.value, text: this.filter.value, now: r.now });
    const rows = this.rows.map(x => {
      const row = [x.logged, x.prio, x.code, x.subsystem, x.data];
      if (PRIO_CLASS[x.prio]) row.$cls = PRIO_CLASS[x.prio];
      return row;
    });
    this.grid.setData(COLS, rows, { keepWidths: true });
    this.status.textContent = `${fmtNum(rows.length)} of ${fmtNum(r.rows.length)} entries${r.rows.length >= 5000 ? ' (the newest 5,000)' : ''}`;
    this.status.title = where;
  }

  ctx(e) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => this.grid.copy() },
      { label: 'Export rows…', icon: 'export', disabled: !this.rows.length, onClick: () => exportGridDialog(this.app, { columns: COLS, rows: this.rows.map(x => [x.logged, x.prio, x.code, x.subsystem, x.data]), selected: this.grid.selectedRowIndexes(), name: 'error_log' }) },
      '-',
      { label: 'Refresh', icon: 'refresh', onClick: () => this.load() },
    ]);
  }
}
