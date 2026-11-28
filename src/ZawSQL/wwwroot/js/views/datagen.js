// "Generate test data…": fills a table with realistic made-up rows. Each column gets a generator picked from its
// name and type (changeable), foreign keys point at existing parent rows, and the rows go in as multi-row INSERTs
// in batches, with progress and Stop, or into a query tab to review first.
import { h, fmtNum } from '../util.js';
import { get } from '../api.js';
import { modal } from '../dialogs.js';
import { Grid } from '../grid.js';
import { GENERATORS, OPTION_HINT, detect, checkColumn, generate, insertStatements, toDisplay, uniqueColumns } from '../datagen.js';

const MAX_ROWS = 1_000_000;
const MAX_SQL_ROWS = 5000; // "Open SQL in query tab" above this would make a huge editor
const BATCH = 500;

export async function dataGenDialog(app, sid, db, table) {
  if (!sid || !db || !table) return;
  if (!app.canModify(sid)) return;
  let info;
  try {
    info = await get(`/s/${sid}/datagen`, { db, table });
  } catch (e) {
    return app.showError(e);
  }
  const cols = info.columns;
  const gens = cols.map(c => detect(c, info));
  const unique = uniqueColumns(info.indexes);
  // The Data tab shows the new rows when it is showing this table.
  const refreshData = () => {
    const t = app.views?.data?.target;
    if (t && t.sid === sid && t.db === db && t.table === table) app.views.data.refresh();
  };

  // ---- settings
  const count = h('input', { class: 'inp', type: 'number', min: 1, max: MAX_ROWS, value: 100, style: { width: '110px' } });
  const nullPct = h('input', { class: 'inp', type: 'number', min: 0, max: 100, value: 10, style: { width: '70px' }, title: 'Columns that allow NULL get NULL in about this share of rows (not key columns)' });
  const status = h('div', { class: 'muted dg-status' });
  const bar = h('div', { class: 'progress-bar' });
  const progress = h('div', { class: 'progress dg-progress' }, bar);
  progress.style.display = 'none';

  // ---- columns
  const body = h('tbody');
  cols.forEach((c, i) => {
    const g = gens[i];
    const sel = h('select', { class: 'inp', disabled: !!g.locked },
      GENERATORS.filter(([k]) => k !== 'fk' || g.kind === 'fk').map(([k, l]) => h('option', { value: k, selected: k === g.kind }, l)));
    const opt = h('input', { class: 'inp', value: g.options, spellcheck: false, placeholder: OPTION_HINT[g.kind] || '' });
    const warn = h('div', { class: 'dg-warn' });
    const refresh = () => {
      opt.placeholder = OPTION_HINT[g.kind] || '';
      opt.disabled = !!g.locked || !(g.kind in OPTION_HINT);
      const p = checkColumn(c, g, info);
      warn.textContent = p || (g.note && g.kind === 'skip' ? `(${g.note})` : '');
      warn.classList.toggle('err', !!p);
    };
    // Back on the detected generator: its options again; another one starts empty (its defaults apply).
    sel.onchange = () => {
      const auto = detect(c, info);
      g.kind = sel.value;
      g.options = opt.value = auto.kind === g.kind ? auto.options : '';
      refresh();
    };
    opt.oninput = () => { g.options = opt.value; refresh(); };
    refresh();
    const fk = g.kind === 'fk' ? info.foreignKeys.find(f => f.columns.some(n => n.toLowerCase() === c.name.toLowerCase())) : null;
    const sample = fk && info.samples.find(s => s.name === fk.name);
    const tr = h('tr', null,
      h('td', { class: 'dg-name', title: c.comment || '' }, h('b', null, c.name), unique.has(c.name.toLowerCase()) ? h('span', { class: 'muted' }, ' unique') : ''),
      h('td', { class: 'muted dg-type' }, c.type, c.nullable ? '' : ' NOT NULL'),
      h('td', null, sel),
      h('td', null, fk ? h('span', { class: 'muted' }, `→ ${fk.refTable} (${fmtNum(sample?.rows.length ?? 0)}${(sample?.rows.length ?? 0) >= 5000 ? '+' : ''} keys)`) : opt, warn));
    body.append(tr);
  });

  // ---- preview
  const grid = new Grid({ gutter: false, emptyText: '' });
  const previewBox = h('div', { class: 'dg-preview' }, grid.el);
  previewBox.style.display = 'none';
  const problems = () => cols.map((c, i) => checkColumn(c, gens[i], info)).filter(Boolean);
  const make = n => generate({ cols, gens, info, count: n, nullPct: Math.max(0, Math.min(100, +nullPct.value || 0)), unique });
  const preview = () => {
    const p = problems();
    if (p.length) { status.className = 'dg-status err'; status.textContent = p[0]; return; }
    const g = make(8);
    if (!g.columns.length) { status.className = 'dg-status err'; status.textContent = 'Every column is left to the server: pick a generator for at least one.'; return; }
    previewBox.style.display = '';
    grid.setData(g.columns.map(n => ({ name: n, readOnly: true })), g.rows.map(r => r.map(toDisplay)));
    status.className = 'muted dg-status';
    status.textContent = 'A sample of what will be inserted. Values are made up each time.';
  };

  let running = false, stop = false;
  const stopBtn = h('button', { class: 'btn', disabled: true, onclick: () => { stop = true; stopBtn.disabled = true; status.textContent += ' – stopping after this batch…'; } }, 'Stop');

  const n = () => Math.max(1, Math.min(MAX_ROWS, Math.floor(+count.value || 0)));

  const insert = async ctx => {
    if (running) return false;
    const p = problems();
    if (p.length) { status.className = 'dg-status err'; status.textContent = p[0]; return false; }
    const total = n();
    const first = make(Math.min(total, 3));
    if (!first.columns.length) { status.className = 'dg-status err'; status.textContent = 'Every column is left to the server: pick a generator for at least one.'; return false; }
    const sample = insertStatements(db, table, first.columns, first.rows, BATCH)[0];
    if (!(await app.confirmChanges(sid, { action: `Insert ${fmtNum(total)} generated row(s) into ${db}.${table}`, statements: [sample + (total > 3 ? `\n… (${fmtNum(total)} rows in all)` : '')] }))) return false;
    running = true; stop = false;
    stopBtn.disabled = false;
    progress.style.display = '';
    for (const el of ctx.dialog.querySelectorAll('.modal-buttons button')) el.disabled = true;
    status.className = 'muted dg-status';
    const t0 = Date.now();
    let done = 0;
    try {
      while (done < total && !stop) {
        const size = Math.min(BATCH, total - done);
        const g = generate({ cols, gens, info, count: size, nullPct: +nullPct.value || 0, unique, runId: `${t0.toString(36).slice(-4)}${done.toString(36)}` });
        status.textContent = `Inserting rows ${fmtNum(done + 1)}–${fmtNum(done + size)} of ${fmtNum(total)}…`;
        bar.style.width = (done / total) * 100 + '%';
        await app.exec(sid, insertStatements(db, table, g.columns, g.rows, BATCH), db);
        done += size;
      }
      bar.style.width = '100%';
      const msg = `Inserted ${fmtNum(done)} row(s) into ${db}.${table} in ${((Date.now() - t0) / 1000).toFixed(1)} s${stop && done < total ? ' (stopped)' : ''}.`;
      app.setStatus(msg);
      refreshData();
      return { done };
    } catch (e) {
      status.className = 'dg-status err';
      status.textContent = `${done ? `Inserted ${fmtNum(done)} row(s), then: ` : ''}${e.message}`;
      if (done) refreshData();
      return false;
    } finally {
      running = false;
      stopBtn.disabled = true;
      progress.style.display = 'none';
      for (const el of ctx.dialog.querySelectorAll('.modal-buttons button')) el.disabled = false;
    }
  };

  const openSql = () => {
    const p = problems();
    if (p.length) { status.className = 'dg-status err'; status.textContent = p[0]; return false; }
    const total = n();
    if (total > MAX_SQL_ROWS) { status.className = 'dg-status err'; status.textContent = `Up to ${fmtNum(MAX_SQL_ROWS)} rows can be opened in a query tab; insert larger amounts directly.`; return false; }
    const g = make(total);
    if (!g.columns.length) { status.className = 'dg-status err'; status.textContent = 'Every column is left to the server: pick a generator for at least one.'; return false; }
    const sql = `-- ${fmtNum(total)} generated test row(s) for ${db}.${table}\n` + insertStatements(db, table, g.columns, g.rows, BATCH).map(s => s + ';').join('\n\n') + '\n';
    app.openQueryTab(sql, `Test data: ${table}`);
    return true;
  };

  const keyNote = (info.indexes || []).some(i => (i.type === 'UNIQUE' || i.type === 'PRIMARY') && i.columns.length > 1)
    ? h('div', { class: 'muted' }, 'This table has a unique key over several columns: generated combinations may repeat and be refused. Use sequences or a smaller number of rows if that happens.') : '';

  await modal({
    title: `Generate test data – ${db}.${table}`,
    width: 860,
    className: 'dg-dlg',
    body: h('div', { class: 'form2 dg' },
      h('div', { class: 'dg-top' },
        h('label', null, 'Rows to insert ', count),
        h('label', null, 'NULL in nullable columns ', nullPct, ' %'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn', onclick: preview }, 'Preview')),
      h('div', { class: 'dg-cols' }, h('table', { class: 'edit-table dg-table' },
        h('thead', null, h('tr', null, ['Column', 'Type', 'Generator', 'Options'].map(t => h('th', null, t)))), body)),
      keyNote,
      previewBox,
      h('div', { class: 'dg-foot' }, status, progress, stopBtn),
      h('div', { class: 'muted' }, `Foreign keys pick existing parent rows (up to 5,000 sampled). Values in single-column unique keys get a running suffix. Rows go in ${BATCH} per INSERT; a batch that fails stops the run, and batches already inserted stay.`)),
    onOpen: () => count.focus(),
    buttons: [
      { label: 'Open SQL in query tab', align: 'left', onClick: () => (openSql() ? true : false) },
      { label: 'Insert rows', primary: true, danger: true, onClick: insert },
      { label: 'Close', value: null },
    ],
  });
  stop = true; // closed during a run: finish the current batch, then stop
}
