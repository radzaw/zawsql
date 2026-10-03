// Host tab › Performance: the queries that cost the most time (statement digests), who is blocking whom
// (row and metadata lock waits, open transactions, the latest deadlock) and the slow query log table.
import { h, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { Grid } from '../grid.js';
import { confirmDlg } from '../dialogs.js';
import { highlightSql } from '../editor.js';
import { formatSql } from '../sqlformat.js';
import {
  SORTS, fmtMs, fmtSeconds, snapshot, sinceSnapshot, derive, sortRows, filterRows, querySql, holderActivity, isIdleHolder, lockSummary,
} from '../insightlogic.js';

const PANELS = [['queries', 'Top queries'], ['locks', 'Locks & transactions'], ['slowlog', 'Slow query log']];
const INTERVALS = [[0, 'No auto refresh'], [2, 'Every 2 s'], [5, 'Every 5 s'], [10, 'Every 10 s'], [30, 'Every 30 s']];

const sel = (pairs, value, onChange, title) => {
  const s = h('select', { class: 'inp', title }, pairs.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  s.addEventListener('change', () => onChange(s.value));
  return s;
};
const tag = (kind, text) => h('span', { class: `ins-tag ${kind}`, html: icon(kind === 'critical' ? 'error' : 'warning') + `<span>${text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span>` });
const pretty = sql => { try { return formatSql(sql); } catch { return sql; } };

export class InsightView {
  constructor(app) {
    this.app = app;
    this.sid = null;
    this.panel = app.state.insight?.panel || 'queries';
    this.interval = app.state.insight?.interval ?? 5;
    this.data = { queries: null, locks: null, slowlog: null };
    this.snap = null;
    this.sort = { key: 'totalMs', dir: 'desc' };
    this.selected = null;

    this.tabs = h('div', { class: 'subtabs' }, PANELS.map(([k, l]) => h('button', { class: 'subtab', 'data-k': k, onclick: () => this.show(k) }, l)));
    this.status = h('span', { class: 'muted ins-status' });
    const toolbar = h('div', { class: 'viewbar small ins-bar' }, this.tabs, h('div', { class: 'grow' }), this.status,
      sel(INTERVALS, this.interval, v => { this.interval = +v; this.remember(); this.schedule(); }, 'Auto refresh'),
      h('button', { class: 'tbtn', title: 'Refresh', html: icon('refresh'), onclick: () => this.load() }));

    this.buildQueries();
    this.locksBox = h('div', { class: 'ins-locks' });
    this.slowBox = h('div', { class: 'ins-slow' });
    this.slowGrid = new Grid({ gutter: false, emptyText: 'No entries.' });
    this.body = h('div', { class: 'ins-body' });
    this.el = h('div', { class: 'ins' }, toolbar, this.body);
  }

  remember() {
    this.app.state.insight = { panel: this.panel, interval: this.interval, hideSystem: this.qHideSys?.checked !== false };
    this.app.saveStateSoon();
  }

  start(sid) {
    if (sid !== this.sid) {
      this.sid = sid;
      this.data = { queries: null, locks: null, slowlog: null };
      this.snap = null;
      this.selected = null;
    }
    this.show(this.panel);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
  }

  show(panel) {
    this.panel = panel;
    this.remember();
    for (const b of this.tabs.children) b.classList.toggle('active', b.dataset.k === panel);
    this.body.replaceChildren(panel === 'queries' ? this.queriesEl : panel === 'locks' ? this.locksBox : this.slowBox);
    this.running = true;
    this.render();
    this.load();
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.running && this.interval > 0) this.timer = setTimeout(() => this.load(true), this.interval * 1000);
  }

  async load(auto = false) {
    clearTimeout(this.timer);
    const sid = this.sid, panel = this.panel;
    if (!sid) return;
    try {
      const path = panel === 'queries' ? 'queries' : panel === 'locks' ? 'locks' : 'slowlog?limit=1000';
      const r = await get(`/s/${sid}/insight/${path}`, null, { quiet: true });
      if (sid !== this.sid || panel !== this.panel) return;
      this.data[panel] = r;
      this.status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      this.status.classList.remove('err');
      this.render();
    } catch (e) {
      this.status.textContent = e.message;
      this.status.classList.add('err');
      if (!auto) this.app.showError(e);
    }
    if (this.running) this.schedule();
  }

  render() {
    if (this.panel === 'queries') this.renderQueries();
    else if (this.panel === 'locks') this.renderLocks();
    else this.renderSlowLog();
  }

  // ---------------------------------------------------------------- top queries

  buildQueries() {
    this.qFilter = h('input', { class: 'inp', type: 'search', placeholder: 'Filter queries', spellcheck: false, oninput: () => this.renderQueries() });
    this.qSchema = sel([['', 'All databases']], '', () => this.renderQueries(), 'Database');
    this.qSort = sel(SORTS, this.sort.key, v => { this.sort = { key: v, dir: 'desc' }; this.renderQueries(); }, 'Sort by');
    this.qHideSys = h('input', { type: 'checkbox', checked: this.app.state.insight?.hideSystem !== false });
    this.qHideSys.addEventListener('change', () => { this.remember(); this.renderQueries(); });
    this.qWindow = h('span', { class: 'muted' });
    this.snapBtn = h('button', { class: 'btn', title: 'Measure from now on: the list then shows only what ran since', onclick: () => this.takeSnapshot() }, 'Start measuring');
    this.resetBtn = h('button', { class: 'btn', title: 'Clear the server-wide statement statistics (TRUNCATE performance_schema.events_statements_summary_by_digest)', onclick: () => this.resetStats() }, 'Reset statistics…');
    this.qNotice = h('div', { class: 'ins-notice' });
    this.qGrid = new Grid({
      gutter: false,
      emptyText: '',
      onSort: c => this.sortByColumn(c),
      onRowChange: (_, r) => this.selectRow(r),
      onActivate: r => this.openRow(this.qRows[r]),
    });
    this.qDetail = h('div', { class: 'ins-detail' });
    this.queriesEl = h('div', { class: 'ins-queries' },
      h('div', { class: 'ins-qbar' }, this.qFilter, this.qSchema, h('label', { class: 'chk' }, 'Sort by ', this.qSort),
        h('label', { class: 'chk', title: 'Statements on information_schema, performance_schema and mysql, SHOW and SET – including the ones ZawSQL runs to browse' }, this.qHideSys, ' Hide system queries'),
        this.qWindow, h('div', { class: 'grow' }), this.snapBtn, this.resetBtn),
      this.qNotice, h('div', { class: 'ins-qgrid' }, this.qGrid.el), this.qDetail);
  }

  takeSnapshot() {
    const r = this.data.queries;
    if (this.snap) { this.snap = null; this.renderQueries(); return; }
    if (!r?.available) return;
    this.snap = snapshot(r.rows);
    this.renderQueries();
    this.load();
  }

  async resetStats() {
    if (!(await confirmDlg(this.app.prodWarn(this.sid) + 'Clear the statement statistics on the server? This affects everyone who reads performance_schema on this server.', { ok: 'Reset', danger: true }))) return;
    try {
      await post(`/s/${this.sid}/insight/reset`);
      this.snap = null;
      this.load();
    } catch (e) { this.app.showError(e); }
  }

  static COLUMNS = [
    ['text', 'Query'], ['schema', 'Database'], ['count', 'Executions'], ['totalMs', 'Total time'], ['avgMs', 'Average'], ['maxMs', 'Slowest'],
    ['examinedPerCall', 'Rows examined / call'], ['sentPerCall', 'Rows returned / call'], ['flags', 'Notes'], ['lastSeen', 'Last seen'],
  ];

  sortByColumn(c) {
    const key = InsightView.COLUMNS[c][0];
    if (['text', 'schema', 'flags', 'lastSeen'].includes(key)) return;
    this.sort = this.sort.key === key ? { key, dir: this.sort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
    if (SORTS.some(([k]) => k === key)) this.qSort.value = key;
    this.renderQueries();
  }

  renderQueries() {
    const r = this.data.queries;
    const ro = this.app.isReadOnly(this.sid);
    this.resetBtn.disabled = ro || !r?.available;
    this.snapBtn.disabled = !r?.available;
    this.snapBtn.textContent = this.snap ? 'Show all-time totals' : 'Start measuring';
    if (!r) { this.qNotice.textContent = 'Loading…'; this.qGrid.setData([], []); return; }
    if (!r.available) {
      this.qNotice.replaceChildren(tag('warning', 'Statement statistics are not available'), h('p', null, r.reason), slowLogHint(r.slowLog));
      this.qGrid.setData([], []);
      this.qDetail.replaceChildren();
      return;
    }
    this.qNotice.replaceChildren();
    const schemas = [...new Set(r.rows.map(x => x.schema).filter(Boolean))].sort();
    const cur = this.qSchema.value;
    this.qSchema.replaceChildren(...[['', 'All databases'], ...schemas.map(s => [s, s])].map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
    this.qWindow.textContent = this.snap ? `since ${new Date(this.snap.at).toLocaleTimeString()}` : r.serverStart ? `since ${r.serverStart} (server start or last reset)` : '';

    const rows = sortRows(filterRows(sinceSnapshot(r.rows, this.snap).map(derive), this.qFilter.value, this.qSchema.value, { hideSystem: this.qHideSys.checked }), this.sort.key, this.sort.dir);
    this.qRows = rows;
    const total = rows.reduce((s, x) => s + x.totalMs, 0);
    const cols = InsightView.COLUMNS.map(([k, name]) => ({
      name, readOnly: true,
      kind: ['count', 'totalMs', 'avgMs', 'maxMs', 'examinedPerCall', 'sentPerCall'].includes(k) ? 'int' : 'text',
      title: k === 'totalMs' ? 'Time spent in all executions; the share of the total shown in brackets' : null,
    }));
    const data = rows.map(x => [
      x.text.replace(/\s+/g, ' '), x.schema ?? '', fmtNum(x.count),
      `${fmtMs(x.totalMs)}${total ? ` (${Math.round((x.totalMs / total) * 100)}%)` : ''}`, fmtMs(x.avgMs), fmtMs(x.maxMs),
      fmtNum(Math.round(x.examinedPerCall)), fmtNum(Math.round(x.sentPerCall)), x.flags.join(' · '), x.lastSeen ?? '',
    ]);
    const keep = this.selected;
    this.qGrid.sort = { c: InsightView.COLUMNS.findIndex(([k]) => k === this.sort.key), dir: this.sort.dir };
    // Auto refresh keeps the scroll position, column widths and the selected query.
    const same = this.qGrid.columns.length === cols.length;
    this.qGrid.setData(cols, data, { keepWidths: same, keepPos: same });
    if (!same && this.qGrid.widths[0] > 520) { this.qGrid.widths[0] = 520; this.qGrid.renderHeader(); this.qGrid.render(); }
    this.qGrid.emptyEl.textContent = this.snap ? 'Nothing ran since you started measuring.' : 'No statements recorded yet.';
    let i = keep ? rows.findIndex(x => `${x.schema}|${x.digest}` === keep) : -1;
    if (i < 0 && rows.length) i = 0; // nothing (or a vanished row) selected: the top query
    if (i >= 0 && this.qGrid.cur.r !== i) this.qGrid.setCur(i, Math.max(0, this.qGrid.cur.c));
    this.selected = i >= 0 ? `${rows[i].schema}|${rows[i].digest}` : null;
    this.renderDetail(i >= 0 ? rows[i] : null);
  }

  selectRow(r) {
    const x = this.qRows?.[r];
    this.selected = x ? `${x.schema}|${x.digest}` : null;
    this.renderDetail(x);
  }

  renderDetail(x) {
    if (!x) { this.qDetail.replaceChildren(h('div', { class: 'muted pad' }, 'Select a query to see its details. Double-click opens it in a query tab.')); return; }
    const stat = (label, value) => h('div', { class: 'ins-stat' }, h('span', { class: 'muted' }, label), h('b', null, value));
    const code = h('pre', { class: 'ins-sql', html: highlightSql(pretty(x.sample || x.text)) });
    this.qDetail.replaceChildren(
      h('div', { class: 'ins-detail-head' },
        h('b', null, x.sample ? 'Example of this query' : 'Query (values replaced by ?)'),
        x.flags.map(f => tag('warning', f)),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn', onclick: () => this.openRow(x) }, 'Open in query tab'),
        h('button', { class: 'btn', disabled: !x.sample, title: x.sample ? 'Visual EXPLAIN of the example, in a query tab' : 'The server keeps no example with real values (MySQL 8.0.3+ does)', onclick: () => this.openRow(x, true) }, 'EXPLAIN'),
        h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(x.sample || x.text) }, 'Copy')),
      h('div', { class: 'ins-detail-body' }, code, h('div', { class: 'ins-stats' },
        stat('Executions', fmtNum(x.count)), stat('Total time', fmtMs(x.totalMs)), stat('Average', fmtMs(x.avgMs)), stat('Slowest', fmtMs(x.maxMs)),
        stat('Lock time', fmtMs(x.lockMs)), stat('Rows examined', fmtNum(x.rowsExamined)), stat('Rows returned', fmtNum(x.rowsSent)),
        stat('Rows changed', fmtNum(x.rowsAffected)), stat('Without index', fmtNum(x.noIndex)), stat('Temp tables (disk)', `${fmtNum(x.tmpTables)} (${fmtNum(x.tmpDisk)})`),
        stat('Errors / warnings', `${fmtNum(x.errors)} / ${fmtNum(x.warnings)}`), stat('First seen', x.firstSeen ?? '–'))));
  }

  async openRow(x, explain = false) {
    if (!x) return;
    const v = this.app.openQueryTab(pretty(querySql(x)), explain ? 'Explain' : 'Top query');
    if (x.schema && x.schema !== this.app.sel.db) await this.app.selectDatabase(this.sid, x.schema, { quiet: true }).catch(() => {});
    if (explain) v.explain({ sql: querySql(x) }); // Visual EXPLAIN of the example
  }

  // ---------------------------------------------------------------- locks

  renderLocks() {
    const r = this.data.locks;
    if (!r) { this.locksBox.replaceChildren(h('div', { class: 'muted pad' }, 'Loading…')); return; }
    const ro = this.app.isReadOnly(this.sid);
    const killBtn = (thread, what) => thread == null ? '' : h('button', {
      class: 'tbtn ins-kill', disabled: ro, title: ro ? 'Not available in read-only mode' : `Kill connection ${thread} (${what}); its transaction is rolled back`,
      onclick: () => this.kill(thread, what),
    }, 'Kill');
    const who = (thread, user, host) => h('div', null, h('b', null, `#${thread ?? '?'}`), ' ', h('span', { class: 'muted' }, [user, host].filter(Boolean).join('@')));
    const query = q => h('div', { class: 'ins-q', title: q ?? '' }, q ?? '');
    const section = (title, count, content, empty) => h('section', { class: 'ins-section' },
      h('h3', null, title, count != null ? h('span', { class: 'ins-count' + (count ? ' on' : '') }, String(count)) : null),
      count === 0 ? h('div', { class: 'muted ins-empty' }, empty) : content);

    const waits = h('table', { class: 'edit-table ins-table' },
      h('thead', null, h('tr', null, ['Waiting', 'For', 'Waiting statement', 'Lock', 'Blocked by', 'Blocker is doing', 'Blocker transaction', ''].map(t => h('th', null, t)))),
      h('tbody', null, r.waits.map(w => h('tr', null,
        h('td', null, who(w.waiting.thread, w.waiting.user, w.waiting.host)),
        h('td', { class: 'num' }, fmtSeconds(w.waiting.seconds)),
        h('td', null, query(w.waiting.query)),
        h('td', null, h('div', null, `${w.waiting.mode ?? ''} on `, h('b', null, [w.db, w.table].filter(Boolean).join('.'))), h('div', { class: 'muted' }, [w.index && `index ${w.index}`, w.lockData && `row ${w.lockData}`].filter(Boolean).join(' · '))),
        h('td', null, who(w.blocking.thread, w.blocking.user, w.blocking.host)),
        h('td', null, w.blocking.query ? query(w.blocking.query) : tag('warning', holderActivity(w.blocking))),
        h('td', null, `open ${fmtSeconds(w.blocking.trxAge)}`, h('div', { class: 'muted' }, `${fmtNum(w.blocking.rowsLocked)} row${w.blocking.rowsLocked === 1 ? '' : 's'} locked, ${fmtNum(w.blocking.rowsModified)} changed`)),
        h('td', null, killBtn(w.blocking.thread, 'the blocking transaction'))))));

    const mdl = h('table', { class: 'edit-table ins-table' },
      h('thead', null, h('tr', null, ['Waiting', 'For', 'Waiting statement', 'Object', 'Held by', 'Holder is doing', ''].map(t => h('th', null, t)))),
      h('tbody', null, r.metadata.map(m => h('tr', null,
        h('td', null, who(m.waiting.thread, m.waiting.user)),
        h('td', { class: 'num' }, fmtSeconds(m.waiting.seconds)),
        h('td', null, query(m.waiting.query)),
        h('td', null, h('b', null, [m.db, m.name].filter(Boolean).join('.') || '?'), h('div', { class: 'muted' }, `${m.objectType ?? ''} · ${m.waiting.mode ?? ''}`)),
        h('td', null, m.blocking ? who(m.blocking.thread, m.blocking.user) : h('span', { class: 'muted', title: 'MariaDB reports the holder only with the metadata_lock_info plugin.' }, 'unknown')),
        h('td', null, m.blocking ? (m.blocking.query ? query(m.blocking.query) : tag('warning', holderActivity(m.blocking))) : ''),
        h('td', null, m.blocking ? killBtn(m.blocking.thread, 'the lock holder') : '')))));

    const trx = h('table', { class: 'edit-table ins-table' },
      h('thead', null, h('tr', null, ['Connection', 'Database', 'Open for', 'State', 'Rows locked', 'Rows changed', 'Running', ''].map(t => h('th', null, t)))),
      h('tbody', null, r.transactions.map(t => h('tr', { class: isIdleHolder(t) ? 'ins-idle' : '' },
        h('td', null, who(t.thread, t.user, t.host)),
        h('td', null, t.db ?? ''),
        h('td', { class: 'num' }, fmtSeconds(t.age)),
        h('td', null, t.state ?? '', h('div', { class: 'muted' }, t.isolation ?? '')),
        h('td', { class: 'num' }, fmtNum(t.rowsLocked)),
        h('td', { class: 'num' }, fmtNum(t.rowsModified)),
        h('td', null, t.query ? query(t.query) : isIdleHolder(t) ? tag('warning', `idle for ${fmtSeconds(t.time)} while holding locks`) : h('span', { class: 'muted' }, holderActivity(t))),
        h('td', null, killBtn(t.thread, 'this transaction'))))));

    const deadlock = r.deadlock
      ? h('details', { class: 'ins-deadlock' }, h('summary', null, 'Show the latest detected deadlock (from SHOW ENGINE INNODB STATUS)'), h('pre', null, r.deadlock))
      : null;

    this.locksBox.replaceChildren(
      h('div', { class: 'ins-summary' }, lockSummary(r)),
      section('Row lock waits', r.waits.length, waits, 'No transaction is waiting for a row lock.'),
      section('Metadata lock waits', r.metadata.length, mdl, 'No statement is waiting for a metadata lock (e.g. ALTER TABLE behind an open transaction).'),
      section('Open transactions', r.transactions.length, trx, 'No open InnoDB transactions.'),
      section('Latest deadlock', null, deadlock ?? h('div', { class: 'muted ins-empty' }, 'No deadlock since the server started.')),
      r.notes.length ? h('div', { class: 'ins-notes' }, r.notes.map(n => h('div', null, n))) : null);
  }

  async kill(thread, what) {
    if (!(await confirmDlg(this.app.prodWarn(this.sid) + `Kill connection ${thread} (${what})? Its transaction is rolled back and the client gets an error.`, { ok: 'Kill', danger: true }))) return;
    try {
      await post(`/s/${this.sid}/kill`, { id: Number(thread) });
      this.load();
    } catch (e) { this.app.showError(e); }
  }

  // ---------------------------------------------------------------- slow log

  renderSlowLog() {
    const r = this.data.slowlog;
    if (!r) { this.slowBox.replaceChildren(h('div', { class: 'muted pad' }, 'Loading…')); return; }
    const s = r.settings;
    const cols = r.log.columns.map(c => ({ name: c.name, kind: c.kind, readOnly: true }));
    this.slowGrid.setData(cols, r.log.rows, { keepWidths: this.slowGrid.columns.length === cols.length });
    this.slowGrid.emptyEl.textContent = s.toTable && s.enabled ? `No queries slower than ${s.longQueryTime} s yet.` : '';
    this.slowBox.replaceChildren(h('div', { class: 'ins-notice' }, slowLogHint(s)), s.toTable ? h('div', { class: 'ins-qgrid' }, this.slowGrid.el) : null);
  }
}

/** The slow log settings, and what to change when it isn't readable here. */
function slowLogHint(s) {
  if (!s) return '';
  const state = `Slow query log ${s.enabled ? 'on' : 'off'} · long_query_time = ${s.longQueryTime} s · log_output = ${s.output}`;
  let hint = '';
  if (!s.enabled) hint = "Turn it on with SET GLOBAL slow_query_log = 1 (and SET GLOBAL log_output = 'FILE,TABLE' to read it here).";
  else if (!s.toTable) hint = "It is written to a file on the server, which ZawSQL can't read. SET GLOBAL log_output = 'FILE,TABLE' also writes it to mysql.slow_log, shown here.";
  return h('div', null, h('div', null, state), hint ? h('div', { class: 'muted' }, hint) : null);
}
