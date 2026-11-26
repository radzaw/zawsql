// Host tab › Fragmentation: tables with free (allocated but unused) space from information_schema.TABLES, filtered
// by how much and what share of the table it is. "Refresh statistics" bypasses MySQL 8's statistics cache; "Optimize
// all" runs OPTIMIZE TABLE on every listed table one at a time (through /maintenance), with progress and Stop, and
// then reads the figures again.
import { h, debounce, fmtBytes, fmtNum, qi } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { Grid, sortRows } from '../grid.js';
import { confirmDlg, contextMenu } from '../dialogs.js';
import { exportGridDialog } from './tools.js';
import { MIN_FREE, MIN_PCT, DEFAULT_MIN_FREE, DEFAULT_MIN_PCT, fragmented, fragSummary, fragSchemas, fragKey as key, optimizeOutcome, expiryText } from '../fraglogic.js';

const fmtPct = v => (v == null ? '' : `${Number(v).toFixed(1)} %`);
const COLS = [
  { name: 'Database' },
  { name: 'Table' },
  { name: 'Engine' },
  { name: 'Rows', kind: 'int', fmt: fmtNum, title: 'Estimated row count' },
  { name: 'Data', kind: 'int', fmt: fmtBytes },
  { name: 'Index', kind: 'int', fmt: fmtBytes },
  { name: 'Free', kind: 'int', fmt: fmtBytes, title: 'Allocated but unused space (DATA_FREE)' },
  { name: 'Fragmentation', kind: 'real', fmt: fmtPct, title: 'Free space as a share of data + indexes + free' },
  { name: 'Result', width: 380 },
];
const select = (options, value, onchange, title) =>
  h('select', { class: 'inp', title, onchange }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

export class FragmentationView {
  constructor(app) {
    this.app = app;
    this.sid = null;
    this.data = null;
    this.rows = [];
    this.sort = null;
    this.results = new Map(); // table key → { ok, text } of the last optimize run
    this.running = false;
    this.stopRequested = false;

    const redraw = () => this.render();
    this.minFree = select(MIN_FREE, DEFAULT_MIN_FREE, redraw, 'Only tables with at least this much free space');
    this.minPct = select(MIN_PCT, DEFAULT_MIN_PCT, redraw, 'Only tables where the free space is at least this share of the table');
    this.schema = h('select', { class: 'inp', title: 'Database', onchange: redraw });
    this.filter = h('input', { class: 'inp filter-inp', placeholder: 'Filter', spellcheck: false, oninput: debounce(redraw, 120) });
    this.local = h('input', { type: 'checkbox' });
    this.caption = h('span', { class: 'muted' });
    this.freshBtn = h('button', { class: 'btn', title: 'Read the current figures from the storage engine instead of the statistics cache (can take a while with many tables)', onclick: () => this.load(true) },
      h('span', { html: icon('refresh') }), ' Refresh statistics');
    this.optBtn = h('button', { class: 'btn primary', onclick: () => this.optimize(this.rows) }, 'Optimize all');
    this.stopBtn = h('button', { class: 'btn', disabled: true, onclick: () => { this.stopRequested = true; this.status.textContent += ' – stopping after this table…'; } }, 'Stop');
    this.status = h('span', { class: 'fr-status' });
    this.bar = h('div', { class: 'progress-bar' });
    this.progress = h('div', { class: 'progress fr-progress' }, this.bar);
    this.progress.style.display = 'none';
    this.tiles = h('div', { class: 'mon-tiles fr-tiles' });
    this.notice = h('div', { class: 'fr-notice' });
    this.grid = new Grid({
      gutter: false,
      emptyText: 'Loading…',
      onSort: c => this.toggleSort(c),
      onContextMenu: e => this.ctx(e),
    });
    this.el = h('div', { class: 'rp fr' },
      h('div', { class: 'viewbar small' }, h('b', null, 'Fragmentation'), this.caption, h('div', { class: 'grow' }),
        this.schema, this.minFree, this.minPct, this.filter, this.freshBtn,
        h('button', { class: 'tbtn', title: 'Reload (statistics may come from the cache)', html: icon('refresh'), onclick: () => this.load(false) })),
      h('div', { class: 'fr-top' }, this.tiles, this.notice),
      this.grid.el,
      h('div', { class: 'fr-foot' }, this.status, this.progress, h('div', { class: 'grow' }),
        h('label', { class: 'chk', title: "OPTIMIZE LOCAL TABLE (NO_WRITE_TO_BINLOG): don't write the statements to the binary log, so replicas don't rebuild their copies" }, this.local, ' Don\'t replicate (LOCAL)'),
        this.optBtn, this.stopBtn));
  }

  start(sid) {
    if (sid === this.sid && (this.data || this.loading)) return;
    this.sid = sid;
    this.data = null;
    this.results.clear();
    this.load(false);
  }

  /** A run goes on while the panel is hidden (Stop ends it); switching to another session ends it after the current table. */
  stop() {}

  async load(fresh) {
    const sid = this.sid;
    if (!sid || this.loading) return;
    this.loading = true;
    this.update();
    this.status.textContent = fresh ? 'Reading current statistics from the storage engine…' : 'Loading…';
    try {
      const r = await get(`/s/${sid}/fragmentation`, fresh ? { fresh: true } : null, { quiet: true });
      if (sid !== this.sid) return;
      this.data = r;
      this.data.loadedAt = new Date();
      this.status.textContent = `Read ${fmtNum(r.tables.length)} table(s) in ${fmtNum(r.ms)} ms`;
      this.render();
    } catch (e) {
      if (sid !== this.sid) return;
      this.status.textContent = e.message;
      this.app.showError(e);
    } finally {
      if (sid === this.sid) this.loading = false;
      this.update();
    }
  }

  render() {
    const r = this.data;
    if (!r) return;
    const schemas = fragSchemas(r.tables);
    const cur = this.schema.value;
    this.schema.replaceChildren(h('option', { value: '' }, 'All databases'), ...schemas.map(s => h('option', { value: s, selected: s === cur }, s)));
    this.rows = fragmented(r.tables, { minFree: +this.minFree.value, minPct: +this.minPct.value, schema: this.schema.value, text: this.filter.value, filePerTable: r.filePerTable, keep: this.results });
    const sum = fragSummary(this.rows);

    const time = r.loadedAt.toLocaleTimeString();
    this.caption.textContent = r.fresh
      ? `current figures, read ${time}`
      : `from the statistics cache (up to ${expiryText(r.statsExpiry)} old, information_schema_stats_expiry), read ${time}`;
    this.caption.title = r.fresh ? '' : 'MySQL caches table statistics. Refresh statistics reads the current figures.';

    const tile = (label, value, sub) => h('div', { class: 'mon-tile' }, h('div', { class: 'mon-tile-label' }, label), h('div', { class: 'mon-tile-value' }, value), sub ? h('div', { class: 'mon-tile-sub' }, sub) : '');
    this.tiles.replaceChildren(
      tile('Fragmented tables', fmtNum(sum.tables), `of ${fmtNum(r.tables.length)} tables`),
      tile('Free space', fmtBytes(sum.freeBytes) || '0 B', 'in the listed tables'),
      tile('Reclaimable', fmtBytes(sum.reclaimBytes) || '0 B', `${fmtNum(sum.optimizable)} table(s) can be optimized`),
      tile('To rebuild', fmtBytes(sum.sizeBytes) || '0 B', 'data + indexes copied by OPTIMIZE'));

    const notes = [];
    if (r.filePerTable === false) notes.push('innodb_file_per_table is off: InnoDB tables in the shared system tablespace report its free space, and optimizing them doesn\'t give it back. They are listed but skipped.');
    if (r.truncated) notes.push(`Only the first ${fmtNum(r.tables.length)} tables were read.`);
    notes.push('OPTIMIZE TABLE rebuilds each table: InnoDB recreates it (mostly online, but it needs free disk space for a copy and causes I/O); MyISAM and Aria lock the table meanwhile. Run it in a quiet period on big tables.');
    this.notice.replaceChildren(...notes.map(n => h('div', { class: 'muted' }, n)));

    const rows = this.rows.map(t => {
      const res = this.results.get(key(t));
      const row = [t.schema, t.name, t.engine, t.rows, t.dataBytes, t.indexBytes, t.freeBytes, t.pct, res ? res.text : t.skip ? `Skipped: ${t.skip}` : ''];
      if (res) row.$cls = res.ok === false ? 'fr-error' : res.ok ? 'fr-ok' : 'fr-running';
      else if (t.skip) row.$cls = 'fr-skip';
      row.t = t;
      return row;
    });
    if (this.sort) sortRows(rows, this.sort.c, this.sort.dir, !!COLS[this.sort.c].kind);
    this.gridRows = rows;
    this.grid.sort = this.sort;
    this.grid.o.emptyText = r.tables.length ? 'No table is over the thresholds.' : 'No tables.';
    this.grid.setData(COLS, rows, { keepWidths: true, keepPos: true });
    this.update();
  }

  toggleSort(c) {
    this.sort = this.sort?.c === c ? (this.sort.dir === 'asc' ? { c, dir: 'desc' } : null) : { c, dir: 'asc' };
    this.render();
  }

  update() {
    const ro = this.sid && this.app.isReadOnly(this.sid);
    const n = this.rows.filter(t => !t.skip).length;
    this.optBtn.textContent = n ? `Optimize all (${fmtNum(n)})` : 'Optimize all';
    this.optBtn.disabled = this.running || this.loading || !n || ro;
    this.optBtn.title = ro ? 'Not available in read-only mode' : 'Run OPTIMIZE TABLE on every listed table, one at a time';
    this.freshBtn.disabled = this.running || this.loading;
    this.stopBtn.disabled = !this.running;
    for (const el of [this.minFree, this.minPct, this.schema, this.filter]) el.disabled = this.running;
  }

  /** OPTIMIZE TABLE for each of the given tables in turn; the skipped ones (see skipReason) are left out. */
  async optimize(list) {
    const sid = this.sid;
    const todo = list.filter(t => !t.skip);
    if (!sid || this.running || !todo.length || !this.app.canModify(sid)) return;
    // Taken before the confirmation, so a second click while it is open can't start another run.
    this.running = true;
    this.update();
    const sum = fragSummary(todo);
    const local = this.local.checked;
    const kw = local ? 'OPTIMIZE LOCAL TABLE' : 'OPTIMIZE TABLE';
    const sample = todo.slice(0, 5).map(t => `${kw} ${qi(t.schema)}.${qi(t.name)};`).join('\n') + (todo.length > 5 ? `\n… and ${todo.length - 5} more` : '');
    const ok = await confirmDlg(this.app.prodWarn(sid) +
      `Optimize ${fmtNum(todo.length)} table(s), one at a time?\n\nThis rebuilds ${fmtBytes(sum.sizeBytes)} of data and indexes to reclaim about ${fmtBytes(sum.reclaimBytes)}. ` +
      `It needs free disk space for a copy of each table and can take a long time.${local ? '' : ' The statements are replicated.'}\n\n${sample}`,
      { title: 'Optimize tables', ok: 'Optimize', danger: true, kind: 'warning' });
    if (!ok || sid !== this.sid) {
      this.running = false;
      this.update();
      return;
    }
    this.stopRequested = false;
    for (const t of todo) this.results.delete(key(t));
    this.progress.style.display = '';
    const t0 = Date.now();
    let done = 0, errors = 0;
    for (const t of todo) {
      if (this.stopRequested || sid !== this.sid) break;
      this.status.textContent = `Optimizing ${t.schema}.${t.name} (${done + 1} of ${todo.length})…`;
      this.bar.style.width = (done / todo.length) * 100 + '%';
      this.results.set(key(t), { ok: null, text: 'Optimizing…' });
      this.render();
      try {
        const rs = await post(`/s/${sid}/maintenance`, { db: t.schema, tables: [t.name], op: 'optimize', options: local ? ['LOCAL'] : [] });
        const out = optimizeOutcome(rs.rows);
        if (!out.ok) errors++;
        this.results.set(key(t), out);
      } catch (e) {
        errors++;
        this.results.set(key(t), { ok: false, text: e.message });
      }
      done++;
      this.render();
    }
    this.bar.style.width = '100%';
    const stopped = done < todo.length;
    const msg = `Optimized ${done} of ${todo.length} table(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s` + (errors ? ` – ${errors} error(s)` : '') + (stopped ? ' – stopped' : '');
    this.running = false;
    this.progress.style.display = 'none';
    this.update();
    if (sid !== this.sid) return;
    this.app.setStatus(msg);
    await this.load(true); // show what is left; the results stay in the Result column
    this.status.textContent = msg;
  }

  ctx(e) {
    const picked = this.grid.selectedRowIndexes().map(i => this.gridRows[i]?.t).filter(Boolean);
    const ro = this.app.isReadOnly(this.sid);
    const exportRows = () => (this.gridRows || []).map(r => r.slice(0, COLS.length).map((v, i) => (v == null ? null : i === 7 ? v.toFixed(1) : String(v))));
    contextMenu(e.clientX, e.clientY, [
      { label: picked.length > 1 ? `Optimize ${picked.length} selected tables` : 'Optimize this table', icon: 'maintenance',
        disabled: ro || this.running || !picked.some(t => !t.skip), onClick: () => this.optimize(picked) },
      '-',
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => this.grid.copy() },
      { label: 'Export rows…', icon: 'export', disabled: !this.rows.length, onClick: () => exportGridDialog(this.app, { columns: COLS, rows: exportRows(), selected: this.grid.selectedRowIndexes(), name: 'fragmentation' }) },
      '-',
      { label: 'Refresh statistics', icon: 'refresh', disabled: this.running, onClick: () => this.load(true) },
    ]);
  }
}
