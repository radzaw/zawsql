// Splits an SQL script into statements, honoring quotes, comments and DELIMITER commands.

const DELIMITER_RE = /[ \t]*delimiter[ \t]+(\S+)[^\n]*(?:\n|$)/iy;

export function splitSql(text) {
  const out = [];
  const n = text.length;
  let delim = ';';
  let i = 0, start = 0, lineStart = true, hasContent = false;

  const push = (s, e) => {
    if (!hasContent) return;
    const raw = text.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    const sql = raw.trim();
    if (sql) out.push({ sql, start: s + lead, end: s + lead + sql.length, rawStart: s, rawEnd: e });
  };

  while (i < n) {
    if (lineStart) {
      lineStart = false;
      if (!hasContent) {
        DELIMITER_RE.lastIndex = i;
        const m = DELIMITER_RE.exec(text);
        if (m) {
          delim = m[1];
          i = DELIMITER_RE.lastIndex;
          start = i;
          lineStart = true;
          continue;
        }
      }
    }
    const ch = text[i];
    if (ch === '\n') { lineStart = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { hasContent = true; i = skipQuoted(text, i, ch); continue; }
    if (ch === '#' || (ch === '-' && text[i + 1] === '-' && (i + 2 >= n || /\s/.test(text[i + 2])))) {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      if (text[i + 2] === '!') hasContent = true; // executable comment, e.g. /*!40101 SET ... */
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (text.startsWith(delim, i)) {
      push(start, i);
      i += delim.length;
      start = i;
      hasContent = false;
      continue;
    }
    if (!/\s/.test(ch)) hasContent = true;
    i++;
  }
  push(start, n);
  return out;
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
  return i;
}

/** The statement containing (or immediately preceding) the caret position. */
export function statementAt(stmts, pos) {
  // Caret inside the statement text or right behind its delimiter wins over the whitespace around it.
  for (const s of stmts) if (pos >= s.start && pos <= s.end + 1) return s;
  for (const s of stmts) if (pos >= s.rawStart && pos <= s.rawEnd) return s;
  let best = null;
  for (const s of stmts) if (s.start <= pos) best = s;
  return best || stmts[0] || null;
}
