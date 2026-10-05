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

// ---------- server groups: saved sets of sessions to run on ----------

const sameName = (a, b) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** Groups in name order. */
export function sortGroups(groups) {
  return [...(groups || [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function findGroup(groups, name) {
  return (groups || []).find(g => sameName(g.name, name)) || null;
}

/** Problems with a new group's name and members, or null. */
export function groupProblem(name, sessions) {
  if (!name || !name.trim()) return 'Give the group a name.';
  if (name.trim().length > 60) return 'Keep the name under 60 characters.';
  if (!sessions?.length) return 'Choose at least one server for the group.';
  return null;
}

/** Saves a group (replacing one with the same name, ignoring case); returns the new list. */
export function saveGroup(groups, { name, sessions, database = '' }) {
  const g = { name: name.trim(), sessions: [...new Set(sessions)], database: (database || '').trim() };
  return sortGroups([...(groups || []).filter(x => !sameName(x.name, g.name)), g]);
}

export function removeGroup(groups, name) {
  return (groups || []).filter(g => !sameName(g.name, name));
}

/** A group's members that still exist as saved sessions, and how many are gone. */
export function groupMembers(group, sessions) {
  const ids = new Set((sessions || []).map(s => s.id));
  const present = group.sessions.filter(id => ids.has(id));
  return { present, missing: group.sessions.length - present.length };
}

/** "3 servers", "2 servers, 1 deleted" – and the database when the group has one. */
export function groupSummary(group, sessions) {
  const { present, missing } = groupMembers(group, sessions);
  let s = `${present.length} server${present.length === 1 ? '' : 's'}`;
  if (missing) s += `, ${missing} deleted`;
  if (group.database) s += ` · ${group.database}`;
  return s;
}

/** The group whose (existing) members are exactly the selection, if any. */
export function matchingGroup(groups, selected, sessions) {
  const sel = new Set(selected);
  return (groups || []).find(g => {
    const { present } = groupMembers(g, sessions);
    return present.length === sel.size && present.every(id => sel.has(id));
  }) || null;
}
