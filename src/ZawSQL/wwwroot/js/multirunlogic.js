// "Run on several servers": combining the results of each server into one result per statement.

const SERVER_COL = { name: 'Server', type: 'VARCHAR', kind: 'text' };

/** The k-th result set of each statement, from every server whose columns match, become one set with a Server column. */
export function combineResults(servers) {
  const groups = new Map();
  for (const s of servers) {
    const seen = new Map(); // statement -> sets seen so far on this server
    for (const set of s.resultSets || []) {
      const k = seen.get(set.statement) || 0;
      seen.set(set.statement, k + 1);
      const sig = set.columns.map(c => c.name).join('\u0001');
      const key = `${set.statement}\u0002${k}\u0002${sig}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { statement: set.statement, k, sql: set.sql, columns: [SERVER_COL, ...set.columns.map(stripSource)], rows: [], truncated: false, servers: [] }));
      for (const r of set.rows) g.rows.push([s.name, ...r]);
      if (set.truncated) g.truncated = true;
      g.servers.push(s.name);
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.statement - b.statement || a.k - b.k)
    .map(g => ({ statement: g.statement, sql: g.sql, columns: g.columns, rows: g.rows, truncated: g.truncated, servers: g.servers, multi: true }));
}

// Combined results can't be edited in place, so the source table isn't kept.
function stripSource(c) {
  return { name: c.name, type: c.type, kind: c.kind };
}

/** One row per server: how the run went there. */
export function summarySet(servers, statementCount) {
  const num = { type: 'BIGINT', kind: 'number' };
  return {
    statement: -1,
    sql: 'Summary',
    summary: true,
    multi: true,
    truncated: false,
    columns: [SERVER_COL, { name: 'Status', type: 'VARCHAR', kind: 'text' }, { name: 'Statements', ...num }, { name: 'Rows', ...num }, { name: 'Affected', ...num }, { name: 'Time (s)', type: 'DECIMAL', kind: 'number' }, { name: 'Error', type: 'VARCHAR', kind: 'text' }],
    rows: servers.map(s => [
      s.name,
      serverStatus(s),
      `${s.executed} of ${statementCount}`,
      String((s.resultSets || []).reduce((n, set) => n + set.rows.length, 0)),
      String(s.affected || 0),
      (s.ms / 1000).toFixed(3),
      s.error || (s.errors?.length ? errorText(s.errors[0]) : null),
    ]),
  };
}

export function serverStatus(s) {
  if (s.error) return s.error === 'Stopped.' ? 'Stopped' : 'Failed';
  if (s.errors?.length) return 'Error';
  return 'OK';
}

function errorText(e) {
  return `#${e.statement + 1}: ${e.code ? `SQL Error (${e.code}): ` : 'Blocked in read-only mode: '}${e.message}`;
}

/** Status line text for the whole run. */
export function runSummary(servers) {
  const failed = servers.filter(s => serverStatus(s) !== 'OK').length;
  const n = servers.length;
  return failed ? `${n - failed} of ${n} servers OK, ${failed} with errors` : `${n} server${n === 1 ? '' : 's'} OK`;
}

/** Sessions shown in the picker: name order, with the ones last chosen preselected. */
export function pickerItems(sessions, connectedProfiles, lastChosen = []) {
  const last = new Set(lastChosen);
  return sessions
    .map(s => ({
      id: s.id,
      name: s.name,
      host: s.host,
      production: !!s.production,
      readOnly: !!s.readOnly,
      connected: connectedProfiles.has(s.id),
      // A session not connected now is connected for the run, which needs its saved password.
      needsPassword: !connectedProfiles.has(s.id) && !s.hasPassword && s.savePassword === false,
      checked: last.has(s.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
