// Classifies statements for safety confirmations (production sessions, UPDATE/DELETE without WHERE).
// This is a convenience check only; read-only mode is enforced by the backend.

const READ_FIRST = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'USE', 'TABLE', 'VALUES', 'HELP']);
const NO_SCAN = new Set(['SHOW', 'DESCRIBE', 'DESC', 'USE', 'HELP']);
const WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'OUTFILE', 'DUMPFILE']);
const FUNCTION_NAMES = new Set(['INSERT', 'REPLACE', 'TRUNCATE']);

/** Words outside strings and comments, with nesting depth and the next non-space character. */
function tokens(sql) {
  const out = [];
  let i = 0, depth = 0, executable = false;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n && sql[i] !== c) i += sql[i] === '\\' && c !== '`' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '#' || (c === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2])))) {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      if (sql[i + 2] === '!') executable = true;
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; i++; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      let k = j;
      while (k < n && /\s/.test(sql[k])) k++;
      out.push({ word: sql.slice(i, j).toUpperCase(), depth, next: sql[k] || '' });
      i = j;
      continue;
    }
    i++;
  }
  return { list: out, executable };
}

/** True when the statement only reads (no data or schema changes). */
export function isReadOnlyStatement(sql) {
  const { list, executable } = tokens(sql);
  if (executable) return false;
  if (!list.length) return true;
  const first = list[0].word;
  if (!READ_FIRST.has(first)) return false;
  if (NO_SCAN.has(first)) return true;
  return !list.some((t, i) => WRITE_WORDS.has(t.word)
    && !(t.next === '(' && FUNCTION_NAMES.has(t.word))
    && !(t.word === 'UPDATE' && list[i - 1]?.word === 'FOR'));
}

/** True for UPDATE / DELETE (also after WITH ...) that have no top-level WHERE clause. */
export function lacksWhere(sql) {
  const { list } = tokens(sql);
  const top = list.filter(t => t.depth === 0);
  const verbIdx = top.findIndex(t => t.word === 'UPDATE' || t.word === 'DELETE');
  if (verbIdx < 0) return false;
  // The statement must start with the verb (or a WITH clause leading to it); skip "... FOR UPDATE" etc.
  if (verbIdx > 0 && top[0].word !== 'WITH') return false;
  return !top.slice(verbIdx).some(t => t.word === 'WHERE');
}
