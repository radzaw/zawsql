// CSV / Excel import wizard: pure helpers (no DOM), unit-tested in tests/js.

export const DELIMITERS = [['', 'Detect'], [',', 'Comma ,'], [';', 'Semicolon ;'], ['\\t', 'Tab'], ['|', 'Pipe |']];
export const QUOTES = [['"', 'Double quote "'], ["'", "Single quote '"], ['', 'None']];
export const DATE_ORDERS = [['', 'ISO only (2024-12-31)'], ['DMY', 'Day first (31.12.2024)'], ['MDY', 'Month first (12/31/2024)'], ['YMD', 'Year first (2024/12/31)']];
export const MODES = [
  ['insert', 'Report as errors'],
  ['ignore', 'Skip rows whose key exists'],
  ['update', 'Update existing rows'],
  ['replace', 'Replace existing rows (delete + insert)'],
];
export const COMMON_TYPES = ['INT', 'BIGINT', 'DECIMAL(10,2)', 'DOUBLE', 'TINYINT(1)', 'VARCHAR(255)', 'TEXT', 'DATE', 'DATETIME', 'TIME', 'JSON'];

/** "Sales Report 2024 (final).csv" → "sales_report_2024_final": a safe default name for a new table. */
export function tableNameFromFile(fileName) {
  let n = String(fileName).replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!n) n = 'imported';
  if (/^\d/.test(n)) n = 't_' + n;
  return n.slice(0, 64);
}

const key = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Target column for each file column: same name ignoring case, spaces, underscores and accents; when the file has
 * no header row and the counts match, by position. Each table column is used once. Returns names or null (skip).
 */
export function autoMap(fileColumns, tableColumns, { header = true } = {}) {
  const byKey = new Map();
  for (const c of tableColumns) if (!byKey.has(key(c))) byKey.set(key(c), c);
  const used = new Set();
  const out = fileColumns.map(f => {
    const t = byKey.get(key(f));
    if (!t || used.has(t)) return null;
    used.add(t);
    return t;
  });
  if (!header && out.every(x => x === null) && fileColumns.length === tableColumns.length) return [...tableColumns];
  return out;
}

/** A column type the backend will accept (letters, digits, parentheses, commas, quotes, spaces). */
export const isValidType = t => /^[A-Za-z][A-Za-z0-9_ (),'.]*$/.test(String(t).trim());

/** Mapping and CREATE definitions sent to the backend; throws Error with a message for the user. */
export function buildTarget({ target, columns, addId }) {
  if (target === 'new') {
    const create = [], mapping = [];
    const seen = new Set(addId ? ['id'] : []);
    columns.forEach((c, i) => {
      if (!c.include) return;
      const name = c.name.trim();
      if (!name) throw new Error(`File column ${i + 1} needs a column name.`);
      if (name.length > 64) throw new Error(`Column name "${name}" is longer than 64 characters.`);
      if (seen.has(name.toLowerCase())) throw new Error(addId && name.toLowerCase() === 'id' ? 'The file has an "id" column: untick "Add an auto-increment id column" or rename it.' : `Column "${name}" appears twice.`);
      seen.add(name.toLowerCase());
      if (!isValidType(c.type)) throw new Error(`"${c.type}" is not a valid type for column "${name}".`);
      create.push({ name, type: c.type.trim() });
      mapping.push({ source: i, column: name });
    });
    if (!mapping.length) throw new Error('Include at least one column.');
    return { create, mapping };
  }
  const mapping = columns.map((c, i) => (c.target ? { source: i, column: c.target } : null)).filter(Boolean);
  if (!mapping.length) throw new Error('Map at least one file column to a table column.');
  const dup = mapping.find((m, i) => mapping.findIndex(x => x.column === m.column) !== i);
  if (dup) throw new Error(`Table column "${dup.column}" is mapped twice.`);
  return { create: null, mapping };
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
