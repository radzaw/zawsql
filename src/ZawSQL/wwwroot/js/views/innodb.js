// Host tab › InnoDB: SHOW ENGINE INNODB STATUS made readable – the figures worth a glance, what needs attention, and
// each section (semaphores, transactions, file I/O, log, buffer pool, row operations …) with its key facts above the
// server's own text.
import { h } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { parseInnodbStatus, innodbFacts, SECTION_INFO } from '../serverlogslogic.js';

const INTERVALS = [[0, 'No auto refresh'], [5, 'Every 5 s'], [10, 'Every 10 s'], [30, 'Every 30 s']];
const SEV_ICON = { critical: 'error', warning: 'warning', info: 'info', good: 'check' };
const badge = (severity, text) => h('span', { class: `rp-badge sev-${severity}` }, h('span', { html: icon(SEV_ICON[severity] || 'info') }), h('span', null, text));
const title = t => t.charAt(0) + t.slice(1).toLowerCase().replace(/\bi\/o\b/g, 'I/O');

export class InnodbView {
  constructor(app) {
    this.app = app;
    this.sid = null;
    this.text = '';
    this.open = new Set(['TRANSACTIONS']); // sections kept open across refreshes
    this.caption = h('span', { class: 'muted' });
    this.auto = h('select', { class: 'inp', title: 'Auto refresh', onchange: () => this.schedule() }, INTERVALS.map(([v, l]) => h('option', { value: v }, l)));
    this.body = h('div', { class: 'rp-body' });
    this.el = h('div', { class: 'rp' },
      h('div', { class: 'viewbar small' }, h('b', null, 'InnoDB status'), this.caption, h('div', { class: 'grow' }), this.auto,
        h('button', { class: 'tbtn', title: 'Copy the whole status text', html: icon('copy'), onclick: () => this.copy() }),
        h('button', { class: 'tbtn', title: 'Refresh', html: icon('refresh'), onclick: () => this.load() })),
      this.body);
  }

  start(sid) {
    if (sid !== this.sid) {
      this.sid = sid;
      this.text = '';
      this.body.replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'));
    }
    this.load();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    clearTimeout(this.timer);
    const s = +this.auto.value;
    if (s && this.sid) this.timer = setTimeout(() => this.load(), s * 1000);
  }

  async load() {
    const sid = this.sid;
    if (!sid) return;
    clearTimeout(this.timer);
    try {
      const r = await get(`/s/${sid}/innodb`, null, { quiet: true });
      if (sid !== this.sid) return;
      this.text = r.status;
      this.render();
    } catch (e) {
      if (sid !== this.sid) return;
      this.body.replaceChildren(h('div', { class: 'placeholder error' }, e.message));
    }
    if (this.el.isConnected && this.el.offsetParent !== null) this.schedule();
  }

  async copy() {
    try { await navigator.clipboard.writeText(this.text); } catch { /* clipboard denied */ }
  }

  render() {
    const p = parseInnodbStatus(this.text);
    if (!p.sections.length) {
      this.body.replaceChildren(h('div', { class: 'placeholder' }, 'The server returned no InnoDB status (is InnoDB enabled?).'));
      return;
    }
    const { tiles, facts, findings } = innodbFacts(p);
    this.caption.textContent = [p.created && `as of ${p.created}`, p.seconds != null && `rates averaged over the last ${p.seconds} s`].filter(Boolean).join(' · ');
    const scroll = this.body.scrollTop;
    this.body.replaceChildren(
      tiles.length ? h('div', { class: 'mon-tiles' }, tiles.map(t => h('div', { class: 'mon-tile', title: t.title || '' },
        h('div', { class: 'mon-tile-label' }, t.label), h('div', { class: 'mon-tile-value' }, t.value)))) : '',
      h('div', { class: 'rp-advice' }, findings.length
        ? findings.map(f => h('div', { class: 'ib-finding', title: f.hint }, badge(f.severity, f.text), h('span', { class: 'muted' }, ' ', f.hint)))
        : badge('good', 'Nothing in the InnoDB status needs attention')),
      ...p.sections.map(s => this.sectionEl(s, facts[s.title])));
    this.body.scrollTop = scroll;
  }

  sectionEl(s, facts) {
    const d = h('details', { class: 'ib-section', open: this.open.has(s.title) },
      h('summary', null, h('b', null, title(s.title)), SECTION_INFO[s.title] ? h('span', { class: 'muted' }, ' – ' + SECTION_INFO[s.title]) : ''),
      facts?.length ? h('table', { class: 'ib-facts' }, facts.map(([k, v]) => h('tr', null, h('td', { class: 'muted' }, k), h('td', null, v)))) : '',
      h('pre', { class: 'ib-text' }, s.text));
    d.addEventListener('toggle', () => { d.open ? this.open.add(s.title) : this.open.delete(s.title); });
    return d;
  }
}
