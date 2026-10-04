// Host tab › Health: the server health report. The facts come from /s/{sid}/health; healthlogic.js turns them into
// findings (what is wrong, how serious, how to fix it) shown by area, with the fix SQL one click from a query tab,
// and saves the whole report as a self-contained HTML page.
import { h, fmtBytes, fmtNum, saveTextFile } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { fmtSeconds } from '../insightlogic.js';
import { analyze, verdict, reportHtml, reportFileName, AREAS, SEVERITY_LABEL } from '../healthlogic.js';

const SEV_ICON = { critical: 'error', warning: 'warning', info: 'info', good: 'check' };
const badge = (severity, text) => h('span', { class: `rp-badge sev-${severity}` }, h('span', { html: icon(SEV_ICON[severity] || 'info') }), h('span', null, text));
const FILTERS = [['all', 'All'], ['critical', 'Critical'], ['warning', 'Warnings'], ['info', 'Notes'], ['passed', 'Passed']];
const MAX_ROWS = 200;

export class HealthView {
  constructor(app) {
    this.app = app;
    this.sid = null;
    this.filter = 'all';
    this.status = h('span', { class: 'muted' });
    this.saveBtn = h('button', { class: 'btn', disabled: true, title: 'Save the report as an HTML page to keep or share', onclick: () => this.save() }, 'Save as HTML…');
    this.runBtn = h('button', { class: 'btn', title: 'Collect the facts again and re-run the checks', onclick: () => this.load() },
      h('span', { html: icon('refresh') }), ' Run again');
    this.body = h('div', { class: 'hl-body' });
    this.el = h('div', { class: 'hl' },
      h('div', { class: 'viewbar small' }, h('b', null, 'Server health report'), h('div', { class: 'grow' }), this.status, this.saveBtn, this.runBtn),
      this.body);
  }

  /** Runs the report the first time the panel is shown for a session; after that only on "Run again". */
  start(sid) {
    if (sid === this.sid && (this.report || this.loading)) return;
    this.sid = sid;
    this.report = null;
    this.load();
  }

  stop() {}

  async load() {
    const sid = this.sid;
    if (!sid) return;
    this.loading = true;
    this.runBtn.disabled = true;
    this.saveBtn.disabled = true;
    this.status.textContent = 'Collecting…';
    this.status.classList.remove('err');
    if (!this.report) this.body.replaceChildren(h('div', { class: 'muted pad' }, 'Checking the server…'));
    try {
      const facts = await get(`/s/${sid}/health`, null, { quiet: true });
      if (sid !== this.sid) return;
      this.facts = facts;
      this.report = analyze(facts);
      this.status.textContent = `Checked ${new Date(facts.collectedAt).toLocaleTimeString()} in ${fmtNum(facts.tookMs)} ms`;
      this.saveBtn.disabled = false;
      this.render();
    } catch (e) {
      if (sid !== this.sid) return;
      this.status.textContent = e.message;
      this.status.classList.add('err');
      if (!this.report) this.body.replaceChildren(h('div', { class: 'muted pad' }, `The report could not be collected: ${e.message}`));
    } finally {
      if (sid === this.sid) {
        this.loading = false;
        this.runBtn.disabled = false;
      }
    }
  }

  serverLabel() {
    const info = this.app.conns.get(this.sid);
    return info ? `${info.name}${info.host && info.host !== info.name ? ` (${info.host})` : ''}` : 'server';
  }

  async save() {
    if (!this.report) return;
    const f = this.facts;
    const html = reportHtml(this.report, {
      server: this.serverLabel(), version: f.version, collectedAt: new Date(f.collectedAt).toLocaleString(), app: this.app.version?.version,
    });
    const info = this.app.conns.get(this.sid);
    const name = await saveTextFile(reportFileName(info?.host || info?.name || 'server', f.collectedAt), html, 'HTML files', '.html');
    if (name) this.app.setStatus(`Saved ${name}`);
  }

  render() {
    const r = this.report, f = this.facts, o = r.overview, v = verdict(r.counts);
    const chip = (key, label, count) => h('button', {
      class: `hl-chip${this.filter === key ? ' active' : ''}${count != null ? ` hl-chip-${key}` : ''}`,
      onclick: () => { this.filter = key; this.render(); },
    }, label, count != null ? h('b', null, String(count)) : '');
    const head = h('div', { class: 'hl-head' },
      h('div', { class: 'hl-verdict' }, badge(v.severity, v.text)),
      h('div', { class: 'muted hl-facts' }, [f.version, `up ${fmtSeconds(o.uptime)}`, `${fmtNum(o.databases)} databases`, `${fmtNum(o.tables)} tables`,
        `${fmtBytes(o.dataBytes + o.indexBytes)} of data and indexes`, `${r.findings.length + r.passed.length} checks`].join(' · ')),
      o.uptime < 86400 ? h('div', { class: 'muted hl-facts' }, `The server started ${fmtSeconds(o.uptime)} ago; checks based on activity counters need more history and are skipped or less certain.`) : '',
      h('div', { class: 'hl-chips' }, FILTERS.map(([k, label]) => chip(k, label, k === 'all' ? null : k === 'passed' ? r.counts.passed : r.counts[k]))));

    const show = fd => this.filter === 'all' || this.filter === fd.severity;
    const sections = AREAS.map(([area, label]) => {
      const list = this.filter === 'passed' ? [] : r.findings.filter(fd => fd.area === area && show(fd));
      const ok = this.filter === 'passed' ? r.passed.filter(p => p.area === area) : [];
      if (!list.length && !ok.length) return '';
      return h('section', { class: 'hl-area', 'data-area': area },
        h('h3', null, label),
        ...list.map(fd => this.finding(fd)),
        ok.length ? h('ul', { class: 'hl-passed' }, ok.map(p => h('li', null, badge('good', p.title)))) : '');
    });
    const nothing = sections.every(s => s === '')
      ? h('div', { class: 'muted pad' }, this.filter === 'passed' ? 'No check passed.' : 'Nothing in this category.') : '';

    // The problems in order of severity, so a critical one in the last area isn't missed.
    const urgent = this.filter === 'all' ? r.findings.filter(fd => fd.severity !== 'info') : [];
    const first = urgent.length ? h('div', { class: 'hl-first' },
      h('b', null, 'Fix first'),
      h('ol', null, urgent.map(fd => h('li', null, h('a', {
        href: '#', onclick: e => {
          e.preventDefault();
          const el = this.body.querySelector(`.hl-finding[data-id="${fd.id}"]`);
          if (!el) return;
          el.open = true;
          el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        },
      }, badge(fd.severity, fd.title)), h('span', { class: 'muted' }, ` – ${AREAS.find(([a]) => a === fd.area)[1]}`))))) : '';

    this.body.replaceChildren(head, first,
      r.notes.length ? h('div', { class: 'hl-notes' }, h('b', null, 'Not everything could be checked: '), r.notes.map(nt => h('div', null, nt))) : '',
      ...sections, nothing,
      this.filter === 'all' ? this.overviewCard(o) : '');
  }

  finding(fd) {
    const items = fd.items;
    const sql = fd.fix?.sql;
    const ro = this.app.isReadOnly(this.sid);
    return h('details', { class: `hl-finding sev-${fd.severity}`, open: fd.severity !== 'info', 'data-id': fd.id },
      h('summary', null, badge(fd.severity, SEVERITY_LABEL[fd.severity]), h('span', { class: 'hl-title' }, fd.title)),
      h('div', { class: 'hl-detail' },
        fd.detail ? h('p', null, fd.detail) : '',
        items ? h('div', { class: 'hl-items' },
          h('table', { class: 'edit-table hl-table' },
            h('thead', null, h('tr', null, items.columns.map(c => h('th', null, c)))),
            h('tbody', null, items.rows.slice(0, MAX_ROWS).map(row => h('tr', null, row.map(cell => h('td', null, cell ?? '')))))),
          items.rows.length > MAX_ROWS ? h('div', { class: 'muted' }, `… and ${fmtNum(items.rows.length - MAX_ROWS)} more (the saved report lists up to 500)`) : '') : '',
        fd.fix?.text ? h('p', null, h('b', null, 'Fix: '), fd.fix.text) : '',
        sql ? h('div', { class: 'hl-fix' },
          h('pre', { class: 'hl-sql' }, sql),
          h('div', { class: 'hl-fix-buttons' },
            h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(sql) }, 'Copy'),
            h('button', { class: 'btn', title: ro ? 'Opens the SQL; this session is read-only, so it won\'t run here' : 'Opens the SQL in a new query tab to review and run', onclick: () => this.app.openQueryTab(`-- ${fd.title}\n-- Review before running.\n${sql}\n`, 'Health fix') }, 'Open in query tab'))) : ''));
  }

  overviewCard(o) {
    const tile = (label, main, sub) => h('div', { class: 'rp-tile' }, h('div', { class: 'muted' }, label), h('div', { class: 'rp-tile-main' }, main), sub ? h('div', { class: 'muted rp-tile-sub' }, sub) : '');
    const table = (cols, rows) => h('table', { class: 'edit-table hl-table' }, h('thead', null, h('tr', null, cols.map(c => h('th', null, c)))), h('tbody', null, rows));
    return h('section', { class: 'hl-area hl-overview' },
      h('h3', null, 'Overview'),
      h('div', { class: 'rp-tiles' },
        tile('Data', fmtBytes(o.dataBytes), `${fmtBytes(o.indexBytes)} indexes`),
        tile('Tables', fmtNum(o.tables), `in ${fmtNum(o.databases)} databases`),
        o.connections.peak != null ? tile('Connections', `${o.connections.peak} peak`, `of max_connections = ${o.connections.max}`) : '',
        tile('Uptime', fmtSeconds(o.uptime))),
      o.engines.length ? table(['Engine', 'Tables', 'Size'], o.engines.map(e => h('tr', null, h('td', null, e.engine), h('td', { class: 'num' }, fmtNum(e.tables)), h('td', { class: 'num' }, fmtBytes(e.bytes))))) : '',
      o.largest.length ? h('div', null, h('b', null, 'Largest tables'),
        table(['Table', 'Engine', 'Rows (estimate)', 'Data', 'Indexes'], o.largest.map(t => h('tr', null,
          h('td', null, `${t.schema}.${t.name}`), h('td', null, t.engine ?? ''), h('td', { class: 'num' }, fmtNum(t.rows)), h('td', { class: 'num' }, fmtBytes(t.dataBytes)), h('td', { class: 'num' }, fmtBytes(t.indexBytes)))))) : '',
      h('div', { class: 'muted hl-facts' }, 'Sizes and row counts are the estimates the server keeps in information_schema.'));
  }
}
