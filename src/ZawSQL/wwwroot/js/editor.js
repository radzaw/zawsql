// Lightweight SQL editor: a transparent <textarea> over a syntax-highlighted <pre>,
// with line numbers, auto-indent, block indent, comment toggling and autocompletion.
import { h, esc } from './util.js';
import { icon } from './icons.js';

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

const TOKEN_RE = /(--(?=\s|$)[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\]|\\[\s\S])*(?:'|$)|"(?:[^"\\]|\\[\s\S])*(?:"|$))|(`[^`]*(?:`|$))|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(@@?[\w$.]*|[A-Za-z_$][\w$]*)|(\s+|[\s\S])/g;

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
    else if (m[5]) {
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
  constructor({ value = '', completer = null, onChange = null, readOnly = false, placeholder = '' } = {}) {
    this.completer = completer;
    this.onChange = onChange;
    this.lines = 0;
    this.gutterInner = h('div', { class: 'sqled-lines' });
    this.gutter = h('div', { class: 'sqled-gutter' }, this.gutterInner);
    this.code = h('code');
    this.pre = h('pre', { class: 'sqled-hl', 'aria-hidden': 'true' }, this.code);
    this.ta = h('textarea', { class: 'sqled-ta', spellcheck: false, autocomplete: 'off', autocapitalize: 'off', wrap: 'off', placeholder });
    this.main = h('div', { class: 'sqled-main' }, this.pre, this.ta);
    this.el = h('div', { class: 'sqled' }, this.gutter, this.main);
    this.ta.value = value;
    this.ta.readOnly = readOnly;
    this.ta.addEventListener('input', () => {
      this.scheduleUpdate();
      this.onChange?.();
      if (this.popup) this.refreshCompletion();
    });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', e => this.onKey(e));
    this.ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== this.ta) this.closeCompletion(); }, 150));
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
    if (this.popup) {
      const n = this.compList.length;
      if (e.key === 'ArrowDown') { this.compSel = (this.compSel + 1) % n; this.renderPopup(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { this.compSel = (this.compSel - 1 + n) % n; this.renderPopup(); e.preventDefault(); return; }
      if (e.key === 'PageDown') { this.compSel = Math.min(n - 1, this.compSel + 8); this.renderPopup(); e.preventDefault(); return; }
      if (e.key === 'PageUp') { this.compSel = Math.max(0, this.compSel - 8); this.renderPopup(); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { this.acceptCompletion(); e.preventDefault(); return; }
      if (e.key === 'Escape') { this.closeCompletion(); e.preventDefault(); e.stopPropagation(); return; }
    }
    if (this.ta.readOnly) return;
    if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); this.openCompletion(true); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { e.preventDefault(); this.indent(e.shiftKey); return; }
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
    this.ta.setSelectionRange(this.compStart, pos);
    this.insert(it.insert ?? it.label);
  }

  closeCompletion() {
    this.compSeq = (this.compSeq || 0) + 1;
    this.popup?.remove();
    this.popup = null;
  }
}
