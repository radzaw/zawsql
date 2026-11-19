// Binary log / relay log viewer: pure helpers (no DOM), unit-tested in tests/js.

/** Events that describe the log itself rather than a change (shown dimmed, and hidden with "Changes only"). */
const META = new Set(['Format_desc', 'Rotate', 'Previous_gtids', 'Stop', 'Binlog_checkpoint', 'Gtid_list', 'Start_encryption', 'Heartbeat', 'Annotate_rows']);
const ROWS = /^(Write|Update|Delete|Partial_update)_rows(_v1)?$/;

/**
 * The GTID a Gtid event starts: MySQL "SET @@SESSION.GTID_NEXT= 'uuid:23'" (also tagged uuid:tag:23), MariaDB
 * "BEGIN GTID 0-1-17" or "GTID 0-1-17" (DDL). null for anonymous transactions and other events.
 */
export function eventGtid(ev) {
  if (!/^Gtid/.test(ev.type || '') || /^Anonymous/.test(ev.type || '')) return null;
  const info = ev.info || '';
  const my = /GTID_NEXT\s*=\s*'([^']+)'/i.exec(info);
  if (my) return my[1] === 'ANONYMOUS' ? null : my[1];
  const ma = /\bGTID\s+(\d+-\d+-\d+)/.exec(info);
  return ma ? ma[1] : null;
}

/** The kind of an event, for its row's style: gtid, commit, rows, meta or other. */
export function eventKind(ev) {
  const t = ev.type || '';
  if (/^(Anonymous_)?Gtid/.test(t)) return 'gtid';
  if (t === 'Xid' || (t === 'Query' && /^\s*COMMIT\b/i.test(ev.info || '')) || t === 'XA_prepare') return 'commit';
  if (ROWS.test(t) || t === 'Table_map') return 'rows';
  if (META.has(t)) return 'meta';
  return 'other';
}

/**
 * The events with what each belongs to: `gtid` (the transaction's GTID, when its Gtid event is on the page), `tx`
 * (a running number per transaction, for alternating shading) and `table` (db.table of row events, from the
 * Table_map event before them).
 */
export function annotateEvents(events) {
  let gtid = null, tx = 0, inTx = false, begun = false;
  const tables = new Map();
  return events.map(ev => {
    const kind = eventKind(ev);
    const out = { ...ev, kind, gtid: null, tx: null, table: null };
    if (kind === 'gtid') {
      gtid = eventGtid(ev);
      tx++;
      inTx = true;
      begun = /^\s*BEGIN\b/i.test(ev.info || ''); // MariaDB's "BEGIN GTID 0-1-17" opens the transaction itself
      out.gtid = gtid;
      out.tx = tx;
      return out;
    }
    if (ev.type === 'Table_map') {
      const m = /table_id:\s*(\d+)\s*\(([^)]*)\)/.exec(ev.info || '');
      if (m) { tables.set(m[1], m[2]); out.table = m[2]; }
    } else if (kind === 'rows') {
      const m = /table_id:\s*(\d+)/.exec(ev.info || '');
      if (m) out.table = tables.get(m[1]) ?? null;
    }
    if (!inTx) return out;
    out.gtid = gtid;
    out.tx = tx;
    const isBegin = ev.type === 'Query' && /^\s*(BEGIN|XA START)\b/i.test(ev.info || '');
    if (isBegin) begun = true;
    // A transaction ends with its commit (Xid / COMMIT), or with its one statement when it has no BEGIN (DDL).
    if (kind === 'commit' || (ev.type === 'Query' && !isBegin && !begun)) {
      inTx = false;
      gtid = null;
    }
    return out;
  });
}

/** Events matching the text (in type, info, table or GTID), optionally without the log's own bookkeeping events. */
export function filterEvents(events, { text = '', changesOnly = false } = {}) {
  const q = text.trim().toLowerCase();
  return events.filter(e => (!changesOnly || e.kind !== 'meta')
    && (!q || [e.type, e.info, e.table, e.gtid, String(e.pos)].some(v => v && String(v).toLowerCase().includes(q))));
}

/** The index of the first event at or after a position (to scroll to it), or -1. */
export function eventIndexAt(events, pos) {
  if (pos == null) return -1;
  const i = events.findIndex(e => e.pos >= pos);
  return i;
}

/** The file after `file` in the list of binary logs, or null. */
export function nextFile(files, file) {
  const i = files.findIndex(f => f.name === file);
  return i >= 0 && i + 1 < files.length ? files[i + 1].name : null;
}

/** The file before `file`, or null. */
export function prevFile(files, file) {
  const i = files.findIndex(f => f.name === file);
  return i > 0 ? files[i - 1].name : null;
}
