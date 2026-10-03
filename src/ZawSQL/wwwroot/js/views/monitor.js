// Live server monitor: KPI tiles, time-series charts, table view and active queries.
// Charts follow the data-viz rules: one y-axis per chart, fixed series colors by slot, 2px lines,
// hairline grid, legend with current values (text in text tokens), crosshair tooltip listing every
// series, keyboard access, and a table view with the same numbers.
import { h } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { confirmDlg } from '../dialogs.js';
import {
  CHARTS, WINDOWS, INTERVALS, pushSample, chartPoints, summarize, kpis, formatValue,
  formatUptime, niceScale, utilizationStatus,
} from './monitor-metrics.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const timeLabel = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------------------------------------------------------------- time-series chart

const PLOT_H = 140, AXIS_H = 18, PAD_T = 8, GUTTER = 64, PAD_R = 10;

export class TimeChart {
  constructor(def) {
    this.def = def;
    this.points = [];
    this.focusIndex = -1;
    this.legend = h('div', { class: 'mon-legend' });
    this.svg = svg('svg', { class: 'mon-svg', height: PAD_T + PLOT_H + AXIS_H, tabindex: 0, role: 'img', 'aria-label': def.title });
    this.tip = h('div', { class: 'mon-tip', role: 'status' });
    this.el = h('div', { class: 'mon-card' },
      h('div', { class: 'mon-card-title' }, def.title),
      this.legend,
      h('div', { class: 'mon-plot' }, this.svg, this.tip));
    this.svg.addEventListener('pointermove', e => this.hover(e));
    this.svg.addEventListener('pointerleave', () => { if (document.activeElement !== this.svg) this.hideTip(); });
    this.svg.addEventListener('focus', () => this.focusAt(this.points.length - 1));
    this.svg.addEventListener('blur', () => this.hideTip());
    this.svg.addEventListener('keydown', e => this.key(e));
  }

  update(points, from, to) {
    this.points = points;
    this.from = from;
    this.to = to;
    this.drawLegend();
    this.draw();
    if (this.focusIndex >= 0 && this.tip.style.display === 'block') this.focusAt(Math.min(this.focusIndex, points.length - 1));
  }

  drawLegend() {
    this.legend.replaceChildren(...this.def.series.map(s => {
      const { current } = summarize(this.points, s.key);
      return h('span', { class: 'mon-legend-item' },
        h('span', { class: `mon-key s${s.slot}` }),
        h('span', { class: 'mon-legend-label' }, s.label),
        h('span', { class: 'mon-legend-value' }, formatValue(current, this.def.format)));
    }));
  }

  geometry() {
    const w = Math.max(240, this.el.querySelector('.mon-plot').clientWidth);
    const plotW = w - GUTTER - PAD_R;
    let maxV = 0;
    for (const p of this.points) for (const s of this.def.series) maxV = Math.max(maxV, p.values[s.key] ?? 0);
    const scale = niceScale(maxV, this.def.format);
    const x = t => GUTTER + ((t - this.from) / (this.to - this.from)) * plotW;
    const y = v => PAD_T + PLOT_H - (v / scale.max) * PLOT_H;
    return { w, plotW, scale, x, y };
  }

  draw() {
    const { w, plotW, scale, x, y } = this.geometry();
    this.svg.setAttribute('width', w);
    this.svg.replaceChildren();
    // Recessive hairline grid with y labels in muted text.
    for (const tick of scale.ticks) {
      const ty = Math.round(y(tick)) + 0.5;
      this.svg.append(svg('line', { class: tick === 0 ? 'mon-baseline' : 'mon-gridline', x1: GUTTER, x2: GUTTER + plotW, y1: ty, y2: ty }));
      const label = svg('text', { class: 'mon-axis', x: GUTTER - 6, y: ty + 3.5, 'text-anchor': 'end' });
      label.textContent = formatValue(tick, this.def.format === 'int' ? 'int' : this.def.format);
      this.svg.append(label);
    }
    // Relative time ticks along the bottom.
    const span = this.to - this.from;
    for (let i = 0; i <= 4; i++) {
      const t = this.from + (span * i) / 4;
      const label = svg('text', { class: 'mon-axis', x: x(t), y: PAD_T + PLOT_H + 13, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' });
      const ago = Math.round((this.to - t) / 1000);
      label.textContent = i === 4 ? 'now' : ago >= 60 ? `-${(ago / 60).toFixed(ago % 60 ? 1 : 0)}m` : `-${ago}s`;
      this.svg.append(label);
    }
    // One 2px line per series; gaps where a value is unknown.
    for (const s of this.def.series) {
      let d = '', pen = false;
      for (const p of this.points) {
        const v = p.values[s.key];
        if (v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      if (d) this.svg.append(svg('path', { class: `mon-line s${s.slot}`, d }));
    }
    this.crosshair = svg('line', { class: 'mon-cross', y1: PAD_T, y2: PAD_T + PLOT_H, visibility: 'hidden' });
    this.dots = svg('g');
    this.svg.append(this.crosshair, this.dots);
    this.geom = { x, y, plotW };
  }

  hover(e) {
    if (!this.points.length) return;
    const rect = this.svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0, bestD = Infinity;
    this.points.forEach((p, i) => {
      const d = Math.abs(this.geom.x(p.t) - px);
      if (d < bestD) { bestD = d; best = i; }
    });
    this.focusAt(best, e.clientX - rect.left);
  }

  key(e) {
    if (!this.points.length) return;
    const last = this.points.length - 1;
    const map = { ArrowLeft: this.focusIndex - 1, ArrowRight: this.focusIndex + 1, Home: 0, End: last };
    if (e.key === 'Escape') { this.hideTip(); return; }
    if (!(e.key in map)) return;
    e.preventDefault();
    this.focusAt(Math.max(0, Math.min(last, map[e.key])));
  }

  focusAt(i, pointerX) {
    const p = this.points[i];
    if (!p) return this.hideTip();
    this.focusIndex = i;
    const cx = this.geom.x(p.t);
    this.crosshair.setAttribute('x1', cx);
    this.crosshair.setAttribute('x2', cx);
    this.crosshair.setAttribute('visibility', 'visible');
    this.dots.replaceChildren(...this.def.series.filter(s => p.values[s.key] != null)
      .map(s => svg('circle', { class: `mon-dot s${s.slot}`, cx, cy: this.geom.y(p.values[s.key]), r: 4 })));
    // Values lead (strong), labels follow; series keyed with a short line, text in text tokens.
    this.tip.replaceChildren(
      h('div', { class: 'mon-tip-time' }, timeLabel(p.t)),
      ...this.def.series.map(s => h('div', { class: 'mon-tip-row' },
        h('span', { class: `mon-key s${s.slot}` }),
        h('b', null, formatValue(p.values[s.key], this.def.format)),
        h('span', { class: 'mon-tip-label' }, s.label))));
    this.tip.style.display = 'block';
    const anchor = pointerX ?? cx;
    const tipW = this.tip.offsetWidth;
    this.tip.style.left = (anchor + 14 + tipW > this.geom.plotW + GUTTER ? anchor - 14 - tipW : anchor + 14) + 'px';
    this.tip.style.top = PAD_T + 'px';
  }

  hideTip() {
    this.focusIndex = -1;
    this.tip.style.display = 'none';
    this.crosshair?.setAttribute('visibility', 'hidden');
    this.dots?.replaceChildren();
  }
}

// ---------------------------------------------------------------- monitor view

export class MonitorView {
  constructor(app) {
    this.app = app;
    this.sid = null;
    this.history = [];
    this.active = { columns: [], rows: [] };
    this.timer = null;
    this.running = false;
    this.paused = false;
    this.mode = 'charts';
    this.intervalSec = app.state.monitor?.interval ?? 2;
    this.windowMs = app.state.monitor?.window ?? 300_000;

    const select = (options, value, onChange, title) => {
      const el = h('select', { class: 'inp', title }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
      el.addEventListener('change', () => onChange(el.value));
      return el;
    };
    this.pauseBtn = h('button', { class: 'tbtn', onclick: () => this.togglePause() });
    this.viewBtn = h('button', { class: 'tbtn', onclick: () => this.toggleMode() });
    this.statusEl = h('span', { class: 'muted mon-status' });
    // One filter row above everything it scopes.
    const controls = h('div', { class: 'mon-controls' },
      h('label', { class: 'chk' }, 'Refresh ', select(INTERVALS.map(s => [s, `every ${s} s`]), this.intervalSec, v => { this.intervalSec = +v; this.remember(); this.schedule(0); }, 'Refresh interval')),
      h('label', { class: 'chk' }, 'Window ', select(WINDOWS.map(w => [w.ms, w.label]), this.windowMs, v => { this.windowMs = +v; this.remember(); this.render(); }, 'Time window shown')),
      this.pauseBtn, this.viewBtn, h('div', { class: 'grow' }), this.statusEl);

    this.tiles = h('div', { class: 'mon-tiles' });
    this.charts = CHARTS.map(def => new TimeChart(def));
    this.chartGrid = h('div', { class: 'mon-grid' }, this.charts.map(c => c.el));
    this.table = h('div', { class: 'mon-table-wrap' });
    this.activeBox = h('div', { class: 'mon-active' });
    this.body = h('div', { class: 'mon-body' }, this.tiles, this.chartGrid, this.table, this.activeBox);
    this.el = h('div', { class: 'mon' }, controls, this.body);
    new ResizeObserver(() => { if (this.running) this.renderCharts(); }).observe(this.chartGrid);
    this.syncButtons();
  }

  remember() {
    this.app.state.monitor = { interval: this.intervalSec, window: this.windowMs };
    this.app.saveStateSoon();
  }

  start(sid) {
    if (sid !== this.sid) {
      this.sid = sid;
      this.history = [];
      this.active = { columns: [], rows: [] };
    }
    this.running = true;
    this.render();
    if (!this.paused) this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delayMs) {
    clearTimeout(this.timer);
    if (!this.running || this.paused) return;
    this.timer = setTimeout(() => this.poll(), delayMs);
  }

  async poll() {
    const sid = this.sid;
    try {
      const sample = await get(`/s/${sid}/monitor`, null, { quiet: true });
      if (sid !== this.sid || !this.running) return;
      if (pushSample(this.history, sample)) this.app.log.info('Server counters were reset (restart or FLUSH STATUS); monitor history restarted.');
      this.active = sample.active;
      this.statusEl.textContent = `Updated ${timeLabel(sample.t)}`;
      this.body.classList.remove('stale');
      this.render();
    } catch (e) {
      // Keep the last frame, dimmed, and keep trying.
      this.statusEl.textContent = `Update failed: ${e.message}`;
      this.body.classList.add('stale');
    }
    this.schedule(this.intervalSec * 1000);
  }

  togglePause() {
    this.paused = !this.paused;
    this.syncButtons();
    if (!this.paused) this.schedule(0);
    else clearTimeout(this.timer);
  }

  toggleMode() {
    this.mode = this.mode === 'charts' ? 'table' : 'charts';
    this.syncButtons();
    this.render();
  }

  syncButtons() {
    this.pauseBtn.innerHTML = this.paused ? `${icon('play')}<span>Resume</span>` : `${icon('stop')}<span>Pause</span>`;
    this.viewBtn.innerHTML = this.mode === 'charts' ? `${icon('columns')}<span>Table view</span>` : `${icon('format')}<span>Chart view</span>`;
    this.chartGrid.style.display = this.mode === 'charts' ? '' : 'none';
    this.table.style.display = this.mode === 'table' ? '' : 'none';
  }

  get since() {
    const last = this.history[this.history.length - 1];
    return last ? last.t - this.windowMs : 0;
  }

  render() {
    this.renderTiles();
    if (this.mode === 'charts') this.renderCharts();
    else this.renderTable();
    this.renderActive();
  }

  renderCharts() {
    const last = this.history[this.history.length - 1];
    const to = last ? last.t : Date.now();
    // The axis grows with the collected data (at least a minute) up to the window, so a fresh monitor isn't squeezed into the right edge.
    const first = this.history[0]?.t ?? to;
    const from = Math.max(to - this.windowMs, Math.min(first, to - 60_000));
    for (const c of this.charts) c.update(chartPoints(this.history, c.def, from), from, to);
  }

  renderTiles() {
    const k = kpis(this.history, this.since);
    if (!k) {
      this.tiles.replaceChildren(h('div', { class: 'placeholder' }, this.sid ? 'Collecting the first samples…' : 'Not connected'));
      return;
    }
    const tile = (label, value, extra) => h('div', { class: 'mon-tile' },
      h('div', { class: 'mon-tile-label' }, label), h('div', { class: 'mon-tile-value' }, value), extra);
    // Meter fill = utilization; with status, high values turn warning/critical and get an icon + label.
    const meter = (ratio, caption, withStatus = true) => {
      const status = withStatus ? utilizationStatus(ratio) : null;
      return h('div', { class: 'mon-meter-wrap' },
        h('div', { class: 'mon-meter' }, h('div', { class: `mon-meter-fill${status ? ' ' + status.level : ''}`, style: { width: `${Math.min(100, (ratio ?? 0) * 100)}%` } })),
        h('div', { class: 'mon-tile-sub' }, status ? h('span', { class: `mon-status-tag ${status.level}`, html: icon('warning') + `<span>${status.label}</span>` }) : null, caption));
    };
    this.tiles.replaceChildren(
      tile('Queries per second', formatValue(k.qps, 'rate'), sparkline(k.qpsTrend)),
      tile('Connections', formatValue(k.connected, 'int'),
        meter(k.connectionUse, k.maxConnections ? ` of ${k.maxConnections.toLocaleString('en-US')} max` : '')),
      tile('Running threads', formatValue(k.running, 'int'), h('div', { class: 'mon-tile-sub' }, 'executing right now')),
      tile('Buffer pool hit rate', formatValue(k.hitRatio, 'percent'), h('div', { class: 'mon-tile-sub' }, 'reads served from memory, this window')),
      tile('Buffer pool used', formatValue(k.bufferPoolUse, 'percent'),
        meter(k.bufferPoolUse, k.bufferPoolSize ? `of ${(k.bufferPoolSize / 1048576).toLocaleString('en-US', { maximumFractionDigits: 0 })} MiB` : '', false)),
      tile('Uptime', formatUptime(k.uptime), h('div', { class: 'mon-tile-sub' }, `${this.history.length} samples`)));
  }

  renderTable() {
    const from = this.since;
    const rows = [];
    for (const def of CHARTS) {
      const pts = chartPoints(this.history, def, from);
      for (const s of def.series) {
        const sum = summarize(pts, s.key);
        rows.push([def.title, s.label, sum.current, sum.avg, sum.peak, def.format]);
      }
    }
    const table = h('table', { class: 'edit-table mon-table' },
      h('thead', null, h('tr', null, ['Chart', 'Series', 'Current', 'Average', 'Peak'].map(t => h('th', null, t)))),
      h('tbody', null, rows.map(([chart, label, cur, avg, peak, fmt]) => h('tr', null,
        h('td', null, chart), h('td', null, label),
        h('td', { class: 'num' }, formatValue(cur, fmt)), h('td', { class: 'num' }, formatValue(avg, fmt)), h('td', { class: 'num' }, formatValue(peak, fmt))))));
    this.table.replaceChildren(h('div', { class: 'mon-card-title' }, `All metrics over the last ${WINDOWS.find(w => w.ms === this.windowMs)?.label ?? ''}`), table);
  }

  renderActive() {
    const cols = this.active.columns.map(c => c.name);
    const idx = name => cols.indexOf(name);
    const rows = this.active.rows || [];
    const k = kpis(this.history);
    const slowAfter = k?.longQueryTime ?? 10;
    const ro = this.app.isReadOnly(this.sid);
    const body = rows.length
      ? h('table', { class: 'edit-table mon-table' },
        h('thead', null, h('tr', null, ['Id', 'User', 'Host', 'Database', 'Time', 'State', 'Query', ''].map(t => h('th', null, t)))),
        h('tbody', null, rows.map(r => {
          const time = Number(r[idx('Time')]);
          return h('tr', null,
            h('td', { class: 'num' }, r[idx('Id')]), h('td', null, r[idx('User')] ?? ''), h('td', null, r[idx('Host')] ?? ''),
            h('td', null, r[idx('Db')] ?? ''),
            h('td', { class: 'num' }, `${time} s `, time >= slowAfter ? h('span', { class: 'mon-status-tag warning', html: icon('warning') + '<span>slow</span>' }) : null),
            h('td', null, r[idx('State')] ?? ''),
            h('td', { class: 'mon-query', title: r[idx('Query')] ?? '' }, r[idx('Query')] ?? ''),
            h('td', null, h('button', { class: 'tbtn', disabled: ro, title: ro ? 'Not available in read-only mode' : 'Kill this query', onclick: () => this.kill(r[idx('Id')]) }, 'Kill')));
        })))
      : h('div', { class: 'muted pad' }, this.history.length ? 'No active queries right now.' : '');
    this.activeBox.replaceChildren(h('div', { class: 'mon-card-title' }, `Active queries (${rows.length})`), body);
  }

  async kill(id) {
    if (!(await confirmDlg(this.app.prodWarn(this.sid) + `Kill query ${id}? The client gets an error and its transaction is rolled back.`, { ok: 'Kill', danger: true }))) return;
    try {
      await post(`/s/${this.sid}/kill`, { id: Number(id) });
      this.schedule(0);
    } catch (e) {
      this.app.showError(e);
    }
  }
}

/** Stat-tile trend: de-emphasis line with the current value as an accent end-dot. */
function sparkline(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  const W = 120, H = 28;
  const el = svg('svg', { class: 'mon-spark', width: W, height: H, 'aria-hidden': 'true' });
  if (pts.length < 2) return el;
  const max = Math.max(...pts.map(p => p[1]), 1);
  const n = values.length - 1 || 1;
  const x = i => 2 + (i / n) * (W - 8), y = v => H - 3 - (v / max) * (H - 8);
  el.append(svg('path', { class: 'mon-spark-line', d: pts.map(([i, v], j) => `${j ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('') }));
  const [li, lv] = pts[pts.length - 1];
  el.append(svg('circle', { class: 'mon-spark-dot', cx: x(li), cy: y(lv), r: 3 }));
  return el;
}

