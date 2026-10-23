// Host tab › Error log and InnoDB: filtering the error log (performance_schema.error_log) and reading SHOW ENGINE
// INNODB STATUS – its sections, the figures worth a glance, and what needs attention. Pure functions (no DOM),
// unit-tested in tests/js.
import { parseDt } from './eventlogic.js';

// ---------------------------------------------------------------- error log

export const PRIOS = ['System', 'Error', 'Warning', 'Note'];
export const SINCE = [['all', 'Everything kept', null], ['1h', 'Last hour', 3600], ['24h', 'Last 24 hours', 86400], ['7d', 'Last 7 days', 7 * 86400]];

/** Error log rows matching the chosen priorities, period (relative to the server's `now`) and text. */
export function filterLog(rows, { prios = PRIOS, since = 'all', text = '', now = null } = {}) {
  const want = new Set(prios);
  const secs = SINCE.find(s => s[0] === since)?.[2] ?? null;
  const from = secs != null && parseDt(now) != null ? parseDt(now) - secs * 1000 : null;
  const needle = text.trim().toLowerCase();
  return rows.filter(r => want.has(r.prio)
    && (from == null || (parseDt(r.logged) ?? 0) >= from)
    && (!needle || `${r.code} ${r.subsystem} ${r.data}`.toLowerCase().includes(needle)));
}

/** How many rows of each priority: { Error: 3, … }. */
export function countByPrio(rows) {
  const out = Object.fromEntries(PRIOS.map(p => [p, 0]));
  for (const r of rows) out[r.prio] = (out[r.prio] || 0) + 1;
  return out;
}

// ---------------------------------------------------------------- InnoDB status

const DASHES = /^[-=]{3,}$/;
const TITLE = /^[A-Z][A-Z0-9 /,'()&-]*[A-Z)]$/;

/** The monitor text as { created, seconds, sections: [{ title, text }] }, in the server's order. */
export function parseInnodbStatus(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const out = { created: null, seconds: null, sections: [] };
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    if (DASHES.test(line) && (TITLE.test(next) || /INNODB MONITOR OUTPUT$/.test(next)) && DASHES.test(lines[i + 2] ?? '')) {
      const title = lines[i + 1].trim();
      i += 2;
      if (/INNODB MONITOR OUTPUT$/.test(title)) {
        // After the time comes the thread id: hex, or decimal on MySQL 8.4.
        if (!/^END OF/.test(title)) out.created = title.replace(/\s*(?:(?:0x[0-9a-f]+|\d+)\s+)?INNODB MONITOR OUTPUT$/i, '').trim() || null;
        cur = null;
        continue;
      }
      cur = { title, text: '' };
      out.sections.push(cur);
      continue;
    }
    const avg = /^Per second averages calculated from the last (\d+) seconds/.exec(line);
    if (avg) { out.seconds = +avg[1]; continue; }
    if (cur) cur.text += (cur.text ? '\n' : '') + line;
  }
  for (const s of out.sections) s.text = s.text.replace(/\s+$/, '');
  return out;
}

const int = s => (s == null ? null : Number(String(s).replace(/,/g, '')));
const fmt = n => (n == null ? '–' : Math.round(n).toLocaleString('en-US'));
const rate = n => (n == null ? '–' : n >= 100 ? fmt(n) : String(Math.round(n * 100) / 100));
const bytes = n => {
  if (n == null) return '–';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
};
const grab = (text, re) => { const m = re.exec(text ?? ''); return m ? m.slice(1) : null; };

/**
 * The figures worth a glance (tiles), per-section facts ({ title: [[label, value]] }) and findings
 * ({ severity: 'critical'|'warning'|'info', text, hint, section }), from a parsed status.
 */
export function innodbFacts(parsed) {
  const sec = t => parsed.sections.find(s => s.title === t)?.text ?? null;
  const tiles = [], findings = [], facts = {};
  const fact = (section, label, value) => (facts[section] ||= []).push([label, value]);
  const find = (severity, text, hint, section) => findings.push({ severity, text, hint, section });

  const tx = sec('TRANSACTIONS');
  if (tx != null) {
    const hll = int(grab(tx, /History list length (\d+)/)?.[0]);
    const active = [...tx.matchAll(/^---TRANSACTION [\w:]+, ACTIVE (?:\(PREPARED\) )?(\d+) sec/gm)].map(m => +m[1]);
    const waits = (tx.match(/^LOCK WAIT /gm) || []).length;
    const oldest = active.length ? Math.max(...active) : null;
    const listed = (tx.match(/^---TRANSACTION /gm) || []).length;
    if (hll != null) { fact('TRANSACTIONS', 'History list length', fmt(hll)); tiles.push({ label: 'History list', value: fmt(hll), title: 'Undo records waiting for purge' }); }
    fact('TRANSACTIONS', 'Active transactions', `${fmt(active.length)}${oldest != null ? ` (oldest ${fmt(oldest)} s)` : ''}`);
    fact('TRANSACTIONS', 'Waiting for a lock', fmt(waits));
    if (/truncated/i.test(tx)) fact('TRANSACTIONS', 'Note', 'the server cut the list short');
    tiles.push({ label: 'Active transactions', value: fmt(active.length), title: `${fmt(listed)} listed, ${fmt(waits)} waiting for a lock` });
    if (hll >= 1_000_000) find('critical', `Purge is far behind: ${fmt(hll)} undo records wait (history list length)`, 'Old row versions pile up and slow every read. A long-running transaction or an open read view usually holds purge back; find it in Performance › Locks & transactions.', 'TRANSACTIONS');
    else if (hll >= 100_000) find('warning', `Purge is behind: ${fmt(hll)} undo records wait (history list length)`, 'A long-running transaction or an open read view usually holds purge back.', 'TRANSACTIONS');
    if (waits) find('warning', `${fmt(waits)} transaction${waits === 1 ? '' : 's'} waiting for a row lock`, 'See who blocks them in Performance › Locks & transactions.', 'TRANSACTIONS');
    if (oldest >= 600) find('warning', `A transaction has been active for ${fmt(oldest)} s`, 'Long transactions hold locks and keep purge from cleaning up.', 'TRANSACTIONS');
  }

  const sem = sec('SEMAPHORES');
  if (sem != null) {
    const waited = [...sem.matchAll(/^--Thread \d+ has waited at .* for ([\d.]+) seconds the semaphore/gm)].map(m => Number(m[1]));
    const res = grab(sem, /reservation count (\d+)/)?.[0];
    if (res != null) fact('SEMAPHORES', 'OS waits (reservation count)', fmt(int(res)));
    fact('SEMAPHORES', 'Threads waiting for a latch', fmt(waited.length));
    if (waited.length) {
      const max = Math.max(...waited);
      fact('SEMAPHORES', 'Longest wait', `${rate(max)} s`);
      find(max >= 240 ? 'critical' : max >= 1 ? 'warning' : 'info', `${fmt(waited.length)} thread${waited.length === 1 ? '' : 's'} waiting for an internal latch, the longest for ${rate(max)} s`,
        'Latch waits that last seconds mean heavy contention (often on the buffer pool, an index page or the dictionary). InnoDB stops the server when one exceeds 600 s.', 'SEMAPHORES');
    }
  }

  const fio = sec('FILE I/O');
  if (fio != null) {
    const pendingAio = [...(fio.match(/Pending normal aio reads:[^\n]*/)?.[0] ?? '').matchAll(/\d+/g)].reduce((a, m) => a + +m[0], 0);
    const fl = grab(fio, /Pending flushes \(fsync\) log: (\d+); buffer pool: (\d+)/);
    const r = grab(fio, /([\d.]+) reads\/s, [\d.]+ avg bytes\/read, ([\d.]+) writes\/s, ([\d.]+) fsyncs\/s/);
    if (r) { fact('FILE I/O', 'Reads / s', rate(+r[0])); fact('FILE I/O', 'Writes / s', rate(+r[1])); fact('FILE I/O', 'Fsyncs / s', rate(+r[2])); }
    const pending = pendingAio + (fl ? +fl[0] + +fl[1] : 0);
    fact('FILE I/O', 'Pending I/O requests', fmt(pending));
    if (pending >= 10) find('warning', `${fmt(pending)} I/O requests are pending`, 'The disks don\'t keep up with InnoDB\'s reads, writes or flushes.', 'FILE I/O');
  }

  const log = sec('LOG');
  if (log != null) {
    const lsn = int(grab(log, /Log sequence number\s+(\d+)/)?.[0]);
    const cp = int(grab(log, /Last checkpoint at\s+(\d+)/)?.[0]);
    const flushed = int(grab(log, /Log flushed up to\s+(\d+)/)?.[0]);
    if (lsn != null) fact('LOG', 'Log sequence number', fmt(lsn));
    if (lsn != null && cp != null) {
      fact('LOG', 'Checkpoint age', bytes(lsn - cp));
      tiles.push({ label: 'Checkpoint age', value: bytes(lsn - cp), title: 'Redo log written since the last checkpoint: what recovery would replay after a crash' });
    }
    if (lsn != null && flushed != null) fact('LOG', 'Not yet flushed', bytes(lsn - flushed));
  }

  const bp = sec('BUFFER POOL AND MEMORY');
  if (bp != null) {
    const size = int(grab(bp, /^Buffer pool size\s+(\d+)/m)?.[0]);
    const free = int(grab(bp, /^Free buffers\s+(\d+)/m)?.[0]);
    const pages = int(grab(bp, /^Database pages\s+(\d+)/m)?.[0]);
    const dirty = int(grab(bp, /^Modified db pages\s+(\d+)/m)?.[0]);
    const hit = grab(bp, /Buffer pool hit rate (\d+) \/ (\d+)/);
    if (size != null) fact('BUFFER POOL AND MEMORY', 'Size', `${fmt(size)} pages`);
    if (free != null) fact('BUFFER POOL AND MEMORY', 'Free', `${fmt(free)} pages`);
    if (dirty != null && pages) fact('BUFFER POOL AND MEMORY', 'Modified (dirty)', `${fmt(dirty)} pages (${Math.round(dirty / pages * 100)}%)`);
    if (hit) {
      const pct = +hit[0] / +hit[1] * 100;
      fact('BUFFER POOL AND MEMORY', 'Hit rate', `${pct.toFixed(1)}%`);
      tiles.push({ label: 'Buffer pool hit rate', value: `${pct.toFixed(1)}%`, title: 'Page reads served from memory since the last printout' });
      if (pct < 95) find('warning', `Buffer pool hit rate is ${pct.toFixed(1)}%`, 'Many page reads go to disk. Right after a restart that is normal while the buffer pool warms up; otherwise a larger innodb_buffer_pool_size helps if the server has the memory.', 'BUFFER POOL AND MEMORY');
    } else if (/No buffer pool page gets since the last printout/.test(bp)) fact('BUFFER POOL AND MEMORY', 'Hit rate', 'no page reads since the last printout');
  }

  const rows = sec('ROW OPERATIONS');
  if (rows != null) {
    const q = grab(rows, /(\d+) queries inside InnoDB, (\d+) queries in queue/);
    const views = grab(rows, /(\d+) read views open inside InnoDB/)?.[0];
    const r = grab(rows, /([\d.]+) inserts\/s, ([\d.]+) updates\/s, ([\d.]+) deletes\/s, ([\d.]+) reads\/s/);
    if (q) { fact('ROW OPERATIONS', 'Queries inside InnoDB', fmt(+q[0])); fact('ROW OPERATIONS', 'Queries in queue', fmt(+q[1])); }
    if (views != null) fact('ROW OPERATIONS', 'Read views open', fmt(+views));
    if (r) {
      fact('ROW OPERATIONS', 'Rows / s', `${rate(+r[3])} read, ${rate(+r[0])} inserted, ${rate(+r[1])} updated, ${rate(+r[2])} deleted`);
      tiles.push({ label: 'Rows read / s', value: rate(+r[3]), title: `${rate(+r[0])} inserted, ${rate(+r[1])} updated, ${rate(+r[2])} deleted per second` });
    }
    if (q && +q[1] > 0) find('warning', `${fmt(+q[1])} queries wait to enter InnoDB`, 'innodb_thread_concurrency limits how many threads work inside InnoDB at once.', 'ROW OPERATIONS');
  }

  const dl = sec('LATEST DETECTED DEADLOCK');
  if (dl != null) {
    const when = dl.split('\n').find(l => /^\d{4}-\d\d-\d\d/.test(l))?.replace(/\s+0x[0-9a-f]+$/i, '');
    find('info', `The latest deadlock was detected${when ? ` at ${when}` : ''}`, 'Performance › Locks & transactions shows it with both transactions.', 'LATEST DETECTED DEADLOCK');
  }
  const fk = sec('LATEST FOREIGN KEY ERROR');
  if (fk != null) {
    const when = fk.split('\n').find(l => /^\d{4}-\d\d-\d\d/.test(l))?.replace(/\s+0x[0-9a-f]+$/i, '');
    find('info', `A foreign key error was recorded${when ? ` at ${when}` : ''}`, 'Its section below names the statement and the constraint.', 'LATEST FOREIGN KEY ERROR');
  }
  const order = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { tiles, facts, findings };
}

/** Human names for the sections, with a line on what each is about. */
export const SECTION_INFO = {
  'BACKGROUND THREAD': 'What the master thread has been doing.',
  SEMAPHORES: 'Threads waiting for InnoDB\'s internal latches (mutexes and rw-locks).',
  'LATEST FOREIGN KEY ERROR': 'The last statement refused by a foreign key, with the constraint.',
  'LATEST DETECTED DEADLOCK': 'The last deadlock: both transactions, the locks they held and wanted, and which one was rolled back.',
  TRANSACTIONS: 'Purge progress and every transaction with its locks.',
  'FILE I/O': 'InnoDB\'s I/O threads, pending requests and read / write rates.',
  'INSERT BUFFER AND ADAPTIVE HASH INDEX': 'The change buffer and the adaptive hash index.',
  LOG: 'The redo log: how far it has been written, flushed and checkpointed.',
  'BUFFER POOL AND MEMORY': 'Pages in memory: free, modified, read and written, and the hit rate.',
  'INDIVIDUAL BUFFER POOL INFO': 'The same figures for each buffer pool instance.',
  'ROW OPERATIONS': 'Queries inside InnoDB and rows read and written per second.',
};
