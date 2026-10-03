// Replication status: pure helpers (no DOM), unit-tested in tests/js.
import { fmtSeconds } from './insightlogic.js';

export { fmtSeconds };
export const LAG_HISTORY_MS = 15 * 60 * 1000;

/** An IO / SQL thread state (Yes / No / Connecting) for people. */
export function threadState(v) {
  if (v === 'Yes') return { label: 'Running', severity: 'good' };
  if (v === 'Connecting') return { label: 'Connecting', severity: 'warning' };
  return { label: 'Stopped', severity: 'critical' };
}

/** How far behind the source a channel is; a configured delay (SQL_Delay) is expected lag. */
export function lagState(ch) {
  const lag = ch.lagSeconds;
  if (lag == null) {
    return ch.sqlRunning === 'Yes' && ch.ioRunning !== 'Yes'
      ? { label: 'Unknown – not receiving events', severity: 'critical' }
      : ch.sqlRunning === 'Yes' ? { label: 'Unknown', severity: 'warning' } : { label: 'Unknown – applier stopped', severity: 'critical' };
  }
  const allowed = ch.sqlDelay || 0;
  if (lag <= allowed + 5) return { label: lag === 0 ? 'In sync' : allowed && lag >= allowed ? `Delayed by design (${fmtSeconds(lag)})` : `${fmtSeconds(lag)} behind`, severity: 'good' };
  if (lag <= allowed + 60) return { label: `${fmtSeconds(lag)} behind`, severity: 'warning' };
  return { label: `${fmtSeconds(lag)} behind`, severity: 'critical' };
}

/** The one-line verdict on a channel, worst first. */
export function channelHealth(ch) {
  if (ch.sqlError) return { label: `Stopped by an error (${ch.sqlError.number})`, severity: 'critical' };
  if (ch.ioError && ch.ioRunning !== 'Yes') return { label: `Can't reach the source (${ch.ioError.number})`, severity: 'critical' };
  if (ch.ioRunning === 'No' && ch.sqlRunning === 'No') return { label: 'Stopped', severity: 'critical' };
  if (ch.sqlRunning !== 'Yes') return { label: 'Applier stopped', severity: 'critical' };
  if (ch.ioRunning !== 'Yes') return { label: ch.ioRunning === 'Connecting' ? 'Connecting to the source' : 'Not receiving events', severity: ch.ioRunning === 'Connecting' ? 'warning' : 'critical' };
  return lagState(ch);
}

export const channelLabel = ch => (ch.channel ? `“${ch.channel}”` : 'default channel');
export const sourceLabel = ch => `${ch.sourceHost ?? '?'}${ch.sourcePort && ch.sourcePort !== 3306 ? ':' + ch.sourcePort : ''}`;

/** What this server is in the replication topology. */
export function roleSummary(s) {
  const replicas = Math.max(s.connected.length, s.registered.length);
  const sources = [...new Set(s.channels.map(sourceLabel))];
  const of = sources.length === 1 ? `of ${sources[0]}` : `of ${sources.length} sources`;
  switch (s.role) {
    case 'both': return `Replica ${of}, and primary for ${replicas} replica${replicas === 1 ? '' : 's'}`;
    case 'replica': return `Replica ${of}`;
    case 'primary': return `Primary with ${replicas} replica${replicas === 1 ? '' : 's'}`;
    default: return s.identity.logBin ? 'Not replicating – binary log on, no replicas connected' : 'Not replicating – binary log off';
  }
}

/** A GTID set ("uuid:1-5,\nuuid2:1-9") as its parts. */
export const gtidParts = set => String(set || '').split(',').map(x => x.trim()).filter(Boolean);

/** Configuration worth knowing about: { severity, text }. */
export function advice(s) {
  const out = [];
  const replica = s.channels.length > 0, primary = s.role === 'primary' || s.role === 'both';
  if (replica && !s.identity.readOnly) out.push({ severity: 'warning', text: 'This replica accepts writes (read_only is off). Data written here directly can conflict with changes from the source and stop replication.' });
  if (primary && !replica && s.identity.readOnly) out.push({ severity: 'info', text: 'This primary is read-only (read_only is on), so applications can\'t write to it.' });
  if ((primary || replica) && s.identity.logBin && s.identity.binlogFormat && s.identity.binlogFormat !== 'ROW') {
    out.push({ severity: 'info', text: `binlog_format is ${s.identity.binlogFormat}; ROW is the safest format for replication.` });
  }
  if (primary && s.identity.syncBinlog != null && s.identity.syncBinlog !== 1) out.push({ severity: 'info', text: `sync_binlog = ${s.identity.syncBinlog}: a crash of the primary can lose the last transactions of the binary log.` });
  if (s.server === 'mysql' && (primary || replica) && s.gtid.mode && s.gtid.mode !== 'ON') out.push({ severity: 'info', text: `GTIDs are ${s.gtid.mode}: with gtid_mode = ON replicas find their position automatically after a failover.` });
  if (s.server === 'mariadb' && s.channels.some(c => c.usingGtid === 'No')) out.push({ severity: 'info', text: 'A channel replicates by file and position (Using_Gtid = No); MASTER_USE_GTID = slave_pos makes failover easier.' });
  return out;
}

/** Appends a lag sample per channel and drops samples older than 15 minutes. */
export function pushLag(history, t, channels) {
  for (const ch of channels) {
    const k = ch.channel || '';
    const list = history.get(k) || [];
    list.push({ t, values: { lag: ch.lagSeconds } });
    while (list.length > 1 && list[0].t < t - LAG_HISTORY_MS) list.shift();
    history.set(k, list);
  }
  for (const k of [...history.keys()]) if (!channels.some(c => (c.channel || '') === k)) history.delete(k);
  return history;
}
