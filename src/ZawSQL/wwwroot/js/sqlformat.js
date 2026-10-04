// SQL formatter for MySQL / MariaDB scripts: clause-per-line layout, indented subqueries, joins, conditions,
// CASE, column definitions and stored-program blocks, with keyword case normalized.
// Only whitespace and the letter case of keywords ever change: formatSql() re-tokenizes its output and
// throws (leaving the caller's text alone) if anything else would differ.
import { KEYWORDS, FUNCTIONS } from './editor.js';

const words = s => new Set(s.trim().split(/\s+/));

// Reserved in MySQL and MariaDB: these can't be unquoted identifiers, so changing their case is always safe.
const RESERVED = words(`ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY CALL
CASCADE CASE CHANGE CHAR CHARACTER CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS CURRENT_DATE
CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DATABASES DAY_HOUR DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC DECIMAL
DECLARE DEFAULT DELAYED DELETE DESC DESCRIBE DETERMINISTIC DISTINCT DISTINCTROW DIV DOUBLE DROP DUAL EACH ELSE ELSEIF ENCLOSED
ESCAPED EXISTS EXIT EXPLAIN FALSE FETCH FLOAT FLOAT4 FLOAT8 FOR FORCE FOREIGN FROM FULLTEXT GENERATED GET GRANT GROUP HAVING
HIGH_PRIORITY HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE IN INDEX INFILE INNER INOUT INSENSITIVE INSERT INT INT1 INT2 INT3
INT4 INT8 INTEGER INTERVAL INTO IS ITERATE JOIN KEY KEYS KILL LEADING LEAVE LEFT LIKE LIMIT LINEAR LINES LOAD LOCALTIME
LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP LOW_PRIORITY MATCH MAXVALUE MEDIUMBLOB MEDIUMINT MEDIUMTEXT MIDDLEINT
MINUTE_MICROSECOND MINUTE_SECOND MOD MODIFIES NATURAL NOT NO_WRITE_TO_BINLOG NULL NUMERIC ON OPTIMIZE OPTION OPTIONALLY OR ORDER
OUT OUTER OUTFILE PARTITION PRECISION PRIMARY PROCEDURE PURGE RANGE READ READS READ_WRITE REAL REFERENCES REGEXP RELEASE RENAME
REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN REVOKE RIGHT RLIKE SCHEMA SCHEMAS SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR
SET SHOW SIGNAL SMALLINT SPATIAL SPECIFIC SQL SQLEXCEPTION SQLSTATE SQLWARNING SQL_BIG_RESULT SQL_CALC_FOUND_ROWS
SQL_SMALL_RESULT SSL STARTING STORED STRAIGHT_JOIN TABLE TERMINATED THEN TINYBLOB TINYINT TINYTEXT TO TRAILING TRIGGER TRUE UNDO
UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING UTC_DATE UTC_TIME UTC_TIMESTAMP VALUES VARBINARY VARCHAR VARCHARACTER
VARYING VIRTUAL WHEN WHERE WHILE WITH WRITE XOR YEAR_MONTH ZEROFILL`);

// Keywords that are (almost) never column names: changed wherever they aren't in a name position.
const ALWAYS = words(`AFTER NAMES AUTO_INCREMENT ALGORITHM BEGIN CHARSET COLUMNS COMMIT DATABASES DEFINER DELIMITER DO DUPLICATE END ENGINE
EXCEPT FOUND HANDLER INTERSECT INVOKER MODIFY OFFSET OVER PROCESSLIST RECURSIVE RETURNS ROLLBACK ROW ROWS SECURITY START TABLES
TEMPORARY TRANSACTION UNTIL VARIABLES WINDOW LATERAL ROLLUP`);

const TYPES = words(`BIT BOOL BOOLEAN DATE DATETIME TIME TIMESTAMP YEAR TEXT ENUM SET JSON GEOMETRY POINT LINESTRING POLYGON
MULTIPOINT MULTILINESTRING MULTIPOLYGON GEOMETRYCOLLECTION SERIAL NCHAR NVARCHAR FIXED`);

// After these words comes a name (table, alias, routine, column…) whose case must stay as typed.
const NAME_CTX = words(`FROM JOIN INTO UPDATE TABLE TABLES REFERENCES DESCRIBE DESC EXPLAIN TRUNCATE USE TO AS LIKE DATABASE SCHEMA
VIEW TRIGGER PROCEDURE FUNCTION EVENT INDEX KEY COLUMN AFTER CHANGE MODIFY STRAIGHT_JOIN ON CALL`);
const NAME_EXCEPT = {
  ON: words('DUPLICATE SCHEDULE COMPLETION DELETE UPDATE'),
  TABLE: words('STATUS'), TABLES: words('STATUS'), FUNCTION: words('STATUS CODE'), PROCEDURE: words('STATUS CODE'),
  DESC: words('LIMIT'), INTO: words('OUTFILE DUMPFILE'),
};
const OPTION_WORDS = words('ENGINE CHARSET AUTO_INCREMENT ALGORITHM DEFINER ROW_FORMAT KEY_BLOCK_SIZE');
// "=" after these keeps its spacing as typed (ENGINE=InnoDB, DEFINER=`root`@`%`).
const OPTION_EQ = words('ENGINE CHARSET COLLATE AUTO_INCREMENT ALGORITHM DEFINER ROW_FORMAT KEY_BLOCK_SIZE COMMENT CHECKSUM COMPRESSION STATS_PERSISTENT');
const INTERVAL_UNITS = words('MICROSECOND SECOND MINUTE HOUR DAY WEEK MONTH QUARTER YEAR');
// Object kinds in DDL (CREATE VIEW, DROP EVENT …) and words that only start statements (OPEN cur).
const OBJECT_KINDS = words('VIEW EVENT FUNCTION USER ROLE SERVER TABLESPACE');
const STMT_WORDS = words('OPEN CLOSE');
// A keyword-looking word followed by one of these is an expression (ORDER BY date DESC), not a keyword.
const EXPR_FOLLOW = words(`ASC DESC AS AND OR XOR IS NOT IN LIKE RLIKE REGEXP BETWEEN FROM WHERE GROUP ORDER HAVING LIMIT UNION
THEN ELSE END WHEN ON USING INTO SEPARATOR COLLATE DIV MOD`);

// Reserved words that always get a space before "(" (no built-in function call can depend on it).
const SPACE_BEFORE_PAREN = words(`IN AS AND OR XOR NOT ON USING FROM JOIN WHERE SELECT EXISTS ALL ANY SOME THEN ELSE WHEN BY
UNION INTO KEY INDEX IS LIKE BETWEEN HAVING SET RETURN DISTINCT`);

const SELECT_MODS = words(`ALL DISTINCT DISTINCTROW HIGH_PRIORITY STRAIGHT_JOIN SQL_SMALL_RESULT SQL_BIG_RESULT SQL_BUFFER_RESULT
SQL_NO_CACHE SQL_CACHE SQL_CALC_FOUND_ROWS`);
const JOIN_PREFIX = words('NATURAL LEFT RIGHT INNER CROSS OUTER FULL');
const QUERY_START = words('SELECT WITH INSERT REPLACE UPDATE DELETE VALUES');
const BLOCK_END = words('IF LOOP WHILE REPEAT CASE');

const CLAUSES = [
  ['ON', 'DUPLICATE', 'KEY', 'UPDATE'], ['LOCK', 'IN', 'SHARE', 'MODE'], ['FOR', 'UPDATE'], ['FOR', 'SHARE'],
  ['GROUP', 'BY'], ['ORDER', 'BY'], ['UNION', 'ALL'], ['UNION', 'DISTINCT'], ['UNION'], ['INTERSECT'], ['EXCEPT'],
  ['WITH', 'RECURSIVE'], ['WITH'], ['SELECT'], ['FROM'], ['WHERE'], ['HAVING'], ['WINDOW'], ['LIMIT'], ['INTO'],
  ['INSERT'], ['REPLACE'], ['UPDATE'], ['DELETE'], ['VALUES'], ['VALUE'], ['SET'], ['RETURNING'],
].map(w => ({ w, key: w.join(' ') }));

export class FormatError extends Error {}

// ---------------------------------------------------------------- tokens

const OPS = ['<=>', '->>', '->', '<=', '>=', '<>', '!=', ':=', '||', '&&', '<<', '>>'];
const DELIM_RE = /delimiter[ \t]+(\S+)[^\n]*/iy;
const NUM_RE = /0x[0-9a-fA-F]+|0b[01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[\w$\u0080-￿]+/y;
const WORD_RE = /[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/y;
const VAR_RE = /@@?[\w$]+(?:\.[\w$]+)*/y;

/**
 * Tokens: {t, v, sp (whitespace before), nl (newline before), bl (blank line before), U (upper-case word)}.
 * Types: word, qid (`quoted`), str, num, op, p ( ( ) , . ), semi, delim (custom delimiter), delimcmd,
 * lc (line comment), bc (block comment), ex (executable comment or optimizer hint).
 */
export function tokenize(text) {
  const toks = [];
  const n = text.length;
  let i = 0, delim = ';', sp = false, nls = 0;
  const push = (t, v, extra) => {
    const tok = { t, v, sp, nl: nls > 0, bl: nls > 1, ...extra };
    // After "." a word is a name (t.select, db.order), never a keyword: its U can't match any keyword.
    if (t === 'word') tok.U = (toks[toks.length - 1]?.v === '.' && toks[toks.length - 1].t === 'p' ? '.' : '') + v.toUpperCase();
    toks.push(tok);
    sp = false;
    nls = 0;
    return tok;
  };
  const atStatementStart = () => {
    for (let k = toks.length - 1; k >= 0; k--) {
      const t = toks[k];
      if (t.t === 'lc' || t.t === 'bc') continue;
      return t.t === 'delim' || t.t === 'delimcmd' || (t.t === 'semi' && delim === ';');
    }
    return true;
  };
  while (i < n) {
    const c = text[i];
    if (c === '\n') { nls++; sp = true; i++; continue; }
    if (/\s/.test(c)) { sp = true; i++; continue; }
    if ((nls > 0 || toks.length === 0) && (c === 'd' || c === 'D') && atStatementStart()) {
      DELIM_RE.lastIndex = i;
      const m = DELIM_RE.exec(text);
      if (m) {
        push('delimcmd', m[0].trimEnd(), { d: m[1] });
        delim = m[1];
        i = DELIM_RE.lastIndex;
        continue;
      }
    }
    if (c === '#' || (c === '-' && text[i + 1] === '-' && (i + 2 >= n || /\s/.test(text[i + 2])))) {
      let e = text.indexOf('\n', i);
      if (e < 0) e = n;
      push('lc', text.slice(i, e).trimEnd());
      i = e;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let e = text.indexOf('*/', i + 2);
      e = e < 0 ? n : e + 2;
      const v = text.slice(i, e);
      push(/^\/\*[!+]/.test(v) ? 'ex' : 'bc', v);
      i = e;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const e = skipQuoted(text, i, c);
      const v = text.slice(i, e);
      const prev = toks[toks.length - 1];
      // Charset introducers and hex/bit literals: _utf8mb4'x', N'x', X'0F', b'01'.
      if (c !== '`' && !sp && prev?.t === 'word' && /^(_[A-Za-z0-9]+|[nNxXbB])$/.test(prev.v)) {
        prev.t = 'str';
        prev.v += v;
        delete prev.U;
      } else push(c === '`' ? 'qid' : 'str', v);
      i = e;
      continue;
    }
    if (delim !== ';' && text.startsWith(delim, i)) { push('delim', delim); i += delim.length; continue; }
    const prev = toks[toks.length - 1];
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? '') && !(prev && (prev.t === 'word' || prev.t === 'qid' || prev.v === ')')))) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(text);
      if (/[\w$]/.test(text[i + m[0].length] ?? '')) { // identifiers may start with digits: 1st_place
        IDENT_RE.lastIndex = i;
        const w = IDENT_RE.exec(text)[0];
        push('word', w);
        i += w.length;
      } else {
        push('num', m[0]);
        i += m[0].length;
      }
      continue;
    }
    if (c === '@') {
      VAR_RE.lastIndex = i;
      const m = VAR_RE.exec(text);
      if (m) { push('word', m[0]); i += m[0].length; continue; }
    }
    WORD_RE.lastIndex = i;
    const w = WORD_RE.exec(text);
    if (w) {
      const v = cutAtDelimiter(w[0], delim);
      push('word', v);
      i += v.length;
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === '.') { push('p', c); i++; continue; }
    if (c === ';') { push('semi', ';'); i++; continue; }
    if (c === '?') { push('num', '?'); i++; continue; }
    // :name query parameters are one value; right after a name ("lbl:" labels) the colon is punctuation.
    if (c === ':' && /[A-Za-z_]/.test(text[i + 1] ?? '') && !(prev && !sp && (prev.t === 'word' || prev.t === 'qid' || prev.v === ')' || prev.v === ':'))) {
      let e = i + 1;
      while (e < n && /\w/.test(text[e])) e++;
      push('num', text.slice(i, e));
      i = e;
      continue;
    }
    const op = OPS.find(o => text.startsWith(o, i)) || c;
    push('op', op);
    i += op.length;
  }
  return toks;
}

/** "END$" with delimiter $ is the word END followed by the delimiter. */
function cutAtDelimiter(v, delim) {
  if (delim === ';') return v;
  const k = v.indexOf(delim);
  return k > 0 ? v.slice(0, k) : v;
}

function skipQuoted(t, i, q) {
  i++;
  while (i < t.length) {
    const c = t[i];
    if (c === '\\' && q !== '`') { i += 2; continue; }
    if (c === q) {
      if (t[i + 1] === q) { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return t.length;
}

const isComment = x => !x.g && !x.c && (x.t === 'lc' || x.t === 'bc');
const isTok = x => !x.g && !x.c;
const word = (x, ...ws) => !!x && isTok(x) && x.t === 'word' && ws.includes(x.U);
const isKeywordTok = t => t?.t === 'word' && t.v[0] !== '@' && (RESERVED.has(t.U) || KEYWORDS.has(t.U) || ALWAYS.has(t.U));
const isIdentTok = t => t && ((t.t === 'word' && t.v[0] !== '@' && !isKeywordTok(t)) || t.t === 'qid');

/** What must survive formatting: every token, word case aside, and calls glued to their "(". */
function signature(toks) {
  return toks.map((t, k) => {
    const next = toks[k + 1];
    switch (t.t) {
      case 'word': return 'w' + t.U + (next?.v === '(' && next.t === 'p' && !next.sp && !SPACE_BEFORE_PAREN.has(t.U) ? '(' : '');
      case 'lc': return 'c' + t.v.trim();
      case 'op': return t.v === '@' ? 'o@' + (t.sp ? ' ' : '') + (next && next.sp ? ' ' : '') : 'o' + t.v;
      default: return t.t[0] + t.v;
    }
  }).join('\u0001');
}

// ---------------------------------------------------------------- keyword case

/** True when a token after `prev` begins a statement (also inside BEGIN … END bodies). */
const startsStatement = prev => !prev || prev.t === 'semi' || prev.t === 'delim' || (prev.t === 'op' && prev.v === ':')
  || (prev.t === 'word' && ['BEGIN', 'THEN', 'ELSE', 'DO', 'LOOP', 'REPEAT'].includes(prev.U));

function applyCase(toks, mode) {
  for (const t of toks) t.d = t.v;
  if (mode === 'keep') return;
  const conv = mode === 'lower' ? s => s.toLowerCase() : s => s.toUpperCase();
  const sig = toks.filter(t => t.t !== 'lc' && t.t !== 'bc');
  const first = sig.find(t => t.t === 'word')?.U;
  const typesCtx = first === 'CREATE' || first === 'ALTER' || first === 'DECLARE';
  const ddl = typesCtx || first === 'DROP' || first === 'SHOW';
  sig.forEach((t, k) => {
    if (t.t !== 'word' || t.v[0] === '@') return;
    const U = t.U, prev = sig[k - 1], next = sig[k + 1];
    if (prev?.v === '.' || next?.v === '.') return; // part of a qualified name
    let change = false;
    if (RESERVED.has(U)) change = true;
    else if (FUNCTIONS.has(U) && next?.v === '(' && !next.sp) change = true;
    else if (INTERVAL_UNITS.has(U) && sig[k - 2]?.U === 'INTERVAL') change = true;
    else if (STMT_WORDS.has(U)) change = startsStatement(prev);
    else if (ddl && OBJECT_KINDS.has(U) && !(prev?.t === 'word' && NAME_CTX.has(prev.U))) change = true;
    else if (KEYWORDS.has(U) || ALWAYS.has(U) || TYPES.has(U)) {
      const pU = prev?.t === 'word' ? prev.U : null;
      if (pU && NAME_CTX.has(pU) && !NAME_EXCEPT[pU]?.has(U)) change = false;
      else if (ALWAYS.has(U)) change = true;
      else if (typesCtx && TYPES.has(U) && isIdentTok(prev)) change = true; // column / variable type
      else if (OPTION_WORDS.has(U) && next?.v === '=') change = true;
      else if (prev && (prev.v === ',' || prev.v === '(')) change = false; // a column in a list
      else if (first === 'SHOW') change = true;
      else if (!prev || (isKeywordTok(next) && !EXPR_FOLLOW.has(next.U))) change = true;
      else if (isKeywordTok(prev) && (!next || next.t === 'semi' || next.t === 'delim')) change = true;
    }
    if (change) t.d = conv(t.v);
  });
}

// ---------------------------------------------------------------- tree: ( … ) groups and CASE … END

function build(toks) {
  const root = { items: [] };
  const stack = [root];
  for (const t of toks) {
    const top = stack[stack.length - 1];
    if (t.t === 'p' && t.v === '(') {
      const g = { g: true, open: t, items: [], close: null };
      top.items.push(g);
      stack.push(g);
    } else if (t.t === 'p' && t.v === ')') {
      while (stack.length > 1 && stack[stack.length - 1].c) stack.pop();
      if (stack.length > 1) stack.pop().close = t;
      else root.items.push(t);
    } else if (t.t === 'word' && t.U === 'CASE') {
      const c = { c: true, items: [t] };
      top.items.push(c);
      stack.push(c);
    } else if (t.t === 'word' && t.U === 'END' && top.c) {
      top.items.push(t);
      stack.pop();
    } else top.items.push(t);
  }
  return root.items;
}

const firstSig = items => items.find(x => !isComment(x));
function isSubquery(items) {
  const f = firstSig(items);
  if (!f) return false;
  if (word(f, 'SELECT', 'WITH')) return true;
  return !!f.g && isSubquery(f.items) && items.some(x => word(x, 'UNION', 'INTERSECT', 'EXCEPT'));
}

// ---------------------------------------------------------------- lines

let O; // options of the running format

const L = (i, s = '', lc = false) => ({ i, s, lc });

/** Appends text to the last line (a new line when that one ends in a line comment). */
function add(lines, s, space = true, lc = false) {
  const last = lines[lines.length - 1];
  if (!last) lines.push(L(0, s, lc));
  else if (last.lc) lines.push(L(last.i, s, lc));
  else {
    last.s += (last.s && space && s ? ' ' : '') + s;
    last.lc = lc || (last.lc && !s);
  }
  return lines;
}

/** Continues the last line with more[0], then adds the remaining lines. */
function join(lines, more, space = true) {
  if (!more.length) return lines;
  add(lines, more[0].s, space, more[0].lc);
  for (let k = 1; k < more.length; k++) lines.push(more[k]);
  return lines;
}

const width = (i, s) => O.unit.length * i + s.length;

function space(a, b) {
  if (!a || !b) return false;
  if (b.t === 'p' && (b.v === ',' || b.v === ')')) return false;
  if (b.t === 'semi' || b.t === 'delim') return false;
  if (a.t === 'p' && a.v === '(') return false;
  if ((a.t === 'p' && a.v === '.') || (b.t === 'p' && b.v === '.')) return false;
  if (a.t === 'op' && b.t === 'op' && (a.v === '-' || a.v === '+') && (b.v === '-' || b.v === '+')) return true; // never "--"
  if (a.unary) return false;
  if ((a.t === 'op' && a.v === '@') || (b.t === 'op' && b.v === '@')) return b.sp;
  if ((a.t === 'op' && (a.v === '->' || a.v === '->>')) || (b.t === 'op' && (b.v === '->' || b.v === '->>'))) return false;
  if (b.t === 'op' && b.v === ':') return false;
  if (b.t === 'op' && b.v === '=' && a.t === 'word' && OPTION_EQ.has(a.U)) { b.keepSp = true; return b.sp; }
  if (a.keepSp) return b.sp;
  if (b.t === 'p' && b.v === '(') {
    if (a.t === 'word') return SPACE_BEFORE_PAREN.has(a.U) ? true : b.sp;
    if (a.t === 'qid') return b.sp;
  }
  return true;
}

function markUnary(t, prev) {
  if (t.t !== 'op') return;
  if (t.v === '!' || t.v === '~') t.unary = true;
  else if (t.v === '-' || t.v === '+') {
    t.unary = !prev || (prev.t === 'op' && !prev.unary) || prev.unary || (prev.t === 'p' && (prev.v === '(' || prev.v === ','))
      || (isKeywordTok(prev) && !['END', 'NULL', 'TRUE', 'FALSE'].includes(prev.U));
  }
}

/** An expression on one line, except where subqueries, long CASEs or line comments need more. */
function expr(items, i) {
  const lines = [L(i)];
  let prev = null;
  for (const x of items) {
    if (isComment(x)) {
      const cur = lines[lines.length - 1];
      if (x.nl && cur.s) lines.push(L(i, x.v, x.t === 'lc'));
      else add(lines, x.v, true, x.t === 'lc');
    } else if (x.g) {
      const sp = space(prev, x.open);
      if (isSubquery(x.items)) {
        add(lines, '(', sp);
        lines.push(...query(x.items, i + 1));
        if (x.close) lines.push(L(i, ')'));
      } else {
        const inner = expr(x.items, i + 1);
        if (inner.length === 1 && !inner[0].lc) add(lines, '(' + inner[0].s + (x.close ? ')' : ''), sp);
        else {
          add(lines, '(' + inner[0].s, sp, inner[0].lc);
          lines.push(...inner.slice(1));
          if (x.close) add(lines, ')', false);
        }
      }
      prev = x.close || x.open;
    } else if (x.c) {
      join(lines, caseExpr(x, i), space(prev, x.items[0]));
      prev = x.items[x.items.length - 1];
    } else {
      markUnary(x, prev);
      add(lines, x.d ?? x.v, space(prev, x));
      prev = x;
    }
  }
  return lines;
}

/** CASE on one line when short, else WHEN / ELSE lines indented under CASE and END. */
function caseExpr(node, i) {
  const flat = expr(node.items, i);
  if (flat.length === 1 && !flat[0].lc && flat[0].s.length <= Math.min(60, O.width - O.unit.length * i)) return flat;
  const items = node.items;
  const hasEnd = word(items[items.length - 1], 'END') && items.length > 1;
  const inner = items.slice(1, hasEnd ? -1 : undefined);
  const segs = [[]];
  for (const x of inner) {
    if (word(x, 'WHEN', 'ELSE')) segs.push([x]);
    else segs[segs.length - 1].push(x);
  }
  const lines = join([L(i, items[0].d)], expr(segs[0], i));
  for (const s of segs.slice(1)) lines.push(...expr(s, i + 1));
  if (hasEnd) lines.push(L(i, items[items.length - 1].d));
  return lines;
}

// ---------------------------------------------------------------- queries

function matchClause(items, k) {
  for (const c of CLAUSES) {
    if (c.w.every((w, n) => word(items[k + n], w))) return c;
  }
  return null;
}

function splitClauses(items) {
  const out = [];
  let cur = { key: null, kw: [], body: [] };
  const seen = key => cur.key === key || out.some(c => c.key === key);
  for (let k = 0; k < items.length;) {
    const m = matchClause(items, k);
    const start = !out.length && !cur.key && !cur.body.some(x => !isComment(x));
    const firstKey = out.find(c => c.key)?.key ?? cur.key;
    let ok = !!m;
    if (m) {
      switch (m.key) {
        case 'WITH': case 'WITH RECURSIVE': case 'INSERT': case 'REPLACE': case 'UPDATE': case 'DELETE': ok = start; break;
        case 'VALUES': case 'VALUE': ok = start || cur.key === 'INSERT' || cur.key === 'REPLACE'; break;
        case 'SET': ok = ['UPDATE', 'INSERT', 'REPLACE'].includes(cur.key); break;
        case 'INTO': ok = seen('SELECT') && firstKey !== 'INSERT' && firstKey !== 'REPLACE'; break;
        case 'WINDOW': ok = seen('SELECT'); break;
      }
    }
    if (ok) {
      if (cur.key || cur.body.length) out.push(cur);
      cur = { key: m.key, kw: items.slice(k, k + m.w.length), body: [] };
      k += m.w.length;
    } else cur.body.push(items[k++]);
  }
  out.push(cur);
  // DELETE [modifiers] FROM t → one clause.
  for (let k = 0; k < out.length - 1; k++) {
    const c = out[k];
    if (c.key === 'DELETE' && out[k + 1].key === 'FROM' && c.body.every(x => word(x, 'LOW_PRIORITY', 'QUICK', 'IGNORE'))) {
      out.splice(k, 2, { key: 'DELETE FROM', kw: [...c.kw, ...c.body, ...out[k + 1].kw], body: out[k + 1].body });
    }
  }
  return out;
}

function query(items, i) {
  const lines = [];
  let k = 0;
  for (; k < items.length && isComment(items[k]); k++) lines.push(L(i, items[k].v, items[k].t === 'lc'));
  for (const c of splitClauses(items.slice(k))) lines.push(...clause(c, i));
  return lines;
}

function clause(c, i) {
  const kw = c.kw.map(t => t.d ?? t.v).join(' ');
  switch (c.key) {
    case null: return expr(c.body, i);
    case 'SELECT': {
      let k = 0;
      const mods = [];
      while (k < c.body.length && isTok(c.body[k]) && (SELECT_MODS.has(c.body[k].U) || c.body[k].t === 'ex')) mods.push(c.body[k++].d);
      return list([kw, ...mods].join(' '), c.body.slice(k), i);
    }
    case 'GROUP BY': case 'ORDER BY': case 'SET': case 'ON DUPLICATE KEY UPDATE': case 'RETURNING': case 'WINDOW':
    case 'VALUES': case 'VALUE':
      return list(kw, c.body, i);
    case 'WHERE': case 'HAVING': return conditions(kw, c.body, i, i + 1);
    case 'FROM': case 'UPDATE': case 'DELETE FROM': return from(kw, c.body, i);
    case 'WITH': case 'WITH RECURSIVE': return withClause(kw, c.body, i);
    default: return join([L(i, kw)], expr(c.body, i));
  }
}

/** Splits at top-level commas; a comment right after a comma stays with the item before it. */
function splitCommas(items) {
  const parts = [{ items: [], trail: null }];
  for (let k = 0; k < items.length; k++) {
    const x = items[k];
    if (isTok(x) && x.t === 'p' && x.v === ',') {
      const nx = items[k + 1];
      if (nx && isComment(nx) && !nx.nl) { parts[parts.length - 1].trail = nx; k++; }
      parts.push({ items: [], trail: null });
    } else parts[parts.length - 1].items.push(x);
  }
  return parts;
}

/** Items one per line under the keyword, or all on the keyword's line when that fits. */
function list(kw, body, i) {
  if (!body.length) return [L(i, kw)];
  const parts = splitCommas(body);
  if (parts.length === 1) return join([L(i, kw)], expr(body, i));
  const rendered = parts.map(p => expr(p.items, i + 1));
  if (rendered.every(r => r.length === 1 && !r[0].lc) && parts.every(p => !p.trail)) {
    const text = kw + ' ' + rendered.map(r => r[0].s).join(', ');
    if (width(i, text) <= O.width) return [L(i, text)];
  }
  const lines = [L(i, kw)];
  rendered.forEach((r, n) => {
    lines.push(...r);
    if (n < rendered.length - 1) add(lines, ',', false);
    if (parts[n].trail) add(lines, parts[n].trail.v, true, parts[n].trail.t === 'lc');
  });
  return lines;
}

/** Conditions split at top-level AND / OR / XOR (not the AND of BETWEEN). */
function splitConditions(items) {
  const out = [{ op: null, items: [] }];
  let between = false;
  for (const x of items) {
    if (word(x, 'BETWEEN')) between = true;
    if (word(x, 'AND', 'OR', 'XOR') && !(between && x.U === 'AND')) out.push({ op: x, items: [] });
    else {
      if (between && word(x, 'AND')) between = false;
      out[out.length - 1].items.push(x);
    }
  }
  return out;
}

function conditions(kw, body, i, ci) {
  const cs = splitConditions(body);
  const lines = join([L(i, kw)], expr(cs[0].items, i));
  for (const c of cs.slice(1)) lines.push(...join([L(ci, c.op.d)], expr(c.items, ci)));
  return lines;
}

function from(kw, body, i) {
  const segs = [{ kw: [], items: [] }];
  for (const x of body) {
    if (word(x, 'JOIN', 'STRAIGHT_JOIN')) {
      const prevItems = segs[segs.length - 1].items;
      let b = prevItems.length;
      while (b > 0 && word(prevItems[b - 1], ...JOIN_PREFIX)) b--;
      segs.push({ kw: [...prevItems.splice(b), x], items: [] });
    } else segs[segs.length - 1].items.push(x);
  }
  const lines = join([L(i, kw)], expr(segs[0].items, i));
  for (const s of segs.slice(1)) {
    const head = [L(i + 1, s.kw.map(t => t.d).join(' '))];
    const on = s.items.findIndex(x => word(x, 'ON'));
    if (on < 0) { lines.push(...join(head, expr(s.items, i + 1))); continue; }
    join(head, expr(s.items.slice(0, on), i + 1));
    add(head, s.items[on].d);
    lines.push(...conditionsOn(head, s.items.slice(on + 1), i + 2));
  }
  return lines;
}

function conditionsOn(head, items, ci) {
  const cs = splitConditions(items);
  join(head, expr(cs[0].items, ci - 1));
  for (const c of cs.slice(1)) head.push(...join([L(ci, c.op.d)], expr(c.items, ci)));
  return head;
}

function withClause(kw, body, i) {
  const parts = splitCommas(body);
  const lines = [L(i, kw)];
  parts.forEach((p, n) => {
    const r = expr(p.items, i);
    if (n === 0) join(lines, r);
    else {
      add(lines, ',', false);
      if (parts[n - 1].trail) add(lines, parts[n - 1].trail.v, true, parts[n - 1].trail.t === 'lc');
      lines.push(...r);
    }
  });
  const last = parts[parts.length - 1];
  if (last.trail) add(lines, last.trail.v, true, last.trail.t === 'lc');
  return lines;
}

// ---------------------------------------------------------------- statements

function statement(toks, i) {
  const items = build(toks);
  const lines = [];
  let k = 0;
  for (; k < items.length && isComment(items[k]); k++) lines.push(L(i, items[k].v, items[k].t === 'lc'));
  const body = items.slice(k);
  if (body.length) lines.push(...statementBody(body, i));
  return lines;
}

function statementBody(items, i) {
  const f = firstSig(items);
  const F = f && isTok(f) && f.t === 'word' ? f.U : null;
  if (QUERY_START.has(F) || (f?.g && isSubquery(f.items))) return query(items, i);
  if (F === 'CREATE') return create(items, i);
  if (F === 'ALTER') return alter(items, i);
  if (['EXPLAIN', 'DESCRIBE', 'DESC', 'DECLARE', 'RETURN'].includes(F)) {
    const q = items.findIndex((x, n) => n > 0 && word(x, 'SELECT', 'WITH'));
    if (q > 0 && F === 'DECLARE') return [...expr(items.slice(0, q), i), ...query(items.slice(q), i + 1)]; // … CURSOR FOR
    if (q > 0) return join(expr(items.slice(0, q), i), query(items.slice(q), i)); // EXPLAIN SELECT …
  }
  return expr(items, i);
}

function create(items, i) {
  const kind = items.findIndex(x => word(x, 'TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT', 'INDEX', 'DATABASE', 'SCHEMA', 'USER'));
  const K = kind >= 0 ? items[kind].U : null;
  const isQueryAt = n => { const x = items.slice(n).find(y => !isComment(y)); return !!x && (word(x, 'SELECT', 'WITH') || (!!x.g && isSubquery(x.items))); };
  if (K === 'VIEW') {
    const as = items.findIndex((x, n) => n > kind && word(x, 'AS') && isQueryAt(n + 1));
    if (as > 0) return [...expr(items.slice(0, as + 1), i), ...query(items.slice(as + 1), i)];
  }
  if (K === 'TABLE') {
    const g = items.findIndex((x, n) => n > kind && x.g);
    const sel = items.findIndex((x, n) => n > kind && word(x, 'SELECT', 'WITH'));
    if (g > 0 && (sel < 0 || g < sel) && !isSubquery(items[g].items)) {
      const lines = expr(items.slice(0, g), i);
      add(lines, '(', items[g].open.sp);
      const parts = splitCommas(items[g].items);
      parts.forEach((p, n) => {
        lines.push(...expr(p.items, i + 1));
        if (n < parts.length - 1) add(lines, ',', false);
        if (p.trail) add(lines, p.trail.v, true, p.trail.t === 'lc');
      });
      if (items[g].close) lines.push(L(i, ')'));
      const rest = items.slice(g + 1);
      const s = rest.findIndex(x => word(x, 'SELECT', 'WITH') || (!!x.g && isSubquery(x.items)));
      if (s < 0) return join(lines, expr(rest, i));
      if (s > 0) join(lines, expr(rest.slice(0, s), i));
      return [...lines, ...query(rest.slice(s), i)];
    }
    if (sel > 0) return [...expr(items.slice(0, sel), i), ...query(items.slice(sel), i)];
  }
  return expr(items, i);
}

/** ALTER TABLE t spec, spec → one specification per line. */
function alter(items, i) {
  const parts = splitCommas(items);
  const p0 = parts[0].items;
  const t = p0.findIndex(x => word(x, 'TABLE'));
  if (parts.length < 2 || t < 0) return expr(items, i);
  let e = t + 1;
  while (e < p0.length && isComment(p0[e])) e++;
  e++;
  while (e + 1 < p0.length && isTok(p0[e]) && p0[e].v === '.') e += 2;
  const lines = expr(p0.slice(0, e), i);
  parts[0] = { items: p0.slice(e), trail: parts[0].trail };
  parts.forEach((p, n) => {
    lines.push(...expr(p.items, i + 1));
    if (n < parts.length - 1) add(lines, ',', false);
    if (p.trail) add(lines, p.trail.v, true, p.trail.t === 'lc');
  });
  return lines;
}

// ---------------------------------------------------------------- stored programs (BEGIN … END bodies)

/** Matches block openers (BEGIN, IF, LOOP, WHILE, REPEAT, CASE) to their END: index → {end, last, expr}. */
function blockMatches(toks) {
  const stack = [];
  const match = new Map();
  let stmtStart = true;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'lc' || t.t === 'bc') continue;
    const U = t.t === 'word' ? t.U : null;
    const inExpr = stack.length > 0 && stack[stack.length - 1].expr;
    if (U === 'END') {
      let n = k + 1;
      while (n < toks.length && (toks[n].t === 'lc' || toks[n].t === 'bc')) n++;
      const e = stack.pop();
      const last = toks[n]?.t === 'word' && BLOCK_END.has(toks[n].U) && !(e?.expr) ? n : k;
      if (e) match.set(e.k, { end: k, last, expr: e.expr });
      k = last;
      stmtStart = false;
    } else if (U === 'BEGIN' || (stmtStart && !inExpr && (U === 'IF' || U === 'LOOP' || U === 'WHILE' || U === 'REPEAT' || U === 'CASE'))) {
      stack.push({ k });
      stmtStart = U === 'BEGIN' || U === 'LOOP' || U === 'REPEAT';
    } else if (U === 'CASE') {
      stack.push({ k, expr: true });
      stmtStart = false;
    } else if (t.t === 'semi' || (t.t === 'op' && t.v === ':')) stmtStart = true;
    else if (!inExpr && (U === 'THEN' || U === 'ELSE' || U === 'DO')) stmtStart = true;
    else stmtStart = false;
  }
  return match;
}

function statements(toks, from, to, i, match) {
  const lines = [];
  let k = from;
  while (k < to) {
    const t = toks[k];
    if (t.t === 'lc' || t.t === 'bc') {
      if (!t.nl && lines.length) add(lines, t.v, true, t.t === 'lc');
      else lines.push(L(i, t.v, t.t === 'lc'));
      k++;
      continue;
    }
    if (t.t === 'semi') { add(lines, ';', false); k++; continue; }
    let label = '', j = k;
    if (t.t === 'word' && toks[k + 1]?.t === 'op' && toks[k + 1].v === ':' && match.has(k + 2)) { label = t.d + ': '; j = k + 2; }
    if (match.has(j) && !match.get(j).expr) {
      const r = block(toks, j, i, match, label);
      lines.push(...r.lines);
      k = r.next;
      continue;
    }
    // A simple statement, up to the ";" outside parentheses and nested blocks.
    let e = k, depth = 0, beginAt = -1;
    while (e < to) {
      const x = toks[e];
      if (x.t === 'p' && x.v === '(') depth++;
      else if (x.t === 'p' && x.v === ')') depth--;
      else if (depth <= 0 && x.t === 'semi') break;
      else if (match.has(e)) {
        if (beginAt < 0 && x.U === 'BEGIN') { beginAt = e; break; }
        e = match.get(e).last;
      }
      e++;
    }
    if (beginAt >= 0) { // e.g. DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN … END;
      lines.push(...statement(toks.slice(k, beginAt), i));
      const r = block(toks, beginAt, i, match, '');
      lines.push(...r.lines);
      k = r.next;
      continue;
    }
    lines.push(...statement(toks.slice(k, e), i));
    if (e < to) add(lines, ';', false);
    k = e + 1;
  }
  return lines;
}

function block(toks, j, i, match, label) {
  const m = match.get(j);
  const U = toks[j].U;
  // Words after the closer (a label) and its ";".
  let next = m.last + 1;
  let closer = toks.slice(m.end, m.last + 1).map(t => t.d).join(' ');
  while (next < toks.length && toks[next].t === 'word') closer += ' ' + toks[next++].d;
  const closeLine = L(i, closer);
  if (next < toks.length && toks[next].t === 'semi') { closeLine.s += ';'; next++; }

  // Depth-0 keywords of this block (nested blocks and CASE expressions skipped).
  const marks = [];
  for (let e = j + 1; e < m.end; e++) {
    if (match.has(e)) { e = match.get(e).last; continue; }
    const t = toks[e];
    if (t.t === 'word' && ['THEN', 'ELSEIF', 'ELSE', 'DO', 'UNTIL', 'WHEN'].includes(t.U)) marks.push(e);
  }
  const markAt = (from, ...ws) => marks.find(e => e >= from && ws.includes(toks[e].U)) ?? m.end;
  const head = (prefix, from, to, suffix) => {
    const ls = [L(i, prefix)];
    if (to > from) join(ls, expr(build(toks.slice(from, to)), i));
    if (suffix) add(ls, suffix.d);
    return ls;
  };
  const body = (from, to) => statements(toks, from, to, i + 1, match);
  const lines = [];
  const kwd = label + toks[j].d;

  if (U === 'BEGIN') {
    lines.push(L(i, kwd), ...body(j + 1, m.end));
  } else if (U === 'IF') {
    let kwPos = j;
    for (;;) {
      let from;
      if (toks[kwPos].U === 'ELSE') { lines.push(L(i, toks[kwPos].d)); from = kwPos + 1; }
      else {
        const then = markAt(kwPos + 1, 'THEN');
        lines.push(...head(kwPos === j ? kwd : toks[kwPos].d, kwPos + 1, then, toks[then]));
        from = then + 1;
      }
      const nx = markAt(from, 'ELSEIF', 'ELSE');
      lines.push(...body(from, nx));
      if (nx >= m.end) break;
      kwPos = nx;
    }
  } else if (U === 'WHILE') {
    const d = markAt(j + 1, 'DO');
    lines.push(...head(kwd, j + 1, d, toks[d]), ...body(d + 1, m.end));
  } else if (U === 'LOOP') {
    lines.push(L(i, kwd), ...body(j + 1, m.end));
  } else if (U === 'REPEAT') {
    const u = markAt(j + 1, 'UNTIL');
    lines.push(L(i, kwd), ...body(j + 1, u));
    if (u < m.end) lines.push(...head(toks[u].d, u + 1, m.end));
  } else if (U === 'CASE') {
    let w = markAt(j + 1, 'WHEN', 'ELSE');
    lines.push(...head(kwd, j + 1, w));
    while (w < m.end) {
      let from;
      if (toks[w].U === 'ELSE') { lines.push(L(i, toks[w].d)); from = w + 1; }
      else {
        const then = markAt(w + 1, 'THEN');
        lines.push(...head(toks[w].d, w + 1, then, toks[then]));
        from = then + 1;
      }
      const nx = markAt(from, 'WHEN', 'ELSE');
      lines.push(...body(from, nx));
      w = nx;
    }
  }
  lines.push(closeLine);
  return { lines, next };
}

/** A whole top-level statement; CREATE PROCEDURE / FUNCTION / TRIGGER / EVENT get their body laid out as blocks. */
function topStatement(toks, i) {
  const sig = toks.filter(t => t.t !== 'lc' && t.t !== 'bc');
  if (sig[0]?.U === 'CREATE' && sig.some(t => ['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'].includes(t.U))) {
    let depth = 0;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.t === 'p' && t.v === '(') depth++;
      else if (t.t === 'p' && t.v === ')') depth--;
      else if (depth === 0 && t.U === 'BEGIN') {
        const body = toks.slice(k);
        return [...statement(toks.slice(0, k), i), ...statements(body, 0, body.length, i, blockMatches(body))];
      }
    }
  }
  return statement(toks, i);
}

// ---------------------------------------------------------------- script

/** Splits into statements at the active delimiter (";" inside BEGIN … END and CASE … END doesn't count). */
function splitScript(toks) {
  const out = [];
  let delim = ';', cur = [], depth = 0, prevSig = null;
  const flush = end => {
    if (cur.length || end) out.push({ toks: cur, end, trail: [] });
    cur = [];
    depth = 0;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'delimcmd') {
      flush(null);
      out.push({ cmd: t });
      delim = t.d;
      prevSig = null;
      continue;
    }
    const last = out[out.length - 1];
    if ((t.t === 'lc' || t.t === 'bc') && !t.nl && !cur.length && last?.end) { last.trail.push(t); continue; }
    if (t.t === 'word') {
      const nxt = toks.slice(k + 1).find(x => x.t !== 'lc' && x.t !== 'bc');
      if (t.U === 'BEGIN' && !(nxt?.t === 'semi' || nxt?.t === 'delim' || nxt?.U === 'WORK' || !nxt)) depth++;
      else if (t.U === 'CASE' && prevSig?.U !== 'END') depth++;
      else if (t.U === 'END' && !(nxt?.t === 'word' && ['IF', 'LOOP', 'WHILE', 'REPEAT'].includes(nxt.U))) depth = Math.max(0, depth - 1);
    }
    if (t.t === 'delim' || (t.t === 'semi' && delim === ';' && depth === 0)) { flush(t); prevSig = null; continue; }
    cur.push(t);
    if (t.t !== 'lc' && t.t !== 'bc') prevSig = t;
  }
  flush(null);
  return out;
}

/**
 * Formats a script. Options: keywordCase 'upper' | 'lower' | 'keep', indent 2 | 4 | 'tab', width (default 80).
 * Throws FormatError when the result would not be token-for-token the same SQL.
 */
export function formatSql(text, { keywordCase = 'upper', indent = 2, width: w = 80 } = {}) {
  O = { unit: indent === 'tab' ? '\t' : ' '.repeat(Number(indent) || 2), width: w };
  const toks = tokenize(text);
  const blocks = [];
  for (const part of splitScript(toks)) {
    if (part.cmd) { blocks.push({ text: part.cmd.v, multi: false, blank: part.cmd.bl }); continue; }
    applyCase(part.toks, keywordCase);
    const lines = topStatement(part.toks, 0).filter(l => l.s !== '');
    if (part.end) {
      if (lines.length) add(lines, part.end.v, false);
      else lines.push(L(0, part.end.v));
    }
    for (const c of part.trail) add(lines, c.v, true, c.t === 'lc');
    const strs = lines.map(l => (O.unit.repeat(l.i) + l.s).trimEnd()).filter(Boolean);
    if (strs.length) blocks.push({ text: strs.join('\n'), multi: strs.length > 1, blank: (part.toks[0] ?? part.end)?.bl });
  }
  let out = '';
  blocks.forEach((b, n) => {
    if (n) out += blocks[n - 1].multi || b.multi || b.blank ? '\n\n' : '\n';
    out += b.text;
  });
  if (/\n\s*$/.test(text) && out) out += '\n';
  if (signature(tokenize(out)) !== signature(toks)) throw new FormatError('The formatted text would differ from the original SQL.');
  return out;
}
