// Host tab › Events: the event scheduler (on, off, or disabled at startup) and the events of every database, with
// their schedule and next run. Events can be enabled, disabled, opened in the code editor and dropped.
import { h, qi } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { Grid } from '../grid.js';
import { contextMenu, confirmDlg } from '../dialogs.js';
import { scheduleText, nextRun, parseDt, fmtDt, fromNow } from '../eventlogic.js';

const COLS = [
  { name: 'Database' }, { name: 'Event' }, { name: 'Status' }, { name: 'Schedule' },
  { name: 'Next run', title: 'Estimated from the schedule, in the event\'s time zone. Nothing runs while the scheduler is off.' },
  { name: 'Last run' }, { name: 'After the last run' }, { name: 'Definer' }, { name: 'Comment' },
];

export class EventsView {
  constructor(app) {
    this.app = app;
    this.sid = null;
    this.events = [];
    this.state = h('span', { class: 'ev-state' });
    this.toggleBtn = h('button', { class: 'btn', onclick: () => this.toggleScheduler() });
    this.note = h('span', { class: 'muted' });
    this.status = h('span', { class: 'muted' });
    const btn = (ic, label, title, fn) => h('button', { class: 'tbtn', title, html: icon(ic) + (label ? `<span>${label}</span>` : ''), onclick: fn });
    this.enableBtn = btn('check', 'Enable', 'Enable the selected events', () => this.act('enable', this.selected()));
    this.disableBtn = btn('cancel', 'Disable', 'Disable the selected events', () => this.act('disable', this.selected()));
    this.grid = new Grid({
      gutter: false,
      emptyText: 'No events on this server.',
      onActivate: r => this.edit(this.events[r]),
      onContextMenu: (e, p) => this.ctx(e, p),
      onRowChange: () => this.updateButtons(),
    });
    this.el = h('div', { class: 'rp' },
      h('div', { class: 'viewbar small' }, h('b', null, 'Event scheduler'), this.state, this.toggleBtn, this.note,
        h('div', { class: 'grow' }), this.status, this.enableBtn, this.disableBtn,
        h('button', { class: 'tbtn', title: 'Refresh', html: icon('refresh'), onclick: () => this.load() })),
      this.grid.el);
  }

  start(sid) {
    if (sid !== this.sid) {
      this.sid = sid;
      this.events = [];
      this.grid.setData([], []);
    }
    this.load();
  }

  stop() {}

  get readOnly() { return this.app.isReadOnly(this.sid); }

  async load() {
    const sid = this.sid;
    if (!sid) return;
    try {
      const r = await get(`/s/${sid}/events`, null, { quiet: true });
      if (sid !== this.sid) return;
      this.scheduler = r.scheduler;
      this.events = r.events;
      this.render();
      this.status.textContent = `${r.events.length} event${r.events.length === 1 ? '' : 's'}`;
    } catch (e) {
      this.status.textContent = e.message;
      this.app.showError(e);
    }
  }

  render() {
    const on = this.scheduler === 'ON', disabled = this.scheduler === 'DISABLED';
    this.state.textContent = disabled ? 'disabled' : on ? 'running' : 'stopped';
    this.state.className = 'ev-state ' + (on ? 'on' : 'off');
    this.toggleBtn.textContent = on ? 'Turn off' : 'Turn on';
    this.toggleBtn.disabled = disabled || this.readOnly;
    this.toggleBtn.title = disabled ? 'The server was started with --event-scheduler=DISABLED; it can only be turned on in the server configuration.'
      : this.readOnly ? 'Read-only session' : `SET GLOBAL event_scheduler = ${on ? 'OFF' : 'ON'}`;
    this.note.textContent = !on && this.events.some(e => e.status === 'ENABLED') ? 'Enabled events don\'t run while the scheduler is off.' : '';
    const rows = this.events.map(ev => {
      const n = nextRun(ev);
      const now = parseDt(ev.nowThere);
      const next = n.at != null ? `${fmtDt(n.at)} (${fromNow(n.at, now)})` : n.note;
      const row = [ev.db, ev.name, ev.status === 'SLAVESIDE_DISABLED' ? 'DISABLED ON REPLICA' : ev.status, scheduleText(ev), next,
        ev.lastExecuted, ev.onCompletion === 'PRESERVE' ? 'kept' : 'dropped', ev.definer, ev.comment || null];
      if (ev.status !== 'ENABLED') row.$cls = 'muted-row';
      return row;
    });
    this.grid.setData(COLS, rows, { keepWidths: true, keepPos: true });
    this.updateButtons();
  }

  selected() {
    return this.grid.selectedRowIndexes().map(i => this.events[i]).filter(Boolean);
  }

  updateButtons() {
    const sel = this.selected();
    this.enableBtn.disabled = this.readOnly || !sel.some(e => e.status !== 'ENABLED');
    this.disableBtn.disabled = this.readOnly || !sel.some(e => e.status === 'ENABLED');
  }

  async toggleScheduler() {
    const on = this.scheduler !== 'ON';
    const sql = `SET GLOBAL event_scheduler = ${on ? 'ON' : 'OFF'}`;
    if (!(await this.app.confirmChanges(this.sid, { action: `Turn the event scheduler ${on ? 'on' : 'off'}`, statements: [sql] }))) return;
    try {
      await post(`/s/${this.sid}/events/scheduler`, { on });
    } catch (e) {
      this.app.showError(e);
    }
    this.load();
  }

  async act(action, events) {
    events = events.filter(e => (action === 'enable' ? e.status !== 'ENABLED' : action === 'disable' ? e.status === 'ENABLED' : true));
    if (!events.length) return;
    const names = events.map(e => `${e.db}.${e.name}`);
    const what = names.length === 1 ? `event ${names[0]}` : `${names.length} events`;
    const ok = action === 'drop'
      ? await confirmDlg(this.app.prodWarn(this.sid) + `Drop ${what}?\n\n${names.join('\n')}\n\nThis cannot be undone.`, { ok: 'Drop', danger: true, kind: 'warning' })
      : await this.app.confirmChanges(this.sid, {
        action: `${action === 'enable' ? 'Enable' : 'Disable'} ${what}`,
        statements: events.map(e => `ALTER EVENT ${qi(e.db)}.${qi(e.name)} ${action.toUpperCase()}`),
      });
    if (!ok) return;
    for (const ev of events) {
      try {
        await post(`/s/${this.sid}/events/action`, { db: ev.db, name: ev.name, action });
      } catch (e) {
        this.app.showError(e);
        break;
      }
    }
    if (action === 'drop') for (const db of new Set(events.map(e => e.db))) this.app.refreshDb(this.sid, db);
    this.load();
  }

  edit(ev) {
    if (ev) this.app.selectObject(this.sid, ev.db, ev.name, 'event', { tab: 'table' });
  }

  ctx(e, p) {
    const ev = p.r >= 0 ? this.events[p.r] : null;
    const sel = this.selected();
    const ro = this.readOnly;
    contextMenu(e.clientX, e.clientY, [
      ev && { label: `Edit event ${ev.name}`, icon: 'event', onClick: () => this.edit(ev) },
      '-',
      { label: 'Enable', icon: 'check', disabled: ro || !sel.some(x => x.status !== 'ENABLED'), onClick: () => this.act('enable', sel) },
      { label: 'Disable', icon: 'cancel', disabled: ro || !sel.some(x => x.status === 'ENABLED'), onClick: () => this.act('disable', sel) },
      '-',
      { label: sel.length > 1 ? `Drop ${sel.length} events…` : 'Drop event…', icon: 'trash', disabled: ro || !sel.length, onClick: () => this.act('drop', sel) },
      '-',
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => this.grid.copy() },
      { label: 'Refresh', icon: 'refresh', onClick: () => this.load() },
    ]);
  }
}
