// Table maintenance: CHECK, ANALYZE, CHECKSUM, OPTIMIZE and REPAIR for a selection of tables.
import { h, esc, qi, fmtBytes } from '../util.js';
import { post } from '../api.js';
import { Grid } from '../grid.js';
import { modal } from '../dialogs.js';
import { exportGridDialog } from './tools.js';

export const OPS = [
  { id: 'check', label: 'Check', readOnly: true, single: true, options: ['QUICK', 'FAST', 'MEDIUM', 'EXTENDED', 'CHANGED', 'FOR UPGRADE'],
    desc: 'Checks tables for errors.' },
  { id: 'analyze', label: 'Analyze', options: ['LOCAL'],
    desc: 'Refreshes the key distribution statistics the query optimizer uses.' },
  { id: 'checksum', label: 'Checksum', readOnly: true, single: true, options: ['QUICK', 'EXTENDED'],
    desc: 'Computes a checksum of each table\'s contents, e.g. to compare copies.' },
  { id: 'optimize', label: 'Optimize', options: ['LOCAL'],
    desc: 'Rebuilds tables to reclaim unused space and defragment (InnoDB recreates the table). Can take long on big tables.' },
  { id: 'repair', label: 'Repair', options: ['LOCAL', 'QUICK', 'EXTENDED', 'USE_FRM'],
    desc: 'Repairs damaged MyISAM, Aria, Archive or CSV tables. InnoDB tables don\'t support it.' },
];

const OPTION_HELP = {
  QUICK: 'Faster, less thorough',
  FAST: 'Only tables not closed properly',
  MEDIUM: 'Scan rows, verify links (default)',
  EXTENDED: 'Full, slow check of every row',
  CHANGED: 'Only tables changed since last check',
  'FOR UPGRADE': 'Check compatibility with this server version',
  LOCAL: "Don't write to the binary log (not replicated)",
  USE_FRM: 'Recreate the index file from the table definition',
};

/** The statement a run would execute (for the preview; the backend builds the real one). */
export function maintenanceSql(op, db, tables, options) {
  const def = OPS.find(o => o.id === op);
  const opts = options.filter(o => def.options.includes(o));
  const local = opts.includes('LOCAL') && op !== 'check' && op !== 'checksum';
  const keyword = def.label.toUpperCase() + (local ? ' LOCAL' : '') + ' TABLE';
  const rest = opts.filter(o => o !== 'LOCAL');
  const list = tables.length > 3 ? `${tables.slice(0, 3).map(t => `${qi(db)}.${qi(t)}`).join(', ')}, … (${tables.length} tables)` : tables.map(t => `${qi(db)}.${qi(t)}`).join(', ');
  return `${keyword} ${list || '…'}${rest.length ? ' ' + rest.join(' ') : ''}`;
}

// Fixed widths: the grid starts empty, so measuring the content would leave the columns too narrow.
const COLUMNS = [{ name: 'Table', width: 220 }, { name: 'Operation', width: 90 }, { name: 'Type', width: 70 }, { name: 'Message', width: 540 }];

export async function maintenanceDialog(app, sid, db, preselected = null) {
  if (!sid || !db) return app.showError(new Error('Select a database first.'));
  const ro = app.isReadOnly(sid);
  let tables;
  try {
    tables = (await app.getObjects(sid, db)).filter(o => o.type === 'table');
  } catch (e) {
    return app.showError(e);
  }
  const selected = new Set(preselected?.length ? preselected : tables.map(t => t.name));
  let op = 'check';
  let options = [];
  let running = false, stopRequested = false;
  const results = [];

  // ---- table checklist
  const filter = h('input', { class: 'inp', placeholder: 'Filter tables', spellcheck: false });
  const list = h('div', { class: 'mt-list' });
  const count = h('span', { class: 'muted' });
  const drawList = () => {
    const q = filter.value.toLowerCase();
    list.innerHTML = tables.filter(t => !q || t.name.toLowerCase().includes(q)).map(t =>
      `<label class="mt-item"><input type="checkbox" data-t="${esc(t.name)}"${selected.has(t.name) ? ' checked' : ''}><span class="mt-name">${esc(t.name)}</span><span class="muted">${esc(t.engine || '')}</span><span class="muted mt-size">${fmtBytes(t.size)}</span></label>`).join('')
      || '<div class="muted pad">No tables</div>';
    count.textContent = `${selected.size} of ${tables.length} selected`;
    update();
  };
  list.addEventListener('change', e => {
    const name = e.target.dataset.t;
    if (name == null) return;
    e.target.checked ? selected.add(name) : selected.delete(name);
    count.textContent = `${selected.size} of ${tables.length} selected`;
    update();
  });
  filter.addEventListener('input', drawList);
  const selectVisible = on => {
    for (const cb of list.querySelectorAll('input[data-t]')) on ? selected.add(cb.dataset.t) : selected.delete(cb.dataset.t);
    drawList();
  };

  // ---- operation and options
  const opBox = h('div', { class: 'mt-ops' });
  const optBox = h('div', { class: 'mt-options' });
  const preview = h('pre', { class: 'code-preview mt-preview' });
  const drawOps = () => {
    opBox.replaceChildren(...OPS.map(o => {
      const disabled = ro && !o.readOnly;
      const radio = h('input', { type: 'radio', name: 'mt-op', value: o.id, checked: o.id === op, disabled });
      radio.addEventListener('change', () => { op = o.id; options = []; drawOps(); });
      return h('label', { class: 'mt-op' + (disabled ? ' disabled' : ''), title: disabled ? 'Not available in read-only mode' : '' },
        radio, h('span', null, h('b', null, o.label), h('span', { class: 'muted' }, ' – ' + o.desc)));
    }));
    const def = OPS.find(o => o.id === op);
    optBox.replaceChildren(h('div', { class: 'sm-sep' }, def.single ? 'Mode (optional)' : 'Options'), ...def.options.map(name => {
      const cb = h('input', { type: 'checkbox', checked: options.includes(name) });
      cb.addEventListener('change', () => {
        options = cb.checked ? (def.single ? [name] : [...options, name]) : options.filter(x => x !== name);
        drawOps();
      });
      return h('label', { class: 'chk mt-opt', title: OPTION_HELP[name] || '' }, cb, ` ${name}`, h('span', { class: 'muted' }, ` – ${OPTION_HELP[name] || ''}`));
    }));
    update();
  };

  // ---- results
  const grid = new Grid({ gutter: false, emptyText: 'Results appear here.', onContextMenu: () => {} });
  const status = h('span', { class: 'mt-status' });
  const bar = h('div', { class: 'progress-bar' });
  const progress = h('div', { class: 'progress mt-progress' }, bar);

  function update() {
    preview.textContent = maintenanceSql(op, db, [...selected], options);
    if (execBtnEl) execBtnEl.disabled = running || !selected.size;
    if (stopBtnEl) stopBtnEl.disabled = !running;
  }

  let execBtnEl = null, stopBtnEl = null;

  async function run() {
    const names = tables.map(t => t.name).filter(n => selected.has(n));
    if (!names.length || running) return false;
    const def = OPS.find(o => o.id === op);
    if (!def.readOnly && !(await app.confirmChanges(sid, { action: `${def.label} ${names.length} table(s) in ${db}`, statements: [maintenanceSql(op, db, names, options)] }))) return false;
    running = true;
    stopRequested = false;
    update();
    results.length = 0;
    grid.setData(COLUMNS, results);
    const t0 = Date.now();
    let errors = 0;
    for (let i = 0; i < names.length && !stopRequested; i++) {
      status.textContent = `${def.label} ${names[i]} (${i + 1} of ${names.length})…`;
      bar.style.width = (i / names.length) * 100 + '%';
      try {
        const rs = await post(`/s/${sid}/maintenance`, { db, tables: [names[i]], op, options });
        for (const row of rs.rows) {
          // CHECKSUM returns (Table, Checksum); the others (Table, Op, Msg_type, Msg_text).
          const out = rs.columns.length === 2 ? [row[0], 'checksum', 'status', row[1] ?? 'NULL (table missing or not supported)'] : row.slice(0, 4);
          out[0] = names[i];
          if (/error/i.test(out[2] ?? '')) errors++;
          results.push(out);
        }
      } catch (e) {
        errors++;
        results.push([names[i], op, 'error', e.message]);
      }
      grid.setData(COLUMNS, results, { keepWidths: true, keepPos: true });
    }
    bar.style.width = '100%';
    const done = new Set(results.map(r => r[0])).size;
    status.textContent = `${def.label}: ${done} of ${names.length} table(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s` +
      (errors ? ` – ${errors} error(s)` : '') + (stopRequested ? ' – stopped' : '');
    app.setStatus(status.textContent);
    running = false;
    update();
    if (!def.readOnly) app.refreshDb(sid, db).catch(() => {});
    return false;
  }

  const body = h('div', { class: 'mt' },
    h('div', { class: 'mt-top' },
      h('div', { class: 'mt-tables' },
        h('div', { class: 'mt-tables-head' }, filter,
          h('button', { class: 'tbtn', type: 'button', onclick: () => selectVisible(true) }, 'All'),
          h('button', { class: 'tbtn', type: 'button', onclick: () => selectVisible(false) }, 'None')),
        list, count),
      h('div', { class: 'mt-right' }, h('div', { class: 'sm-sep' }, 'Operation'), opBox, optBox, preview,
        ro ? h('div', { class: 'ro-note' }, 'Read-only session: only Check and Checksum are available.') : null)),
    h('div', { class: 'mt-results' }, grid.el),
    h('div', { class: 'mt-foot' }, status, progress));

  drawList();
  drawOps();
  grid.setData(COLUMNS, results);

  await modal({
    title: `Table maintenance – ${db}`,
    width: 980,
    className: 'maintenance',
    body,
    onOpen: c => {
      const btns = c.dialog.querySelectorAll('.modal-buttons .btn');
      execBtnEl = [...btns].find(b => b.textContent === 'Execute');
      stopBtnEl = [...btns].find(b => b.textContent === 'Stop');
      update();
    },
    buttons: [
      { label: 'Copy / export results', align: 'left', onClick: () => { if (results.length) exportGridDialog(app, { columns: COLUMNS, rows: results, name: 'maintenance' }); return false; } },
      { label: 'Execute', primary: true, onClick: run },
      { label: 'Stop', onClick: () => { stopRequested = true; status.textContent += ' – stopping after this table…'; return false; } },
      { label: 'Close', value: null, onClick: () => (running ? false : undefined) },
    ],
  });
  stopRequested = true; // closing the dialog ends a run after the current table
}
