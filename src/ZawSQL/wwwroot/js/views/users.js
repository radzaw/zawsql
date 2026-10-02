// User manager: accounts, passwords, limits, privileges (global/db/table/column/routine) and roles.
import { h, esc, qi, sqlStr } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { modal, confirmDlg, alertError } from '../dialogs.js';
import { highlightSql } from '../editor.js';

const PRIVS = {
  global: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE TEMPORARY TABLES', 'LOCK TABLES',
    'EXECUTE', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'TRIGGER', 'SHOW DATABASES', 'PROCESS', 'RELOAD',
    'SHUTDOWN', 'FILE', 'SUPER', 'REPLICATION SLAVE', 'REPLICATION CLIENT', 'CREATE USER', 'CREATE TABLESPACE', 'CREATE ROLE', 'DROP ROLE'],
  db: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE TEMPORARY TABLES', 'LOCK TABLES',
    'EXECUTE', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'TRIGGER'],
  table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER'],
  column: ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'],
  routine: ['EXECUTE', 'ALTER ROUTINE'],
};
const READ_PRIVS = ['SELECT', 'SHOW VIEW', 'SHOW DATABASES', 'EXECUTE'];
const LIMITS = [
  ['maxQueries', 'Queries per hour', 'MAX_QUERIES_PER_HOUR'],
  ['maxUpdates', 'Updates per hour', 'MAX_UPDATES_PER_HOUR'],
  ['maxConnections', 'Connections per hour', 'MAX_CONNECTIONS_PER_HOUR'],
  ['maxUserConnections', 'Simultaneous connections', 'MAX_USER_CONNECTIONS'],
];
const PASSWORD = '{{PASSWORD}}';
const LEVEL_NAMES = { db: 'Database', table: 'Table', column: 'Column', routine: 'Routine' };

const acctSql = (u, hst) => `${sqlStr(u)}@${sqlStr(hst)}`;
const objKey = g => [g.level, g.db, g.table, g.column, g.routineType].join('\u0001');

function objLabel(g) {
  switch (g.level) {
    case 'global': return 'Global (*.*)';
    case 'db': return `${g.db}.*`;
    case 'table': return `${g.db}.${g.table}`;
    case 'column': return `${g.db}.${g.table} (${g.column})`;
    default: return `${g.routineType.toLowerCase()} ${g.db}.${g.table}`;
  }
}

function objTarget(g) {
  switch (g.level) {
    case 'global': return '*.*';
    case 'db': return `${qi(g.db)}.*`;
    case 'routine': return `${g.routineType} ${qi(g.db)}.${qi(g.table)}`;
    default: return `${qi(g.db)}.${qi(g.table)}`;
  }
}

function sortPrivs(level, privs) {
  const order = PRIVS[level];
  return [...privs].sort((a, b) => {
    const i = order.indexOf(a), j = order.indexOf(b);
    return (i < 0 ? 999 : i) - (j < 0 ? 999 : j) || a.localeCompare(b);
  });
}

const privList = (g, privs) => sortPrivs(g.level, privs).map(p => (g.level === 'column' ? `${p} (${qi(g.column)})` : p)).join(', ');

/** Editable model of an account loaded from the server. */
function toModel(d) {
  const grants = d.grants.map(g => ({
    level: g.level, db: g.db, table: g.table, column: g.column, routineType: g.routineType,
    privs: new Set([...(g.all ? PRIVS[g.level] || [] : []), ...g.privs]),
    grantOption: g.grantOption,
  }));
  if (!grants.some(g => g.level === 'global')) grants.unshift({ level: 'global', privs: new Set(), grantOption: false });
  const m = {
    isNew: false, user: d.user, host: d.host, plugin: d.plugin, locked: d.locked, expired: d.passwordExpired,
    limits: { ...d.limits }, grants, roles: [...d.roles], other: d.other,
  };
  m.orig = {
    user: d.user, host: d.host, locked: d.locked, limits: { ...d.limits },
    grants: new Map(grants.map(g => [objKey(g), { privs: new Set(g.privs), grantOption: g.grantOption }])),
    roles: new Set(d.roles),
  };
  return m;
}

function newModel(from) {
  return {
    isNew: true,
    user: from ? from.user + '_copy' : 'new_user',
    host: from ? from.host : '%',
    plugin: null, locked: false, expired: false,
    limits: from ? { ...from.limits } : Object.fromEntries(LIMITS.map(([k]) => [k, 0])),
    grants: from ? from.grants.map(g => ({ ...g, privs: new Set(g.privs) })) : [{ level: 'global', privs: new Set(), grantOption: false }],
    roles: from ? [...from.roles] : [],
    other: [],
    orig: null,
  };
}

/** SQL statements turning the original account into the edited one (password as a placeholder). */
function genSql(m, password) {
  const o = m.orig;
  const acct = acctSql(m.user, m.host);
  const out = [];
  if (m.isNew) {
    out.push(`CREATE USER ${acct}${password ? ` IDENTIFIED BY ${PASSWORD}` : ''}`);
  } else {
    if (m.user !== o.user || m.host !== o.host) out.push(`RENAME USER ${acctSql(o.user, o.host)} TO ${acct}`);
    if (password) out.push(`ALTER USER ${acct} IDENTIFIED BY ${PASSWORD}`);
  }
  if (m.locked !== (o ? o.locked : false)) out.push(`ALTER USER ${acct} ACCOUNT ${m.locked ? 'LOCK' : 'UNLOCK'}`);
  const changedLimits = LIMITS.filter(([k]) => (parseInt(m.limits[k], 10) || 0) !== (o ? o.limits[k] || 0 : 0));
  if (changedLimits.length) out.push(`ALTER USER ${acct} WITH ${changedLimits.map(([k, , kw]) => `${kw} ${parseInt(m.limits[k], 10) || 0}`).join(' ')}`);

  const origGrants = o ? o.grants : new Map();
  const cur = new Map(m.grants.map(g => [objKey(g), g]));
  const keys = new Set([...origGrants.keys(), ...cur.keys()]);
  for (const k of keys) {
    const before = origGrants.get(k) || { privs: new Set(), grantOption: false };
    const now = cur.get(k) || { privs: new Set(), grantOption: false };
    const g = cur.get(k) || keyToObj(k);
    const target = objTarget(g);
    const removed = [...before.privs].filter(p => !now.privs.has(p));
    const added = [...now.privs].filter(p => !before.privs.has(p));
    if (removed.length) out.push(`REVOKE ${privList(g, removed)} ON ${target} FROM ${acct}`);
    if (before.grantOption && !now.grantOption) out.push(`REVOKE GRANT OPTION ON ${target} FROM ${acct}`);
    const addGo = now.grantOption && !before.grantOption && g.level !== 'column';
    if (added.length || addGo) out.push(`GRANT ${added.length ? privList(g, added) : 'USAGE'} ON ${target} TO ${acct}${addGo ? ' WITH GRANT OPTION' : ''}`);
  }

  const origRoles = o ? o.roles : new Set();
  const roles = new Set(m.roles.map(r => r.trim()).filter(Boolean));
  for (const r of roles) if (!origRoles.has(r)) out.push(`GRANT ${r} TO ${acct}`);
  for (const r of origRoles) if (!roles.has(r)) out.push(`REVOKE ${r} FROM ${acct}`);
  return out;
}

function keyToObj(k) {
  const [level, db, table, column, routineType] = k.split('\u0001');
  return { level, db: db || null, table: table || null, column: column || null, routineType: routineType || null };
}

// ---------------------------------------------------------------- dialog

export async function userManager(app, sid) {
  if (!sid) return app.showError(new Error('Not connected.'));
  const ro = app.isReadOnly(sid);
  let users = [];
  try {
    users = await get(`/s/${sid}/users`);
  } catch (e) {
    return app.showError(new Error(`Cannot read the account list: ${e.message}\n\nThe user manager needs SELECT on the mysql database.`));
  }

  let m = null;          // current model
  let curKey = null;     // "user@host" of the loaded account
  let tab = 'credentials';
  let selObj = 0;

  const filter = h('input', { class: 'inp', placeholder: 'Filter accounts', spellcheck: false });
  const list = h('div', { class: 'um-list', tabindex: 0 });
  const btn = (ic, label, fn, title = '') => h('button', { class: 'tbtn', title, html: icon(ic) + `<span>${label}</span>`, onclick: fn, disabled: ro });
  const left = h('div', { class: 'um-left' }, filter, list,
    h('div', { class: 'um-left-btns' },
      btn('plus', 'Add', () => switchTo(null, newModel())),
      btn('copy', 'Clone', () => m && switchTo(null, newModel(m))),
      btn('trash', 'Delete', () => del())));

  const subtabs = h('div', { class: 'subtabs' });
  const pane = h('div', { class: 'um-pane' });
  const pw1 = h('input', { class: 'inp', type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'inp', type: 'password', autocomplete: 'new-password' });
  const saveBtn = h('button', { class: 'btn primary', onclick: () => save() }, 'Save');
  const discardBtn = h('button', { class: 'btn', onclick: () => discard() }, 'Discard');
  const title = h('b');
  const right = h('div', { class: 'um-right' },
    h('div', { class: 'viewbar' }, h('span', { class: 'viewtitle', html: icon('user') }), title,
      ro ? h('span', { class: 'ro-note' }, 'Read-only session') : null, h('div', { class: 'grow' }), discardBtn, saveBtn),
    subtabs, pane);
  const root = h('div', { class: 'um' }, left, right);

  const password = () => pw1.value;
  const dirty = () => !!m && genSql(m, password()).length > 0;
  const refreshState = () => {
    const d = dirty();
    saveBtn.disabled = ro || !d;
    discardBtn.disabled = !d;
    title.textContent = m ? `${m.user}@${m.host}${m.isNew ? ' (new)' : ''}${d ? ' *' : ''}` : 'No account selected';
    if (tab === 'sql') renderPane();
  };
  for (const el of [pw1, pw2]) el.addEventListener('input', refreshState);

  function renderList() {
    const q = filter.value.toLowerCase();
    list.innerHTML = users
      .map((u, i) => ({ u, i }))
      .filter(({ u }) => !q || `${u.user}@${u.host}`.toLowerCase().includes(q))
      .map(({ u, i }) => `<div class="um-item${`${u.user}@${u.host}` === curKey ? ' sel' : ''}" data-i="${i}">${icon('user')}<span class="um-name">${esc(u.user || '(anonymous)')}</span><span class="muted">@${esc(u.host)}</span>${u.locked ? '<span class="um-tag">locked</span>' : ''}</div>`)
      .join('') || '<div class="muted pad">No accounts</div>';
  }
  filter.addEventListener('input', renderList);
  list.addEventListener('mousedown', e => {
    const it = e.target.closest('.um-item');
    if (!it) return;
    const u = users[+it.dataset.i];
    if (`${u.user}@${u.host}` !== curKey || m?.isNew) switchTo(u);
  });

  async function switchTo(u, model) {
    if (dirty() && !(await confirmDlg('Discard unsaved changes to this account?', { ok: 'Discard' }))) return;
    pw1.value = pw2.value = '';
    selObj = 0;
    if (model) {
      m = model;
      curKey = null;
      tab = 'credentials'; // a new account starts with its name and password
    } else {
      try {
        m = toModel(await get(`/s/${sid}/user`, { user: u.user, host: u.host }));
        curKey = `${u.user}@${u.host}`;
      } catch (e) {
        return alertError(e.message);
      }
    }
    renderList();
    renderTabs();
    renderPane();
    refreshState();
  }

  function renderTabs() {
    const tabs = [['credentials', 'Credentials'], ['limits', 'Limits'], ['privileges', `Privileges (${m ? m.grants.filter(g => g.privs.size || g.grantOption).length : 0})`], ['roles', `Roles (${m ? m.roles.length : 0})`], ['sql', 'SQL preview']];
    subtabs.replaceChildren(...tabs.map(([k, label]) =>
      h('button', { class: 'subtab' + (k === tab ? ' active' : ''), onclick: () => { tab = k; renderTabs(); renderPane(); } }, label)));
  }

  const field = (label, input) => h('label', { class: 'frow' }, h('span', null, label), input);

  function renderPane() {
    if (!m) { pane.replaceChildren(h('div', { class: 'placeholder' }, 'Select an account on the left.')); return; }
    if (tab === 'credentials') {
      const user = h('input', { class: 'inp', value: m.user, spellcheck: false, disabled: ro });
      const host = h('input', { class: 'inp', value: m.host, spellcheck: false, list: 'dl-um-hosts', disabled: ro });
      const locked = h('input', { type: 'checkbox', checked: m.locked, disabled: ro });
      user.addEventListener('input', () => { m.user = user.value; refreshState(); });
      host.addEventListener('input', () => { m.host = host.value; refreshState(); });
      locked.addEventListener('change', () => { m.locked = locked.checked; refreshState(); });
      pw1.disabled = pw2.disabled = ro;
      pw1.placeholder = m.isNew ? 'Empty = no password' : 'Unchanged';
      pane.replaceChildren(h('div', { class: 'form2' },
        field('User name:', user),
        field('From host:', host),
        h('div', { class: 'frow' }, h('span'), h('span', { class: 'muted' }, '% = any host, localhost, an IP address or a pattern like 192.168.%')),
        field(m.isNew ? 'Password:' : 'New password:', pw1),
        field('Repeat password:', pw2),
        m.plugin ? field('Authentication:', h('span', null, m.plugin)) : null,
        field('', h('label', { class: 'chk' }, locked, ' Account locked (cannot log in)')),
        m.expired ? field('', h('span', { class: 'ro-note' }, 'Password is expired')) : null),
        h('datalist', { id: 'dl-um-hosts' }, ['%', 'localhost', '127.0.0.1', '::1', '192.168.%', '10.%'].map(v => h('option', { value: v }))));
    } else if (tab === 'limits') {
      pane.replaceChildren(h('div', { class: 'form2' },
        ...LIMITS.map(([k, label]) => {
          const inp = h('input', { class: 'inp', type: 'number', min: 0, value: m.limits[k] ?? 0, disabled: ro });
          inp.addEventListener('input', () => { m.limits[k] = inp.value; refreshState(); });
          return field(label + ':', inp);
        }),
        h('div', { class: 'muted' }, '0 means unlimited.')));
    } else if (tab === 'privileges') {
      pane.replaceChildren(renderPrivileges());
    } else if (tab === 'roles') {
      const ta = h('textarea', { class: 'inp mono', rows: 8, spellcheck: false, disabled: ro, placeholder: '`role_name`@`%`' });
      ta.value = m.roles.join('\n');
      ta.addEventListener('input', () => { m.roles = ta.value.split('\n').map(s => s.trim()).filter(Boolean); refreshState(); });
      pane.replaceChildren(h('div', { class: 'form' },
        h('div', { class: 'muted' }, 'Granted roles, one per line, quoted as shown by SHOW GRANTS (e.g. `app_read`@`%` on MySQL, `app_read` on MariaDB).'), ta));
    } else {
      const stmts = genSql(m, password());
      pane.replaceChildren(h('pre', { class: 'code-preview um-sql', html: stmts.length ? highlightSql(stmts.join(';\n') + ';').replaceAll(esc(PASSWORD), "<span class=\"t-str\">'***'</span>") : '<span class="t-com">/* No changes */</span>' }));
    }
  }

  function renderPrivileges() {
    const objs = h('div', { class: 'um-objs' });
    const checks = h('div', { class: 'um-checks' });
    const drawObjs = () => {
      objs.innerHTML = m.grants.map((g, i) => `<div class="um-obj${i === selObj ? ' sel' : ''}" data-i="${i}">${icon(g.level === 'global' ? 'server' : g.level === 'db' ? 'database' : g.level === 'routine' ? (g.routineType === 'FUNCTION' ? 'function' : 'procedure') : g.level === 'column' ? 'columns' : 'table')}<span>${esc(objLabel(g))}</span><span class="muted">${g.privs.size || ''}${g.grantOption ? ' +G' : ''}</span></div>`).join('');
    };
    const drawChecks = () => {
      const g = m.grants[selObj];
      if (!g) { checks.replaceChildren(); return; }
      const known = PRIVS[g.level];
      const extra = [...g.privs].filter(p => !known.includes(p));
      const box = p => {
        const cb = h('input', { type: 'checkbox', checked: g.privs.has(p), disabled: ro });
        cb.addEventListener('change', () => { cb.checked ? g.privs.add(p) : g.privs.delete(p); drawObjs(); renderTabs(); refreshState(); });
        return h('label', { class: 'chk um-priv' }, cb, ' ' + p);
      };
      const set = privs => { g.privs = new Set(privs); drawChecks(); drawObjs(); renderTabs(); refreshState(); };
      const go = h('input', { type: 'checkbox', checked: g.grantOption, disabled: ro || g.level === 'column' });
      go.addEventListener('change', () => { g.grantOption = go.checked; drawObjs(); refreshState(); });
      // h() drops null children; replaceChildren() would render them as the text "null".
      checks.replaceChildren(h('div', null,
        h('div', { class: 'viewbar small' }, h('b', null, objLabel(g)), h('div', { class: 'grow' }),
          h('button', { class: 'tbtn', disabled: ro, onclick: () => set([...known, ...extra]) }, 'All'),
          h('button', { class: 'tbtn', disabled: ro, onclick: () => set(known.filter(p => READ_PRIVS.includes(p))) }, 'Read only'),
          h('button', { class: 'tbtn', disabled: ro, onclick: () => set([]) }, 'None')),
        h('div', { class: 'um-grid' }, known.map(box)),
        extra.length ? h('div', null, h('div', { class: 'sm-sep' }, 'Other privileges'), h('div', { class: 'um-grid' }, extra.map(box))) : null,
        h('div', { class: 'sm-sep' }, 'Options'),
        h('label', { class: 'chk' }, go, ' WITH GRANT OPTION (may pass these privileges on)'),
        m.other.length ? h('div', null, h('div', { class: 'sm-sep' }, 'Not editable here'), h('pre', { class: 'code-preview' }, m.other.join('\n'))) : null));
    };
    objs.addEventListener('mousedown', e => {
      const it = e.target.closest('.um-obj');
      if (!it) return;
      selObj = +it.dataset.i;
      drawObjs();
      drawChecks();
    });
    drawObjs();
    drawChecks();
    return h('div', { class: 'um-privs' },
      h('div', { class: 'um-objs-wrap' }, objs,
        h('div', { class: 'um-left-btns' },
          btn('plus', 'Add object', async () => {
            const g = await addObjectDialog(app, sid);
            if (!g) return;
            const k = objKey(g);
            const existing = m.grants.findIndex(x => objKey(x) === k);
            if (existing >= 0) selObj = existing;
            else { m.grants.push(g); selObj = m.grants.length - 1; }
            drawObjs(); drawChecks(); renderTabs(); refreshState();
          }),
          btn('minus', 'Remove', () => {
            const g = m.grants[selObj];
            if (!g || g.level === 'global') return;
            m.grants.splice(selObj, 1);
            selObj = Math.max(0, selObj - 1);
            drawObjs(); drawChecks(); renderTabs(); refreshState();
          }, 'Revokes everything on the selected object'))),
      checks);
  }

  async function reload(selectUser, selectHost) {
    users = await get(`/s/${sid}/users`);
    m = null;
    curKey = null;
    const u = users.find(x => x.user === selectUser && x.host === selectHost);
    if (u) await switchTo(u);
    else { renderList(); renderTabs(); renderPane(); refreshState(); }
  }

  async function save() {
    if (!m || ro) return;
    if (pw1.value !== pw2.value) return alertError('The passwords do not match.');
    if (!m.user.trim() && !(await confirmDlg('Create an anonymous account (empty user name)?'))) return;
    const stmts = genSql(m, password());
    if (!stmts.length) return;
    if (!(await app.confirmChanges(sid, { action: `Save account ${m.user}@${m.host}`, statements: stmts.map(s => s.replace(PASSWORD, "'***'")) }))) return;
    const r = await post(`/s/${sid}/users/apply`, { statements: stmts, password: password() || null }).catch(e => ({ error: { message: e.message, statement: 0 } }));
    const target = r.executed > 0 || !m.isNew ? [m.user, m.host] : [m.orig?.user, m.orig?.host];
    if (r.error) {
      await alertError(`${r.executed ? `${r.executed} of ${stmts.length} statements were applied before the error.\n\n` : ''}${r.error.code ? `SQL Error (${r.error.code}): ` : ''}${r.error.message}\n\nin: ${stmts[r.error.statement]?.replace(PASSWORD, "'***'")}`);
      if (!r.executed) return;
    } else {
      app.setStatus(m.isNew ? `Account ${m.user}@${m.host} created.` : `Account ${m.user}@${m.host} saved.`);
    }
    pw1.value = pw2.value = '';
    const [u, hst] = target;
    m = null;
    await reload(u, hst);
  }

  async function discard() {
    if (!m) return;
    if (m.isNew) { m = null; curKey = null; renderList(); renderTabs(); renderPane(); refreshState(); return; }
    const [u, hst] = curKey.split(/@(?=[^@]*$)/);
    m = null;
    pw1.value = pw2.value = '';
    await switchTo(users.find(x => x.user === u && x.host === hst));
  }

  async function del() {
    if (!m || m.isNew || ro) return;
    const info = app.conns.get(sid);
    const self = info && `${m.user}@${m.host}` === info.user;
    const msg = app.prodWarn(sid) + `Delete account ${m.orig.user}@${m.orig.host}?${self ? '\n\nThis is the account you are connected with!' : ''}`;
    if (!(await confirmDlg(msg, { ok: 'Delete', danger: true, kind: 'warning' }))) return;
    const r = await post(`/s/${sid}/users/apply`, { statements: [`DROP USER ${acctSql(m.orig.user, m.orig.host)}`], password: null }).catch(e => ({ error: { message: e.message } }));
    if (r.error) return alertError(r.error.message);
    app.setStatus(`Account ${m.orig.user}@${m.orig.host} deleted.`);
    m = null;
    await reload();
  }

  renderList();
  renderTabs();
  renderPane();
  refreshState();

  await modal({
    title: `User manager – ${app.conns.get(sid).name}`,
    width: 1000,
    className: 'user-manager',
    body: root,
    closeValue: null,
    buttons: [{
      label: 'Close', value: null, onClick: async () => {
        if (dirty() && !(await confirmDlg('Discard unsaved changes to this account?', { ok: 'Discard' }))) return false;
      },
    }],
  });
}

/** Asks for a privilege target below global level. */
async function addObjectDialog(app, sid) {
  const level = h('select', { class: 'inp' }, Object.entries(LEVEL_NAMES).map(([k, v]) => h('option', { value: k }, v)));
  const rtype = h('select', { class: 'inp' }, h('option', { value: 'PROCEDURE' }, 'Procedure'), h('option', { value: 'FUNCTION' }, 'Function'));
  const db = h('input', { class: 'inp', list: 'dl-um-dbs', spellcheck: false, placeholder: 'Database (wildcards _ and % allowed at database level)' });
  const obj = h('input', { class: 'inp', list: 'dl-um-objs', spellcheck: false });
  const col = h('input', { class: 'inp', list: 'dl-um-cols', spellcheck: false });
  const dlDbs = h('datalist', { id: 'dl-um-dbs' }), dlObjs = h('datalist', { id: 'dl-um-objs' }), dlCols = h('datalist', { id: 'dl-um-cols' });
  const rowObj = h('label', { class: 'frow' }, h('span', null, 'Table:'), obj);
  const rowType = h('label', { class: 'frow' }, h('span', null, 'Routine type:'), rtype);
  const rowCol = h('label', { class: 'frow' }, h('span', null, 'Column:'), col);
  const sync = () => {
    const l = level.value;
    rowObj.style.display = l === 'db' ? 'none' : '';
    rowObj.firstChild.textContent = l === 'routine' ? 'Routine:' : 'Table:';
    rowType.style.display = l === 'routine' ? '' : 'none';
    rowCol.style.display = l === 'column' ? '' : 'none';
  };
  level.addEventListener('change', () => { sync(); fillObjs(); });
  rtype.addEventListener('change', fillObjs);
  db.addEventListener('change', fillObjs);
  obj.addEventListener('change', fillCols);
  async function fillObjs() {
    try {
      const objs = await app.getObjects(sid, db.value);
      const want = level.value === 'routine' ? [rtype.value.toLowerCase()] : ['table', 'view'];
      dlObjs.replaceChildren(...objs.filter(o => want.includes(o.type)).map(o => h('option', { value: o.name })));
    } catch { /* unknown database */ }
  }
  async function fillCols() {
    if (level.value !== 'column') return;
    const cols = await app.getColumns(sid, db.value, obj.value);
    dlCols.replaceChildren(...cols.map(c => h('option', { value: c.name })));
  }
  app.getDatabases(sid).then(dbs => dlDbs.replaceChildren(...dbs.map(d => h('option', { value: d })))).catch(() => {});
  sync();
  return modal({
    title: 'Add privilege object',
    width: 460,
    body: h('div', { class: 'form2' },
      h('label', { class: 'frow' }, h('span', null, 'Level:'), level),
      h('label', { class: 'frow' }, h('span', null, 'Database:'), db),
      rowType, rowObj, rowCol, dlDbs, dlObjs, dlCols),
    buttons: [{
      label: 'Add', primary: true, onClick: () => {
        const l = level.value;
        if (!db.value.trim() || (l !== 'db' && !obj.value.trim()) || (l === 'column' && !col.value.trim())) {
          alertError('Please fill in all fields.');
          return false;
        }
        return {
          level: l, db: db.value.trim(),
          table: l === 'db' ? null : obj.value.trim(),
          column: l === 'column' ? col.value.trim() : null,
          routineType: l === 'routine' ? rtype.value : null,
          privs: new Set(), grantOption: false,
        };
      },
    }, { label: 'Cancel', value: null }],
  });
}

export const _test = { genSql, toModel, newModel };
