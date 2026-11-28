// Test data generator: picks a generator for each column from its name and type, makes rows of realistic values,
// and turns them into INSERT statements. Pure logic (no DOM, no requests), with a seeded random source for tests.
import { qi, sqlStr, parseEnum } from './util.js';
import { sqlLiteral } from './fklogic.js';

// ---------------------------------------------------------------- random source and word lists

/** A small seeded random generator (mulberry32): the same seed gives the same rows. */
export function rng(seed = Date.now()) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => Math.floor(next() * (max - min + 1)) + min;
  return { next, int, pick: list => list[Math.floor(next() * list.length)] };
}

const FIRST = ['Anna', 'Adam', 'Maria', 'Piotr', 'Olivia', 'Liam', 'Emma', 'Noah', 'Sofia', 'Lucas', 'Mia', 'Leon', 'Julia', 'Oskar', 'Zoe', 'Mateo', 'Chloe', 'Hugo', 'Laura', 'Ivan', 'Nora', 'Elias', 'Ava', 'Felix', 'Ella', 'Max', 'Lena', 'Jan', 'Clara', 'Tom'];
const LAST = ['Smith', 'Nowak', 'Müller', 'Garcia', 'Rossi', 'Kowalski', 'Johnson', 'Martin', 'Silva', 'Novak', 'Brown', 'Dubois', 'Jensen', 'Popescu', 'Kim', 'Wilson', 'Fischer', 'Lopez', 'Moreau', 'Horvat', 'Taylor', 'Schmidt', 'Costa', 'Nielsen', 'Petrov'];
const CITY = ['Warsaw', 'Berlin', 'Lisbon', 'Madrid', 'Prague', 'Vienna', 'Oslo', 'Dublin', 'Rome', 'Paris', 'Kraków', 'Porto', 'Lyon', 'Munich', 'Gdańsk', 'Seville', 'Milan', 'Bergen', 'Ghent', 'Turin'];
const COUNTRY = ['Poland', 'Germany', 'Portugal', 'Spain', 'Czechia', 'Austria', 'Norway', 'Ireland', 'Italy', 'France', 'Belgium', 'Netherlands', 'Sweden', 'Denmark', 'Finland'];
const STREET = ['Main St', 'Oak Avenue', 'Park Lane', 'River Road', 'Hill Street', 'Market Square', 'Station Road', 'Church Lane', 'Mill Way', 'Garden Close'];
const COMPANY = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay', 'Stark', 'Wayne', 'Soylent', 'Tyrell', 'Cyberdyne', 'Wonka'];
const SUFFIX = ['Ltd', 'Inc', 'GmbH', 'S.A.', 'Sp. z o.o.', 'Group', 'Labs'];
const DOMAIN = ['example.com', 'example.org', 'example.net', 'test.example'];
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');
const COLORS = ['red', 'green', 'blue', 'orange', 'purple', 'black', 'white', 'grey', 'yellow', 'teal'];

// ---------------------------------------------------------------- column types

/** `varchar(40)`, `decimal(10,2) unsigned`, `enum('a','b')` → { base, len, scale, unsigned, values }. */
export function parseType(type) {
  const t = String(type || '').toLowerCase();
  const m = /^(\w+)(?:\(([^)]*)\))?/.exec(t) || [];
  const base = m[1] || t;
  const args = (m[2] || '').split(',').map(s => s.trim());
  const values = base === 'enum' || base === 'set' ? parseEnum(String(type).replace(/^\s*set\b/i, 'enum')) || [] : null;
  return { base, len: values ? null : +args[0] || null, scale: values ? null : +args[1] || 0, unsigned: /\bunsigned\b/.test(t), values };
}

const INT_MAX = { tinyint: 127, smallint: 32767, mediumint: 8388607, int: 2147483647, integer: 2147483647, bigint: 9007199254740991 };
const TEXT_LEN = { tinytext: 255, text: 65535, mediumtext: 1e6, longtext: 1e6 };

/** Longest string the column takes (characters), or null when unbounded enough not to matter. */
function maxLen(pt) {
  if (['char', 'varchar', 'binary', 'varbinary'].includes(pt.base)) return pt.len || 1;
  return TEXT_LEN[pt.base] ?? null;
}

// ---------------------------------------------------------------- generators

/** The generators offered for a column, as [kind, label]. Options are written in one text field (see parseOptions). */
export const GENERATORS = [
  ['skip', 'Leave to the server (default / auto increment)'],
  ['null', 'NULL'],
  ['constant', 'Constant value'],
  ['fk', 'Existing parent key'],
  ['seq', 'Sequence (next number)'],
  ['int', 'Integer in range'],
  ['decimal', 'Decimal in range'],
  ['bool', 'Yes / no (0 or 1)'],
  ['date', 'Date in range'],
  ['datetime', 'Date and time in range'],
  ['time', 'Time of day'],
  ['year', 'Year in range'],
  ['first', 'First name'],
  ['last', 'Last name'],
  ['full', 'Full name'],
  ['username', 'User name'],
  ['email', 'E-mail address'],
  ['phone', 'Phone number'],
  ['street', 'Street address'],
  ['city', 'City'],
  ['zip', 'Postal code'],
  ['country', 'Country'],
  ['company', 'Company name'],
  ['url', 'URL'],
  ['ip', 'IP address'],
  ['color', 'Colour name'],
  ['words', 'A few words'],
  ['sentence', 'Sentence'],
  ['paragraph', 'Paragraph'],
  ['uuid', 'UUID'],
  ['hex', 'Random bytes / hex'],
  ['enum', 'One of the listed values'],
  ['json', 'Small JSON object'],
  ['point', 'Point (longitude latitude)'],
];

/** What the options field means for each generator (its placeholder). */
export const OPTION_HINT = {
  constant: 'the value', seq: 'first number', int: 'min..max', decimal: 'min..max', date: 'from..to (YYYY-MM-DD)',
  datetime: 'from..to (YYYY-MM-DD)', year: 'from..to', enum: 'a, b, c (empty: the column\'s values)', words: 'words: min..max',
};

const isoDay = d => d.toISOString().slice(0, 10);
const yearsAgo = (n, now) => { const d = new Date(now); d.setUTCFullYear(d.getUTCFullYear() - n); return isoDay(d); };

/**
 * The generator for a column: { kind, options } chosen from its name and type. `info` is the /datagen response
 * (foreign keys, maxima). `now` (ms) makes date ranges reproducible in tests.
 */
export function detect(col, info = {}, now = Date.now()) {
  const pt = parseType(col.type);
  const name = String(col.name).toLowerCase();
  const extra = String(col.extra || '').toLowerCase();
  const has = re => re.test(name);
  if (/\b(virtual|stored|persistent)\b/.test(extra) || col.isGenerated) return { kind: 'skip', options: '', locked: true, note: 'generated column' };
  if (extra.includes('auto_increment')) return { kind: 'skip', options: '', note: 'auto increment' };
  if ((info.foreignKeys || []).some(fk => fk.columns.some(c => c.toLowerCase() === name))) return { kind: 'fk', options: '' };
  const intLike = pt.base in INT_MAX;
  if (intLike && info.maxima && Object.keys(info.maxima).some(k => k.toLowerCase() === name)) {
    const max = Object.entries(info.maxima).find(([k]) => k.toLowerCase() === name)[1];
    return { kind: 'seq', options: String((max != null && max !== '' ? BigInt(max) : 0n) + 1n) };
  }
  // A DEFAULT such as CURRENT_TIMESTAMP is usually what the application relies on.
  if (/current_timestamp|now\(\)/i.test(String(col.default || '')) || /on update current_timestamp/.test(extra)) return { kind: 'skip', options: '', note: 'has a default' };

  if (pt.values) return { kind: 'enum', options: '' };
  if (pt.base === 'bit' && (pt.len || 1) === 1) return { kind: 'bool', options: '' };
  if (pt.base === 'tinyint' && pt.len === 1) return { kind: 'bool', options: '' };
  if (pt.base === 'bool' || pt.base === 'boolean') return { kind: 'bool', options: '' };
  if (['date'].includes(pt.base)) return { kind: 'date', options: has(/birth|dob/) ? '1950-01-01..2006-12-31' : `${yearsAgo(2, now)}..${isoDay(new Date(now))}` };
  if (['datetime', 'timestamp'].includes(pt.base)) return { kind: 'datetime', options: `${yearsAgo(2, now)}..${isoDay(new Date(now))}` };
  if (pt.base === 'time') return { kind: 'time', options: '' };
  if (pt.base === 'year') return { kind: 'year', options: '2000..2030' };
  if (pt.base === 'json') return { kind: 'json', options: '' };
  if (['point', 'geometry'].includes(pt.base)) return { kind: 'point', options: '' };
  if (['blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary'].includes(pt.base)) return { kind: has(/uuid|guid/) && pt.len === 16 ? 'uuid' : 'hex', options: '' };
  if (['decimal', 'numeric', 'float', 'double', 'real'].includes(pt.base)) {
    if (has(/lat(itude)?$/)) return { kind: 'decimal', options: '-90..90' };
    if (has(/(lng|lon|longitude)$/)) return { kind: 'decimal', options: '-180..180' };
    return { kind: 'decimal', options: has(/price|amount|total|balance|cost|salary|fee/) ? '1..1000' : '0..1000' };
  }
  if (intLike) {
    if (has(/age$/)) return { kind: 'int', options: '18..90' };
    if (has(/qty|quantity|count|num|stock/)) return { kind: 'int', options: '0..100' };
    if (has(/year/)) return { kind: 'int', options: '2000..2030' };
    if (has(/^(is|has)_|_flag$|active|enabled|deleted/)) return { kind: 'bool', options: '' };
    const top = pt.unsigned ? INT_MAX[pt.base] * 2 + 1 : INT_MAX[pt.base];
    return { kind: 'int', options: `${pt.unsigned || pt.base !== 'tinyint' ? 1 : 0}..${Math.min(top, 1000)}` };
  }
  // Text: by name first.
  if (has(/e_?mail/)) return { kind: 'email', options: '' };
  if (has(/first_?name|given_?name|^fname$|forename/)) return { kind: 'first', options: '' };
  if (has(/last_?name|surname|family_?name|^lname$/)) return { kind: 'last', options: '' };
  if (has(/user_?name|login|nick/)) return { kind: 'username', options: '' };
  if (has(/phone|mobile|^tel|fax/)) return { kind: 'phone', options: '' };
  if (has(/city|town/)) return { kind: 'city', options: '' };
  if (has(/country/)) return { kind: 'country', options: '' };
  if (has(/zip|postal|post_?code/)) return { kind: 'zip', options: '' };
  if (has(/street|address/)) return { kind: 'street', options: '' };
  if (has(/company|organi[sz]ation|employer|vendor|supplier/)) return { kind: 'company', options: '' };
  if (has(/url|website|link|homepage/)) return { kind: 'url', options: '' };
  if (has(/(^|_)ip(_?addr(ess)?)?$/)) return { kind: 'ip', options: '' };
  if (has(/colou?r/)) return { kind: 'color', options: '' };
  if (has(/uuid|guid/) || (pt.base === 'char' && pt.len === 36)) return { kind: 'uuid', options: '' };
  if (has(/password|hash|token|secret|salt/)) return { kind: 'hex', options: '' };
  if (has(/(^|_)name$|full_?name|display_?name|author|contact/)) return { kind: 'full', options: '' };
  if (has(/title|subject|headline|caption|label/)) return { kind: 'sentence', options: '' };
  if (has(/desc|note|comment|body|content|text|bio|message|summary|details/) || TEXT_LEN[pt.base]) return { kind: 'paragraph', options: '' };
  if (has(/(^|_)(code|sku|ref)$/)) return { kind: 'hex', options: '' };
  return { kind: 'words', options: '1..3' };
}

/** "a..b" → [a, b] as strings (either may be empty). */
function range(opt) {
  const m = /^\s*(.*?)\s*\.\.\s*(.*?)\s*$/.exec(String(opt || ''));
  return m ? [m[1], m[2]] : [String(opt || '').trim(), ''];
}

/** Problems with a column's settings, or null: e.g. a range written the wrong way round. */
export function checkColumn(col, gen, info = {}) {
  const [a, b] = range(gen.options);
  const num = v => v !== '' && Number.isFinite(+v);
  if (['int', 'decimal', 'year'].includes(gen.kind) && (gen.options.trim() && (!num(a) || !num(b) || +a > +b))) return 'Write the range as min..max, e.g. 1..100.';
  if (['date', 'datetime'].includes(gen.kind) && gen.options.trim() && (Number.isNaN(Date.parse(a)) || Number.isNaN(Date.parse(b)) || Date.parse(a) > Date.parse(b))) return 'Write the range as from..to, e.g. 2024-01-01..2024-12-31.';
  if (gen.kind === 'seq' && gen.options.trim() && !/^-?\d+$/.test(gen.options.trim())) return 'The first number of the sequence, e.g. 1.';
  if (gen.kind === 'null' && !col.nullable) return `${col.name} is NOT NULL.`;
  if (gen.kind === 'fk') {
    const fk = fkOf(col, info);
    if (!fk) return `${col.name} isn't part of a foreign key.`;
    const s = sampleOf(fk, info);
    if (s?.error) return `Can't read ${fk.refTable}: ${s.error}`;
    if (!s?.rows.length && !col.nullable) return `${fk.refTable} has no rows to point at.`;
  }
  if (gen.kind === 'enum' && !parseType(col.type).values && !gen.options.trim()) return 'List the values, e.g. new, paid, sent.';
  return null;
}

const fkOf = (col, info) => (info.foreignKeys || []).find(fk => fk.columns.some(c => c.toLowerCase() === col.name.toLowerCase()));
const sampleOf = (fk, info) => (info.samples || []).find(s => s.name === fk.name);

/**
 * Makes `count` rows. `cols`: the table's columns ({ name, type, nullable, ... }); `gens`: { kind, options } for each,
 * in the same order; `info`: the /datagen response. Columns left to the server are not in the result.
 * Returns { columns: [name], rows: [[value]] } where a value is null, a number, a string, or { sql } (a raw expression).
 * unique: names of columns in a single-column unique key, whose generated values get a running suffix.
 */
export function generate({ cols, gens, info = {}, count, seed, nullPct = 0, unique = new Set(), runId = '' }) {
  const r = rng(seed);
  const used = cols.map((c, i) => [c, gens[i], i]).filter(([, g]) => g.kind !== 'skip');
  const tag = runId || Math.floor(r.next() * 36 ** 4).toString(36).padStart(4, '0');
  const rows = [];
  const fkPick = new Map();
  for (let n = 0; n < count; n++) {
    fkPick.clear();
    rows.push(used.map(([col, g]) => value(col, g, n)));
  }
  return { columns: used.map(([c]) => c.name), rows };

  function value(col, g, n) {
    const pt = parseType(col.type);
    const isUnique = unique.has(col.name.toLowerCase());
    if (g.kind === 'null') return null;
    if (g.kind === 'fk') {
      const fk = fkOf(col, info);
      const s = fk && sampleOf(fk, info);
      if (!s?.rows.length) return null;
      // All columns of one composite key come from the same parent row.
      if (!fkPick.has(fk.name)) fkPick.set(fk.name, r.int(0, s.rows.length - 1));
      const pos = fk.columns.findIndex(c => c.toLowerCase() === col.name.toLowerCase());
      const v = s.rows[fkPick.get(fk.name)][pos];
      return v == null ? null : { sql: sqlLiteral(v, s.kinds[pos]) };
    }
    if (col.nullable && nullPct > 0 && !isUnique && g.kind !== 'constant' && g.kind !== 'seq' && r.next() * 100 < nullPct) return null;
    const v = raw(col, g, pt, n);
    if (typeof v !== 'string') return v;
    return fit(v, pt, isUnique ? `${tag}${n}` : null, g.kind);
  }

  function raw(col, g, pt, n) {
    const [a, b] = range(g.options);
    switch (g.kind) {
      case 'constant': return g.options;
      case 'seq': return { sql: String(BigInt(g.options.trim() || '1') + BigInt(n)) };
      case 'int': {
        const lo = a !== '' ? Math.ceil(+a) : 1, hi = b !== '' ? Math.floor(+b) : 1000;
        return r.int(lo, Math.max(lo, hi));
      }
      case 'decimal': {
        const lo = a !== '' ? +a : 0, hi = b !== '' ? +b : 1000;
        const scale = ['decimal', 'numeric'].includes(pt.base) ? pt.scale : 2;
        return { sql: (lo + r.next() * (hi - lo)).toFixed(scale) };
      }
      case 'bool': return r.int(0, 1);
      case 'year': return r.int(a !== '' ? +a : 2000, b !== '' ? +b : 2030);
      case 'date': case 'datetime': {
        const from = Date.parse(a || '2020-01-01'), to = Date.parse(b || '2026-12-31') + (g.kind === 'datetime' ? 86399000 : 0);
        const d = new Date(from + Math.floor(r.next() * Math.max(0, to - from)));
        return g.kind === 'date' ? isoDay(d) : d.toISOString().slice(0, 19).replace('T', ' ');
      }
      case 'time': return `${String(r.int(0, 23)).padStart(2, '0')}:${String(r.int(0, 59)).padStart(2, '0')}:${String(r.int(0, 59)).padStart(2, '0')}`;
      case 'first': return r.pick(FIRST);
      case 'last': return r.pick(LAST);
      case 'full': return `${r.pick(FIRST)} ${r.pick(LAST)}`;
      case 'username': return `${r.pick(FIRST).toLowerCase()}${r.int(1, 999)}`;
      case 'email': return `${ascii(r.pick(FIRST))}.${ascii(r.pick(LAST))}${r.int(1, 99)}@${r.pick(DOMAIN)}`;
      case 'phone': return `+48 ${r.int(500, 899)} ${String(r.int(0, 999)).padStart(3, '0')} ${String(r.int(0, 999)).padStart(3, '0')}`;
      case 'street': return `${r.int(1, 250)} ${r.pick(STREET)}`;
      case 'city': return r.pick(CITY);
      case 'zip': return `${String(r.int(0, 99)).padStart(2, '0')}-${String(r.int(0, 999)).padStart(3, '0')}`;
      case 'country': return r.pick(COUNTRY);
      case 'company': return `${r.pick(COMPANY)} ${r.pick(SUFFIX)}`;
      case 'url': return `https://www.${r.pick(DOMAIN)}/${r.pick(WORDS)}/${r.int(1, 9999)}`;
      case 'ip': return `${r.int(10, 223)}.${r.int(0, 255)}.${r.int(0, 255)}.${r.int(1, 254)}`;
      case 'color': return r.pick(COLORS);
      case 'words': {
        const lo = a !== '' ? Math.max(1, +a) : 1, hi = b !== '' ? Math.max(lo, +b) : lo + 2;
        return sentence(r.int(lo, hi), false);
      }
      case 'sentence': return sentence(r.int(4, 9), true);
      case 'paragraph': return Array.from({ length: r.int(2, 4) }, () => sentence(r.int(6, 14), true)).join(' ');
      case 'uuid': {
        const hex = Array.from({ length: 32 }, () => r.int(0, 15).toString(16)).join('');
        const u = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[r.int(0, 3)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        return ['binary', 'varbinary'].includes(pt.base) && pt.len === 16 ? { sql: '0x' + u.replace(/-/g, '') } : u;
      }
      case 'hex': {
        // Binary columns take bytes (0x… literal); text columns take hex digits, two per byte.
        const bin = /blob|binary/.test(pt.base);
        const len = maxLen(pt);
        const bytes = Math.max(1, Math.min(16, len ? (bin ? len : Math.floor(len / 2)) : 16));
        const h = Array.from({ length: bytes }, () => r.int(0, 255).toString(16).padStart(2, '0')).join('');
        return bin ? { sql: '0x' + h } : h;
      }
      case 'enum': {
        const list = g.options.trim() ? g.options.split(',').map(s => s.trim()).filter(Boolean) : pt.values || [];
        if (pt.base === 'set' && !g.options.trim()) return list.filter(() => r.next() < 0.4).join(',') || list[0] || '';
        return r.pick(list) ?? '';
      }
      case 'json': return JSON.stringify({ id: r.int(1, 1000), tag: r.pick(WORDS), active: r.next() < 0.5 });
      case 'point': return { sql: `ST_GeomFromText('POINT(${(r.next() * 360 - 180).toFixed(5)} ${(r.next() * 180 - 90).toFixed(5)})')` };
      default: return null;
    }
  }

  function sentence(n, cap) {
    const w = Array.from({ length: n }, () => r.pick(WORDS)).join(' ');
    return cap ? w[0].toUpperCase() + w.slice(1) + '.' : w;
  }
}

const ascii = s => s.normalize('NFD').replace(/[^\w]/g, '').toLowerCase();

/** Cuts a string to the column's length; a unique suffix is kept (before the @ of an e-mail address). */
function fit(v, pt, suffix, kind) {
  const max = maxLen(pt);
  if (suffix) {
    if (kind === 'email' && v.includes('@')) {
      const [local, domain] = v.split('@');
      const room = max ? Math.max(1, max - domain.length - suffix.length - 2) : local.length;
      v = `${local.slice(0, room)}.${suffix}@${domain}`;
    } else {
      const room = max ? Math.max(0, max - suffix.length - 1) : v.length;
      v = room ? `${v.slice(0, room)}-${suffix}` : suffix;
    }
  }
  return max && v.length > max ? v.slice(0, max) : v;
}

/** A generated value as SQL. */
export function toSql(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return v.sql;
  return sqlStr(v);
}

/** A generated value as the grid shows it in the preview. */
export function toDisplay(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v.sql.startsWith("'") ? v.sql.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, '\\') : v.sql;
  return String(v);
}

/** Multi-row INSERT statements of at most `batch` rows each. */
export function insertStatements(db, table, columns, rows, batch = 500) {
  const head = `INSERT INTO ${qi(db)}.${qi(table)} (${columns.map(qi).join(', ')}) VALUES\n`;
  const out = [];
  for (let i = 0; i < rows.length; i += batch) {
    out.push(head + rows.slice(i, i + batch).map(r => `(${r.map(toSql).join(', ')})`).join(',\n'));
  }
  return out;
}

/** Lower-case names of the columns that alone make up a primary or unique key. */
export function uniqueColumns(indexes) {
  return new Set((indexes || []).filter(i => (i.type === 'PRIMARY' || i.type === 'UNIQUE') && i.columns.length === 1 && i.columns[0].name)
    .map(i => i.columns[0].name.toLowerCase()));
}
