// Dialogs: session manager, exports, SQL file import, create database, preferences, about.
import { h, esc, qi, sqlStr, fmtBytes, fmtNum, saveTextFile, pickFile, isNumericKind } from '../util.js';
import { icon } from '../icons.js';
import { get, post, del, urlWithToken, SSH_HOSTKEY_UNKNOWN } from '../api.js';
import { modal, confirmDlg, alertError } from '../dialogs.js';
import { splitSql } from '../sqlsplit.js';

// ---------------------------------------------------------------- session manager

const SSL_MODES = ['None', 'Preferred', 'Required', 'VerifyCA', 'VerifyFull'];
const SESSION_COLORS = ['', '#d13438', '#ca5010', '#c19c00', '#107c10', '#0078d4', '#8764b8', '#69797e'];

export async function sessionManager(app) {
  let sessions = [];
  try { sessions = await get('/sessions'); } catch (e) { return app.showError(e); }
  let cur = null, dirty = false, pwdDirty = false, sshDirty = false;

  const f = {
    name: h('input', { class: 'inp', spellcheck: false }),
    host: h('input', { class: 'inp', spellcheck: false }),
    user: h('input', { class: 'inp', spellcheck: false }),
    password: h('input', { class: 'inp', type: 'password' }),
    savePassword: h('input', { type: 'checkbox' }),
    port: h('input', { class: 'inp', type: 'number', min: 1, max: 65535 }),
    databases: h('input', { class: 'inp', spellcheck: false, placeholder: 'Separated by semicolon; empty = all' }),
    sslMode: h('select', { class: 'inp' }, SSL_MODES.map(m => h('option', { value: m }, m))),
    connectTimeout: h('input', { class: 'inp', type: 'number', min: 1, max: 600 }),
    compression: h('input', { type: 'checkbox' }),
    readOnly: h('input', { type: 'checkbox' }),
    production: h('input', { type: 'checkbox' }),
    sshEnabled: h('input', { type: 'checkbox' }),
    sshHost: h('input', { class: 'inp', spellcheck: false, placeholder: 'ssh.example.com' }),
    sshPort: h('input', { class: 'inp', type: 'number', min: 1, max: 65535 }),
    sshUser: h('input', { class: 'inp', spellcheck: false }),
    sshAuth: h('select', { class: 'inp' }, h('option', { value: 'password' }, 'Password'), h('option', { value: 'key' }, 'Private key')),
    sshKeyFile: h('input', { class: 'inp', spellcheck: false, placeholder: '~/.ssh/id_ed25519 – or paste the key text' }),
    sshSecret: h('input', { class: 'inp', type: 'password' }),
    comment: h('textarea', { class: 'inp', rows: 3 }),
  };
  // Session color: preset swatches plus a custom picker; '' = no color.
  let colorVal = '';
  const custom = h('input', { type: 'color', class: 'color-custom', title: 'Custom color' });
  const swatches = h('div', { class: 'swatches' });
  const setColor = (c, markDirty = true) => {
    colorVal = c;
    for (const s of swatches.querySelectorAll('.swatch')) s.classList.toggle('sel', s.dataset.c === c);
    custom.classList.toggle('sel', !!c && !SESSION_COLORS.includes(c));
    if (c) custom.value = c;
    if (markDirty) dirty = true;
  };
  swatches.append(...SESSION_COLORS.map(c => h('button', {
    class: 'swatch' + (c ? '' : ' none'), type: 'button', 'data-c': c, title: c || 'No color',
    style: c ? { background: c } : null, onclick: () => setColor(c),
  })), custom);
  custom.addEventListener('input', () => setColor(custom.value));
  f.production.addEventListener('change', () => { if (f.production.checked && !colorVal) setColor('#d13438'); });

  // SSH tunnel section: rows shown only when enabled; the stored host key can be forgotten.
  const hostKeyText = h('code', { class: 'sm-hostkey' });
  const forgetBtn = h('button', {
    class: 'tbtn', type: 'button', title: 'Forget the trusted host key; you will be asked to confirm it on the next connection',
    onclick: async () => {
      if (!cur) return;
      if (cur.id) await post(`/sessions/${cur.id}/hostkey`, { fingerprint: null }).catch(e => alertError(e.message));
      cur.sshHostKey = null;
      syncSsh();
    },
  }, 'Forget');
  const sshRows = {
    host: row('SSH host:', f.sshHost),
    port: row('SSH port:', f.sshPort),
    user: row('SSH user:', f.sshUser),
    auth: row('Authentication:', f.sshAuth),
    key: row('Private key:', f.sshKeyFile),
    secret: row('SSH password:', f.sshSecret),
    hostKey: h('div', { class: 'frow' }, h('span', null, 'Host key:'), h('div', { class: 'sm-hostkey-row' }, hostKeyText, forgetBtn)),
  };
  function syncSsh() {
    const on = f.sshEnabled.checked;
    for (const r of Object.values(sshRows)) r.style.display = on ? '' : 'none';
    const key = f.sshAuth.value === 'key';
    sshRows.key.style.display = on && key ? '' : 'none';
    sshRows.secret.firstChild.textContent = key ? 'Key passphrase:' : 'SSH password:';
    f.sshSecret.placeholder = cur?.hasSshSecret ? '(saved – type to change)' : key ? 'Only if the key is encrypted' : '';
    hostKeyText.textContent = cur?.sshHostKey || 'not trusted yet – you will be asked to confirm it';
    forgetBtn.style.display = cur?.sshHostKey ? '' : 'none';
    f.host.placeholder = on ? 'As seen from the SSH server, usually 127.0.0.1' : '127.0.0.1, hostname or /path/to/mysql.sock';
  }
  f.sshEnabled.addEventListener('change', syncSsh);
  f.sshAuth.addEventListener('change', syncSsh);

  const list = h('div', { class: 'sm-list', tabindex: 0 });
  const form = h('div', { class: 'form2 sm-form' },
    row('Session name:', f.name),
    h('div', { class: 'sm-sep' }, 'Settings'),
    row('Network type:', h('select', { class: 'inp', disabled: true }, h('option', null, 'MariaDB or MySQL (TCP/IP or socket)'))),
    row('Hostname / IP:', f.host),
    row('User:', f.user),
    row('Password:', f.password),
    row('', h('label', { class: 'chk' }, f.savePassword, ' Save passwords')),
    row('Port:', f.port),
    row('Databases:', f.databases),
    row('SSL mode:', f.sslMode),
    row('Connect timeout (s):', f.connectTimeout),
    row('', h('label', { class: 'chk' }, f.compression, ' Compressed client/server protocol')),
    row('', h('label', { class: 'chk', title: 'Only SELECT, SHOW, DESCRIBE, EXPLAIN and USE can run; editing, DDL and other changes are blocked.' },
      f.readOnly, ' Read-only mode (no changes possible)')),
    row('', h('label', { class: 'chk', title: 'Highlights the session everywhere and asks for confirmation before any change.' },
      f.production, ' Production server (confirm every change)')),
    row('Color:', swatches),
    h('div', { class: 'sm-sep' }, 'SSH tunnel'),
    row('', h('label', { class: 'chk' }, f.sshEnabled, ' Connect through an SSH tunnel')),
    ...Object.values(sshRows),
    h('div', { class: 'sm-sep' }, 'Notes'),
    row('Comment:', f.comment));
  const empty = h('div', { class: 'placeholder' }, 'Create a new session with the "New" button.');
  const right = h('div', { class: 'sm-right' });

  function row(label, input) {
    return h('label', { class: 'frow' }, h('span', null, label), input);
  }

  for (const [k, el] of Object.entries(f)) {
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      dirty = true;
      if (k === 'password') pwdDirty = true;
      if (k === 'sshSecret') sshDirty = true;
      if (k === 'name' && cur) { cur.name = f.name.value; renderList(); }
    });
  }

  function renderList() {
    list.innerHTML = sessions.map((s, i) => `<div class="sm-item${s === cur ? ' sel' : ''}" data-i="${i}">${s.color ? `<span class="color-dot" style="background:${s.color}"></span>` : '<span class="color-dot"></span>'}${icon('server')}<span>${esc(s.name || '(unnamed)')}</span>${s.sshEnabled ? '<span class="um-tag" title="SSH tunnel">ssh</span>' : ''}${s.production ? '<span class="prod-badge">prod</span>' : ''}${s.readOnly ? '<span class="ro-badge">read-only</span>' : ''}</div>`).join('')
      || '<div class="muted pad">No saved sessions</div>';
  }

  function fill(s) {
    cur = s;
    dirty = !!s && !s.id;
    pwdDirty = false;
    sshDirty = false;
    right.replaceChildren(s ? form : empty);
    if (!s) return renderList();
    f.name.value = s.name ?? '';
    f.host.value = s.host ?? '';
    f.user.value = s.user ?? '';
    f.password.value = '';
    f.password.placeholder = s.hasPassword ? '(saved – type to change)' : '';
    f.savePassword.checked = s.savePassword ?? true;
    f.port.value = s.port ?? 3306;
    f.databases.value = s.databases ?? '';
    f.sslMode.value = s.sslMode || 'Preferred';
    f.connectTimeout.value = s.connectTimeout ?? 15;
    f.compression.checked = !!s.compression;
    f.readOnly.checked = !!s.readOnly;
    f.production.checked = !!s.production;
    setColor(s.color || '', false);
    f.sshEnabled.checked = !!s.sshEnabled;
    f.sshHost.value = s.sshHost ?? '';
    f.sshPort.value = s.sshPort ?? 22;
    f.sshUser.value = s.sshUser ?? '';
    f.sshAuth.value = s.sshAuth === 'key' ? 'key' : 'password';
    f.sshKeyFile.value = s.sshKeyFile ?? '';
    f.sshSecret.value = '';
    f.comment.value = s.comment ?? '';
    syncSsh();
    renderList();
  }

  function collect() {
    return {
      ...cur,
      name: f.name.value.trim() || 'Unnamed',
      host: f.host.value.trim() || '127.0.0.1',
      user: f.user.value,
      password: pwdDirty ? f.password.value : null,
      savePassword: f.savePassword.checked,
      port: parseInt(f.port.value, 10) || 3306,
      databases: f.databases.value.trim() || null,
      sslMode: f.sslMode.value,
      connectTimeout: parseInt(f.connectTimeout.value, 10) || 15,
      compression: f.compression.checked,
      readOnly: f.readOnly.checked,
      production: f.production.checked,
      color: colorVal || null,
      sshEnabled: f.sshEnabled.checked,
      sshHost: f.sshHost.value.trim() || null,
      sshPort: parseInt(f.sshPort.value, 10) || 22,
      sshUser: f.sshUser.value.trim() || null,
      sshAuth: f.sshAuth.value,
      sshKeyFile: f.sshKeyFile.value.trim() || null,
      sshSecret: sshDirty ? f.sshSecret.value : null,
      sshHostKey: cur.sshHostKey ?? null,
      comment: f.comment.value || null,
    };
  }

  async function save() {
    if (!cur) return null;
    if (!dirty) return cur;
    const typed = pwdDirty ? f.password.value : null;
    const typedSsh = sshDirty ? f.sshSecret.value : null;
    const saved = await post('/sessions', collect());
    saved.$typedPassword = typed;
    saved.$typedSsh = typedSsh;
    const i = sessions.indexOf(cur);
    sessions[i] = saved;
    sessions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    cur = saved;
    dirty = false;
    pwdDirty = false;
    sshDirty = false;
    syncSsh();
    renderList();
    return saved;
  }

  list.addEventListener('mousedown', async e => {
    const it = e.target.closest('.sm-item');
    if (!it) return;
    const s = sessions[+it.dataset.i];
    if (s === cur) return;
    try { await save(); } catch (err) { return alertError(err.message); }
    fill(s);
  });
  let ctxRef;
  list.addEventListener('dblclick', e => { if (e.target.closest('.sm-item')) ctxRef.dialog.querySelector('.btn.primary').click(); });
  list.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = sessions.indexOf(cur) + (e.key === 'ArrowDown' ? 1 : -1);
    if (sessions[i]) save().then(() => fill(sessions[i])).catch(err => alertError(err.message));
  });

  const last = app.state.lastSession;
  fill(sessions.find(s => s.id === last) || sessions[0] || null);

  await modal({
    title: 'Session manager',
    width: 760,
    className: 'session-manager',
    body: c => { ctxRef = c; return h('div', { class: 'sm' }, list, right); },
    buttons: [
      {
        label: 'New', align: 'left', onClick: async () => {
          await save();
          const s = { id: null, name: 'Unnamed', host: '127.0.0.1', user: 'root', port: 3306, savePassword: true, sslMode: 'Preferred', connectTimeout: 15, sshPort: 22, sshAuth: 'password' };
          sessions.push(s);
          fill(s);
          f.name.select();
          return false;
        },
      },
      { label: 'Save', align: 'left', onClick: async () => { await save(); app.setStatus('Session saved.'); return false; } },
      {
        label: 'Delete', align: 'left', onClick: async () => {
          if (!cur) return false;
          if (!(await confirmDlg(`Delete session "${cur.name}"?`, { ok: 'Delete', danger: true }))) return false;
          if (cur.id) await del('/sessions/' + cur.id);
          sessions.splice(sessions.indexOf(cur), 1);
          fill(sessions[0] || null);
          return false;
        },
      },
      {
        label: 'Test', align: 'left', onClick: async () => {
          if (!cur) return false;
          for (;;) {
            try {
              const r = await post('/test', { profile: collect(), sessionId: cur.id, password: pwdDirty ? f.password.value : null, sshSecret: sshDirty ? f.sshSecret.value : null });
              await modal({ title: 'Connection test', body: `Connection successful${r.ssh ? ' (through the SSH tunnel)' : ''}.\nServer version: ${r.version}` });
              return false;
            } catch (e) {
              if (e.code !== SSH_HOSTKEY_UNKNOWN) throw e;
              if (!(await confirmHostKey(e.data))) return false;
              cur.sshHostKey = e.data.fingerprint;
              if (cur.id) await post(`/sessions/${cur.id}/hostkey`, { fingerprint: e.data.fingerprint });
              else dirty = true;
              syncSsh();
            }
          }
        },
      },
      {
        label: 'Open', primary: true, onClick: async () => {
          if (!cur) return false;
          let pwd = pwdDirty ? f.password.value : cur.$typedPassword ?? null;
          let ssh = sshDirty ? f.sshSecret.value : cur.$typedSsh ?? null;
          const s = await save();
          const needPwd = !s.savePassword && pwd == null;
          const needSsh = !s.savePassword && s.sshEnabled && ssh == null;
          if (needPwd || needSsh) {
            const r = await passwordPrompt(s, needPwd, needSsh);
            if (!r) return false;
            pwd = r.password ?? pwd;
            ssh = r.sshSecret ?? ssh;
          }
          app.state.lastSession = s.id;
          app.saveStateSoon();
          return (await app.connect(s.id, pwd, ssh)) !== false;
        },
      },
      { label: 'Cancel', value: null },
    ],
  });
}

/** Asks the user to trust an SSH server's host key on first contact. */
export async function confirmHostKey({ host, port, fingerprint }) {
  return confirmDlg(
    `The authenticity of SSH host ${host}:${port} can't be established.\n\nKey fingerprint:\n${fingerprint}\n\n` +
    'Compare it with the fingerprint shown by the server administrator (e.g. ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). ' +
    'Only continue if they match; ZawSQL will remember this key and refuse to connect if it ever changes.',
    { title: 'Unknown SSH host key', ok: 'Trust and connect', kind: 'warning' });
}

async function passwordPrompt(s, askPassword = true, askSsh = false) {
  const pwd = h('input', { class: 'inp wide', type: 'password' });
  const ssh = h('input', { class: 'inp wide', type: 'password' });
  return modal({
    title: 'Password',
    width: 400,
    body: h('div', { class: 'form' },
      askPassword ? h('label', null, `Password for ${s.user}@${s.host}:`) : null, askPassword ? pwd : null,
      askSsh ? h('label', null, s.sshAuth === 'key' ? `Passphrase for the SSH key (empty if none):` : `SSH password for ${s.sshUser}@${s.sshHost}:`) : null, askSsh ? ssh : null),
    buttons: [{ label: 'OK', primary: true, onClick: () => ({ password: askPassword ? pwd.value : null, sshSecret: askSsh ? ssh.value : null }) }, { label: 'Cancel', value: null }],
  });
}

// ---------------------------------------------------------------- grid export

const FORMATS = { csv: 'CSV', tsv: 'Tab separated', sql: 'SQL INSERTs', json: 'JSON', md: 'Markdown table', html: 'HTML table' };
const EXT = { csv: '.csv', tsv: '.tsv', sql: '.sql', json: '.json', md: '.md', html: '.html' };

function sqlValue(v, col) {
  if (v == null) return 'NULL';
  if (isNumericKind(col.kind) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return v;
  if ((col.kind === 'binary' || col.kind === 'spatial') && /^0x[0-9a-f]*$/i.test(v)) return v;
  return sqlStr(v);
}

export function rowsToSql(table, columns, rows) {
  const head = `INSERT INTO ${qi(table)} (${columns.map(c => qi(c.name)).join(', ')}) VALUES`;
  return rows.map(r => `${head} (${columns.map((c, i) => sqlValue(r[i], c)).join(', ')});`).join('\n');
}

export function exportRows(fmt, columns, rows, { header = true, table = 'export' } = {}) {
  const names = columns.map(c => c.name);
  switch (fmt) {
    case 'csv': {
      const q = v => (v == null ? '' : /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
      return (header ? names.map(q).join(',') + '\r\n' : '') + rows.map(r => r.map(q).join(',')).join('\r\n');
    }
    case 'tsv': {
      const q = v => (v == null ? '\\N' : v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r'));
      return (header ? names.join('\t') + '\n' : '') + rows.map(r => r.map(q).join('\t')).join('\n');
    }
    case 'sql': return rowsToSql(table, columns, rows);
    case 'json': return JSON.stringify(rows.map(r => {
      const o = {};
      columns.forEach((c, i) => {
        const v = r[i];
        o[c.name] = v != null && isNumericKind(c.kind) && Math.abs(Number(v)) < Number.MAX_SAFE_INTEGER && !isNaN(Number(v)) ? Number(v) : v;
      });
      return o;
    }), null, 2);
    case 'md': {
      const q = v => (v == null ? 'NULL' : v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'));
      return `| ${names.map(q).join(' | ')} |\n|${names.map(() => ' --- ').join('|')}|\n` + rows.map(r => `| ${r.map(q).join(' | ')} |`).join('\n');
    }
    case 'html': {
      const q = v => (v == null ? '<i>NULL</i>' : esc(v));
      return `<table border="1" cellspacing="0" cellpadding="3">\n<thead><tr>${names.map(n => `<th>${esc(n)}</th>`).join('')}</tr></thead>\n<tbody>\n` +
        rows.map(r => `<tr>${r.map(v => `<td>${q(v)}</td>`).join('')}</tr>`).join('\n') + '\n</tbody>\n</table>\n';
    }
  }
  return '';
}

export async function exportGridDialog(app, { columns, rows, selected = [], name = 'export' }) {
  const fmt = h('select', { class: 'inp' }, Object.entries(FORMATS).map(([k, v]) => h('option', { value: k, selected: k === (app.state.exportFormat || 'csv') }, v)));
  const scopeAll = h('input', { type: 'radio', name: 'scope', checked: selected.length <= 1 });
  const scopeSel = h('input', { type: 'radio', name: 'scope', checked: selected.length > 1, disabled: !selected.length });
  const header = h('input', { type: 'checkbox', checked: true });
  const toClip = h('input', { type: 'radio', name: 'dest', checked: true });
  const toFile = h('input', { type: 'radio', name: 'dest' });
  const table = h('input', { class: 'inp', value: name, spellcheck: false });
  const body = h('div', { class: 'form2' },
    h('label', { class: 'frow' }, h('span', null, 'Format:'), fmt),
    h('div', { class: 'frow' }, h('span', null, 'Rows:'), h('div', null,
      h('label', { class: 'chk' }, scopeAll, ` All loaded rows (${fmtNum(rows.length)})`), h('br'),
      h('label', { class: 'chk' }, scopeSel, ` Selected rows (${fmtNum(selected.length)})`))),
    h('div', { class: 'frow' }, h('span', null, 'Output:'), h('div', null,
      h('label', { class: 'chk' }, toClip, ' Copy to clipboard'), h('br'),
      h('label', { class: 'chk' }, toFile, ' Save to file'))),
    h('label', { class: 'frow' }, h('span', null, ''), h('label', { class: 'chk' }, header, ' Include column names')),
    h('label', { class: 'frow' }, h('span', null, 'Table name (SQL):'), table));
  const ok = await modal({ title: 'Export grid rows', width: 460, body, buttons: [{ label: 'Export', value: true, primary: true }, { label: 'Cancel', value: false }] });
  if (!ok) return;
  app.state.exportFormat = fmt.value;
  app.saveStateSoon();
  const data = scopeSel.checked ? selected.map(i => rows[i]) : rows;
  const text = exportRows(fmt.value, columns, data, { header: header.checked, table: table.value || name });
  if (toClip.checked) {
    await navigator.clipboard.writeText(text);
    app.setStatus(`${fmtNum(data.length)} rows copied to clipboard.`);
  } else {
    await saveTextFile(name + EXT[fmt.value], text, FORMATS[fmt.value], EXT[fmt.value]);
  }
}

// ---------------------------------------------------------------- database dump

export async function exportDumpDialog(app, sid, db, tables = null) {
  const structure = h('input', { type: 'checkbox', checked: true });
  const data = h('input', { type: 'checkbox', checked: true });
  const drop = h('input', { type: 'checkbox', checked: true });
  const createDb = h('input', { type: 'checkbox', checked: !tables });
  const scope = tables?.length ? `${tables.length} selected object(s): ${tables.slice(0, 5).join(', ')}${tables.length > 5 ? ', …' : ''}` : 'All objects (tables, views, routines, triggers, events)';
  const body = h('div', { class: 'form2' },
    h('div', { class: 'frow' }, h('span', null, 'Database:'), h('b', null, db)),
    h('div', { class: 'frow' }, h('span', null, 'Objects:'), h('span', null, scope)),
    h('div', { class: 'frow' }, h('span', null, 'Options:'), h('div', null,
      h('label', { class: 'chk' }, createDb, ' CREATE DATABASE + USE'), h('br'),
      h('label', { class: 'chk' }, drop, ' DROP before CREATE'), h('br'),
      h('label', { class: 'chk' }, structure, ' Structure'), h('br'),
      h('label', { class: 'chk' }, data, ' Data (INSERT statements)'))));
  const ok = await modal({ title: 'Export database as SQL', width: 480, body, buttons: [{ label: 'Export', value: true, primary: true }, { label: 'Cancel', value: false }] });
  if (!ok) return;
  const url = urlWithToken(`/s/${sid}/dump`, {
    db, tables: tables?.join(','), structure: String(structure.checked), data: String(data.checked), drop: String(drop.checked), createDb: String(createDb.checked),
  });
  const a = h('a', { href: url, download: `${db}.sql` });
  document.body.append(a);
  a.click();
  a.remove();
  app.log.info(`Exporting ${db} to SQL file`);
}

// ---------------------------------------------------------------- run SQL file

export async function runSqlFile(app) {
  const { sid, db } = app.sel;
  if (!sid) return app.showError(new Error('Not connected.'));
  if (!app.canModify(sid)) return;
  const file = await pickFile('.sql,.txt,text/plain');
  if (!file) return;
  const text = await file.text();
  const stmts = splitSql(text);
  if (!stmts.length) return app.showError(new Error('The file contains no SQL statements.'));
  const cont = h('input', { type: 'checkbox' });
  const ok = await modal({
    title: 'Run SQL file',
    width: 480,
    body: h('div', { class: 'form' },
      h('div', null, `File: ${file.name} (${fmtBytes(file.size)}), ${fmtNum(stmts.length)} statements.`),
      h('div', null, `Target: ${app.conns.get(sid).name}${db ? ' › ' + db : ''}`),
      h('label', { class: 'chk' }, cont, ' Continue on errors')),
    buttons: [{ label: 'Run', value: true, primary: true }, { label: 'Cancel', value: false }],
  });
  if (!ok) return;
  if (!(await app.confirmChanges(sid, { action: `Run SQL file ${file.name} (${fmtNum(stmts.length)} statements)` }))) return;

  const bar = h('div', { class: 'progress-bar' });
  const label = h('div');
  let cancelled = false, errors = 0, done = 0;
  const t0 = Date.now();
  let closeDlg = () => {};
  const dlg = modal({
    title: `Running ${file.name}`,
    width: 460,
    body: h('div', { class: 'form' }, label, h('div', { class: 'progress' }, bar)),
    buttons: [{ label: 'Cancel', onClick: () => { cancelled = true; label.textContent = 'Cancelling…'; return false; } }],
    onOpen: c => { closeDlg = c.close; },
  });

  let curDb = db;
  try {
    let i = 0;
    while (i < stmts.length && !cancelled) {
      const chunk = [];
      let size = 0;
      while (i < stmts.length && chunk.length < 500 && size < 4_000_000) {
        chunk.push(stmts[i].sql);
        size += stmts[i].sql.length;
        i++;
      }
      const r = await post(`/s/${sid}/exec`, { statements: chunk, database: curDb, maxRows: 0, stopOnError: !cont.checked }, { quiet: true });
      curDb = r.database || curDb;
      done += r.executed;
      errors += r.errors.length;
      for (const er of r.errors) app.log.error(`Statement ${done + 1}: (${er.code}) ${er.message}`);
      label.textContent = `${fmtNum(i)} of ${fmtNum(stmts.length)} statements, ${errors} error(s)`;
      bar.style.width = (i / stmts.length) * 100 + '%';
      if (r.errors.length && !cont.checked) {
        const er = r.errors[0];
        closeDlg();
        await alertError(`SQL Error (${er.code}): ${er.message}\n\nin statement:\n${chunk[er.statement].slice(0, 500)}`);
        break;
      }
    }
  } catch (e) {
    closeDlg();
    await app.showError(e);
  }
  closeDlg();
  await dlg;
  app.log.info(`Executed ${fmtNum(done)} statements from ${file.name} in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${errors} error(s)${cancelled ? ', cancelled' : ''}`);
  app.setStatus(`SQL file finished: ${fmtNum(done)} statements, ${errors} error(s).`);
  app.afterDdl(sid, curDb);
}

// ---------------------------------------------------------------- create database

export async function createDatabaseDialog(app, sid) {
  if (!app.canModify(sid)) return;
  const name = h('input', { class: 'inp', spellcheck: false });
  const coll = h('input', { class: 'inp', list: 'dl-collations', placeholder: '(server default)', spellcheck: false });
  app.fillCollationList(sid);
  const code = h('pre', { class: 'code-preview' });
  const upd = () => { code.textContent = `CREATE DATABASE ${qi(name.value || 'new_db')}${coll.value ? ' COLLATE ' + sqlStr(coll.value) : ''};`; };
  name.addEventListener('input', upd);
  coll.addEventListener('input', upd);
  upd();
  const r = await modal({
    title: 'Create database',
    width: 460,
    body: h('div', { class: 'form2' }, h('label', { class: 'frow' }, h('span', null, 'Name:'), name), h('label', { class: 'frow' }, h('span', null, 'Collation:'), coll), code),
    buttons: [{
      label: 'OK', primary: true, onClick: async () => {
        if (!name.value.trim()) return false;
        const sql = code.textContent.replace(/;$/, '');
        if (!(await app.confirmChanges(sid, { action: 'Create database', statements: [sql] }))) return false;
        await app.exec(sid, [sql]);
        return name.value.trim();
      },
    }, { label: 'Cancel', value: null }],
  });
  if (r) {
    await app.tree.refresh(app.tree.sessionNode(sid));
    app.selectDatabase(sid, r);
  }
}

// ---------------------------------------------------------------- preferences / about

export async function preferencesDialog(app) {
  const p = app.prefs;
  const rows = h('input', { class: 'inp', type: 'number', min: 10, max: 1000000, value: p.rowsPerPage });
  const maxRows = h('input', { class: 'inp', type: 'number', min: 1, max: 10000000, value: p.maxResultRows });
  const theme = h('select', { class: 'inp' }, [['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: v === p.theme }, l)));
  const font = h('input', { class: 'inp', type: 'number', min: 9, max: 24, value: p.editorFontSize });
  const noWhere = h('input', { type: 'checkbox', checked: p.confirmNoWhere !== false });
  const ok = await modal({
    title: 'Preferences',
    width: 440,
    body: h('div', { class: 'form2' },
      h('label', { class: 'frow' }, h('span', null, 'Data tab rows per page:'), rows),
      h('label', { class: 'frow' }, h('span', null, 'Max rows in query results:'), maxRows),
      h('label', { class: 'frow' }, h('span', null, 'Theme:'), theme),
      h('label', { class: 'frow' }, h('span', null, 'SQL editor font size:'), font),
      h('label', { class: 'frow' }, h('span', null, 'Safety:'), h('label', { class: 'chk' }, noWhere, ' Confirm UPDATE/DELETE without WHERE'))),
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
  });
  if (!ok) return;
  Object.assign(p, {
    rowsPerPage: Math.max(10, parseInt(rows.value, 10) || 1000),
    maxResultRows: Math.max(1, parseInt(maxRows.value, 10) || 10000),
    theme: theme.value,
    editorFontSize: Math.max(9, parseInt(font.value, 10) || 13),
    confirmNoWhere: noWhere.checked,
  });
  app.applyPrefs();
  app.saveStateSoon();
}

export function aboutDialog() {
  return modal({
    title: 'About ZawSQL',
    width: 420,
    body: h('div', { class: 'about' },
      h('div', { class: 'about-logo', html: icon('database').replace('width="16" height="16"', 'width="48" height="48"') }),
      h('div', null, h('h2', null, 'ZawSQL'), h('p', null, 'A lightweight MySQL / MariaDB client.'), h('p', { class: 'muted' }, 'C# / ASP.NET Core backend with a browser-hosted UI. Runs on Windows, Linux and macOS.'))),
  });
}
