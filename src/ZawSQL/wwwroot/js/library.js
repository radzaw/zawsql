// Saved queries and snippets: library format, snippet expansion, grouping and import.
// Pure functions (no DOM), unit-tested in tests/js.

export const LIBRARY_VERSION = 1;

/** Built-in snippets, seeded into a new library (and restorable later). Bodies use the snippet syntax below. */
export const DEFAULT_SNIPPETS = [
  { trigger: 'sel', name: 'SELECT … FROM … WHERE', body: 'SELECT ${2:*}\nFROM ${1:${TABLE:table_name}}\nWHERE ${3:1 = 1}\nLIMIT ${4:100};$0' },
  { trigger: 'selc', name: 'Count rows', body: 'SELECT COUNT(*) FROM ${1:${TABLE:table_name}}${2: WHERE 1 = 1};$0' },
  { trigger: 'ins', name: 'INSERT INTO … VALUES', body: 'INSERT INTO ${1:${TABLE:table_name}} (${2:column1, column2})\nVALUES (${3:value1, value2});$0' },
  { trigger: 'upd', name: 'UPDATE … SET … WHERE', body: 'UPDATE ${1:${TABLE:table_name}}\nSET ${2:column} = ${3:value}\nWHERE ${4:id = 1};$0' },
  { trigger: 'del', name: 'DELETE FROM … WHERE', body: 'DELETE FROM ${1:${TABLE:table_name}}\nWHERE ${2:id = 1};$0' },
  { trigger: 'join', name: 'JOIN … ON', body: 'JOIN ${1:other_table} ON ${2:other_table.id = t.other_id}$0' },
  {
    trigger: 'ct', name: 'CREATE TABLE',
    body: 'CREATE TABLE ${1:new_table} (\n  id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n  ${2:name VARCHAR(100) NOT NULL},\n  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;$0',
  },
  { trigger: 'idx', name: 'CREATE INDEX', body: 'CREATE INDEX ${2:idx_name} ON ${1:${TABLE:table_name}} (${3:column});$0' },
  { trigger: 'tx', name: 'Transaction', description: 'Wraps the selection when inserted from the panel.', body: 'START TRANSACTION;\n${SELECTION}$0\nCOMMIT;' },
  {
    trigger: 'proc', name: 'CREATE PROCEDURE',
    body: 'DELIMITER $$\nCREATE PROCEDURE ${1:procedure_name}(${2:IN p_id INT})\nBEGIN\n  ${3:SELECT p_id;}\nEND$$\nDELIMITER ;$0',
  },
  {
    trigger: 'sizes', name: 'Table sizes in the current database',
    body: "SELECT TABLE_NAME, TABLE_ROWS, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1048576, 1) AS size_mb\nFROM information_schema.TABLES\nWHERE TABLE_SCHEMA = DATABASE()\nORDER BY size_mb DESC;$0",
  },
  {
    trigger: 'running', name: 'Running queries',
    body: "SELECT ID, USER, HOST, DB, TIME, STATE, INFO\nFROM information_schema.PROCESSLIST\nWHERE COMMAND <> 'Sleep'\nORDER BY TIME DESC;$0",
  },
];

let idCounter = 0;
export function newId() {
  idCounter = (idCounter + 1) % 1e6;
  return Date.now().toString(36) + idCounter.toString(36) + Math.random().toString(36).slice(2, 6);
}

const str = (v, max = 1e6) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A trigger is one word: letters, digits, _ and $ (what the editor treats as a word before the caret). */
export const isValidTrigger = t => /^[\w$]{1,40}$/.test(t);

function cleanQuery(q) {
  return {
    id: str(q.id, 64) || newId(),
    name: str(q.name, 200).trim() || 'Untitled',
    folder: normalizeFolder(q.folder),
    description: str(q.description, 2000),
    sql: str(q.sql),
    updated: Number(q.updated) || Date.now(),
  };
}

function cleanSnippet(s) {
  const trigger = str(s.trigger, 40).trim();
  return {
    id: str(s.id, 64) || newId(),
    name: str(s.name, 200).trim() || trigger || 'Snippet',
    trigger: isValidTrigger(trigger) ? trigger : '',
    description: str(s.description, 2000),
    body: str(s.body, 100000),
    updated: Number(s.updated) || Date.now(),
  };
}

/** Folder paths are "a/b/c": trimmed segments, no empty ones. */
export function normalizeFolder(f) {
  return str(f, 300).split('/').map(s => s.trim()).filter(Boolean).join('/');
}

/** A clean library from whatever was stored; null (nothing stored yet) gives the default snippets. */
export function normalizeLibrary(lib) {
  if (!lib || typeof lib !== 'object') {
    return { version: LIBRARY_VERSION, queries: [], snippets: DEFAULT_SNIPPETS.map(cleanSnippet) };
  }
  return {
    version: LIBRARY_VERSION,
    queries: (Array.isArray(lib.queries) ? lib.queries : []).filter(q => q && typeof q === 'object').map(cleanQuery),
    snippets: (Array.isArray(lib.snippets) ? lib.snippets : []).filter(s => s && typeof s === 'object').map(cleanSnippet),
  };
}

export function makeQuery(fields) { return cleanQuery({ ...fields, id: newId(), updated: Date.now() }); }
export function makeSnippet(fields) { return cleanSnippet({ ...fields, id: newId(), updated: Date.now() }); }

/** "name", or "name (2)", "name (3)", … – the first not in `taken` (case-insensitive). */
export function uniqueName(base, taken) {
  const set = new Set([...taken].map(t => t.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}

/** A name for a new saved query: the first comment or statement line, shortened. */
export function suggestName(sql, fallback = 'Query') {
  for (const raw of String(sql).split('\n')) {
    const line = raw.replace(/^\s*(--|#)\s?/, '').replace(/^\s*\/\*+|\*+\/\s*$/g, '').trim();
    if (line) return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
  }
  return fallback;
}

/** Case-insensitive match on every whitespace-separated term, across name, folder, trigger, description and text. */
export function matches(item, filter) {
  const terms = String(filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [item.name, item.folder, item.trigger, item.description, item.sql, item.body].filter(Boolean).join('\n').toLowerCase();
  return terms.every(t => hay.includes(t));
}

/**
 * Saved queries grouped by folder for the panel: [{folder, items}] with folders sorted (unfiled first)
 * and items sorted by name. Only matching queries (and folders holding them) are included.
 */
export function groupByFolder(queries, filter = '') {
  const groups = new Map();
  for (const q of queries) {
    if (!matches(q, filter)) continue;
    if (!groups.has(q.folder)) groups.set(q.folder, []);
    groups.get(q.folder).push(q);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })))
    .map(([folder, items]) => ({ folder, items: items.sort(byName) }));
}

export function folders(queries) {
  return [...new Set(queries.map(q => q.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function findSnippet(snippets, trigger) {
  if (!trigger) return null;
  const t = trigger.toLowerCase();
  return snippets.find(s => s.trigger && s.trigger.toLowerCase() === t) || null;
}

/**
 * Merges an imported library into `lib` (in place). Items with a known id replace that item when the
 * import is newer; identical copies are skipped; snippets whose trigger is taken keep their text but
 * lose the trigger. Returns counts for the user.
 */
export function mergeLibrary(lib, incoming) {
  const src = normalizeLibrary(incoming && typeof incoming === 'object' ? incoming : { queries: [], snippets: [] });
  const res = { added: 0, updated: 0, skipped: 0 };
  const merge = (list, items, same, adjust) => {
    for (const it of items) {
      const i = list.findIndex(x => x.id === it.id);
      if (i >= 0) {
        if (it.updated > list[i].updated && !same(list[i], it)) { list[i] = it; res.updated++; } else res.skipped++;
      } else if (list.some(x => same(x, it))) res.skipped++;
      else { list.push(adjust(it)); res.added++; }
    }
  };
  merge(lib.queries, src.queries,
    (a, b) => a.name === b.name && a.folder === b.folder && a.sql === b.sql,
    q => ({ ...q, name: uniqueName(q.name, lib.queries.filter(x => x.folder === q.folder).map(x => x.name)) }));
  merge(lib.snippets, src.snippets,
    (a, b) => a.trigger === b.trigger && a.body === b.body,
    s => (findSnippet(lib.snippets, s.trigger) ? { ...s, trigger: '' } : s));
  return res;
}

/** Adds the built-in snippets whose trigger isn't used; returns how many were added. */
export function restoreDefaultSnippets(lib) {
  let n = 0;
  for (const d of DEFAULT_SNIPPETS) {
    if (findSnippet(lib.snippets, d.trigger)) continue;
    lib.snippets.push(makeSnippet(d));
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- snippet expansion

/**
 * Expands a snippet body. Syntax:
 *   $1, ${1}, ${1:default}  tab stops, visited in ascending order (the default text is selected)
 *   $0                      where the caret ends up (default: the end)
 *   ${NAME} / ${NAME:default}  variables from `vars` (SELECTION, DB, TABLE, DATE, …); the default is used when empty
 *   \$                      a literal $ (any other $, e.g. in "$$" or "@$x", is literal too)
 * Variables may appear inside a tab stop's default ("${1:${TABLE:t}}"); tab stops don't nest.
 * Continuation lines of the body get `indent` prepended, so a snippet keeps the indentation of the line it's inserted on;
 * variable values (e.g. a multi-line selection) are inserted as they are.
 * Returns { text, stops: [{start, end}] (in visiting order), cursor }.
 */
export function expandSnippet(body, vars = {}, indent = '') {
  let out = '';
  const found = []; // { n, start, end }
  let cursor = null;
  let i = 0;

  const emit = s => { out += indent ? s.replace(/\n/g, '\n' + indent) : s; };

  // Reads a default text up to the matching "}", expanding variables (and stops when allowed).
  function readUntilClose(allowStops) {
    while (i < body.length && body[i] !== '}') {
      if (!readToken(allowStops)) { emit(body[i]); i++; }
    }
    i++; // past "}" (or the end)
  }

  function variable(name) {
    const v = vars[name];
    return v == null ? '' : String(v);
  }

  // Handles one special token at body[i]; false when body[i] is plain text.
  function readToken(allowStops) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '$') { emit('$'); i += 2; return true; }
    if (c !== '$') return false;
    let m = /^\$(\d+)/.exec(body.slice(i, i + 6));
    if (m) {
      i += m[0].length;
      stop(+m[1], () => {}, allowStops);
      return true;
    }
    m = /^\$\{(\d+)(:|\})/.exec(body.slice(i, i + 8));
    if (m) {
      i += m[0].length;
      stop(+m[1], () => { if (m[2] === ':') readUntilClose(false); }, allowStops);
      return true;
    }
    m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:|\})/.exec(body.slice(i, i + 40));
    if (m) {
      i += m[0].length;
      const value = variable(m[1]);
      if (m[2] === '}') { out += value; return true; }
      if (value) {
        out += value;
        skipDefault();
      } else readUntilClose(false);
      return true;
    }
    return false;
  }

  function skipDefault() {
    let depth = 1;
    while (i < body.length && depth) {
      if (body[i] === '\\' && body[i + 1] === '$') { i += 2; continue; }
      if (body[i] === '$' && body[i + 1] === '{') { depth++; i += 2; continue; }
      if (body[i] === '}') depth--;
      i++;
    }
  }

  function stop(n, readDefault, allowStops) {
    const start = out.length;
    readDefault();
    if (!allowStops) return; // nested: just its default text
    if (n === 0) { if (cursor == null) cursor = start; return; }
    found.push({ n, start, end: out.length });
  }

  while (i < body.length) {
    if (!readToken(true)) { emit(body[i]); i++; }
  }
  const stops = found.sort((a, b) => a.n - b.n || a.start - b.start).map(({ start, end }) => ({ start, end }));
  return { text: out, stops, cursor: cursor ?? out.length };
}

/** Variables available to snippets. `ident` quotes identifiers when needed. */
export function snippetVars({ db, table, selection = '', ident = s => s, now = new Date() } = {}) {
  const pad = n => String(n).padStart(2, '0');
  return {
    SELECTION: selection,
    DB: db ? ident(db) : '',
    TABLE: table ? ident(table) : '',
    DATE: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  };
}
