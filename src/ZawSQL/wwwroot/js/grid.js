// Virtualized data grid: renders only visible rows, supports cell selection, keyboard navigation,
// column resizing, sorting callbacks and in-place editing.
import { h, esc, isNumericKind } from './util.js';
import { icon } from './icons.js';

const GRID_FONT = '12px "Segoe UI", system-ui, Ubuntu, Cantarell, "Noto Sans", sans-serif';
const measureCtx = document.createElement('canvas').getContext('2d');

export class Grid {
  constructor(opts = {}) {
    this.o = Object.assign({
      rowHeight: 21,
      editable: false,
      gutter: true,
      emptyText: '',
      onCellEdit: null,     // (r, c, value) => void
      onSort: null,         // (c) => void
      onContextMenu: null,  // (event, {r, c}) => void
      onRowChange: null,    // (prevRow, newRow) => void
      onActivate: null,     // (r, c) => void  (double click / Enter on read-only grid)
      onKey: null,          // (event) => void  (unhandled keys)
    }, opts);
    this.rh = this.o.rowHeight;
    this.columns = [];
    this.rows = [];
    this.widths = [];
    this.cur = { r: -1, c: -1 };
    this.anchor = { r: -1, c: -1 };
    this.sort = null;
    this.editing = null;

    this.headerInner = h('div', { class: 'grid-hdr-inner' });
    this.header = h('div', { class: 'grid-hdr' }, this.headerInner);
    this.rowsEl = h('div', { class: 'grid-rows' });
    this.spacer = h('div', { class: 'grid-spacer' }, this.rowsEl);
    this.body = h('div', { class: 'grid-body', tabindex: 0 }, this.spacer);
    this.emptyEl = h('div', { class: 'grid-empty' });
    this.el = h('div', { class: 'grid' }, this.header, this.body, this.emptyEl);

    this.body.addEventListener('scroll', () => {
      this.headerInner.style.transform = `translateX(${-this.body.scrollLeft}px)`;
      this.scheduleRender();
    });
    this.body.addEventListener('mousedown', e => this.onMouseDown(e));
    this.body.addEventListener('dblclick', e => this.onDblClick(e));
    this.body.addEventListener('contextmenu', e => this.onCtx(e));
    this.body.addEventListener('keydown', e => this.onKeyDown(e));
    this.header.addEventListener('mousedown', e => this.onHeaderDown(e));
    this.header.addEventListener('click', e => this.onHeaderClick(e));
    this.header.addEventListener('dblclick', e => {
      const rz = e.target.closest('.gh-rz');
      if (rz) this.autoFit(+rz.dataset.rz);
    });
    new ResizeObserver(() => this.scheduleRender()).observe(this.body);
  }

  get gutterW() { return this.o.gutter ? 16 : 0; }

  focus() { this.body.focus({ preventScroll: true }); }

  setData(columns, rows, { keepWidths = false, keepPos = false } = {}) {
    if (this.editing) this.cancelEdit();
    const same = keepWidths && columns.length === this.columns.length && columns.every((c, i) => c.name === this.columns[i].name);
    this.columns = columns;
    this.rows = rows;
    if (!same) this.widths = this.computeWidths();
    if (!keepPos) {
      this.cur = { r: rows.length ? 0 : -1, c: columns.length ? 0 : -1 };
      this.anchor = { ...this.cur };
      this.body.scrollTop = 0;
      this.body.scrollLeft = 0;
    } else {
      this.cur.r = Math.min(this.cur.r, rows.length - 1);
      this.cur.c = Math.min(Math.max(this.cur.c, columns.length ? 0 : -1), columns.length - 1);
      if (this.cur.r < 0 && rows.length) this.cur.r = 0;
      this.anchor = { ...this.cur };
    }
    this.renderHeader();
    this.render();
  }

  cellText(v, col) {
    if (col.fmt) v = col.fmt(v);
    v = String(v);
    if (v.length > 400) v = v.slice(0, 400) + '…';
    return v.replace(/\r\n|\r|\n/g, '¶');
  }

  measureCol(i, sampleRows = 200) {
    measureCtx.font = GRID_FONT;
    const c = this.columns[i];
    let w = measureCtx.measureText(c.name).width + (c.key ? 40 : 24);
    const n = Math.min(this.rows.length, sampleRows);
    for (let r = 0; r < n; r++) {
      const v = this.rows[r][i];
      const t = v == null ? '(NULL)' : this.cellText(v, c);
      if (t.length > 100) { w = Math.max(w, 360); break; }
      w = Math.max(w, measureCtx.measureText(t).width + 12);
    }
    return Math.round(Math.min(Math.max(w, 36), 360));
  }

  computeWidths() {
    return this.columns.map((c, i) => c.width || this.measureCol(i));
  }

  autoFit(i) {
    this.widths[i] = Math.max(36, Math.min(this.measureCol(i, 2000), 800));
    this.renderHeader();
    this.render();
  }

  totalWidth() {
    return this.gutterW + this.widths.reduce((a, b) => a + b, 0);
  }

  colLeft(c) {
    let x = 0;
    for (let i = 0; i < c; i++) x += this.widths[i];
    return x;
  }

  renderHeader() {
    const parts = [];
    if (this.o.gutter) parts.push(`<div class="gh gutter" style="width:${this.gutterW}px"></div>`);
    this.columns.forEach((c, i) => {
      const s = this.sort && this.sort.c === i ? (this.sort.dir === 'desc' ? '▼' : '▲') : '';
      const key = c.key ? icon(c.key === 'pri' ? 'key' : c.key === 'uni' ? 'keyu' : 'keyi', 'gh-key') : '';
      parts.push(`<div class="gh${isNumericKind(c.kind) ? ' num' : ''}" data-c="${i}" style="width:${this.widths[i]}px" title="${esc(c.title || c.type || c.name)}">${key}<span class="gh-t">${esc(c.name)}</span><span class="gh-s">${s}</span><div class="gh-rz" data-rz="${i}"></div></div>`);
    });
    this.headerInner.innerHTML = parts.join('');
    this.headerInner.style.width = this.totalWidth() + 40 + 'px';
  }

  scheduleRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  selRect() {
    if (this.cur.r < 0 || this.anchor.r < 0) return null;
    return {
      r1: Math.min(this.cur.r, this.anchor.r), r2: Math.max(this.cur.r, this.anchor.r),
      c1: Math.min(this.cur.c, this.anchor.c), c2: Math.max(this.cur.c, this.anchor.c),
    };
  }

  selectedRowIndexes() {
    const s = this.selRect();
    if (!s) return [];
    const out = [];
    for (let r = s.r1; r <= s.r2; r++) out.push(r);
    return out;
  }

  render() {
    const total = this.totalWidth();
    this.spacer.style.height = Math.max(this.rows.length * this.rh, 1) + 'px';
    this.spacer.style.width = total + 'px';
    const top = this.body.scrollTop;
    const height = this.body.clientHeight || 400;
    const r0 = Math.max(0, Math.floor(top / this.rh) - 4);
    const r1 = Math.min(this.rows.length, Math.ceil((top + height) / this.rh) + 4);
    const sel = this.selRect();
    const multi = sel && (sel.r1 !== sel.r2 || sel.c1 !== sel.c2);
    const out = [];
    for (let r = r0; r < r1; r++) {
      const row = this.rows[r];
      let cls = 'gr';
      if (r === this.cur.r) cls += ' cur';
      if (r & 1) cls += ' odd';
      if (row.$new) cls += ' new';
      else if (row.$dirty) cls += ' dirty';
      out.push(`<div class="${cls}" style="top:${r * this.rh}px;width:${total}px;height:${this.rh}px">`);
      if (this.o.gutter) out.push(`<div class="gc gutter" style="width:${this.gutterW}px">${r === this.cur.r ? '▸' : row.$new ? '*' : ''}</div>`);
      for (let c = 0; c < this.columns.length; c++) {
        const col = this.columns[c];
        const v = row[c];
        let ccls = 'gc k-' + (col.kind || 'text');
        let txt;
        if (row.$new && row.$set && !row.$set.has(c)) { txt = '(default)'; ccls += ' null'; }
        else if (v == null) { txt = '(NULL)'; ccls += ' null'; }
        else txt = esc(this.cellText(v, col));
        if (multi && r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2) ccls += ' sel';
        if (r === this.cur.r && c === this.cur.c) ccls += ' focus';
        if (row.$changed?.has(c)) ccls += ' changed';
        out.push(`<div class="${ccls}" style="width:${this.widths[c]}px">${txt}</div>`);
      }
      out.push('</div>');
    }
    this.rowsEl.innerHTML = out.join('');
    const showEmpty = !this.rows.length && this.o.emptyText;
    this.emptyEl.textContent = showEmpty ? this.o.emptyText : '';
    this.emptyEl.style.display = showEmpty ? '' : 'none';
  }

  hit(e) {
    const rect = this.body.getBoundingClientRect();
    const bx = e.clientX - rect.left, by = e.clientY - rect.top;
    if (bx > this.body.clientWidth || by > this.body.clientHeight) return null; // scrollbar
    const y = by + this.body.scrollTop;
    const x = bx + this.body.scrollLeft - this.gutterW;
    const r = Math.floor(y / this.rh);
    let c = -1;
    if (x < 0) c = Math.max(0, this.cur.c);
    else {
      let acc = 0;
      for (let i = 0; i < this.widths.length; i++) {
        if (x < acc + this.widths[i]) { c = i; break; }
        acc += this.widths[i];
      }
      if (c < 0) c = this.widths.length - 1;
    }
    return { r: r < this.rows.length ? r : -1, c };
  }

  setCur(r, c, extend = false) {
    if (!this.rows.length || !this.columns.length) return;
    r = Math.max(0, Math.min(this.rows.length - 1, r));
    c = Math.max(0, Math.min(this.columns.length - 1, c));
    const prevR = this.cur.r;
    this.cur = { r, c };
    if (!extend) this.anchor = { r, c };
    this.ensureVisible(r, c);
    this.render();
    if (prevR !== r) this.o.onRowChange?.(prevR, r);
  }

  ensureVisible(r, c) {
    const b = this.body;
    const top = r * this.rh;
    if (top < b.scrollTop) b.scrollTop = top;
    else if (top + this.rh > b.scrollTop + b.clientHeight) b.scrollTop = top + this.rh - b.clientHeight;
    if (c >= 0) {
      const left = this.colLeft(c);
      const w = this.widths[c];
      const viewW = b.clientWidth - this.gutterW;
      if (left < b.scrollLeft) b.scrollLeft = left;
      else if (left + w > b.scrollLeft + viewW) b.scrollLeft = Math.min(left, left + w - viewW);
    }
  }

  selectAll() {
    if (!this.rows.length) return;
    this.anchor = { r: 0, c: 0 };
    this.cur = { r: this.rows.length - 1, c: this.columns.length - 1 };
    this.render();
  }

  onMouseDown(e) {
    const p = this.hit(e);
    if (!p || p.r < 0) return;
    if (this.editing) this.commitEdit();
    if (e.button === 2) {
      const s = this.selRect();
      if (!s || p.r < s.r1 || p.r > s.r2 || p.c < s.c1 || p.c > s.c2) this.setCur(p.r, p.c);
      return;
    }
    if (e.button !== 0) return;
    this.setCur(p.r, p.c, e.shiftKey);
    const move = ev => {
      const q = this.hit(ev);
      if (q && q.r >= 0 && q.c >= 0 && (q.r !== this.cur.r || q.c !== this.cur.c)) {
        this.cur = q;
        this.ensureVisible(q.r, q.c);
        this.render();
      }
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  onDblClick(e) {
    const p = this.hit(e);
    if (!p || p.r < 0) return;
    if (this.o.editable && !this.columns[p.c]?.readOnly) this.startEdit();
    else this.o.onActivate?.(p.r, p.c);
  }

  onCtx(e) {
    e.preventDefault();
    const p = this.hit(e) || { r: -1, c: -1 };
    this.o.onContextMenu?.(e, p);
  }

  onKeyDown(e) {
    if (this.editing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const { r, c } = this.cur;
    const page = Math.max(1, Math.floor(this.body.clientHeight / this.rh) - 1);
    let nr = r, nc = c;
    switch (e.key) {
      case 'ArrowDown': nr++; break;
      case 'ArrowUp': nr--; break;
      case 'ArrowLeft': nc--; break;
      case 'ArrowRight': nc++; break;
      case 'PageDown': nr += page; break;
      case 'PageUp': nr -= page; break;
      case 'Home': if (ctrl) nr = 0; nc = 0; break;
      case 'End': if (ctrl) nr = this.rows.length - 1; nc = this.columns.length - 1; break;
      case 'Tab': nc += e.shiftKey ? -1 : 1; break;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (this.o.editable) this.startEdit();
        else this.o.onActivate?.(r, c);
        return;
      default:
        if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); return; }
        if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); this.copy(); return; }
        if (this.o.editable && !ctrl && !e.altKey && e.key.length === 1 && !this.columns[c]?.readOnly) {
          e.preventDefault();
          this.startEdit(e.key);
          return;
        }
        this.o.onKey?.(e);
        return;
    }
    e.preventDefault();
    this.setCur(nr, nc, e.shiftKey && e.key !== 'Tab');
  }

  onHeaderDown(e) {
    const rz = e.target.closest('.gh-rz');
    if (!rz) return;
    e.preventDefault();
    e.stopPropagation();
    const i = +rz.dataset.rz;
    const sx = e.clientX, sw = this.widths[i];
    document.body.classList.add('resizing-x');
    const move = ev => {
      this.widths[i] = Math.max(24, sw + ev.clientX - sx);
      this.renderHeader();
      this.render();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-x');
      this.justResized = Date.now();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  onHeaderClick(e) {
    if (Date.now() - (this.justResized || 0) < 250 || e.target.closest('.gh-rz')) return;
    const gh = e.target.closest('.gh[data-c]');
    if (gh && this.o.onSort) this.o.onSort(+gh.dataset.c);
  }

  // ---------- clipboard ----------

  selectedText() {
    const s = this.selRect();
    if (!s) return '';
    const lines = [];
    for (let r = s.r1; r <= s.r2; r++) {
      const vals = [];
      for (let c = s.c1; c <= s.c2; c++) {
        const v = this.rows[r][c];
        vals.push(v == null ? 'NULL' : v);
      }
      lines.push(vals.join('\t'));
    }
    return lines.join('\n');
  }

  async copy(text = this.selectedText()) {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard denied */ }
  }

  // ---------- editing ----------

  startEdit(initial) {
    const { r, c } = this.cur;
    if (r < 0 || c < 0 || !this.o.editable) return;
    const col = this.columns[c];
    if (col.readOnly) return;
    const row = this.rows[r];
    const val = row.$new && row.$set && !row.$set.has(c) ? null : row[c];
    this.ensureVisible(r, c);
    const left = this.gutterW + this.colLeft(c);
    const top = r * this.rh;
    const w = this.widths[c];
    const multi = /text|json|blob/i.test(col.type || '') || (val != null && (val.includes('\n') || val.length > 120));
    let ed;
    if (col.enumValues && initial == null) {
      ed = h('select', { class: 'grid-ed' }, col.enumValues.map(v => h('option', { value: v, selected: v === val }, v)));
    } else if (multi) {
      ed = h('textarea', { class: 'grid-ed multi', spellcheck: false, title: 'Ctrl+Enter to apply, Esc to cancel' });
    } else {
      ed = h('input', { class: 'grid-ed', spellcheck: false });
    }
    if (ed.tagName !== 'SELECT') ed.value = initial != null ? initial : val ?? '';
    Object.assign(ed.style, {
      left: left + 'px',
      top: top + 'px',
      width: (multi ? Math.max(w, 380) : Math.max(w, 60)) + 'px',
      height: multi ? '160px' : this.rh + 'px',
    });
    this.spacer.append(ed);
    this.editing = { r, c, el: ed, orig: val };
    ed.focus();
    if (initial == null && ed.select && !multi) ed.select();
    ed.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); this.cancelEdit(); }
      else if (ev.key === 'Enter' && (!multi || ev.ctrlKey)) { ev.preventDefault(); this.commitEdit(); this.focus(); }
      else if (ev.key === 'Tab') { ev.preventDefault(); this.commitEdit(); this.setCur(r, c + (ev.shiftKey ? -1 : 1)); this.focus(); }
      else if (!multi && ed.tagName === 'INPUT' && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        ev.preventDefault();
        this.commitEdit();
        this.setCur(r + (ev.key === 'ArrowUp' ? -1 : 1), c);
        this.focus();
      }
    });
    ed.addEventListener('blur', () => { if (this.editing?.el === ed) this.commitEdit(); });
  }

  commitEdit() {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const v = e.el.value;
    e.el.remove();
    const unchanged = e.orig == null ? v === '' : v === e.orig;
    if (!unchanged) this.o.onCellEdit?.(e.r, e.c, v);
    this.render();
  }

  cancelEdit() {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    e.el.remove();
    this.focus();
  }
}

/** Sorts rows in place by column; used for client-side sorting of result grids. */
export function sortRows(rows, c, dir, numeric) {
  const m = dir === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    const x = a[c], y = b[c];
    if (x == null) return y == null ? 0 : -m;
    if (y == null) return m;
    if (numeric) {
      const p = parseFloat(x), q = parseFloat(y);
      if (!isNaN(p) && !isNaN(q)) return (p - q) * m;
    }
    return (x < y ? -1 : x > y ? 1 : 0) * m;
  });
}
