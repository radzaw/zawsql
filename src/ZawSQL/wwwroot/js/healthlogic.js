// Server health report: the checks (pure functions, no DOM), unit-tested in tests/js against facts captured from
// MySQL and MariaDB. The backend (HealthReport.cs) only collects facts; everything that decides what is a problem,
// how serious it is and how to fix it lives here.
import { esc, fmtBytes, fmtNum, qi } from './util.js';
import { fmtSeconds } from './insightlogic.js';
import { channelHealth, channelLabel, sourceLabel, advice } from './replicationlogic.js';

export const AREAS = [
  ['config', 'Configuration'],
  ['schema', 'Schema'],
  ['indexes', 'Indexes'],
  ['security', 'Security'],
  ['replication', 'Replication'],
  ['workload', 'Workload'],
];
export const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
export const SEVERITY_LABEL = { critical: 'Critical', warning: 'Warning', info: 'Note' };

const MIB = 1024 ** 2, GIB = 1024 ** 3;
const DEFAULT_BUFFER_POOL = 128 * MIB;
/** Built-in accounts that are locked or can't log in by design. */
const SYSTEM_ACCOUNTS = new Set(['mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'PUBLIC']);

const n = v => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
const on = v => v === 'ON' || v === '1' || v === 'YES';
const pct = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;
const plural = (k, one, many = one + 's') => `${fmtNum(k)} ${k === 1 ? one : many}`;
const tableName = t => `${t.schema}.${t.name ?? t.table}`;
const quoted = (schema, table) => `${qi(schema)}.${qi(table)}`;
const account = a => `'${a.user.replace(/'/g, "''")}'@'${a.host.replace(/'/g, "''")}'`;
/** Seconds as "30 days" when whole days, else like fmtSeconds. */
const fmtDays = s => (s >= 86400 && s % 86400 === 0 ? plural(s / 86400, 'day') : fmtSeconds(s));

// ------------------------------------------------------------------ versions

/** Support end of release series (YYYY-MM). MariaDB short-term releases are supported for a year. */
const EOL = {
  mysql: { '5.6': '2021-02', '5.7': '2023-10', '8.0': '2026-04', '8.4': '2032-04' },
  mariadb: { '10.3': '2023-05', '10.4': '2024-06', '10.5': '2025-06', '10.6': '2026-07', '10.11': '2028-02', '11.4': '2029-05' },
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** "8.4.11" / "11.4.13-MariaDB-ubu2404-log" → { major, minor, series: "8.4" }. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v || '');
  return m ? { major: +m[1], minor: +m[2], patch: m[3] != null ? +m[3] : null, series: `${m[1]}.${m[2]}` } : null;
}

// ------------------------------------------------------------------ redundant indexes

/** "name(10)" → { name, len: 10 }. */
const part = c => {
  const m = /^(.*)\((\d+)\)$/.exec(c);
  return m ? { name: m[1], len: +m[2] } : { name: c, len: null };
};
/** Does index column a serve every lookup that b's column serves? b may index a longer prefix (or all) of it. */
const covers = (a, b) => {
  if (a.startsWith('(expression') || b.startsWith('(expression')) return false;
  const x = part(a), y = part(b);
  return x.name.toLowerCase() === y.name.toLowerCase() && (y.len == null || (x.len != null && x.len <= y.len));
};
const rank = i => (i.name === 'PRIMARY' ? 0 : i.unique ? 1 : 2);

/**
 * Indexes whose columns are a leading part of another index on the same table: lookups can use the other one,
 * so this one only costs space and write time. Unique indexes and the primary key enforce rules and are only
 * redundant as an exact duplicate of another unique index. Returns [{ schema, table, index, columns, coveredBy, byColumns }].
 */
export function redundantIndexes(indexes) {
  const byTable = new Map();
  for (const i of indexes) {
    if ((i.type || 'BTREE') !== 'BTREE') continue; // FULLTEXT, SPATIAL and HASH work differently
    const k = `${i.schema}\u0000${i.table}`;
    if (!byTable.has(k)) byTable.set(k, []);
    byTable.get(k).push(i);
  }
  const out = [];
  for (const list of byTable.values()) {
    list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    for (const [ai, a] of list.entries()) {
      if (a.name === 'PRIMARY') continue;
      const by = list.find((b, bi) => {
        if (b === a || out.some(o => o.schema === b.schema && o.table === b.table && o.index === b.name)) return false;
        if (b.columns.length < a.columns.length || !a.columns.every((c, j) => covers(c, b.columns[j]))) return false;
        // Of two identical indexes, the first (primary key, unique, then by name) is kept.
        const same = b.columns.length === a.columns.length && a.columns.every((c, j) => c === b.columns[j]);
        if (same && bi > ai) return false;
        if (!a.unique) return true;
        // A unique index enforces uniqueness of exactly its columns.
        return b.unique && same;
      });
      if (by) out.push({ schema: a.schema, table: a.table, index: a.name, columns: a.columns, coveredBy: by.name, byColumns: by.columns });
    }
  }
  return out;
}

// ------------------------------------------------------------------ auto-increment

const INT_MAX = { tinyint: 127, smallint: 32767, mediumint: 8388607, int: 2147483647, integer: 2147483647, bigint: 9223372036854775807 };
/** The largest value an integer column type can hold. */
export const intMax = (type, unsigned) => {
  const m = INT_MAX[String(type).toLowerCase()];
  return m == null ? null : unsigned ? m * 2 + 1 : m;
};
const NEXT_TYPE = { tinyint: 'SMALLINT', smallint: 'INT', mediumint: 'INT', int: 'BIGINT', integer: 'BIGINT' };

// ------------------------------------------------------------------ the checks

/**
 * Each check returns a finding ({ severity, title, detail, fix?, items? }), pass(text) when the check found
 * nothing wrong, or null when it doesn't apply to this server (or there isn't enough data to judge).
 */
const pass = text => ({ pass: text });

const CHECKS = [
  // ---------------------------------------------------------------- configuration
  ['version', 'config', (f, x) => {
    const v = parseVersion(f.version);
    if (!v) return null;
    const product = f.server === 'mariadb' ? 'MariaDB' : 'MySQL';
    if (f.server === 'mysql' && v.major >= 9) {
      return { severity: 'info', title: `MySQL ${v.series} is an Innovation release`, detail: 'Innovation releases are supported only until the next one comes out (about every three months). Either upgrade with each release, or use the long-term support series 8.4.' };
    }
    const eol = EOL[f.server]?.[v.series];
    if (!eol) {
      return f.server === 'mariadb' && v.major === 11 && ![4, 8].includes(v.minor)
        ? { severity: 'info', title: `MariaDB ${v.series} is a short-term release`, detail: 'Short-term MariaDB releases are supported for one year. For a server that should run for years, use a long-term series (10.11, 11.4 or 11.8).' }
        : null;
    }
    const nowYm = new Date(x.now).toISOString().slice(0, 7);
    const soon = new Date(x.now); soon.setMonth(soon.getMonth() + 6);
    if (eol < nowYm) return { severity: 'critical', title: `${product} ${v.series} reached its end of life in ${monthName(eol)}`, detail: 'It no longer gets security fixes. Plan an upgrade to a supported long-term series.' };
    if (eol <= soon.toISOString().slice(0, 7)) return { severity: 'warning', title: `${product} ${v.series} reaches its end of life in ${monthName(eol)}`, detail: 'After that it gets no more security fixes. Plan the upgrade now.' };
    return pass(`${product} ${v.series} is supported until ${monthName(eol)}`);
  }],

  ['buffer-pool-size', 'config', (f, x) => {
    const bp = n(f.variables.innodb_buffer_pool_size);
    if (bp == null || !x.innodbBytes) return null;
    if (x.innodbBytes <= bp) return pass(`The InnoDB buffer pool (${fmtBytes(bp)}) can hold all InnoDB data (${fmtBytes(x.innodbBytes)})`);
    const isDefault = bp === DEFAULT_BUFFER_POOL;
    return {
      severity: isDefault ? 'warning' : 'info',
      title: isDefault ? `The InnoDB buffer pool is still the default ${fmtBytes(bp)}` : `InnoDB data (${fmtBytes(x.innodbBytes)}) is larger than the buffer pool (${fmtBytes(bp)})`,
      detail: `InnoDB keeps data and indexes it works with in the buffer pool; what doesn't fit is read from disk. The data is ${fmtBytes(x.innodbBytes)}. Only the frequently used part needs to fit, so check the buffer pool hit rate too.`,
      fix: { text: 'On a dedicated database server, give the buffer pool 50–75% of the memory. It can be resized while the server runs; also put the value in the configuration file.', sql: `SET ${x.persist} innodb_buffer_pool_size = ${Math.ceil(Math.min(x.innodbBytes * 1.25, 64 * GIB) / GIB)} * 1024 * 1024 * 1024;` },
    };
  }],

  ['buffer-pool-hits', 'config', f => {
    const req = n(f.status.Innodb_buffer_pool_read_requests), reads = n(f.status.Innodb_buffer_pool_reads);
    if (req == null || reads == null || req < 1_000_000) return null;
    const miss = reads / req;
    if (miss <= 0.01) return pass(`${pct(1 - miss, 2)} of InnoDB page reads come from memory`);
    return {
      severity: miss > 0.05 ? 'warning' : 'info',
      title: `${pct(miss, 1)} of InnoDB page reads have to go to disk`,
      detail: `${fmtNum(reads)} of ${fmtNum(req)} page reads since the server started missed the buffer pool. On a busy server, more than 1% usually means the frequently used data doesn't fit in memory.`,
      fix: { text: 'Increase innodb_buffer_pool_size if the server has memory to spare, or find the queries that read the most rows (Host › Performance).' },
    };
  }],

  ['redo-log', 'config', (f, x) => {
    const v = f.variables;
    const capacity = n(v.innodb_redo_log_capacity) ?? (n(v.innodb_log_file_size) != null ? n(v.innodb_log_file_size) * (n(v.innodb_log_files_in_group) ?? 1) : null);
    const written = n(f.status.Innodb_os_log_written);
    if (capacity == null || written == null || x.uptime < 3600 || written === 0) return null;
    const perHour = written / x.uptime * 3600;
    if (capacity >= perHour) return pass(`The redo log (${fmtBytes(capacity)}) holds more than an hour of writes (${fmtBytes(perHour)} per hour)`);
    const target = Math.ceil(perHour * 1.5 / GIB) * GIB;
    const sql = v.innodb_redo_log_capacity != null
      ? `SET PERSIST innodb_redo_log_capacity = ${target / GIB} * 1024 * 1024 * 1024;`
      : f.server === 'mariadb' ? `SET GLOBAL innodb_log_file_size = ${target / GIB} * 1024 * 1024 * 1024;` : null;
    return {
      severity: capacity < perHour / 4 ? 'warning' : 'info',
      title: `The redo log is smaller than an hour of writes`,
      detail: `InnoDB writes ${fmtBytes(perHour)} of redo log per hour on average, but the redo log holds ${fmtBytes(capacity)}. A full redo log forces InnoDB to flush pages early, which slows down writes in bursts.`,
      fix: { text: 'Size the redo log for at least an hour of writes. MySQL 8.0.30+ (innodb_redo_log_capacity) and MariaDB 10.9+ (innodb_log_file_size) can resize it while running; older versions need a restart with a new configuration.', sql },
    };
  }],

  ['connections', 'config', f => {
    const max = n(f.variables.max_connections), used = n(f.status.Max_used_connections);
    if (!max || used == null) return null;
    const refused = n(f.status.Connection_errors_max_connections) ?? 0;
    if (used >= max || refused > 0) {
      return {
        severity: 'critical',
        title: refused ? `${plural(refused, 'connection was', 'connections were')} refused: max_connections (${max}) was reached` : `The connection limit (max_connections = ${max}) was reached`,
        detail: 'Clients got "Too many connections". Either the application opens more connections than needed (connection leaks, missing pooling) or the limit is too low.',
        fix: { text: 'Check the process list for idle connections, use connection pooling, and raise the limit if the server has memory for it.', sql: `SET ${f.server === 'mariadb' ? 'GLOBAL' : 'PERSIST'} max_connections = ${Math.ceil(max * 1.5)};` },
      };
    }
    if (used / max >= 0.85) return { severity: 'warning', title: `Connections peaked at ${used} of ${max} (${pct(used / max)})`, detail: 'The server came close to refusing connections since it started.', fix: { text: 'Look for idle or leaked connections in the process list, and raise max_connections if needed.' } };
    return pass(`Connections peaked at ${used} of ${max}`);
  }],

  ['tmp-disk', 'config', f => {
    const all = n(f.status.Created_tmp_tables), disk = n(f.status.Created_tmp_disk_tables);
    if (all == null || disk == null || all < 1000) return null;
    const share = disk / all;
    if (share <= 0.25) return pass(`${pct(share)} of internal temporary tables went to disk`);
    return {
      severity: 'info',
      title: `${pct(share)} of internal temporary tables went to disk`,
      detail: `${fmtNum(disk)} of ${fmtNum(all)} temporary tables (GROUP BY, DISTINCT, UNION, derived tables) were too big for memory or contained TEXT/BLOB columns.`,
      fix: { text: 'Find the queries with "Using temporary" in Host › Performance (temp tables on disk). Raising tmp_table_size and max_heap_table_size helps when they are large, not when they contain TEXT/BLOB columns.' },
    };
  }],

  ['thread-cache', 'config', f => {
    const conns = n(f.status.Connections), created = n(f.status.Threads_created);
    if (conns == null || created == null || conns < 1000) return null;
    if (created / conns <= 0.1) return pass(`The thread cache served ${pct(1 - created / conns)} of new connections`);
    return {
      severity: 'info',
      title: `A new thread was created for ${pct(created / conns)} of connections`,
      detail: 'Creating a thread per connection costs time when clients connect often. The thread cache keeps threads of closed connections for reuse.',
      fix: { sql: `SET GLOBAL thread_cache_size = ${Math.min(Math.max(n(f.status.Max_used_connections) ?? 16, 16), 1000)};` },
    };
  }],

  ['durability', 'config', f => {
    const v = f.variables, items = [];
    if (n(v.innodb_flush_log_at_trx_commit) != null && n(v.innodb_flush_log_at_trx_commit) !== 1) items.push(['innodb_flush_log_at_trx_commit', v.innodb_flush_log_at_trx_commit, 'up to about a second of committed transactions can be lost in a crash']);
    if (on(v.log_bin) && n(v.sync_binlog) != null && n(v.sync_binlog) !== 1) items.push(['sync_binlog', v.sync_binlog, 'the last transactions can be missing from the binary log after a crash, so replicas and point-in-time recovery can miss them']);
    if (!items.length) return pass('Committed transactions survive a crash (innodb_flush_log_at_trx_commit = 1, sync_binlog = 1)');
    return {
      severity: 'info',
      title: 'Commits are not fully durable',
      detail: 'These settings trade crash safety for write speed. That can be the right choice, but it should be a decision.',
      items: { columns: ['Setting', 'Value', 'Effect'], rows: items },
      fix: { sql: items.map(([k]) => `SET ${f.server === 'mariadb' ? 'GLOBAL' : 'PERSIST'} ${k} = 1;`).join('\n') },
    };
  }],

  ['sql-mode', 'config', f => {
    const mode = f.variables.sql_mode;
    if (mode == null) return null;
    if (/STRICT_(TRANS|ALL)_TABLES/.test(mode)) return pass('Strict SQL mode is on: invalid values are rejected');
    return {
      severity: 'warning',
      title: 'Strict SQL mode is off',
      detail: `sql_mode is "${mode || '(empty)'}". Without STRICT_TRANS_TABLES, values that don't fit (too long strings, out-of-range numbers, invalid dates) are silently cut or changed instead of rejected.`,
      fix: { text: 'Test the application with strict mode first: statements that used to "work" will fail.', sql: `SET GLOBAL sql_mode = '${['STRICT_TRANS_TABLES', ...mode.split(',').filter(Boolean)].join(',')}';` },
    };
  }],

  ['charset-server', 'config', f => {
    const cs = f.variables.character_set_server;
    if (!cs) return null;
    if (cs === 'utf8mb4') return pass('New databases use utf8mb4 by default');
    return {
      severity: 'info',
      title: `The server's default character set is ${cs}`,
      detail: 'New databases and tables get it unless they say otherwise. utf8mb4 stores every character, including emoji; utf8/utf8mb3 and latin1 don\'t.',
      fix: { text: 'Set character_set_server = utf8mb4 in the configuration file (and collation_server to a utf8mb4 collation).' },
    };
  }],

  ['binlog', 'config', f => {
    if (f.variables.log_bin == null) return null;
    if (on(f.variables.log_bin)) return pass(`The binary log is on (point-in-time recovery possible; kept for ${fmtDays(n(f.variables.binlog_expire_logs_seconds) ?? (n(f.variables.expire_logs_days) ?? 0) * 86400)})`);
    return { severity: 'info', title: 'The binary log is off', detail: 'Without it, a backup can only be restored to the moment it was taken (no point-in-time recovery), and the server can\'t be a replication source.', fix: { text: 'Enable log_bin (and server_id) in the configuration file; it needs a restart.' } };
  }],

  ['slow-log', 'config', f => {
    const v = f.variables;
    if (v.slow_query_log == null) return null;
    const lqt = n(v.long_query_time) ?? 10;
    if (!on(v.slow_query_log)) return { severity: 'info', title: 'The slow query log is off', detail: 'It records statements slower than long_query_time, which is often the quickest way to find what slows the server down.', fix: { sql: `SET GLOBAL slow_query_log = 1;${lqt > 2 ? '\nSET GLOBAL long_query_time = 1;' : ''}` } };
    if (lqt > 2) return { severity: 'info', title: `The slow query log only records statements slower than ${lqt} s`, detail: 'Most problem queries take well under 10 seconds but run often.', fix: { sql: 'SET GLOBAL long_query_time = 1;' } };
    return pass(`The slow query log records statements slower than ${lqt} s`);
  }],

  ['performance-schema', 'config', f => (f.performanceSchema
    ? pass('performance_schema is on (statement statistics, unused-index check)')
    : { severity: 'info', title: 'performance_schema is off', detail: 'Statement statistics (Host › Performance › Top queries), the unused-index check and lock details need it. It is off by default on MariaDB.', fix: { text: 'Set performance_schema = ON in the configuration file and restart. It costs a few percent of performance and some memory.' } })],

  ['file-per-table', 'config', f => {
    const v = f.variables.innodb_file_per_table;
    if (v == null) return null;
    if (on(v)) return pass('Each InnoDB table has its own file (innodb_file_per_table)');
    return { severity: 'info', title: 'InnoDB tables are stored in the shared system tablespace', detail: 'With innodb_file_per_table off, space freed by dropping or truncating tables is never returned to the operating system.', fix: { sql: 'SET GLOBAL innodb_file_per_table = ON;', text: 'Tables move to their own files only when they are rebuilt (ALTER TABLE … ENGINE=InnoDB).' } };
  }],

  // ---------------------------------------------------------------- schema
  ['primary-keys', 'schema', (f, x) => {
    const missing = f.tables.filter(t => t.engine === 'InnoDB' && !x.primary.has(`${t.schema}\u0000${t.name}`));
    if (!f.tables.some(t => t.engine === 'InnoDB')) return null;
    if (!missing.length) return pass('Every InnoDB table has a primary key');
    const first = missing[0];
    return {
      severity: 'warning',
      title: `${plural(missing.length, 'table has', 'tables have')} no primary key`,
      detail: 'InnoDB then uses a hidden row id, rows can\'t be addressed reliably (editing them in a grid or in tools is ambiguous), row-based replication scans the whole table for every changed row, and Group Replication and Galera refuse such tables.',
      items: { columns: ['Table', 'Rows', 'Size'], rows: missing.map(t => [tableName(t), fmtNum(t.rows), fmtBytes(t.dataBytes + t.indexBytes)]) },
      fix: { text: 'Make a unique NOT NULL column the primary key, or add an id column. Example for the first table:', sql: `ALTER TABLE ${quoted(first.schema, first.name)} ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;` },
    };
  }],

  ['engines', 'schema', f => {
    if (!f.tables.length) return null;
    const odd = f.tables.filter(t => ['MyISAM', 'Aria', 'MEMORY'].includes(t.engine));
    if (!odd.length) return pass('All tables use InnoDB (or a special-purpose engine)');
    const myisam = odd.filter(t => t.engine === 'MyISAM');
    const why = { MyISAM: 'not crash-safe, no transactions, locks the whole table', Aria: 'no transactions, locks the whole table', MEMORY: 'emptied when the server restarts' };
    return {
      severity: myisam.length ? 'warning' : 'info',
      title: `${plural(odd.length, 'table doesn\'t', 'tables don\'t')} use InnoDB`,
      detail: 'InnoDB is crash-safe, transactional and locks rows instead of whole tables. Other engines are fine for special cases but are usually left over from old setups.',
      items: { columns: ['Table', 'Engine', 'Why it matters', 'Size'], rows: odd.map(t => [tableName(t), t.engine, why[t.engine], fmtBytes(t.dataBytes + t.indexBytes)]) },
      fix: myisam.length ? { text: 'Converting rebuilds the table and locks it meanwhile; do large tables in a quiet period.', sql: myisam.map(t => `ALTER TABLE ${quoted(t.schema, t.name)} ENGINE=InnoDB;`).join('\n') } : null,
    };
  }],

  ['auto-increment', 'schema', f => {
    if (!f.autoIncrement.length) return null;
    const rows = f.autoIncrement.map(a => ({ ...a, max: intMax(a.type, a.unsigned) }))
      .filter(a => a.max).map(a => ({ ...a, used: (a.next - 1) / a.max }))
      .filter(a => a.used >= 0.75).sort((a, b) => b.used - a.used);
    if (!rows.length) return pass('All auto-increment columns are below 75% of their range');
    const worst = rows[0].used;
    return {
      severity: worst >= 0.9 ? 'critical' : 'warning',
      title: `${plural(rows.length, 'auto-increment column is', 'auto-increment columns are')} running out of values`,
      detail: 'When the column reaches the largest value of its type, inserts fail ("Duplicate entry" or "Out of range"). Gaps from deleted rows and rolled-back inserts are never reused.',
      items: { columns: ['Table', 'Column', 'Type', 'Next value', 'Maximum', 'Used'], rows: rows.map(a => [tableName(a), a.column, `${a.type}${a.unsigned ? ' unsigned' : ''}`, fmtNum(a.next), fmtNum(a.max), pct(a.used, 1)]) },
      fix: { text: `Change the column to a larger type (${rows.map(a => `${a.type.toUpperCase()} → ${NEXT_TYPE[a.type.toLowerCase()] ?? 'BIGINT UNSIGNED'}`).filter((v, i, all) => all.indexOf(v) === i).join(', ')}), keeping its other attributes, and the same for columns that reference it. The table is rebuilt.` },
    };
  }],

  ['fragmentation', 'schema', f => {
    if (!f.tables.length) return null;
    const shared = f.variables.innodb_file_per_table != null && !on(f.variables.innodb_file_per_table);
    const rows = f.tables.filter(t => !(shared && t.engine === 'InnoDB') && t.freeBytes >= 100 * MIB && t.freeBytes > 0.2 * (t.dataBytes + t.indexBytes));
    if (!rows.length) return pass('No table has much unused space');
    const total = rows.reduce((s, t) => s + t.freeBytes, 0);
    return {
      severity: 'info',
      title: `${fmtBytes(total)} of unused space in ${plural(rows.length, 'table')}`,
      detail: 'Space from deleted rows is reused for new rows of the same table, but isn\'t returned to the operating system until the table is rebuilt.',
      items: { columns: ['Table', 'Data + indexes', 'Unused'], rows: rows.map(t => [tableName(t), fmtBytes(t.dataBytes + t.indexBytes), fmtBytes(t.freeBytes)]) },
      fix: { text: 'Rebuilding copies the table; it only pays off when the space is needed elsewhere.', sql: rows.map(t => `OPTIMIZE TABLE ${quoted(t.schema, t.name)};`).join('\n') },
    };
  }],

  ['charsets', 'schema', f => {
    if (!f.tables.length) return null;
    const rows = f.tables.filter(t => t.collation && !/^(utf8mb4|binary|ascii)/i.test(t.collation));
    if (!rows.length) return pass('All tables use utf8mb4');
    const target = /^utf8mb4/.test(f.variables.collation_server || '') ? f.variables.collation_server : 'utf8mb4_unicode_ci';
    return {
      severity: 'info',
      title: `${plural(rows.length, 'table uses', 'tables use')} a legacy character set`,
      detail: 'latin1 and utf8/utf8mb3 can\'t store every character (utf8mb3 rejects emoji). Joining columns with different character sets also stops the join from using an index.',
      items: { columns: ['Table', 'Collation', 'Size'], rows: rows.map(t => [tableName(t), t.collation, fmtBytes(t.dataBytes + t.indexBytes)]) },
      fix: { text: 'CONVERT TO rebuilds the table and converts the text. Check first that latin1 columns really hold latin1 (not UTF-8 bytes stored as latin1).', sql: rows.map(t => `ALTER TABLE ${quoted(t.schema, t.name)} CONVERT TO CHARACTER SET utf8mb4 COLLATE ${target};`).join('\n') },
    };
  }],

  // ---------------------------------------------------------------- indexes
  ['redundant-indexes', 'indexes', (f, x) => {
    if (!f.indexes.length) return null;
    if (!x.redundant.length) return pass('No redundant indexes');
    return {
      severity: 'warning',
      title: `${plural(x.redundant.length, 'index is', 'indexes are')} redundant`,
      detail: 'Each of these is a leading part of another index on the same table, which serves the same lookups. A redundant index still costs disk space, memory and time on every insert, update and delete.',
      items: { columns: ['Table', 'Index', 'Columns', 'Covered by', 'Its columns'], rows: x.redundant.map(r => [tableName(r), r.index, r.columns.join(', '), r.coveredBy, r.byColumns.join(', ')]) },
      fix: { text: 'Review before dropping: an index hint (USE INDEX) or a tool may refer to it by name.', sql: x.redundant.map(r => `ALTER TABLE ${quoted(r.schema, r.table)} DROP INDEX ${qi(r.index)};`).join('\n') },
    };
  }],

  ['unused-indexes', 'indexes', (f, x) => {
    if (!f.unusedIndexes) return null;
    const unique = new Set(f.indexes.filter(i => i.unique).map(i => `${i.schema}\u0000${i.table}\u0000${i.name}`));
    const redundant = new Set(x.redundant.map(r => `${r.schema}\u0000${r.table}\u0000${r.index}`));
    const rows = f.unusedIndexes.filter(u => !unique.has(`${u.schema}\u0000${u.table}\u0000${u.index}`) && !redundant.has(`${u.schema}\u0000${u.table}\u0000${u.index}`));
    if (!rows.length) return pass('Every non-unique index was used since the server started');
    const longEnough = x.uptime >= 30 * 86400;
    const hide = f.server === 'mariadb' ? 'IGNORED' : 'INVISIBLE';
    return {
      severity: longEnough ? 'warning' : 'info',
      title: `${plural(rows.length, 'index was', 'indexes were')} not used since the server started ${fmtSeconds(x.uptime)} ago`,
      detail: longEnough
        ? 'No query read these indexes, but every write still updates them.'
        : `The server has only been running for ${fmtSeconds(x.uptime)}; an index used by a weekly or monthly job may still be needed. Unique indexes are not listed (they enforce uniqueness even when unread).`,
      items: { columns: ['Table', 'Index'], rows: rows.map(u => [tableName(u), u.index]) },
      fix: { text: `Make the index ${hide.toLowerCase()} first: queries stop using it but it is kept up to date, so it can be switched back at once if something gets slow. Drop it later.`, sql: rows.map(u => `ALTER TABLE ${quoted(u.schema, u.table)} ALTER INDEX ${qi(u.index)} ${hide};`).join('\n') },
    };
  }],

  ['no-index-statements', 'indexes', f => {
    if (!f.noIndexStatements) return null;
    const rows = f.noIndexStatements;
    if (!rows.length) return pass('No statement ran without a usable index');
    return {
      severity: 'info',
      title: `${plural(rows.length, 'statement shape', 'statement shapes')}${rows.length === 10 ? ' (or more)' : ''} ran without a usable index`,
      detail: 'These statements read tables without an index (full table scans) or with a poor one, slowest first. On small tables that is fine.',
      items: { columns: ['Database', 'Statement', 'Executions', 'Total time', 'Rows examined per row returned'], rows: rows.map(r => [r.schema, r.query.length > 160 ? r.query.slice(0, 157) + '…' : r.query, fmtNum(r.count), fmtSeconds(r.totalMs / 1000), r.rowsSent ? fmtNum(Math.round(r.rowsExamined / r.rowsSent)) : '–']) },
      fix: { text: 'Open Host › Performance › Top queries for the full statements and their EXPLAIN, then add the missing indexes.' },
    };
  }],

  // ---------------------------------------------------------------- security
  ['anonymous-accounts', 'security', (f, x) => {
    if (!x.accounts) return null;
    const rows = x.accounts.filter(a => a.user === '');
    if (!rows.length) return pass('No anonymous accounts');
    return {
      severity: 'critical',
      title: `${plural(rows.length, 'anonymous account exists', 'anonymous accounts exist')}`,
      detail: 'An account with an empty user name lets anyone log in with any user name (from the hosts it allows).',
      items: { columns: ['Account'], rows: rows.map(a => [account(a)]) },
      fix: { sql: rows.map(a => `DROP USER ${account(a)};`).join('\n') },
    };
  }],

  ['empty-passwords', 'security', (f, x) => {
    if (!x.accounts) return null;
    const rows = x.accounts.filter(a => a.emptyPassword && a.user !== '');
    if (!rows.length) return pass('Every account that logs in with a password has one');
    return {
      severity: 'critical',
      title: `${plural(rows.length, 'account has', 'accounts have')} no password`,
      detail: 'Anyone who can reach the server can log in as these accounts.',
      items: { columns: ['Account', 'Authentication'], rows: rows.map(a => [account(a), a.plugin]) },
      fix: { text: 'Set a password, or lock the account if it isn\'t used. Replace the placeholder before running:', sql: rows.map(a => `ALTER USER ${account(a)} IDENTIFIED BY '<new password>';`).join('\n') },
    };
  }],

  ['remote-admins', 'security', (f, x) => {
    if (!x.accounts) return null;
    const rows = x.accounts.filter(a => a.host === '%' && (a.allPrivileges || a.admin.length));
    if (!rows.length) return pass('No administrator account accepts logins from any host');
    return {
      severity: 'warning',
      title: `${plural(rows.length, 'administrator account accepts', 'administrator accounts accept')} logins from any host`,
      detail: 'These accounts have global administrative privileges and their host is "%", so a leaked password works from anywhere that can reach the server.',
      items: { columns: ['Account', 'Privileges'], rows: rows.map(a => [account(a), a.allPrivileges ? 'ALL PRIVILEGES' : a.admin.join(', ')]) },
      fix: { text: 'Limit the host to where administrators connect from (for example a subnet), or use a separate, restricted account for applications.', sql: rows.map(a => `RENAME USER ${account(a)} TO ${account({ ...a, host: '10.0.0.%' })};  -- adjust the host`).join('\n') },
    };
  }],

  ['native-password', 'security', (f, x) => {
    if (!x.accounts || f.server !== 'mysql') return null;
    const v = parseVersion(f.version);
    const rows = x.accounts.filter(a => a.plugin === 'mysql_native_password');
    if (!rows.length) return pass('No account uses the deprecated mysql_native_password');
    const removed = v && (v.major > 8 || (v.major === 8 && v.minor >= 4));
    return {
      severity: removed ? 'warning' : 'info',
      title: `${plural(rows.length, 'account uses', 'accounts use')} mysql_native_password`,
      detail: `mysql_native_password is deprecated: ${removed ? 'MySQL 8.4 disables it by default and MySQL 9.0 removed it.' : 'MySQL 8.4 disables it by default and 9.0 removes it.'} caching_sha2_password is the replacement; current client libraries support it.`,
      items: { columns: ['Account'], rows: rows.map(a => [account(a)]) },
      fix: { text: 'Re-set each password with the new plugin. Replace the placeholder before running:', sql: rows.map(a => `ALTER USER ${account(a)} IDENTIFIED WITH caching_sha2_password BY '<password>';`).join('\n') },
    };
  }],

  ['local-infile', 'security', f => {
    const v = f.variables.local_infile;
    if (v == null) return null;
    if (!on(v)) return pass('LOAD DATA LOCAL INFILE is disabled');
    return { severity: 'info', title: 'LOAD DATA LOCAL INFILE is enabled', detail: 'It lets clients send local files to the server. If a client connects to a malicious or compromised server, that server can request any file the client can read. Turn it off unless an application needs it.', fix: { sql: 'SET GLOBAL local_infile = OFF;' } };
  }],

  ['tls', 'security', f => {
    const v = f.variables;
    const tls = v.have_ssl === 'YES' || (v.have_ssl == null && !!v.tls_version);
    if (!tls) return { severity: 'warning', title: 'TLS (SSL) is not available', detail: 'Passwords and data travel unencrypted between clients and the server.', fix: { text: 'Configure ssl_cert, ssl_key and ssl_ca and restart (MySQL 8 creates certificates automatically).' } };
    if (on(v.require_secure_transport)) return pass('Clients must use TLS (require_secure_transport)');
    return { severity: 'info', title: 'Clients may connect without TLS', detail: 'TLS is available, but unencrypted connections are accepted too. Over an untrusted network, passwords and data can be read.', fix: { text: 'Require TLS for all connections, or per account (ALTER USER … REQUIRE SSL), once every client supports it.', sql: `SET ${f.server === 'mariadb' ? 'GLOBAL' : 'PERSIST'} require_secure_transport = ON;` } };
  }],

  ['test-database', 'security', f => {
    if (!f.schemas.includes('test')) return pass('There is no "test" database');
    return { severity: 'info', title: 'A database named "test" exists', detail: 'Older installations gave every user access to "test" (and to databases starting with "test_"). If it isn\'t used, it is better removed.', fix: { text: 'Check that it is not used, then drop it and remove grants on `test` and `test\\_%` from mysql.db.' } };
  }],

  // ---------------------------------------------------------------- replication
  ['replication-channels', 'replication', f => {
    const r = f.replication;
    if (!r || !r.channels.length) return null;
    const bad = r.channels.map(ch => ({ ch, h: channelHealth(ch) })).filter(x => x.h.severity === 'critical' || x.h.severity === 'warning');
    if (!bad.length) return pass(`Replication is healthy (${r.channels.map(ch => `${sourceLabel(ch)}: ${channelHealth(ch).label}`).join(', ')})`);
    return {
      severity: bad.some(x => x.h.severity === 'critical') ? 'critical' : 'warning',
      title: bad.length === 1 ? `Replication from ${sourceLabel(bad[0].ch)}: ${bad[0].h.label}` : `${bad.length} replication channels have problems`,
      detail: 'Host › Replication shows the threads, errors and positions, and can start replication again.',
      items: { columns: ['Source', 'Channel', 'State', 'Error'], rows: bad.map(({ ch, h }) => [sourceLabel(ch), channelLabel(ch), h.label, (ch.sqlError || ch.ioError)?.message ?? '']) },
    };
  }],

  ['replication-setup', 'replication', f => {
    const r = f.replication;
    if (!r || r.role === 'standalone') return null;
    // sync_binlog is covered by the durability check.
    const tips = advice(r).filter(a => !a.text.startsWith('sync_binlog'));
    if (!tips.length) return pass('The replication setup follows the usual recommendations');
    return {
      severity: tips.some(t => t.severity === 'warning') ? 'warning' : 'info',
      title: `${plural(tips.length, 'replication setting is', 'replication settings are')} worth a look`,
      detail: tips.map(t => t.text).join(' '),
      items: { columns: ['Advice'], rows: tips.map(t => [t.text]) },
    };
  }],

  // ---------------------------------------------------------------- workload (counters since the server started)
  ['slow-queries', 'workload', f => {
    const q = n(f.status.Questions), slow = n(f.status.Slow_queries);
    if (q == null || slow == null || q < 10_000) return null;
    if (slow / q <= 0.01) return pass(`${pct(slow / q, 2)} of statements were slower than long_query_time`);
    return { severity: 'warning', title: `${pct(slow / q, 1)} of statements were slower than long_query_time (${n(f.variables.long_query_time) ?? '?'} s)`, detail: `${fmtNum(slow)} of ${fmtNum(q)} statements since the server started.`, fix: { text: 'Find them in Host › Performance (top queries, slow query log).' } };
  }],

  ['full-joins', 'workload', f => {
    const sel = n(f.status.Com_select), full = n(f.status.Select_full_join);
    if (sel == null || full == null || sel < 1000) return null;
    if (full / sel <= 0.01) return pass('Joins almost always use an index');
    return { severity: 'warning', title: `${pct(full / sel, 1)} of SELECTs joined a table without an index`, detail: `${fmtNum(full)} joins read every row of a table for each row of the previous one (Select_full_join). They get slower with the square of the table size.`, fix: { text: 'Look for "Using join buffer" in EXPLAIN (Host › Performance › Top queries flags joins without an index) and index the join columns.' } };
  }],

  ['row-lock-waits', 'workload', f => {
    const waits = n(f.status.Innodb_row_lock_waits), avg = n(f.status.Innodb_row_lock_time_avg);
    if (waits == null || avg == null) return null;
    if (waits < 100 || avg < 500) return pass(`Row lock waits are rare or short (${fmtNum(waits)} waits, ${fmtNum(avg)} ms on average)`);
    return { severity: 'warning', title: `Transactions waited for row locks ${fmtNum(waits)} times, ${fmtNum(avg)} ms on average`, detail: 'Long waits usually come from long transactions or transactions left open by the application.', fix: { text: 'Host › Performance › Locks & transactions shows who blocks whom, right now.' } };
  }],

  ['deadlocks', 'workload', (f, x) => {
    const d = n(f.status.Innodb_deadlocks);
    if (d == null) return null;
    if (d === 0) return pass('No deadlocks since the server started');
    const perDay = d / Math.max(x.uptime / 86400, 1);
    return { severity: perDay >= 10 ? 'warning' : 'info', title: `${plural(d, 'deadlock')} since the server started (${perDay.toFixed(perDay < 10 ? 1 : 0)} per day)`, detail: 'InnoDB resolves a deadlock by rolling back one transaction; the application has to retry it.', fix: { text: 'Host › Performance › Locks & transactions shows the latest one. Touching rows in the same order in every transaction avoids most deadlocks.' } };
  }],

  ['aborted-connects', 'workload', f => {
    const conns = n(f.status.Connections), aborted = n(f.status.Aborted_connects);
    if (conns == null || aborted == null || conns < 1000) return null;
    if (aborted < 100 || aborted / conns <= 0.05) return pass(`Few failed connection attempts (${fmtNum(aborted)})`);
    return { severity: 'info', title: `${pct(aborted / conns, 1)} of connection attempts failed`, detail: `${fmtNum(aborted)} attempts failed: wrong passwords, unknown accounts, missing privileges on the default database, or clients timing out during the handshake.`, fix: { text: 'The server\'s error log names the accounts and hosts (with log_error_verbosity = 3 on MySQL).' } };
  }],

  ['table-locks', 'workload', f => {
    const waited = n(f.status.Table_locks_waited), immediate = n(f.status.Table_locks_immediate);
    if (waited == null || immediate == null || waited + immediate < 1000) return null;
    const share = waited / (waited + immediate);
    if (share <= 0.01) return pass('Table locks rarely had to wait');
    return { severity: 'info', title: `${pct(share, 1)} of table locks had to wait`, detail: 'Table-level locks come from MyISAM, Aria and MEMORY tables (and LOCK TABLES). Under concurrent writes they serialize everything.', fix: { text: 'Convert busy non-InnoDB tables to InnoDB (see Schema).' } };
  }],
];

/** Number of checks (for the summary and tests). */
export const CHECK_COUNT = CHECKS.length;

/** Runs every check. Returns { findings, passed, skipped, counts, overview, notes }. */
export function analyze(f, now = Date.now()) {
  const primary = new Set(f.indexes.filter(i => i.name === 'PRIMARY').map(i => `${i.schema}\u0000${i.table}`));
  const x = {
    now,
    uptime: n(f.status.Uptime) ?? 0,
    innodbBytes: f.tables.filter(t => t.engine === 'InnoDB').reduce((s, t) => s + t.dataBytes + t.indexBytes, 0),
    persist: f.server === 'mariadb' ? 'GLOBAL' : 'PERSIST',
    primary,
    accounts: f.accounts?.filter(a => !a.locked && !a.isRole && !SYSTEM_ACCOUNTS.has(a.user)) ?? null,
  };
  // Computed on first use, inside the checks that need it, so a failure is reported by them.
  let redundant;
  Object.defineProperty(x, 'redundant', { get: () => (redundant ??= redundantIndexes(f.indexes)) });
  const findings = [], passed = [], skipped = [];
  for (const [id, area, check] of CHECKS) {
    let r;
    try {
      r = check(f, x);
    } catch (e) {
      r = { severity: 'info', title: `The "${id}" check failed`, detail: String(e?.message ?? e) };
    }
    if (!r) skipped.push(id);
    else if (r.pass) passed.push({ id, area, title: r.pass });
    else findings.push({ id, area, ...r });
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { critical: 0, warning: 0, info: 0, passed: passed.length };
  for (const fd of findings) counts[fd.severity]++;
  return { findings, passed, skipped, counts, overview: overview(f, x), notes: f.notes ?? [] };
}

/** Sizes, engines and the largest tables. */
export function overview(f, x = { uptime: n(f.status.Uptime) ?? 0 }) {
  const engines = new Map();
  for (const t of f.tables) {
    const e = engines.get(t.engine ?? '?') ?? { engine: t.engine ?? '?', tables: 0, bytes: 0 };
    e.tables++;
    e.bytes += t.dataBytes + t.indexBytes;
    engines.set(e.engine, e);
  }
  return {
    uptime: x.uptime,
    databases: f.schemas.length,
    tables: f.tables.length,
    dataBytes: f.tables.reduce((s, t) => s + t.dataBytes, 0),
    indexBytes: f.tables.reduce((s, t) => s + t.indexBytes, 0),
    engines: [...engines.values()].sort((a, b) => b.bytes - a.bytes),
    largest: [...f.tables].sort((a, b) => b.dataBytes + b.indexBytes - (a.dataBytes + a.indexBytes)).slice(0, 10),
    connections: { peak: n(f.status.Max_used_connections), max: n(f.variables.max_connections) },
  };
}

/** The one-line verdict. */
export function verdict(counts) {
  if (counts.critical) return { severity: 'critical', text: `${plural(counts.critical, 'critical problem')} to fix` };
  if (counts.warning) return { severity: 'warning', text: `${plural(counts.warning, 'warning')} worth a look` };
  return { severity: 'good', text: counts.info ? 'No problems found, a few notes' : 'No problems found' };
}

// ------------------------------------------------------------------ standalone HTML

const CSS = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #dcdce0; --panel: #f6f6f8; --critical: #c42b2b; --warning: #a86b00; --info: #2b62c4; --good: #1f7a3a; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1c1f; --fg: #e6e6e9; --muted: #9a9aa2; --line: #3a3b40; --panel: #232428; --critical: #f07070; --warning: #e8b04a; --info: #7aa7f5; --good: #6ccf8a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1000px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.muted { color: var(--muted); } .verdict { font-size: 17px; font-weight: 600; margin: 12px 0 4px; }
.counts span { margin-right: 14px; } .sev { font-weight: 600; } .sev-critical { color: var(--critical); } .sev-warning { color: var(--warning); } .sev-info { color: var(--info); } .sev-good { color: var(--good); }
.finding { border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 4px; padding: 8px 12px; margin: 8px 0; background: var(--panel); }
.finding.critical { border-left-color: var(--critical); } .finding.warning { border-left-color: var(--warning); } .finding.info { border-left-color: var(--info); }
.finding h3 { font-size: 14px; margin: 0; } .finding p { margin: 4px 0; }
.scroll { overflow-x: auto; } table { border-collapse: collapse; font-size: 12.5px; margin: 6px 0; } th, td { border: 1px solid var(--line); padding: 3px 8px; text-align: left; vertical-align: top; } th { background: var(--bg); }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 8px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
ul.passed { columns: 2; padding-left: 18px; } @media (max-width: 640px) { ul.passed { columns: 1; } }
`;

const htmlTable = (columns, rows, limit = 500) =>
  `<div class="scroll"><table><thead><tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, limit).map(r => `<tr>${r.map(v => `<td>${esc(v ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${rows.length > limit ? `<p class="muted">… and ${fmtNum(rows.length - limit)} more</p>` : ''}`;

/** The report as a self-contained HTML page (inline CSS, light and dark), to save and share. */
export function reportHtml(report, meta) {
  const v = verdict(report.counts), o = report.overview;
  const title = `Health report – ${meta.server}`;
  const section = ([area, label]) => {
    const list = report.findings.filter(fd => fd.area === area);
    const ok = report.passed.filter(p => p.area === area);
    if (!list.length && !ok.length) return '';
    return `<h2>${esc(label)}</h2>${list.map(fd => `<div class="finding ${fd.severity}"><h3><span class="sev sev-${fd.severity}">${SEVERITY_LABEL[fd.severity]}:</span> ${esc(fd.title)}</h3>${fd.detail ? `<p>${esc(fd.detail)}</p>` : ''}${fd.items ? htmlTable(fd.items.columns, fd.items.rows) : ''}${fd.fix?.text ? `<p><b>Fix:</b> ${esc(fd.fix.text)}</p>` : ''}${fd.fix?.sql ? `<pre>${esc(fd.fix.sql)}</pre>` : ''}</div>`).join('')}${ok.length ? `<p class="muted">Passed: ${ok.map(p => esc(p.title)).join(' · ')}</p>` : ''}`;
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(title)}</h1>
<div class="muted">${esc(meta.version ?? '')} · collected ${esc(meta.collectedAt ?? '')} · up for ${esc(fmtSeconds(o.uptime))} · ZawSQL ${esc(meta.app ?? '')}</div>
<div class="verdict sev-${v.severity}">${esc(v.text)}</div>
<div class="counts"><span class="sev-critical">${report.counts.critical} critical</span><span class="sev-warning">${report.counts.warning} warnings</span><span class="sev-info">${report.counts.info} notes</span><span class="sev-good">${report.counts.passed} passed</span></div>
${AREAS.map(section).join('')}
<h2>Overview</h2>
<p>${fmtNum(o.databases)} databases · ${fmtNum(o.tables)} tables · ${fmtBytes(o.dataBytes)} data · ${fmtBytes(o.indexBytes)} indexes${o.connections.peak != null ? ` · connections peaked at ${o.connections.peak} of ${o.connections.max}` : ''}</p>
${o.engines.length ? htmlTable(['Engine', 'Tables', 'Size'], o.engines.map(e => [e.engine, fmtNum(e.tables), fmtBytes(e.bytes)])) : ''}
${o.largest.length ? `<p><b>Largest tables</b></p>${htmlTable(['Table', 'Engine', 'Rows (estimate)', 'Data', 'Indexes'], o.largest.map(t => [tableName(t), t.engine, fmtNum(t.rows), fmtBytes(t.dataBytes), fmtBytes(t.indexBytes)]))}` : ''}
${report.notes.length ? `<h2>Notes</h2><ul>${report.notes.map(nt => `<li>${esc(nt)}</li>`).join('')}</ul>` : ''}
</main></body></html>
`;
}

/** "health-db1.example.com-2026-10-04.html" */
export const reportFileName = (server, collectedAt) =>
  `health-${String(server).replace(/[^\w.-]+/g, '_')}-${String(collectedAt).slice(0, 10)}.html`;
