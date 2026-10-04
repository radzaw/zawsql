// Session manager › Import: sessions from HeidiSQL, DBeaver and MySQL Workbench, found on this computer or read from
// files the user picks. The backend parses them and keeps the passwords; this dialog only sees what to show.
import { h } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { modal } from '../dialogs.js';

const SOURCES = [
  { id: 'heidisql', name: 'HeidiSQL', accept: '.txt', multiple: false,
    hint: 'On Windows its sessions are found in the registry. Otherwise choose the file from File › Export settings in HeidiSQL, or portable_settings.txt of a portable HeidiSQL.' },
  { id: 'dbeaver', name: 'DBeaver', accept: '.json', multiple: true,
    hint: 'Choose data-sources.json from the project\'s .dbeaver folder, together with credentials-config.json for the users and passwords.' },
  { id: 'workbench', name: 'MySQL Workbench', accept: '.xml', multiple: false,
    hint: 'Choose connections.xml. Workbench keeps passwords in the system keychain, so ZawSQL asks for them when connecting.' },
];

const toBase64 = async file => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const pickFiles = (accept, multiple) => new Promise(resolve => {
  const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
  input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
  input.addEventListener('cancel', () => { resolve([]); input.remove(); });
  document.body.append(input);
  input.click();
});

/** Shows the import dialog; resolves to the saved sessions (empty when nothing was imported). */
export async function importSessionsDialog(app) {
  let ctx, found = [];
  const body = h('div', { class: 'si' });
  const buttons = h('div', { class: 'upd-buttons' });
  const done = modal({ title: 'Import sessions', width: 860, className: 'si-dialog', buttons: [], closeValue: [], body: c => { ctx = c; return h('div', null, body, buttons); } });

  body.replaceChildren(h('div', { class: 'muted pad' }, 'Looking for HeidiSQL, DBeaver and MySQL Workbench sessions…'));
  try { found = await get('/sessions/import/sources', null, { quiet: true }); } catch (e) { app.log?.error?.(e.message); }
  chooseSource();
  return done;

  function chooseSource() {
    body.replaceChildren(
      h('p', { class: 'si-intro' }, 'Copy saved sessions from another client. Passwords come along where the other tool stored them; nothing is changed there.'),
      ...SOURCES.map(src => {
        const here = found.filter(f => f.source === src.id);
        return h('section', { class: 'si-source', 'data-source': src.id },
          h('div', { class: 'si-source-head' }, h('b', null, src.name),
            here.length ? h('span', { class: 'si-found' }, h('span', { html: icon('check') }), `found on this computer`) : h('span', { class: 'muted' }, 'not found on this computer')),
          ...here.map(f => h('div', { class: 'si-location' },
            h('code', null, f.path),
            h('span', { class: 'muted' }, `${f.count} MySQL / MariaDB session${f.count === 1 ? '' : 's'}`),
            h('button', { class: 'btn', disabled: !f.count, onclick: () => read({ source: src.id, location: f.path }, `${src.name} (${f.path})`) }, 'Show sessions'))),
          h('div', { class: 'si-file' },
            h('span', { class: 'muted' }, src.hint),
            h('button', { class: 'btn', onclick: async () => {
              const files = await pickFiles(src.accept, src.multiple);
              if (!files.length) return;
              const payload = await Promise.all(files.map(async f => ({ name: f.name, data: await toBase64(f) })));
              read({ source: src.id, files: payload }, `${src.name} (${files.map(f => f.name).join(', ')})`);
            } }, src.multiple ? 'Choose files…' : 'Choose file…')));
      }));
    buttons.replaceChildren(h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: () => ctx.close([]) }, 'Cancel'));
  }

  async function read(request, label) {
    let r;
    try {
      r = await post('/sessions/import/read', request, { quiet: true });
    } catch (e) {
      return app.showError(e);
    }
    pick(r, label);
  }

  function pick(r, label) {
    const rows = r.sessions.map(s => {
      const check = h('input', { type: 'checkbox', checked: !s.skip && !s.exists, disabled: !!s.skip });
      const name = h('input', { class: 'inp si-name', value: s.name, disabled: !!s.skip, spellcheck: false });
      const server = s.host.startsWith('/') ? s.host : `${s.host}:${s.port}`;
      const who = s.skip ? s.host : `${s.user || '(no user)'}@${server}`;
      const status = s.skip ? [h('span', { class: 'muted' }, `Skipped: ${s.skip}`)]
        : [s.exists ? h('div', { class: 'si-exists' }, `Already saved as "${s.exists}"`) : '', ...s.notes.map(n => h('div', { class: 'muted' }, n))];
      const tags = [
        s.ssh ? h('span', { class: 'um-tag', title: `SSH tunnel through ${s.ssh}` }, 'ssh') : '',
        s.production ? h('span', { class: 'prod-badge' }, 'prod') : '',
        s.readOnly ? h('span', { class: 'ro-badge' }, 'read-only') : '',
      ];
      const tr = h('tr', { class: s.skip ? 'si-skipped' : '' },
        h('td', null, check),
        h('td', null, h('div', { class: 'si-name-cell' }, s.color ? h('span', { class: 'color-dot', style: { background: s.color } }) : h('span', { class: 'color-dot' }), name)),
        h('td', null, h('div', null, who, ...tags), s.ssh ? h('div', { class: 'muted' }, `via ${s.ssh}`) : ''),
        h('td', null, s.skip ? '' : s.hasPassword ? 'saved' : h('span', { class: 'muted' }, 'asked when connecting')),
        h('td', { class: 'si-status' }, ...status));
      return { s, check, name, tr };
    });
    const usable = rows.filter(x => !x.s.skip);
    const all = h('input', { type: 'checkbox', title: 'Select all', onchange: () => { for (const x of usable) x.check.checked = all.checked; sync(); } });
    const importBtn = h('button', { class: 'btn primary' });
    const sync = () => {
      const n = usable.filter(x => x.check.checked).length;
      importBtn.textContent = n ? `Import ${n} session${n === 1 ? '' : 's'}` : 'Import';
      importBtn.disabled = !n;
      all.checked = n === usable.length && n > 0;
      all.indeterminate = n > 0 && n < usable.length;
    };
    for (const x of rows) x.check.addEventListener('change', sync);
    importBtn.onclick = async () => {
      const items = usable.filter(x => x.check.checked).map(x => ({ index: x.s.index, name: x.name.value }));
      importBtn.disabled = true;
      try {
        const res = await post('/sessions/import/save', { id: r.id, items }, { quiet: true });
        ctx.close(res.saved);
      } catch (e) {
        importBtn.disabled = false;
        app.showError(e);
      }
    };
    const skipped = rows.length - usable.length;
    body.replaceChildren(
      h('div', { class: 'si-intro' }, h('b', null, `${usable.length} session${usable.length === 1 ? '' : 's'}`), ` from ${label}`,
        skipped ? h('span', { class: 'muted' }, ` · ${skipped} skipped (not MySQL or MariaDB)`) : ''),
      rows.length
        ? h('div', { class: 'si-table-wrap' }, h('table', { class: 'edit-table si-table' },
          h('thead', null, h('tr', null, h('th', null, all), h('th', null, 'Name in ZawSQL'), h('th', null, 'Server'), h('th', null, 'Password'), h('th', null, 'Notes'))),
          h('tbody', null, rows.map(x => x.tr))))
        : h('div', { class: 'muted pad' }, 'No sessions were found there.'),
      usable.some(x => x.s.exists) ? h('div', { class: 'muted' }, 'Sessions you already have are not selected; importing them anyway adds a copy with a numbered name.') : '');
    buttons.replaceChildren(
      h('button', { class: 'btn', onclick: chooseSource }, 'Back'),
      h('div', { class: 'grow' }),
      importBtn,
      h('button', { class: 'btn', onclick: () => ctx.close([]) }, 'Cancel'));
    sync();
  }
}
