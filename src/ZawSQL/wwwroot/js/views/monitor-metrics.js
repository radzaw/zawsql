// Live monitor: turning periodic SHOW GLOBAL STATUS snapshots into rates, series and formatted values.
// Pure functions (no DOM), unit-tested in tests/js.

export const MAX_HISTORY_MS = 15 * 60 * 1000;
export const WINDOWS = [{ label: '1 min', ms: 60_000 }, { label: '5 min', ms: 300_000 }, { label: '15 min', ms: 900_000 }];
export const INTERVALS = [1, 2, 5, 10];

// Each sample runs one SELECT (active queries) and two SHOW statements; subtract them so the monitor
// doesn't show up as load. Keep in sync with ServerMonitor.cs.
export const OWN = { select: 1, other: 2 };

/**
 * Appends a sample to the history (oldest first). A restart or FLUSH STATUS makes counters go backwards;
 * then the history restarts so no negative rates are drawn. Returns true when the history was reset.
 */
export function pushSample(history, sample) {
  const last = history[history.length - 1];
  const reset = !!last && (sample.status.Uptime ?? 0) < (last.s.Uptime ?? 0);
  if (reset) history.length = 0;
  history.push({ t: sample.t, s: sample.status, v: sample.variables || {} });
  const cutoff = sample.t - MAX_HISTORY_MS;
  while (history.length > 2 && history[0].t < cutoff) history.shift();
  return reset;
}

/** Per-second rate of a counter between two samples; null when unknown or the counter went backwards. */
export function rate(prev, cur, key, subtract = 0) {
  const a = prev?.s[key], b = cur?.s[key];
  const dt = (cur?.t - prev?.t) / 1000;
  if (a == null || b == null || !(dt > 0) || b < a) return null;
  return Math.max(0, (b - a - subtract) / dt);
}

const gauge = key => (_, cur) => cur?.s[key] ?? null;

/** Total client statements per second, without the monitor's own. */
export function totalQps(prev, cur) {
  return rate(prev, cur, 'Questions', OWN.select + OWN.other);
}

function otherQps(prev, cur) {
  const total = totalQps(prev, cur);
  if (total == null) return null;
  const known = ['Com_select', 'Com_insert', 'Com_replace', 'Com_update', 'Com_delete']
    .map(k => rate(prev, cur, k, k === 'Com_select' ? OWN.select : 0) ?? 0)
    .reduce((a, b) => a + b, 0);
  return Math.max(0, total - known);
}

/** Chart definitions: one unit per chart (never two y-scales); series colors follow their slot, never their rank. */
export const CHARTS = [
  {
    id: 'queries', title: 'Queries per second', format: 'rate',
    series: [
      { key: 'select', label: 'SELECT', slot: 1, value: (p, c) => rate(p, c, 'Com_select', OWN.select) },
      { key: 'insert', label: 'INSERT', slot: 2, value: (p, c) => sumRates(p, c, ['Com_insert', 'Com_replace']) },
      { key: 'update', label: 'UPDATE', slot: 3, value: (p, c) => rate(p, c, 'Com_update') },
      { key: 'delete', label: 'DELETE', slot: 4, value: (p, c) => rate(p, c, 'Com_delete') },
      { key: 'other', label: 'Other', slot: 5, value: otherQps },
    ],
  },
  {
    id: 'connections', title: 'Connections', format: 'int',
    series: [
      { key: 'connected', label: 'Connected', slot: 1, value: gauge('Threads_connected') },
      { key: 'running', label: 'Running', slot: 2, value: gauge('Threads_running') },
    ],
  },
  {
    id: 'network', title: 'Network traffic', format: 'bytes',
    series: [
      { key: 'received', label: 'Received', slot: 1, value: (p, c) => rate(p, c, 'Bytes_received') },
      { key: 'sent', label: 'Sent', slot: 2, value: (p, c) => rate(p, c, 'Bytes_sent') },
    ],
  },
  {
    id: 'rows', title: 'Row operations per second', format: 'rate',
    series: [
      { key: 'read', label: 'Read', slot: 1, value: (p, c) => rowRate(p, c, 'Innodb_rows_read', HANDLER_READS) },
      { key: 'inserted', label: 'Inserted', slot: 2, value: (p, c) => rowRate(p, c, 'Innodb_rows_inserted', ['Handler_write']) },
      { key: 'updated', label: 'Updated', slot: 3, value: (p, c) => rowRate(p, c, 'Innodb_rows_updated', ['Handler_update']) },
      { key: 'deleted', label: 'Deleted', slot: 4, value: (p, c) => rowRate(p, c, 'Innodb_rows_deleted', ['Handler_delete']) },
    ],
  },
  {
    id: 'issues', title: 'Problem indicators per second', format: 'rate',
    series: [
      { key: 'slow', label: 'Slow queries', slot: 1, value: (p, c) => rate(p, c, 'Slow_queries') },
      { key: 'tmpdisk', label: 'Temp tables on disk', slot: 2, value: (p, c) => rate(p, c, 'Created_tmp_disk_tables') },
      { key: 'aborted', label: 'Aborted connects', slot: 3, value: (p, c) => rate(p, c, 'Aborted_connects') },
    ],
  },
];

const HANDLER_READS = ['Handler_read_first', 'Handler_read_key', 'Handler_read_last', 'Handler_read_next',
  'Handler_read_prev', 'Handler_read_rnd', 'Handler_read_rnd_next'];

/** InnoDB's row counter when the server has it (MySQL), else the engine-independent Handler counters (MariaDB). */
function rowRate(p, c, innodbKey, handlerKeys) {
  return c?.s[innodbKey] != null ? rate(p, c, innodbKey) : sumRates(p, c, handlerKeys);
}

function sumRates(p, c, keys) {
  const vals = keys.map(k => rate(p, c, k));
  return vals.every(v => v == null) ? null : vals.reduce((a, b) => a + (b ?? 0), 0);
}

/** Points [{t, values: {key: number|null}}] of a chart for samples newer than `since`. */
export function chartPoints(history, chart, since = -Infinity) {
  const out = [];
  for (let i = 1; i < history.length; i++) {
    const cur = history[i];
    if (cur.t < since) continue;
    const values = {};
    for (const s of chart.series) values[s.key] = s.value(history[i - 1], cur);
    out.push({ t: cur.t, values });
  }
  return out;
}

/** Current / average / peak of each series over the points (for legends and the table view). */
export function summarize(points, key) {
  const vals = points.map(p => p.values[key]).filter(v => v != null);
  if (!vals.length) return { current: null, avg: null, peak: null };
  const current = [...points].reverse().find(p => p.values[key] != null).values[key];
  return { current, avg: vals.reduce((a, b) => a + b, 0) / vals.length, peak: Math.max(...vals) };
}

/** Headline numbers from the latest samples; window aggregates use the samples since `since`. */
export function kpis(history, since = -Infinity) {
  const n = history.length;
  const cur = history[n - 1], prev = history[n - 2];
  if (!cur) return null;
  const inWindow = history.filter(h => h.t >= since);
  const first = inWindow[0] ?? cur;
  const maxConn = Number(cur.v.max_connections) || null;
  const total = cur.s.Innodb_buffer_pool_pages_total, free = cur.s.Innodb_buffer_pool_pages_free;
  const reqs = (cur.s.Innodb_buffer_pool_read_requests ?? 0) - (first.s.Innodb_buffer_pool_read_requests ?? 0);
  const diskReads = (cur.s.Innodb_buffer_pool_reads ?? 0) - (first.s.Innodb_buffer_pool_reads ?? 0);
  return {
    qps: prev ? totalQps(prev, cur) : null,
    qpsTrend: history.slice(1).map((h, i) => totalQps(history[i], h)).slice(-60),
    connected: cur.s.Threads_connected ?? null,
    maxConnections: maxConn,
    connectionUse: maxConn ? (cur.s.Threads_connected ?? 0) / maxConn : null,
    running: cur.s.Threads_running ?? null,
    hitRatio: reqs > 0 ? 1 - diskReads / reqs : null,
    bufferPoolUse: total ? 1 - (free ?? 0) / total : null,
    bufferPoolSize: Number(cur.v.innodb_buffer_pool_size) || null,
    uptime: cur.s.Uptime ?? null,
    longQueryTime: Number(cur.v.long_query_time) || null,
  };
}

/** Status of a utilization ratio: thresholds for the meter (paired with an icon + label in the UI). */
export function utilizationStatus(ratio) {
  if (ratio == null) return null;
  if (ratio >= 0.95) return { level: 'critical', label: 'Critical' };
  if (ratio >= 0.8) return { level: 'warning', label: 'High' };
  return null;
}

// ---------------------------------------------------------------- formatting

export function formatValue(v, format) {
  if (v == null || !isFinite(v)) return '–';
  if (format === 'bytes') return formatBytesRate(v);
  if (format === 'int') return Math.round(v).toLocaleString('en-US');
  if (format === 'percent') return (v * 100).toFixed(v >= 0.999 && v < 1 ? 2 : 1) + '%';
  return formatRate(v);
}

export function formatRate(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  if (v >= 100) return Math.round(v).toLocaleString('en-US');
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export function formatBytesRate(v) {
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

export function formatUptime(s) {
  if (s == null) return '–';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

/**
 * A clean axis with four equal intervals: the smallest step of 1/2/2.5/5×10ⁿ (binary multiples of
 * 1024ⁿ for bytes, whole numbers for counts) whose four steps cover the data.
 */
export function niceScale(maxValue, format) {
  const bytes = format === 'bytes';
  const base = bytes ? 1024 : 10;
  const multipliers = bytes ? [1, 2, 5, 10, 20, 50, 100, 200, 500] : [1, 2, 2.5, 5];
  const floor = format === 'int' ? 4 : bytes ? 1024 : 1;
  const max = Math.max(maxValue || 0, floor);
  let mag = Math.pow(base, Math.floor(Math.log(max / 4) / Math.log(base)));
  for (let guard = 0; guard < 40; guard++, mag *= base) {
    for (const m of multipliers) {
      const step = format === 'int' ? Math.max(1, Math.ceil(mag * m)) : mag * m;
      if (step * 4 >= max) return { max: step * 4, ticks: [0, step, 2 * step, 3 * step, 4 * step] };
    }
  }
  return { max, ticks: [0, max] };
}
