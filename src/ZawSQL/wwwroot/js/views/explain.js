// Visual EXPLAIN of one statement, shown in a query tab's result area: what needs attention, the plan as a
// diagram (blocks, operations, tables with their access type, rows and cost), the measured steps of EXPLAIN ANALYZE,
// and the classic tabular EXPLAIN and raw JSON.
import { h, esc, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { Grid } from '../grid.js';
import { highlightSql } from '../editor.js';
import { formatSql } from '../sqlformat.js';
import { parsePlan, findIssues, totalCost, tables, parseAnalyzeTree, flattenSteps, misestimates } from '../explainlogic.js';

const VIEWS = [['diagram', 'Diagram'], ['measured', 'Measured'], ['table', 'Table'], ['json', 'JSON']];
const SEV_ICON = { critical: 'error', warning: 'warning', info: 'info', good: 'check', ok: 'info' };
const fmtRows = n => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : fmtNum(Math.round(n * 100) / 100));
const fmtTime = ms => (ms == null ? '–' : ms < 1 ? ms.toFixed(3) + ' ms' : ms < 1000 ? ms.toFixed(1) + ' ms' : (ms / 1000).toFixed(2) + ' s');
const pretty = sql => { try { return formatSql(sql); } catch { return sql; } };
const pct = v => `${Math.round(v * 10) / 10}%`;
const badge = (severity, text, title) => h('span', { class: `xp-badge sev-${severity}`, title: title || '', html: icon(SEV_ICON[severity] || 'info') + `<span>${esc(text)}</span>` });

export class ExplainView {
  /** `onAnalyze()` re-explains with ANALYZE (which runs the statement). */
  constructor({ onAnalyze } = {}) {
    this.onAnalyze = onAnalyze;
    this.view = 'diagram';
    this.switcher = h('div', { class: 'subtabs' });
    this.analyzeBtn = h('button', { class: 'btn', title: 'Runs the statement to measure actual rows and time', onclick: () => this.onAnalyze?.() }, 'Analyze (runs it)');
    this.caption = h('div', { class: 'xp-caption' });
    this.issuesBox = h('div', { class: 'xp-issues' });
    this.body = h('div', { class: 'xp-body' });
    this.grid = new Grid({ gutter: false, emptyText: '' });
    this.el = h('div', { class: 'xp' },
      h('div', { class: 'xp-bar' }, this.switcher, h('div', { class: 'grow' }), this.analyzeBtn),
      this.caption, this.issuesBox, this.body);
  }

  /** Shows an /explain result. */
  show(r) {
    this.r = r;
    this.root = r.json ? parsePlan(r.json) : null;
    this.steps = r.analyzeTree ? flattenSteps(parseAnalyzeTree(r.analyzeTree)) : null;
    this.issues = this.root ? findIssues(this.root) : [];
    if (this.steps) {
      for (const s of misestimates(this.steps)) {
        this.issues.push({ severity: 'warning', text: `${s.label}: estimated ${fmtRows(s.estimate.rows)} rows, actually ${fmtRows(s.actual.rows)}`, hint: 'Stale statistics mislead the optimizer: running ANALYZE TABLE on the tables involved may produce a better plan.' });
      }
    }
    if (this.view === 'measured' && !this.steps) this.view = 'diagram';
    if (r.analyzed) this.view = this.steps ? 'measured' : 'diagram'; // MariaDB's ANALYZE puts actual rows and time on the diagram
    this.render();
  }

  render() {
    const r = this.r;
    this.switcher.replaceChildren(...VIEWS.filter(([k]) => k !== 'measured' || this.steps).map(([k, l]) =>
      h('button', { class: 'subtab' + (k === this.view ? ' active' : ''), onclick: () => { this.view = k; this.render(); } }, l)));
    this.analyzeBtn.style.display = r.canAnalyze && !r.analyzed ? '' : 'none';
    const tbls = this.root ? tables(this.root) : [];
    const cost = this.root ? totalCost(this.root) : null;
    this.caption.replaceChildren(
      h('span', null, r.analyzed ? 'Measured plan' : 'Estimated plan', ' · ', `${tbls.length} table${tbls.length === 1 ? '' : 's'}`,
        cost != null ? ` · cost ${fmtRows(cost)}` : '', this.root?.actual?.timeMs != null ? ` · ran in ${fmtTime(this.root.actual.timeMs)}` : ''),
      h('span', { class: 'muted xp-stmt', title: r.statement }, r.statement.replace(/\s+/g, ' ')));
    this.renderIssues();
    if (this.view === 'diagram') this.renderDiagram(cost);
    else if (this.view === 'measured') this.renderMeasured();
    else if (this.view === 'table') {
      this.body.replaceChildren(h('div', { class: 'xp-grid' }, this.grid.el), this.notesEl());
      this.grid.setData(r.table.columns.map(c => ({ name: c.name, kind: c.kind, readOnly: true })), r.table.rows);
    } else {
      let text = r.json;
      try { text = JSON.stringify(JSON.parse(r.json), null, 2); } catch { /* as returned */ }
      this.body.replaceChildren(h('pre', { class: 'xp-json' }, text));
    }
  }

  renderIssues() {
    if (!this.issues.length) {
      this.issuesBox.replaceChildren(badge('good', 'Nothing stands out in this plan'));
      return;
    }
    this.issuesBox.replaceChildren(...this.issues.map(i => h('div', { class: 'xp-issue', 'data-node': i.nodeId ?? '' },
      badge(i.severity, i.text), h('span', { class: 'muted' }, i.hint))));
    this.issuesBox.onclick = e => {
      const id = e.target.closest('.xp-issue')?.dataset.node;
      if (!id || this.view !== 'diagram') return;
      const card = this.body.querySelector(`.xp-card[data-id="${id}"]`);
      if (!card) return;
      card.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    };
  }

  renderDiagram(cost) {
    if (!this.root) { this.body.replaceChildren(h('div', { class: 'muted pad' }, 'No plan.')); return; }
    const tree = h('div', { class: 'xp-tree' }, this.nodeEl(this.root, cost));
    this.body.replaceChildren(h('div', { class: 'xp-diagram' },
      h('div', { class: 'xp-hint muted' }, 'Rows flow downwards: from the tables at the top through each step to the result at the bottom. A join reads its tables left to right.'), tree),
      this.notesEl());
  }

  nodeEl(n, cost) {
    const card = h('div', { class: `xp-card xp-${n.kind}` + (n.severity ? ` sev-${n.severity}` : ''), 'data-id': n.id });
    const head = h('div', { class: 'xp-head' });
    if (n.kind === 'table') {
      head.append(h('span', { class: 'xp-ic', html: icon('table') }), h('b', { class: 'xp-name', title: n.table }, n.title));
      if (n.statement) head.append(h('span', { class: 'xp-stmt-kind' }, n.statement));
      card.append(head, badge(n.severity, n.accessLabel, `access type: ${n.access}`));
      const rows = [];
      if (n.key) rows.push(['Index', `${n.key}${n.keyParts.length ? ` (${n.keyParts.join(', ')})` : ''}`]);
      else if (n.possibleKeys.length) rows.push(['Index', `none used (possible: ${n.possibleKeys.join(', ')})`]);
      else rows.push(['Index', 'none']);
      if (n.ref.length) rows.push(['Matched on', n.ref.join(', ')]);
      rows.push(['Rows', `${fmtRows(n.rows)}${n.loops > 1 ? ` × ${fmtRows(n.loops)} loops` : ''}${n.filtered != null && n.filtered < 100 ? ` · keeps ${pct(n.filtered)}` : ''}`]);
      if (n.actual) rows.push(['Actual', `${fmtRows(n.actual.rows)} rows${n.actual.loops != null ? ` × ${fmtRows(n.actual.loops)}` : ''}${n.actual.filtered != null && n.actual.filtered < 100 ? ` · kept ${pct(n.actual.filtered)}` : ''}${n.actual.timeMs != null ? ` · ${fmtTime(n.actual.timeMs)}` : ''}`]);
      card.append(h('table', { class: 'xp-props' }, rows.map(([k, v]) => h('tr', null, h('td', { class: 'muted' }, k), h('td', null, v)))));
      if (cost && n.selfCost != null) {
        const share = Math.min(1, n.selfCost / cost);
        card.append(h('div', { class: 'xp-cost', title: `estimated cost ${fmtRows(n.selfCost)} of ${fmtRows(cost)}` },
          h('div', { class: 'xp-cost-bar' }, h('div', { style: { width: Math.max(2, share * 100) + '%' } })), h('span', { class: 'muted' }, `${Math.round(share * 100)}% of cost`)));
      }
      const cond = [n.indexCondition && ['Index condition', n.indexCondition], n.condition && ['Condition', n.condition], n.joinCondition && ['Join condition', n.joinCondition]].filter(Boolean);
      for (const [k, v] of cond) card.append(h('div', { class: 'xp-cond', title: v }, h('span', { class: 'muted' }, k + ': '), v));
    } else {
      const ic = { block: 'query', op: 'nextall', union: 'columns', subquery: 'query', message: 'info' }[n.kind] || 'info';
      head.append(h('span', { class: 'xp-ic', html: icon(ic) }), h('b', null, n.title));
      card.append(head);
      if (n.sub) card.append(h('div', { class: 'muted xp-sub' }, n.sub));
      const meta = [];
      if (n.kind === 'block' && n.cost != null) meta.push(`cost ${fmtRows(n.cost)}`);
      if (n.actual?.timeMs != null) meta.push(`${fmtTime(n.actual.timeMs)}${n.actual.rows != null ? ` · ${fmtRows(n.actual.rows)} rows` : ''}`);
      if (meta.length) card.append(h('div', { class: 'muted xp-sub' }, meta.join(' · ')));
      if (n.condition) card.append(h('div', { class: 'xp-cond', title: n.condition }, n.condition));
    }
    if (n.flags.length) {
      card.append(h('div', { class: 'xp-flags' }, n.flags.map(f => {
        const warn = /filesort|temporary|join buffer|per outer row/.test(f);
        return warn ? badge('warning', f) : h('span', { class: 'xp-flag' }, f);
      })));
    }
    const el = h('div', { class: 'xp-node' }, card);
    if (n.children.length) el.prepend(h('div', { class: 'xp-children' + (n.children.length === 1 ? ' single' : '') }, n.children.map(c => this.nodeEl(c, cost))));
    return el;
  }

  renderMeasured() {
    const steps = this.steps || [];
    const max = Math.max(0.0001, ...steps.map(s => s.actual?.totalMs ?? 0));
    const off = new Set(misestimates(steps));
    const table = h('table', { class: 'edit-table xp-steps' },
      h('thead', null, h('tr', null, ['Step', 'Time (total)', '', 'Rows: estimated → actual', 'Loops'].map(t => h('th', null, t)))),
      h('tbody', null, steps.map(s => h('tr', { class: s.neverExecuted ? 'muted' : '' },
        h('td', { class: 'xp-step', style: { paddingLeft: 6 + s.depth * 18 + 'px' }, title: s.label }, s.label),
        h('td', { class: 'num' }, s.neverExecuted ? 'never executed' : fmtTime(s.actual?.totalMs)),
        h('td', { class: 'xp-timebar' }, s.actual ? h('div', { style: { width: Math.max(1, (s.actual.totalMs / max) * 100) + '%' } }) : ''),
        h('td', null, s.estimate ? fmtRows(s.estimate.rows) : '–', ' → ', s.actual ? fmtRows(s.actual.rows) : '–',
          off.has(s) ? h('span', null, ' ', badge('warning', 'estimate off')) : ''),
        h('td', { class: 'num' }, s.actual ? fmtNum(s.actual.loops) : '')))));
    this.body.replaceChildren(h('div', { class: 'xp-measured' },
      h('div', { class: 'xp-hint muted' }, 'EXPLAIN ANALYZE ran the statement. Times are cumulative: a step includes the steps nested under it; "total" multiplies by loops.'),
      table), this.notesEl());
  }

  /** The optimizer's notes; Note 1003 is the query as the optimizer rewrote it. */
  notesEl() {
    const notes = this.r.notes || [];
    if (!notes.length) return '';
    const rewritten = notes.find(n => String(n.code) === '1003');
    const others = notes.filter(n => n !== rewritten);
    return h('div', { class: 'xp-notes' },
      others.map(n => h('div', null, badge(n.level === 'Warning' ? 'warning' : 'info', `${n.level} ${n.code}: ${n.message}`))),
      rewritten ? h('details', null, h('summary', null, 'The query as the optimizer rewrote it'), h('pre', { class: 'xp-rewritten', html: highlightSql(pretty(rewritten.message.replace(/^\/\*.*?\*\/\s*/, ''))) })) : '');
  }
}
