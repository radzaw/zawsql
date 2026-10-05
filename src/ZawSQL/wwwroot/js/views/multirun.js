// "Run on several servers": choosing the servers (or a saved group of them), confirming changes.
import { h } from '../util.js';
import { get } from '../api.js';
import { modal, alertError, promptDlg, confirmDlg } from '../dialogs.js';
import { isReadOnlyStatement } from '../sqlcheck.js';
import { pickerItems, sortGroups, findGroup, groupProblem, saveGroup, removeGroup, groupMembers, groupSummary, matchingGroup } from '../multirunlogic.js';

async function savedSessions(app) {
  let sessions;
  try { sessions = await get('/sessions'); } catch (e) { app.showError(e); return null; }
  if (!sessions.length) { app.showError(new Error('There are no saved sessions. Add them in the session manager first.')); return null; }
  return sessions;
}

const connectedProfiles = app => new Set([...app.conns.values()].map(c => c.profileId));

/** Asks which saved sessions to run on; resolves to { sessions, database, stopOnError, items } or null. */
export async function pickServers(app, { database = '' } = {}) {
  const sessions = await savedSessions(app);
  if (!sessions) return null;
  const last = app.state.multiRun || {};
  const items = pickerItems(sessions, connectedProfiles(app), last.sessions || []);

  const filter = h('input', { class: 'inp mr-filter', placeholder: 'Filter servers', spellcheck: false });
  const count = h('span', { class: 'muted mr-count' });
  const rows = items.map(it => {
    const cb = h('input', { type: 'checkbox', checked: it.checked, disabled: it.needsPassword });
    cb.addEventListener('change', updateCount);
    const row = h('label', { class: 'mr-item' + (it.needsPassword ? ' disabled' : ''), title: it.needsPassword ? 'Its password isn\'t saved; connect it first to include it.' : it.host },
      cb,
      h('span', { class: 'mr-name' }, it.name),
      h('span', { class: 'muted mr-host' }, it.host),
      it.connected ? h('span', { class: 'mr-tag' }, 'connected') : null,
      it.production ? h('span', { class: 'prod-badge' }, 'PROD') : null,
      it.readOnly ? h('span', { class: 'ro-badge' }, 'read-only') : null);
    return { it, cb, row };
  });
  const chosen = () => rows.filter(r => r.cb.checked).map(r => r.it.id);
  const db = h('input', { class: 'inp', value: database || last.database || '', placeholder: 'Default database of each session', spellcheck: false });
  const stop = h('input', { type: 'checkbox', checked: last.stopOnError !== false });

  // Server groups: one click selects a saved set of servers (and its database).
  const groupsEl = h('div', { class: 'mr-groups' });
  function renderGroups() {
    const groups = sortGroups(app.state.serverGroups);
    const match = matchingGroup(groups, chosen(), sessions);
    const chips = groups.map(g => {
      const pick = h('button', { class: 'mr-group' + (g === match ? ' on' : ''), title: `${groupSummary(g, sessions)} – click to select them` }, g.name);
      pick.addEventListener('click', () => {
        const ids = new Set(groupMembers(g, sessions).present);
        filter.value = '';
        for (const r of rows) { r.row.style.display = ''; r.cb.checked = ids.has(r.it.id) && !r.cb.disabled; }
        if (g.database) db.value = g.database;
        updateCount();
      });
      const x = h('button', { class: 'mr-group-x', title: `Delete the group "${g.name}"`, 'aria-label': `Delete the group ${g.name}`, html: '×' });
      x.addEventListener('click', async () => {
        if (!(await confirmDlg(`Delete the server group "${g.name}"? The sessions stay as they are.`, { ok: 'Delete', danger: true }))) return;
        app.state.serverGroups = removeGroup(app.state.serverGroups, g.name);
        app.saveStateSoon();
        renderGroups();
      });
      return h('span', { class: 'mr-chip' }, pick, x);
    });
    const save = h('button', { class: 'btn mr-save-group', disabled: !chosen().length, title: 'Save the selected servers (and the database below) as a group' }, 'Save as group…');
    save.addEventListener('click', saveAsGroup);
    groupsEl.replaceChildren(h('span', { class: 'muted' }, groups.length ? 'Groups:' : 'No groups yet.'), ...chips, save);
  }
  async function saveAsGroup() {
    const ids = chosen();
    const suggested = matchingGroup(app.state.serverGroups, ids, sessions)?.name || '';
    const name = await promptDlg('Save as server group', `Name for these ${ids.length} server${ids.length === 1 ? '' : 's'}:`, suggested, { placeholder: 'e.g. EU shards' });
    if (name == null) return;
    const problem = groupProblem(name, ids);
    if (problem) return alertError(problem);
    const existing = findGroup(app.state.serverGroups, name);
    if (existing && !(await confirmDlg(`Replace the servers of the group "${existing.name}"?`, { ok: 'Replace' }))) return;
    app.state.serverGroups = saveGroup(app.state.serverGroups, { name, sessions: ids, database: db.value });
    app.saveStateSoon();
    renderGroups();
  }

  function updateCount() {
    count.textContent = `${chosen().length} selected`;
    renderGroups();
  }
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const r of rows) r.row.style.display = !q || (r.it.name + ' ' + r.it.host).toLowerCase().includes(q) ? '' : 'none';
  });
  const setAll = on => { for (const r of rows) if (r.row.style.display !== 'none' && !r.cb.disabled) r.cb.checked = on; updateCount(); };
  updateCount();

  const body = h('div', { class: 'form mr-dialog' },
    groupsEl,
    h('div', { class: 'mr-top' }, filter,
      h('button', { class: 'btn', onclick: () => setAll(true) }, 'All'),
      h('button', { class: 'btn', onclick: () => setAll(false) }, 'None'), count),
    h('div', { class: 'mr-list' }, rows.map(r => r.row)),
    h('div', { class: 'row' }, h('label', null, 'Database'), db),
    h('label', { class: 'chk' }, stop, ' Stop at the first error on a server'),
    h('div', { class: 'muted' }, 'Sessions that aren\'t connected are connected for the run and disconnected afterwards. Up to 4 servers run at the same time.'));
  const res = await modal({
    title: 'Run on several servers',
    width: 560,
    className: 'mr-modal',
    body,
    onOpen: () => filter.focus(),
    buttons: [
      { label: 'Run', primary: true, onClick: () => {
        const ids = chosen();
        if (!ids.length) { alertError('Choose at least one server.'); return false; }
        return { sessions: ids, database: db.value.trim(), stopOnError: stop.checked };
      } },
      { label: 'Cancel', value: null },
    ],
  });
  if (!res) return null;
  app.state.multiRun = res;
  app.saveStateSoon();
  return { ...res, items: items.filter(it => res.sessions.includes(it.id)) };
}

/** The servers of a saved group, without asking; resolves like pickServers, or null. */
export async function groupTargets(app, name) {
  const group = findGroup(app.state.serverGroups, name);
  if (!group) { app.showError(new Error(`The server group "${name}" no longer exists.`)); return null; }
  const sessions = await savedSessions(app);
  if (!sessions) return null;
  const { present } = groupMembers(group, sessions);
  if (!present.length) { app.showError(new Error(`None of the servers of the group "${group.name}" exist any more.`)); return null; }
  const items = pickerItems(sessions, connectedProfiles(app)).filter(it => present.includes(it.id));
  return { sessions: present, database: group.database || '', stopOnError: app.state.multiRun?.stopOnError !== false, items, group: group.name };
}

/** Confirms statements that change data; production servers are named. */
export async function confirmMultiRun(items, statements) {
  const changing = statements.filter(s => !isReadOnlyStatement(s));
  if (!changing.length) return true;
  const prod = items.filter(it => it.production);
  const shown = changing.slice(0, 6);
  const body = h('div', { class: 'form confirm-changes' },
    prod.length ? h('div', { class: 'prod-banner' }, h('b', null, 'PRODUCTION SERVERS'), ' – ' + prod.map(p => p.name).join(', ')) : null,
    h('div', null, `These statements change data or structure on ${items.length} server${items.length === 1 ? '' : 's'}:`),
    shown.map(s => h('div', { class: 'confirm-stmt' }, h('code', null, s.length > 300 ? s.slice(0, 300) + ' …' : s))),
    changing.length > shown.length ? h('div', { class: 'muted' }, `… and ${changing.length - shown.length} more`) : null,
    h('div', { class: 'mr-targets muted' }, 'Servers: ' + items.map(it => it.name).join(', ')));
  const ok = await modal({
    title: prod.length ? 'Confirm changes on production' : 'Confirm changes on several servers',
    width: 620,
    body,
    buttons: [{ label: 'Execute', value: true, primary: true, danger: true }, { label: 'Cancel', value: false }],
  });
  return ok === true;
}
