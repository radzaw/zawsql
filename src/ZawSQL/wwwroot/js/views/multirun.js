// "Run on several servers": choosing the servers, confirming changes.
import { h } from '../util.js';
import { get } from '../api.js';
import { modal, alertError } from '../dialogs.js';
import { isReadOnlyStatement } from '../sqlcheck.js';
import { pickerItems } from '../multirunlogic.js';

/** Asks which saved sessions to run on; resolves to { sessions, database, stopOnError } or null. */
export async function pickServers(app, { database = '' } = {}) {
  let sessions;
  try { sessions = await get('/sessions'); } catch (e) { app.showError(e); return null; }
  if (!sessions.length) { app.showError(new Error('There are no saved sessions. Add them in the session manager first.')); return null; }
  const last = app.state.multiRun || {};
  const connected = new Set([...app.conns.values()].map(c => c.profileId));
  const items = pickerItems(sessions, connected, last.sessions || []);

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
  function updateCount() {
    const n = rows.filter(r => r.cb.checked).length;
    count.textContent = `${n} selected`;
  }
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const r of rows) r.row.style.display = !q || (r.it.name + ' ' + r.it.host).toLowerCase().includes(q) ? '' : 'none';
  });
  const setAll = on => { for (const r of rows) if (r.row.style.display !== 'none' && !r.cb.disabled) r.cb.checked = on; updateCount(); };
  const db = h('input', { class: 'inp', value: database || last.database || '', placeholder: 'Default database of each session', spellcheck: false });
  const stop = h('input', { type: 'checkbox', checked: last.stopOnError !== false });
  updateCount();

  const body = h('div', { class: 'form mr-dialog' },
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
        const chosen = rows.filter(r => r.cb.checked).map(r => r.it.id);
        if (!chosen.length) { alertError('Choose at least one server.'); return false; }
        return { sessions: chosen, database: db.value.trim(), stopOnError: stop.checked };
      } },
      { label: 'Cancel', value: null },
    ],
  });
  if (!res) return null;
  app.state.multiRun = res;
  app.saveStateSoon();
  return { ...res, items: items.filter(it => res.sessions.includes(it.id)) };
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
