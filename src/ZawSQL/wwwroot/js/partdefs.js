// Partition and subpartition definitions with their options, read from SHOW CREATE TABLE (information_schema
// doesn't report DATA DIRECTORY, MAX_ROWS and the like). Pure functions, unit-tested against real server output.

/** Options a partition or subpartition definition can carry, in the order ZawSQL writes them. */
export const OPTION_KEYS = ['comment', 'dataDir', 'indexDir', 'maxRows', 'minRows', 'tablespace'];
export const emptyOptions = () => ({ comment: '', dataDir: '', indexDir: '', maxRows: '', minRows: '', tablespace: '' });

/** Tokens of a SQL fragment: words, numbers, 'strings' (unescaped), `names` (unquoted) and punctuation. */
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let v = '';
      i++;
      while (i < s.length) {
        if (s[i] === '\\' && i + 1 < s.length) { const e = s[i + 1]; v += { n: '\n', r: '\r', t: '\t', 0: '\0' }[e] ?? e; i += 2; continue; }
        if (s[i] === c) { if (s[i + 1] === c) { v += c; i += 2; continue; } i++; break; }
        v += s[i++];
      }
      out.push({ t: 'str', v });
      continue;
    }
    if (c === '`') {
      let v = '';
      i++;
      while (i < s.length) {
        if (s[i] === '`') { if (s[i + 1] === '`') { v += '`'; i += 2; continue; } i++; break; }
        v += s[i++];
      }
      out.push({ t: 'id', v });
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < s.length && /[\w$.]/.test(s[j])) j++;
      out.push({ t: 'word', v: s.slice(i, j), U: s.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    out.push({ t: 'p', v: c });
    i++;
  }
  return out;
}

/** The PARTITION BY … clause of a CREATE TABLE statement (MySQL wraps it in /*!50100 … *\/), or null. */
export function partitionClauseOf(create) {
  if (!create) return null;
  const at = findClauseStart(create);
  if (at < 0) return null;
  return create.slice(at).trim().replace(/^\/\*!\d+\s*/, '').replace(/\s*\*\/\s*$/, '');
}

/** Where PARTITION BY starts at the top level (after the column list), skipping strings and quoted names. */
function findClauseStart(create) {
  let depth = 0;
  for (let i = 0; i < create.length; i++) {
    const c = create[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < create.length && create[i] !== q) i += create[i] === '\\' && q !== '`' ? 2 : 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /^(\/\*!\d+\s*)?PARTITION\s+BY\b/i.test(create.slice(i, i + 30))) return i;
  }
  return -1;
}

/** Reads the options after a definition's name/values: COMMENT, DATA DIRECTORY, MAX_ROWS … (ENGINE kept separately). */
function readOptions(toks, k) {
  const opts = emptyOptions();
  let engine = null;
  const eq = () => { if (toks[k]?.v === '=') k++; };
  for (;;) {
    const t = toks[k];
    if (!t || t.t !== 'word') break;
    if (t.U === 'COMMENT') { k++; eq(); opts.comment = toks[k++]?.v ?? ''; continue; }
    if ((t.U === 'DATA' || t.U === 'INDEX') && toks[k + 1]?.U === 'DIRECTORY') {
      k += 2; eq();
      opts[t.U === 'DATA' ? 'dataDir' : 'indexDir'] = normDir(toks[k++]?.v ?? '');
      continue;
    }
    if (t.U === 'MAX_ROWS' || t.U === 'MIN_ROWS') { k++; eq(); opts[t.U === 'MAX_ROWS' ? 'maxRows' : 'minRows'] = toks[k++]?.v ?? ''; continue; }
    if (t.U === 'TABLESPACE') { k++; eq(); opts.tablespace = toks[k++]?.v ?? ''; continue; }
    if (t.U === 'STORAGE' && toks[k + 1]?.U === 'ENGINE') { k++; continue; }
    if (t.U === 'ENGINE') { k++; eq(); engine = toks[k++]?.v ?? null; continue; }
    if (t.U === 'NODEGROUP') { k++; eq(); k++; continue; }
    break;
  }
  return { opts, engine, k };
}

/** MySQL reports DATA DIRECTORY with a trailing slash ('/data/x/'); MariaDB without. Both mean the same. */
export const normDir = d => (d.length > 1 ? d.replace(/[\\/]+$/, '') : d);

/** Skips a balanced ( … ) group starting at toks[k]; returns the index after it and the raw text inside. */
function group(toks, k) {
  let depth = 0;
  const start = k;
  for (; k < toks.length; k++) {
    if (toks[k].v === '(' && toks[k].t === 'p') depth++;
    else if (toks[k].v === ')' && toks[k].t === 'p' && --depth === 0) return k + 1;
  }
  return start;
}

/**
 * The explicit partition definitions of a CREATE TABLE statement:
 * { subpartitionsAuto, partitions: [{ name, opts, engine, subs: [{ name, opts, engine }] }] }, or null when the table
 * has no partition list (not partitioned, or HASH/KEY with PARTITIONS n). Throws when the clause can't be read.
 */
export function parsePartitionDefs(create) {
  const clause = partitionClauseOf(create);
  if (!clause) return null;
  const toks = tokenize(clause);
  // Find the "(" that opens the partition list: the first one after PARTITION BY … [SUBPARTITION BY …] that is followed by PARTITION.
  let k = 0;
  let subAuto = false;
  while (k < toks.length) {
    const t = toks[k];
    if (t.t === 'p' && t.v === '(') {
      if (toks[k + 1]?.U === 'PARTITION' && toks[k + 2] && toks[k + 2].U !== 'BY') break;
      k = group(toks, k);
      continue;
    }
    if (t.U === 'SUBPARTITIONS') subAuto = true;
    k++;
  }
  if (k >= toks.length) return null; // no list: PARTITIONS n
  k++;
  const partitions = [];
  for (;;) {
    if (toks[k]?.U !== 'PARTITION') throw new Error('Unexpected partition definition.');
    k++;
    const name = toks[k++]?.v;
    if (toks[k]?.U === 'VALUES') {
      k++;
      if (toks[k]?.U === 'LESS') {
        k += 2; // LESS THAN
        if (toks[k]?.U === 'MAXVALUE') k++;
        else k = group(toks, k);
      } else if (toks[k]?.U === 'IN') {
        k = group(toks, k + 1);
      }
    }
    const read = readOptions(toks, k);
    k = read.k;
    const subs = [];
    if (toks[k]?.v === '(' && toks[k + 1]?.U === 'SUBPARTITION') {
      k++;
      for (;;) {
        if (toks[k]?.U !== 'SUBPARTITION') throw new Error('Unexpected subpartition definition.');
        const sname = toks[k + 1]?.v;
        const sub = readOptions(toks, k + 2);
        subs.push({ name: sname, opts: sub.opts, engine: sub.engine });
        k = sub.k;
        if (toks[k]?.v === ',') { k++; continue; }
        if (toks[k]?.v === ')') { k++; break; }
        throw new Error('Unexpected text in the subpartition list.');
      }
    }
    partitions.push({ name, opts: read.opts, engine: read.engine, subs });
    if (toks[k]?.v === ',') { k++; continue; }
    if (toks[k]?.v === ')') break;
    throw new Error('Unexpected text in the partition list.');
  }
  return { subpartitionsAuto: subAuto, partitions };
}

/** Whether any option is set. */
export const hasOptions = o => OPTION_KEYS.some(key => String(o?.[key] ?? '') !== '');

/**
 * A subpartitioned partition as the editor models it: options common to all its subpartitions become the
 * partition's (inherited by subpartitions without their own), the rest stay on the subpartitions. The server stores
 * options only on subpartitions when they are named, and on the partition when it names them itself.
 */
export function splitInherited(partOpts, subs) {
  const effective = subs.map(s => Object.fromEntries(OPTION_KEYS.map(key => [key, s.opts[key] !== '' ? s.opts[key] : partOpts[key]])));
  const common = emptyOptions();
  for (const key of OPTION_KEYS) {
    const vals = new Set(effective.map(e => e[key]));
    common[key] = vals.size === 1 ? [...vals][0] : '';
  }
  const own = effective.map(e => Object.fromEntries(OPTION_KEYS.map(key => [key, e[key] === common[key] ? '' : e[key]])));
  return { common, own };
}
