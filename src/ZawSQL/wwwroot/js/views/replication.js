// Host tab › Replication: this server as a replica (per channel: threads, lag with a chart, errors, positions,
// GTIDs, start/stop) and as a primary (binary log, GTIDs, connected and registered replicas).
import { h, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { confirmDlg } from '../dialogs.js';
import { TimeChart } from './monitor.js';
import {
  threadState, lagState, channelHealth, channelLabel, sourceLabel, roleSummary, gtidParts, advice, pushLag, fmtSeconds, LAG_HISTORY_MS,
} from '../replicationlogic.js';

const INTERVALS = [[0, 'No auto refresh'], [2, 'Every 2 s'], [5, 'Every 5 s'], [10, 'Every 10 s'], [30, 'Every 30 s']];
const SEV_ICON = { critical: 'error', warning: 'warning', info: 'info', good: 'check' };
const badge = (severity, text) => h('span', { class: `rp-badge sev-${severity}` }, h('span', { html: icon(SEV_ICON[severity] || 'info') }), h('span', null, text));
const pos = (file, p) => (file ? `${file} : ${fmtNum(p)}` : '–');

export class ReplicationView {
  constructor(app) {
    this.app = app;
    this.sid = null;
    this.interval = app.state.replication?.interval ?? 5;
    this.history = new Map();
    this.charts = new Map();
    this.status = h('span', { class: 'muted' });
    const intervalSel = h('select', { class: 'inp', title: 'Auto refresh' }, INTERVALS.map(([v, l]) => h('option', { value: v, selected: v === this.interval }, l)));
    intervalSel.addEventListener('change', () => {
      this.interval = +intervalSel.value;
      this.app.state.replication = { interval: this.interval };
      this.app.saveStateSoon();
      this.schedule();
    });
    this.body = h('div', { class: 'rp-body' });
    this.el = h('div', { class: 'rp' },
      h('div', { class: 'viewbar small' }, h('b', null, 'Replication'), h('div', { class: 'grow' }), this.status, intervalSel,
        h('button', { class: 'tbtn', title: 'Refresh', html: icon('refresh'), onclick: () => this.load() })),
      this.body);
  }

  start(sid) {
    if (sid !== this.sid) {
      this.sid = sid;
      this.data = null;
      this.history = new Map();
      this.charts = new Map();
      this.body.replaceChildren(h('div', { class: 'muted pad' }, 'Loading…'));
    }
    this.running = true;
    this.load();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.running && this.interval > 0) this.timer = setTimeout(() => this.load(true), this.interval * 1000);
  }

  async load(auto = false) {
    clearTimeout(this.timer);
    const sid = this.sid;
    if (!sid) return;
    try {
      const r = await get(`/s/${sid}/replication`, null, { quiet: true });
      if (sid !== this.sid) return;
      this.data = r;
      pushLag(this.history, Date.now(), r.channels);
      this.status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      this.status.classList.remove('err');
      this.render();
    } catch (e) {
      this.status.textContent = e.message;
      this.status.classList.add('err');
      if (!auto) this.app.showError(e);
    }
    if (this.running) this.schedule();
  }

  render() {
    const s = this.data;
    const worst = s.channels.map(channelHealth).sort((a, b) => sevRank(b.severity) - sevRank(a.severity))[0];
    const id = s.identity;
    const facts = [
      `server_id ${id.serverId ?? '?'}`, id.serverUuid && `uuid ${id.serverUuid}`,
      id.logBin ? `binary log on (${id.binlogFormat ?? '?'})` : 'binary log off',
      s.gtid.mode ? `GTID ${s.gtid.mode}` : s.server === 'mariadb' && s.gtid.domainId != null ? `GTID domain ${s.gtid.domainId}` : null,
      id.superReadOnly ? 'super_read_only' : id.readOnly ? 'read_only' : 'writable',
      s.channels.length && id.parallelWorkers ? `${id.parallelWorkers} parallel applier threads` : null,
    ].filter(Boolean);
    const head = h('div', { class: 'rp-head' },
      h('div', { class: 'rp-role' }, h('span', { class: 'rp-role-text' }, roleSummary(s)), worst ? badge(worst.severity, worst.label) : null),
      h('div', { class: 'muted rp-facts' }, facts.join(' · ')));
    const tips = advice(s);
    this.body.replaceChildren(head,
      tips.length ? h('div', { class: 'rp-advice' }, tips.map(a => h('div', null, badge(a.severity, a.text)))) : '',
      ...s.channels.map(ch => this.channelCard(ch)),
      // A replica's own binary log only matters when something replicates from it (chained replication).
      s.identity.logBin && s.role !== 'replica' ? this.primaryCard(s) : '',
      s.role === 'standalone' && !s.channels.length ? h('div', { class: 'rp-card muted' }, 'This server neither replicates from a source nor has replicas connected. Replicas show up here once they connect (as Binlog Dump threads), and replication channels once CHANGE REPLICATION SOURCE (CHANGE MASTER) is configured.') : '',
      s.notes.length ? h('div', { class: 'rp-notes' }, s.notes.map(n => h('div', null, n))) : '');
    // Charts measure their width once they are on the page.
    for (const c of this.charts.values()) if (c.el.isConnected) c.update(c.points, c.from, c.to);
  }

  channelCard(ch) {
    const health = channelHealth(ch);
    const io = threadState(ch.ioRunning), sql = threadState(ch.sqlRunning), lag = lagState(ch);
    const ro = this.app.isReadOnly(this.sid);
    const running = ch.ioRunning !== 'No' || ch.sqlRunning !== 'No';
    const tile = (label, main, sub) => h('div', { class: 'rp-tile' }, h('div', { class: 'muted' }, label), h('div', { class: 'rp-tile-main' }, main), sub ? h('div', { class: 'muted rp-tile-sub' }, sub) : '');
    const errors = [
      ch.sqlError && ['Applier (SQL thread) error', ch.sqlError, 'Fix the cause on this replica (for example remove the conflicting row), then start replication again.'],
      ch.ioError && ['Receiver (IO thread) error', ch.ioError, 'Check that the source is reachable and the replication user and password are valid.'],
    ].filter(Boolean).map(([title, e, hint]) => h('div', { class: 'rp-error' },
      badge('critical', `${title} ${e.number}${e.time ? ` at ${e.time}` : ''}`),
      h('div', { class: 'rp-error-msg' }, e.message ?? ''),
      e.transaction ? h('div', { class: 'muted' }, `Failed transaction: ${e.transaction}`) : '',
      h('div', { class: 'muted' }, hint)));

    const key = ch.channel || '';
    if (!this.charts.has(key)) this.charts.set(key, new TimeChart({ title: 'Seconds behind the source', format: 'int', series: [{ key: 'lag', label: 'Lag (s)', slot: 1 }] }));
    const chart = this.charts.get(key);
    const pts = this.history.get(key) || [];
    const now = Date.now();
    chart.update(pts, Math.max(now - LAG_HISTORY_MS, Math.min(pts[0]?.t ?? now, now - 60_000)), now);

    const gtidRows = [];
    if (ch.retrievedGtid) gtidRows.push(['Received GTIDs', gtidParts(ch.retrievedGtid)]);
    if (ch.executedGtid) gtidRows.push(['Executed GTIDs', gtidParts(ch.executedGtid)]);
    if (ch.usingGtid) gtidRows.push(['Using GTID', [ch.usingGtid]]);
    if (ch.gtidIoPos) gtidRows.push(['GTID received position', gtidParts(ch.gtidIoPos)]);
    if (ch.gtidSlavePos) gtidRows.push(['GTID applied position', gtidParts(ch.gtidSlavePos)]);
    const details = [
      ['Source', `${sourceLabel(ch)} as ${ch.sourceUser ?? '?'}${ch.ssl ? ' · SSL' : ''}`],
      ['Source server', [ch.sourceServerId != null ? `server_id ${ch.sourceServerId}` : null, ch.sourceUuid].filter(Boolean).join(' · ') || '–'],
      ['Received up to', pos(ch.readFile, ch.readPos)],
      ['Applied up to', pos(ch.execFile, ch.execPos)],
      ['Relay log', `${pos(ch.relayFile, ch.relayPos)}${ch.relaySpace != null ? ` (${fmtNum(ch.relaySpace)} bytes pending)` : ''}`],
      ...gtidRows.map(([k, parts]) => [k, h('div', { class: 'rp-gtid' }, parts.map(p => h('div', null, p)))]),
      ch.autoPosition ? ['Positioning', 'automatic (GTID auto-position)'] : null,
      ch.parallelMode ? ['Parallel mode', ch.parallelMode] : null,
      ch.retriedTransactions ? ['Retried transactions', fmtNum(ch.retriedTransactions)] : null,
      ...ch.filters.map(f => [f.name.replace(/_/g, ' '), f.value]),
    ].filter(Boolean);

    return h('section', { class: 'rp-card' },
      h('div', { class: 'rp-card-head' },
        h('b', null, `Replicating from ${sourceLabel(ch)}`), h('span', { class: 'muted' }, channelLabel(ch)), badge(health.severity, health.label),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn', disabled: ro || running && !ch.sqlError && ch.sqlRunning === 'Yes' && ch.ioRunning === 'Yes', title: ro ? 'Not available in read-only mode' : 'START REPLICA', onclick: () => this.control('start', ch) }, 'Start replication'),
        h('button', { class: 'btn', disabled: ro || !running, title: ro ? 'Not available in read-only mode' : 'STOP REPLICA', onclick: () => this.control('stop', ch) }, 'Stop replication')),
      h('div', { class: 'rp-tiles' },
        tile('Receiver (IO thread)', badge(io.severity, io.label), ch.ioState),
        tile('Applier (SQL thread)', badge(sql.severity, sql.label), ch.sqlState),
        tile('Lag', h('span', null, h('span', { class: 'rp-lag' }, ch.lagSeconds == null ? '–' : fmtSeconds(ch.lagSeconds)), ' ', badge(lag.severity, lag.label))),
        ch.sqlDelay ? tile('Configured delay', fmtSeconds(ch.sqlDelay), ch.sqlRemainingDelay != null ? `${fmtSeconds(ch.sqlRemainingDelay)} until the next event is applied` : null) : ''),
      ...errors,
      h('div', { class: 'rp-split' }, h('div', { class: 'rp-chart' }, chart.el),
        h('table', { class: 'rp-details' }, details.map(([k, v]) => h('tr', null, h('td', { class: 'muted' }, k), h('td', null, v))))));
  }

  primaryCard(s) {
    const g = s.gtid;
    const gtid = g.executed || g.binlogPos || g.currentPos;
    const semi = s.semiSync ? Object.entries(s.semiSync).map(([k, v]) => `${k.replace('Rpl_semi_sync_', '').replace(/_/g, ' ')}: ${v}`).join(' · ') : null;
    const table = (cols, rows) => h('table', { class: 'edit-table rp-table' }, h('thead', null, h('tr', null, cols.map(c => h('th', null, c)))), h('tbody', null, rows));
    return h('section', { class: 'rp-card' },
      h('div', { class: 'rp-card-head' }, h('b', null, 'As a primary'), h('span', { class: 'muted' }, `${s.connected.length} replica${s.connected.length === 1 ? '' : 's'} connected`)),
      h('table', { class: 'rp-details' },
        h('tr', null, h('td', { class: 'muted' }, 'Binary log position'), h('td', null, s.binlog ? pos(s.binlog.file, s.binlog.position) : '–')),
        gtid ? h('tr', null, h('td', { class: 'muted' }, s.server === 'mariadb' ? 'GTID binlog position' : 'Executed GTIDs'), h('td', null, h('div', { class: 'rp-gtid' }, gtidParts(gtid).map(p => h('div', null, p))))) : '',
        s.identity.binlogExpireSeconds ? h('tr', null, h('td', { class: 'muted' }, 'Binary logs kept'), h('td', null, fmtSeconds(s.identity.binlogExpireSeconds))) : '',
        semi ? h('tr', null, h('td', { class: 'muted' }, 'Semi-synchronous'), h('td', null, semi)) : ''),
      s.connected.length
        ? table(['Connection', 'User', 'From', 'Connected for', 'State'], s.connected.map(c => h('tr', null,
          h('td', { class: 'num' }, `#${c.thread}`), h('td', null, c.user ?? ''), h('td', null, c.host ?? ''), h('td', null, fmtSeconds(c.seconds)), h('td', null, c.state ?? ''))))
        : h('div', { class: 'muted' }, 'No replica is connected right now.'),
      s.registered.length
        ? table(['Registered replica', 'Host', 'Port', 'UUID'], s.registered.map(r => h('tr', null,
          h('td', null, `server_id ${r.serverId ?? '?'}`), h('td', null, r.host || h('span', { class: 'muted' }, '(not reported)')), h('td', null, r.port ?? ''), h('td', null, r.uuid ?? ''))))
        : '');
  }

  async control(action, ch) {
    const what = action === 'start' ? 'Start' : 'Stop';
    const msg = action === 'stop'
      ? `Stop replication from ${sourceLabel(ch)} (${channelLabel(ch)})? This replica falls behind until it is started again.`
      : `Start replication from ${sourceLabel(ch)} (${channelLabel(ch)})?`;
    if (!(await confirmDlg(this.app.prodWarn(this.sid) + msg, { ok: `${what} replication`, danger: action === 'stop' }))) return;
    try {
      await post(`/s/${this.sid}/replication/${action}`, { channel: ch.channel || '' });
      this.load();
    } catch (e) { this.app.showError(e); }
  }
}

const sevRank = s => ({ good: 0, info: 1, warning: 2, critical: 3 })[s] ?? 0;
