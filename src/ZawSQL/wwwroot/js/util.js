// Small DOM and formatting helpers shared by all modules.

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'readOnly', 'spellcheck', 'tabIndex', 'multiple']);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

/** Quotes a MySQL identifier. */
export const qi = s => '`' + String(s).replace(/`/g, '``') + '`';

/** Quotes a MySQL string literal. */
export const sqlStr = s => "'" + String(s)
  .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\0')
  .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1a/g, '\\Z') + "'";

export function fmtBytes(n) {
  if (n == null || n === '') return '';
  n = Number(n);
  if (!isFinite(n)) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + units[i];
}

export const fmtNum = n => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US'));

export function fmtSecs(ms) {
  return (ms / 1000).toFixed(3) + ' sec.';
}

export function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Makes `handle` a drag handle that resizes something along one axis. */
export function makeSplitter(handle, { axis, get, set, onEnd }) {
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startVal = get();
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = ev => set(startVal + ((axis === 'x' ? ev.clientX : ev.clientY) - start));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-x', 'resizing-y');
      onEnd?.();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

export function download(name, text, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function pickFile(accept = '') {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

/** Saves text through the native save dialog when available, else as a download. */
export async function saveTextFile(name, text, description = 'SQL files', ext = '.sql') {
  if (window.showSaveFilePicker) {
    try {
      const fh = await window.showSaveFilePicker({ suggestedName: name, types: [{ description, accept: { 'text/plain': [ext] } }] });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      return fh.name;
    } catch (e) {
      if (e.name === 'AbortError') return null;
    }
  }
  download(name, text);
  return name;
}

/** Values of an ENUM column type, or null. */
export function parseEnum(type) {
  const m = /^enum\((.*)\)/i.exec(type || '');
  if (!m) return null;
  const out = [];
  const re = /'((?:[^'\\]|''|\\.)*)'/g;
  let x;
  while ((x = re.exec(m[1]))) out.push(x[1].replace(/''/g, "'").replace(/\\(.)/g, '$1'));
  return out;
}

export const isNumericKind = k => k === 'int' || k === 'real';

export function compareValues(a, b, numeric) {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  if (numeric) {
    const x = parseFloat(a), y = parseFloat(b);
    if (!isNaN(x) && !isNaN(y)) return x - y;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Splits on `sep` outside of parentheses and quotes. */
export function splitTopLevel(s, sep = ',') {
  const out = [];
  let depth = 0, cur = '', q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/** A log timestamp in local time with milliseconds: "2026-10-05 14:03:21.457". */
export function fmtLogTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
