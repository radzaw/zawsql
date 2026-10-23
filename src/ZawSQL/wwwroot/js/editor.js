// Lightweight SQL editor: a transparent <textarea> over a syntax-highlighted <pre>,
// with line numbers, auto-indent, block indent, comment toggling, autocompletion, parameter hints and snippets.
import { h, esc } from './util.js';
import { icon } from './icons.js';
import { expandSnippet } from './library.js';
import { callAt, activeParam } from './sqlsigs.js';
import { matchBracket, caretContext, missingCloser } from './sqlbrackets.js';

const PAIRS = { '(': ')', '[': ']', "'": "'", '"': '"', '`': '`' };

export const KEYWORDS = new Set(`ACCESSIBLE ADD AFTER ALGORITHM ALL ALTER ANALYZE AND AS ASC AUTO_INCREMENT BEFORE BEGIN BETWEEN BIGINT BINARY BIT
BLOB BOOL BOOLEAN BOTH BY CALL CASCADE CASE CHANGE CHAR CHARACTER CHARSET CHECK COLLATE COLUMN COLUMNS COMMENT COMMIT CONDITION
CONSTRAINT CONTINUE CONVERT CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DATABASES DATE
DATETIME DAY_HOUR DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC DECIMAL DECLARE DEFAULT DEFINER DELAYED DELETE DELIMITER DESC DESCRIBE
DETERMINISTIC DISTINCT DISTINCTROW DIV DO DOUBLE DROP DUAL DUPLICATE EACH ELSE ELSEIF ENCLOSED END ENGINE ENUM ESCAPED EVENT EXISTS EXIT
EXPLAIN FALSE FETCH FIRST FLOAT FOR FORCE FOREIGN FROM FULL FULLTEXT FUNCTION GENERATED GRANT GROUP HANDLER HAVING HIGH_PRIORITY
HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE IN INDEX INFILE INNER INOUT INSENSITIVE INSERT INT INTEGER INTERVAL INTO INVOKER
IS ITERATE JOIN JSON KEY KEYS KILL LATERAL LEADING LEAVE LEFT LIKE LIMIT LINEAR LINES LOAD LOCALTIME LOCALTIMESTAMP LOCK LONG LONGBLOB
LONGTEXT LOOP LOW_PRIORITY MATCH MEDIUMBLOB MEDIUMINT MEDIUMTEXT MOD MODIFIES MODIFY NATURAL NOT NULL NUMERIC OFFSET ON OPTIMIZE
OPTION OPTIONALLY OR ORDER OUT OUTER OUTFILE OVER PARTITION PRECISION PRIMARY PROCEDURE PROCESSLIST PURGE RANGE READ READS REAL
RECURSIVE REFERENCES REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN RETURNS REVOKE RIGHT RLIKE ROLLBACK ROWS
SCHEMA SCHEMAS SECURITY SELECT SENSITIVE SEPARATOR SET SHOW SIGNAL SMALLINT SPATIAL SPECIFIC SQL SQLEXCEPTION SQLSTATE SQLWARNING
SQL_CALC_FOUND_ROWS START STARTING STATUS STRAIGHT_JOIN TABLE TABLES TEMPORARY TERMINATED TEXT THEN TIME TIMESTAMP TINYBLOB TINYINT
TINYTEXT TO TRAILING TRANSACTION TRIGGER TRUE TRUNCATE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING UTC_DATE UTC_TIME
UTC_TIMESTAMP VALUES VARBINARY VARCHAR VARIABLES VARYING VIEW WHEN WHERE WHILE WINDOW WITH WRITE XOR YEAR ZEROFILL`.split(/\s+/));

export const FUNCTIONS = new Set(`ABS AES_DECRYPT AES_ENCRYPT ASCII AVG BIN BIT_LENGTH CAST CEIL CEILING CHAR_LENGTH COALESCE CONCAT CONCAT_WS
CONNECTION_ID CONV CONVERT_TZ COUNT CRC32 CURDATE CURTIME DATE DATEDIFF DATE_ADD DATE_FORMAT DATE_SUB DAY DAYNAME DAYOFMONTH DAYOFWEEK
DAYOFYEAR DENSE_RANK ELT EXP EXTRACT FIELD FIND_IN_SET FLOOR FORMAT FOUND_ROWS FROM_BASE64 FROM_DAYS FROM_UNIXTIME GREATEST GROUP_CONCAT
HEX HOUR IF IFNULL INET_ATON INET_NTOA INSERT INSTR ISNULL JSON_ARRAY JSON_ARRAYAGG JSON_CONTAINS JSON_EXTRACT JSON_KEYS JSON_LENGTH
JSON_OBJECT JSON_OBJECTAGG JSON_SET JSON_UNQUOTE LAG LAST_DAY LAST_INSERT_ID LCASE LEAD LEAST LEFT LENGTH LOCATE LOWER LPAD LTRIM MAKEDATE
MAX MD5 MICROSECOND MID MIN MINUTE MONTH MONTHNAME NOW NULLIF OCT PERIOD_DIFF PI POSITION POW POWER QUARTER QUOTE RAND RANK REGEXP_REPLACE
REGEXP_SUBSTR REPEAT REPLACE REVERSE RIGHT ROUND ROW_COUNT ROW_NUMBER RPAD RTRIM SEC_TO_TIME SECOND SHA1 SHA2 SIGN SLEEP SPACE SQRT
STR_TO_DATE STRCMP SUBDATE SUBSTR SUBSTRING SUBSTRING_INDEX SUM SYSDATE TIME TIME_FORMAT TIME_TO_SEC TIMEDIFF TIMESTAMP TIMESTAMPADD
TIMESTAMPDIFF TO_BASE64 TO_DAYS TRIM TRUNCATE UCASE UNHEX UNIX_TIMESTAMP UPPER USER UTC_TIMESTAMP UUID UUID_SHORT VERSION WEEK WEEKDAY
YEAR YEARWEEK`.split(/\s+/));

const TOKEN_RE = /(--(?=\s|$)[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\]|\\[\s\S])*(?:'|$)|"(?:[^"\\]|\\[\s\S])*(?:"|$))|(`[^`]*(?:`|$))|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|((?<![\w$`)\]:]):[A-Za-z_]\w*)|(@@?[\w$.]*|[A-Za-z_$][\w$]*)|(\s+|[\s\S])/g;

export function highlightSql(text) {
  let out = '';
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    const t = m[0];
    if (m[1]) out += `<span class="t-com">${esc(t)}</span>`;
    else if (m[2]) out += `<span class="t-str">${esc(t)}</span>`;
    else if (m[3]) out += `<span class="t-id">${esc(t)}</span>`;
    else if (m[4]) out += `<span class="t-num">${t}</span>`;
    else if (m[5]) out += `<span class="t-param">${t}</span>`; // :name query parameter
    else if (m[6]) {
      const u = t.toUpperCase();
      if (t[0] === '@') out += `<span class="t-var">${esc(t)}</span>`;
      else if (FUNCTIONS.has(u) && /^\s*\(/.test(text.slice(TOKEN_RE.lastIndex, TOKEN_RE.lastIndex + 8))) out += `<span class="t-fn">${t}</span>`;
      else if (KEYWORDS.has(u)) out += `<span class="t-kw">${t}</span>`;
      else out += t;
    } else out += esc(t);
  }
  return out;
}

const measureCtx = document.createElement('canvas').getContext('2d');

export class SqlEditor {
  /** Typing an opening bracket or quote adds the closing one (Preferences; the same for every editor). */
  static autoClose = true;

  /**
   * `snippets`: { lookup(trigger) -> {body}|null, vars() -> {DB, TABLE, …} } enables Tab expansion of snippet triggers.
   * `signatures`: async ({ name, qualifier }) -> { name, params: [string], returns?, doc? } | null enables parameter
   * hints inside a call's parentheses.
   */
  constructor({ value = '', completer = null, signatures = null, onChange = null, readOnly = false, placeholder = '', snippets = null, onFormat = null } = {}) {
    this.completer = completer;
    this.signatures = signatures;
    this.onFormat = onFormat;
    this.snippets = snippets;
    this.onChange = onChange;
    this.lines = 0;
    this.gutterInner = h('div', { class: 'sqled-lines' });
    this.gutter = h('div', { class: 'sqled-gutter' }, this.gutterInner);
    this.code = h('code');
    this.pre = h('pre', { class: 'sqled-hl', 'aria-hidden': 'true' }, this.code);
    this.ta = h('textarea', { class: 'sqled-ta', spellcheck: false, autocomplete: 'off', autocapitalize: 'off', wrap: 'off', placeholder });
    this.snipHint = h('div', { class: 'sqled-snip-hint' }, 'Tab: next field · Shift+Tab: previous · Esc: done');
    // The bracket at the caret and its partner are outlined (between the highlighting and the textarea).
    this.bm = [h('div', { class: 'sqled-bm' }), h('div', { class: 'sqled-bm' })];
    for (const el of this.bm) el.style.display = 'none';
    this.main = h('div', { class: 'sqled-main' }, this.pre, ...this.bm, this.ta, this.snipHint);
    this.el = h('div', { class: 'sqled' }, this.gutter, this.main);
    this.ta.value = value;
    this.ta.readOnly = readOnly;
    this.ta.addEventListener('beforeinput', e => {
      if (this.snip) this.snipPre = { s: this.ta.selectionStart, e: this.ta.selectionEnd, len: this.ta.value.length, type: e.inputType };
    });
    this.ta.addEventListener('input', () => {
      if (this.snip) this.trackSnippetEdit();
      this.scheduleUpdate();
      this.onChange?.();
      if (this.popup) this.refreshCompletion();
      // Typing "(" or "," shows the hint; any other edit keeps an open one up to date.
      if (this.signatures && (this.sigEl || /[(,]/.test(this.ta.value[this.ta.selectionStart - 1] ?? ''))) this.updateSignature();
    });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', e => this.onKey(e));
    // The caret moved without an edit: the hint may now be for another argument, or another call.
    this.ta.addEventListener('keyup', e => {
      if (!/^(Arrow|Home|End|Page)/.test(e.key)) return;
      this.markBrackets();
      if (this.sigEl) this.updateSignature();
    });
    this.ta.addEventListener('mouseup', () => {
      this.markBrackets();
      if (this.sigEl) this.updateSignature();
    });
    this.ta.addEventListener('focus', () => this.markBrackets());
    this.ta.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement === this.ta) return;
      this.closeCompletion();
      this.closeSignature();
      this.markBrackets();
    }, 150));
    this.ta.addEventListener('mousedown', () => this.closeCompletion());
    new ResizeObserver(() => this.syncScroll()).observe(this.ta);
    this.update();
  }

  get value() { return this.ta.value; }
  set value(v) {
    this.ta.value = v;
    this.update();
  }

  focus() { this.ta.focus({ preventScroll: true }); }

  selection() {
    const { selectionStart: start, selectionEnd: end, value } = this.ta;
    return { start, end, text: value.slice(start, end) };
  }

  selectRange(start, end) {
    this.ta.focus();
    this.ta.setSelectionRange(start, end);
    const line = this.ta.value.slice(0, start).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 18;
    const top = line * lh;
    if (top < this.ta.scrollTop || top > this.ta.scrollTop + this.ta.clientHeight - lh * 2) this.ta.scrollTop = Math.max(0, top - this.ta.clientHeight / 3);
    this.markBrackets();
  }

  scheduleUpdate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.update(); });
  }

  update() {
    const v = this.ta.value;
    this.code.innerHTML = (v.length > 400000 ? esc(v) : highlightSql(v)) + '\n ';
    let lines = 1;
    for (let i = v.indexOf('\n'); i >= 0; i = v.indexOf('\n', i + 1)) lines++;
    if (lines !== this.lines) {
      this.lines = lines;
      let s = '';
      for (let i = 1; i <= lines; i++) s += i + '\n';
      this.gutterInner.textContent = s;
    }
    this.findBrackets();
    this.syncScroll();
  }

  syncScroll() {
    const ta = this.ta;
    // Keep the highlight layer exactly as large as the textarea's scrollable client area.
    this.pre.style.right = ta.offsetWidth - ta.clientWidth + 'px';
    this.pre.style.bottom = ta.offsetHeight - ta.clientHeight + 'px';
    this.pre.scrollTop = ta.scrollTop;
    this.pre.scrollLeft = ta.scrollLeft;
    this.gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
    if (this.popup) this.positionPopup();
    if (this.sigEl) this.positionSignature();
    this.positionMarks();
  }

  /** Inserts text at the caret, keeping the browser's undo stack intact. */
  insert(text) {
    this.ta.focus();
    if (!document.execCommand('insertText', false, text)) {
      this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
      this.update();
      this.onChange?.();
    }
  }

  onKey(e) {
    // Enter / Tab / Esc while an input method (Chinese, Japanese …) composes a word belong to the input method.
    if (e.isComposing || e.keyCode === 229) return;
    if (this.popup) {
      const n = this.compList.length;
      if (e.key === 'ArrowDown') { this.compSel = (this.compSel + 1) % n; this.renderPopup(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { this.compSel = (this.compSel - 1 + n) % n; this.renderPopup(); e.preventDefault(); return; }
      if (e.key === 'PageDown') { this.compSel = Math.min(n - 1, this.compSel + 8); this.renderPopup(); e.preventDefault(); return; }
      if (e.key === 'PageUp') { this.compSel = Math.max(0, this.compSel - 8); this.renderPopup(); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { this.acceptCompletion(); e.preventDefault(); return; }
      if (e.key === 'Escape') { this.closeCompletion(); e.preventDefault(); e.stopPropagation(); return; }
    }
    if (this.sigEl && e.key === 'Escape') { this.closeSignature(); e.preventDefault(); e.stopPropagation(); return; }
    if (this.signatures && e.key === ' ' && e.ctrlKey && e.shiftKey) { e.preventDefault(); this.updateSignature(); return; }
    if (this.ta.readOnly) return;
    if (SqlEditor.autoClose && !this.snip && !e.ctrlKey && !e.altKey && !e.metaKey && this.autoPair(e.key)) { e.preventDefault(); return; }
    if (this.snip && e.key === 'Tab' && !e.ctrlKey && !e.altKey) { e.preventDefault(); this.gotoStop(this.snip.i + (e.shiftKey ? -1 : 1)); return; }
    if (this.snip && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.endSnippet(); return; }
    if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); this.openCompletion(true); return; }
    if (this.onFormat && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); this.onFormat(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (!e.shiftKey && this.expandTrigger()) return;
      this.indent(e.shiftKey);
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      const v = this.ta.value, pos = this.ta.selectionStart;
      const ls = v.lastIndexOf('\n', pos - 1) + 1;
      const ind = /^[ \t]*/.exec(v.slice(ls, pos))[0];
      e.preventDefault();
      this.insert('\n' + ind);
      return;
    }
    if (e.key === '/' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.toggleComment(); return; }
    if (e.key === '.' && !e.ctrlKey) setTimeout(() => this.openCompletion(false), 0);
  }

  lineRange() {
    const ta = this.ta, v = ta.value;
    const s = ta.selectionStart;
    let e = ta.selectionEnd;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    if (e > s && v[e - 1] === '\n') e--;
    let le = v.indexOf('\n', e);
    if (le < 0) le = v.length;
    return [ls, le];
  }

  indent(outdent) {
    const ta = this.ta;
    if (ta.selectionStart === ta.selectionEnd && !outdent) { this.insert('  '); return; }
    const [ls, le] = this.lineRange();
    const block = ta.value.slice(ls, le);
    const nb = block.split('\n').map(l => (outdent ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l)).join('\n');
    ta.setSelectionRange(ls, le);
    this.insert(nb);
    ta.setSelectionRange(ls, ls + nb.length);
  }

  toggleComment() {
    const ta = this.ta;
    const [ls, le] = this.lineRange();
    const lines = ta.value.slice(ls, le).split('\n');
    const all = lines.filter(l => l.trim()).every(l => /^\s*-- ?/.test(l));
    const nb = lines.map(l => (all ? l.replace(/^(\s*)-- ?/, '$1') : l.trim() ? '-- ' + l : l)).join('\n');
    ta.setSelectionRange(ls, le);
    this.insert(nb);
    ta.setSelectionRange(ls, ls + nb.length);
  }

  // ---------- brackets ----------

  findBrackets() {
    const { selectionStart: s, selectionEnd: e, value } = this.ta;
    this.bracketAt = s === e && document.activeElement === this.ta ? matchBracket(value, s) : null;
  }

  markBrackets() {
    this.findBrackets();
    this.positionMarks();
  }

  /** Outlines the bracket at the caret and its partner; one without a partner is shown as an error. */
  positionMarks() {
    const m = this.bracketAt;
    const at = m ? [m.at, m.match] : [];
    const lh = m ? parseFloat(getComputedStyle(this.ta).lineHeight) || 18 : 0;
    this.bm.forEach((el, i) => {
      if (!(at[i] >= 0)) { el.style.display = 'none'; return; }
      const { x, y } = this.caretXY(at[i]);
      el.classList.toggle('bad', m.match < 0);
      Object.assign(el.style, { display: '', left: x + 'px', top: y - lh + 'px', width: this.charW + 'px', height: lh + 'px' });
    });
  }

  /**
   * Auto-closing (when the key is handled here): an opening bracket or quote adds its partner (or wraps the
   * selection), typing the closing one steps over it, and Backspace between an empty pair removes both. Not inside
   * strings and comments, and only where the pair can't glue onto the next word.
   */
  autoPair(key) {
    const ta = this.ta, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const prev = v[s - 1] ?? '', next = v[e] ?? '';
    if (key === 'Backspace') {
      if (s !== e || !PAIRS[prev] || PAIRS[prev] !== next || caretContext(v, s - 1) !== 'code') return false;
      ta.setSelectionRange(s - 1, s + 1);
      if (!document.execCommand('delete')) {
        ta.setRangeText('', s - 1, s + 1, 'end');
        this.update();
        this.onChange?.();
      }
      return true;
    }
    if (key.length !== 1) return false;
    const ctx = caretContext(v, s);
    // Step over a closer that is already there, unless the text still needs one more.
    if (s === e && next === key) {
      if ((key === ')' || key === ']') && ctx === 'code' && !missingCloser(v, key)) return this.moveTo(s + 1);
      if (ctx === key) return this.moveTo(s + 1); // the quote that ends the string the caret is in
    }
    if (!PAIRS[key] || ctx !== 'code') return false;
    const close = PAIRS[key];
    if (s !== e) {
      const sel = v.slice(s, e);
      this.insert(key + sel + close);
      ta.setSelectionRange(s + 1, s + 1 + sel.length);
      return true;
    }
    if (next && !/[\s)\],;]/.test(next)) return false;
    if (close === key && /[\w$'"`]/.test(prev)) return false; // a quote right after a word or another quote
    this.insert(key + close);
    this.moveTo(s + 1);
    if (key === '(' && this.signatures) this.updateSignature();
    return true;
  }

  moveTo(pos) {
    this.ta.setSelectionRange(pos, pos);
    this.markBrackets();
    if (this.sigEl) this.updateSignature();
    return true;
  }

  // ---------- autocompletion ----------

  wordAt(pos) {
    const v = this.ta.value;
    let s = pos;
    while (s > 0 && /[\w$]/.test(v[s - 1])) s--;
    let qualifier = null;
    if (v[s - 1] === '.') {
      const q = s - 1;
      if (v[q - 1] === '`') {
        const open = v.lastIndexOf('`', q - 2);
        qualifier = v.slice(open + 1, q - 1);
      } else {
        let qs = q;
        while (qs > 0 && /[\w$]/.test(v[qs - 1])) qs--;
        qualifier = v.slice(qs, q) || null;
      }
    }
    return { start: s, prefix: v.slice(s, pos), qualifier };
  }

  async openCompletion(explicit) {
    if (!this.completer || this.ta.readOnly) return;
    const pos = this.ta.selectionStart;
    const w = this.wordAt(pos);
    if (!explicit && !w.qualifier) return;
    const seq = (this.compSeq = (this.compSeq || 0) + 1);
    let items;
    try {
      items = await this.completer({ text: this.ta.value, pos, prefix: w.prefix, qualifier: w.qualifier });
    } catch {
      return;
    }
    if (seq !== this.compSeq || document.activeElement !== this.ta) return;
    // The caret may have moved on while the items loaded (e.g. Tab to the next snippet field).
    const { selectionStart: now, selectionEnd } = this.ta;
    if (now !== selectionEnd || now < w.start || !/^[\w$]*$/.test(this.ta.value.slice(w.start, now))) return;
    this.compAll = items || [];
    this.compStart = w.start;
    this.showCompletion(w.prefix);
  }

  refreshCompletion() {
    const pos = this.ta.selectionStart;
    const prefix = this.ta.value.slice(this.compStart, pos);
    if (pos < this.compStart || !/^[\w$]*$/.test(prefix)) return this.closeCompletion();
    this.showCompletion(prefix);
  }

  showCompletion(prefix) {
    const p = prefix.toLowerCase();
    const starts = [], contains = [];
    for (const it of this.compAll) {
      const l = it.label.toLowerCase();
      if (l.startsWith(p)) starts.push(it);
      else if (p.length > 1 && l.includes(p)) contains.push(it);
    }
    this.compList = starts.concat(contains).slice(0, 300);
    if (!this.compList.length) return this.closeCompletion();
    this.compSel = 0;
    if (!this.popup) {
      this.popup = h('div', { class: 'sqled-pop' });
      this.popup.addEventListener('mousedown', e => {
        e.preventDefault();
        const it = e.target.closest('.pi');
        if (it) { this.compSel = +it.dataset.i; this.acceptCompletion(); }
      });
      this.main.append(this.popup);
    }
    this.renderPopup();
    this.positionPopup();
  }

  renderPopup() {
    this.popup.innerHTML = this.compList.map((it, i) =>
      `<div class="pi${i === this.compSel ? ' sel' : ''}" data-i="${i}">${icon(it.icon || 'none')}<span class="pl">${esc(it.label)}</span><span class="pk">${esc(it.detail || '')}</span></div>`).join('');
    this.popup.children[this.compSel]?.scrollIntoView({ block: 'nearest' });
  }

  positionPopup() {
    const { x, y } = this.caretXY(this.compStart);
    const maxX = this.main.clientWidth - 260;
    this.popup.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
    const below = y + 2;
    this.popup.style.top = (below + 200 > this.main.clientHeight && y > 220 ? y - 222 : below) + 'px';
  }

  caretXY(pos) {
    const ta = this.ta, v = ta.value;
    const cs = getComputedStyle(ta);
    if (!this.charW || this.charFont !== cs.font) {
      measureCtx.font = cs.font;
      this.charW = measureCtx.measureText('MMMMMMMMMM').width / 10;
      this.charFont = cs.font;
    }
    const ls = v.lastIndexOf('\n', pos - 1) + 1;
    let line = 0;
    for (let i = v.indexOf('\n'); i >= 0 && i < ls; i = v.indexOf('\n', i + 1)) line++;
    const col = v.slice(ls, pos).replace(/\t/g, '    ').length;
    const lh = parseFloat(cs.lineHeight) || 18;
    return {
      x: parseFloat(cs.paddingLeft) + col * this.charW - ta.scrollLeft,
      y: parseFloat(cs.paddingTop) + (line + 1) * lh - ta.scrollTop,
    };
  }

  acceptCompletion() {
    const it = this.compList?.[this.compSel];
    const pos = this.ta.selectionStart;
    this.closeCompletion();
    if (!it) return;
    if (it.snippet != null) return this.insertSnippet(it.snippet, { from: this.compStart, to: pos });
    this.ta.setSelectionRange(this.compStart, pos);
    const text = it.insert ?? it.label;
    // A function: with auto-closing its ")" comes along, and the caret goes between the brackets.
    if (SqlEditor.autoClose && text.endsWith('(') && /^$|^[\s)\],;]/.test(this.ta.value[pos] ?? '')) {
      this.insert(text + ')');
      this.moveTo(this.ta.selectionStart - 1);
      if (this.signatures) this.updateSignature();
      return;
    }
    this.insert(text);
  }

  closeCompletion() {
    this.compSeq = (this.compSeq || 0) + 1;
    this.popup?.remove();
    this.popup = null;
  }

  // ---------- parameter hints ----------

  /** Shows (or updates, or closes) the hint for the call the caret is in. */
  async updateSignature() {
    const pos = this.ta.selectionStart;
    const call = this.ta.selectionEnd === pos ? callAt(this.ta.value, pos) : null;
    const seq = (this.sigSeq = (this.sigSeq || 0) + 1);
    let sig = null;
    if (call) {
      try { sig = await this.signatures(call); } catch { /* no hint */ }
    }
    if (seq !== this.sigSeq) return;
    if (!sig || document.activeElement !== this.ta) return this.closeSignature();
    const act = activeParam(sig.params, call.argIndex);
    if (!this.sigEl) {
      this.sigEl = h('div', { class: 'sqled-sig' });
      this.sigEl.addEventListener('mousedown', e => e.preventDefault()); // keep the focus in the editor
      this.main.append(this.sigEl);
    }
    this.sigEl.innerHTML = `<div class="sig-line"><span class="sig-name">${esc(sig.name)}</span>(${
      sig.params.map((p, i) => `<span class="sig-p${i === act ? ' on' : ''}">${esc(p)}</span>`).join(', ')})${
      sig.returns ? ` <span class="sig-ret">→ ${esc(sig.returns)}</span>` : ''}</div>${sig.doc ? `<div class="sig-doc">${esc(sig.doc)}</div>` : ''}`;
    this.sigOpen = call.open;
    this.positionSignature();
  }

  /** Above the caret's line, starting at the call's "("; below the line when there is no room above. */
  positionSignature() {
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 18;
    const { x } = this.caretXY(this.sigOpen);
    const { y } = this.caretXY(this.ta.selectionStart);
    const maxX = Math.max(0, this.main.clientWidth - this.sigEl.offsetWidth - 4);
    this.sigEl.style.left = Math.max(0, Math.min(x - 8, maxX)) + 'px';
    const above = y - lh - this.sigEl.offsetHeight - 2;
    this.sigEl.style.top = (above >= 0 ? above : y + 2) + 'px';
  }

  closeSignature() {
    this.sigSeq = (this.sigSeq || 0) + 1;
    this.sigEl?.remove();
    this.sigEl = null;
  }

  // ---------- snippets ----------

  /** Tab after a snippet trigger (with no selection) expands it; false when there is nothing to expand. */
  expandTrigger() {
    const { selectionStart: pos, selectionEnd } = this.ta;
    if (!this.snippets || pos !== selectionEnd) return false;
    const w = this.wordAt(pos);
    if (w.qualifier || !w.prefix) return false;
    const sn = this.snippets.lookup(w.prefix);
    if (!sn) return false;
    this.insertSnippet(sn.body, { from: w.start, to: pos });
    return true;
  }

  /**
   * Inserts an expanded snippet over [from, to) (default: the selection, which becomes ${SELECTION}),
   * then selects the first tab stop. Undo removes the whole insertion.
   */
  insertSnippet(body, { from, to } = {}) {
    const ta = this.ta, v = ta.value;
    const selected = from == null ? v.slice(ta.selectionStart, ta.selectionEnd) : '';
    from ??= ta.selectionStart;
    to ??= ta.selectionEnd;
    const indent = /^[ \t]*/.exec(v.slice(v.lastIndexOf('\n', from - 1) + 1, from))[0];
    const r = expandSnippet(body, { ...(this.snippets?.vars?.() || {}), SELECTION: selected }, indent);
    this.endSnippet();
    ta.focus();
    ta.setSelectionRange(from, to);
    this.insert(r.text);
    const stops = r.stops.map(st => ({ start: from + st.start, end: from + st.end }));
    stops.push({ start: from + r.cursor, end: from + r.cursor, final: true });
    if (stops.length === 1) return this.selectRange(stops[0].start, stops[0].end);
    this.snip = { stops, i: 0 };
    this.el.classList.add('snippet-active');
    this.gotoStop(0);
  }

  gotoStop(i) {
    const sn = this.snip;
    if (!sn) return;
    sn.i = Math.max(0, Math.min(i, sn.stops.length - 1));
    const st = sn.stops[sn.i];
    this.selectRange(st.start, st.end);
    if (st.final) this.endSnippet();
  }

  endSnippet() {
    this.snip = null;
    this.snipPre = null;
    this.el.classList.remove('snippet-active');
  }

  /** Keeps tab stops in place while the active field is edited; an edit elsewhere (or undo) ends the snippet. */
  trackSnippetEdit() {
    const pre = this.snipPre, sn = this.snip;
    this.snipPre = null;
    const cur = sn.stops[sn.i];
    if (!pre || pre.type?.startsWith('history')) return this.endSnippet();
    let rs = pre.s, re = pre.e;
    if (rs === re && pre.type === 'deleteContentBackward') rs--;
    if (rs === re && pre.type === 'deleteContentForward') re++;
    if (rs < cur.start || re > cur.end) return this.endSnippet();
    const delta = this.ta.value.length - pre.len;
    const oldEnd = cur.end;
    cur.end += delta;
    for (const st of sn.stops) {
      if (st === cur || st.start < oldEnd) continue;
      st.start += delta;
      st.end += delta;
    }
  }
}
