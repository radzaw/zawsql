// CSV / Excel import wizard: 1. file and how to read it, 2. target table and column mapping, 3. options, then a
// batched import with progress. Parsing, conversion and inserting happen in the backend (Importer.cs).
import { h, fmtNum, fmtBytes, debounce, pickFile } from '../util.js';
import { post, del, upload } from '../api.js';
import { Grid } from '../grid.js';
import { modal } from '../dialogs.js';
import {
  DELIMITERS, QUOTES, DATE_ORDERS, MODES, COMMON_TYPES, tableNameFromFile, autoMap, buildTarget, fmtDuration,
} from '../importlogic.js';

const select = (pairs, value, onChange) => {
  const s = h('select', { class: 'inp' }, pairs.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  s.addEventListener('change', () => onChange(s.value));
  return s;
};
const field = (label, el, hint) => h('label', { class: 'frow' }, h('span', null, label), hint ? h('div', { class: 'imp-field' }, el, h('span', { class: 'muted' }, hint)) : el);
const check = (label, checked, onChange, attrs = {}) => {
  const c = h('input', { type: 'checkbox', checked, ...attrs });
  c.addEventListener('change', () => onChange(c.checked));
  return h('label', { class: 'chk' }, c, ' ' + label);
};

/** Opens the wizard; `table` preselects an existing table as the target. */
export async function importDialog(app, sid, db, table = null) {
  if (!sid) return app.showError(new Error('Connect to a server first.'));
  if (!app.canModify(sid)) return;
  const st = {
    step: 1, file: null, preview: null, previewError: '',
    source: { encoding: '', delimiter: '', quote: '"', header: true, skipRows: 0, sheet: '' },
    db: db || '', target: table ? 'existing' : 'new', table: table || '', newName: '', addId: false,
    tableColumns: [], columns: [],
    opts: { mode: 'insert', empty: 'auto', nullText: '\\N', decimalComma: false, dateOrder: '', stopOnError: true, transaction: false, truncate: false },
    optsTouched: { decimalComma: false, dateOrder: false },
    job: null, running: false, result: null,
  };
  let ctx;
  const steps = h('div', { class: 'imp-steps' });
  const content = h('div', { class: 'imp-content' });
  const left = h('div', { class: 'left' }), right = h('div', { class: 'right' });
  const root = h('div', { class: 'imp' }, steps, content, h('div', { class: 'imp-buttons' }, left, right));
  const button = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn }, label);

  // ---------------------------------------------------------------- step 1: file
  const grid = new Grid({ gutter: true, emptyText: 'Choose a CSV or Excel file.' });
  const fileInfo = h('div', { class: 'imp-file' });
  const sourceForm = h('div', { class: 'form2 cols2 imp-source' });
  const previewInfo = h('div', { class: 'imp-info muted' });
  const uploadBar = h('div', { class: 'progress-bar' });

  async function chooseFile(f) {
    f ??= await pickFile('.csv,.tsv,.txt,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (!f) return;
    if (st.file) del(`/import/${st.file.id}`, { quiet: true }).catch(() => {});
    st.file = null;
    st.preview = null;
    fileInfo.replaceChildren(h('span', null, `Uploading ${f.name} (${fmtBytes(f.size)})…`), h('div', { class: 'progress' }, uploadBar));
    try {
      st.file = await upload(`/import/upload?name=${encodeURIComponent(f.name)}`, f, { onProgress: p => { uploadBar.style.width = p * 100 + '%'; } });
    } catch (e) {
      fileInfo.textContent = '';
      return app.showError(e);
    }
    st.source = { encoding: '', delimiter: '', quote: '"', header: true, skipRows: 0, sheet: '' };
    st.newName = tableNameFromFile(f.name);
    st.optsTouched = { decimalComma: false, dateOrder: false };
    await loadPreview();
    render();
  }

  async function loadPreview(again = true) {
    if (!st.file) return;
    previewInfo.textContent = 'Reading…';
    try {
      st.preview = await post('/import/preview', {
        fileId: st.file.id, source: st.source, decimalComma: st.opts.decimalComma, dateOrder: st.opts.dateOrder || null,
      }, { quiet: true });
      st.previewError = '';
      // Adopt the suggested decimal separator and date order (unless chosen by hand), re-reading once so the
      // guessed column types use them.
      const p = st.preview;
      let changed = false;
      if (!st.optsTouched.decimalComma && p.suggestedDecimalComma !== st.opts.decimalComma) { st.opts.decimalComma = p.suggestedDecimalComma; changed = true; }
      if (!st.optsTouched.dateOrder && (p.suggestedDateOrder || '') !== st.opts.dateOrder) { st.opts.dateOrder = p.suggestedDateOrder || ''; changed = true; }
      if (changed && again) return loadPreview(false);
      resetColumns();
    } catch (e) {
      st.preview = null;
      st.previewError = e.message;
    }
    if (st.step === 1) renderFile();
  }
  const reloadSoon = debounce(() => loadPreview(), 300);

  function resetColumns() {
    const p = st.preview;
    st.columns = p.columns.map((c, i) => ({
      include: true, name: c.name, type: c.type, sample: c.sample, file: p.header[i] || c.name, target: null,
    }));
    if (st.tableColumns.length) applyAutoMap();
  }

  function applyAutoMap() {
    const targets = autoMap(st.columns.map(c => c.file), st.tableColumns.map(c => c.name), { header: st.source.header });
    st.columns.forEach((c, i) => { c.target = targets[i]; });
  }

  function renderFile() {
    const p = st.preview;
    fileInfo.replaceChildren(
      button(st.file ? 'Choose another file…' : 'Choose file…', () => chooseFile()),
      st.file ? h('span', null, h('b', null, st.file.name), ` · ${fmtBytes(st.file.size)} · ${st.file.kind === 'xlsx' ? 'Excel workbook' : 'text file'}`) : h('span', { class: 'muted' }, 'CSV, TSV, TXT or Excel .xlsx – or drop a file here'));
    const set = (k, v) => { st.source[k] = v; reloadSoon(); };
    const rows = [];
    if (st.file?.kind === 'xlsx') {
      rows.push(field('Worksheet:', select((p?.sheets || []).map(s => [s, s]), st.source.sheet || p?.sheets?.[0], v => set('sheet', v))));
    } else if (st.file) {
      const encs = [['', `Detect${p?.encoding ? ` (${p.encoding})` : ''}`], ...st.file.encodings.map(e => [e, e])];
      rows.push(field('Encoding:', select(encs, st.source.encoding, v => set('encoding', v)), 'Polish/Czech Excel CSV: windows-1250'));
      const delims = DELIMITERS.map(([v, l]) => [v, v === '' && p?.delimiter ? `Detect (${p.delimiter === '\t' ? 'Tab' : p.delimiter})` : l]);
      rows.push(field('Delimiter:', select(delims, st.source.delimiter, v => set('delimiter', v))));
      rows.push(field('Quotes:', select(QUOTES, st.source.quote, v => set('quote', v))));
    }
    if (st.file) {
      const skip = h('input', { class: 'inp', type: 'number', min: 0, value: st.source.skipRows, style: { width: '80px' } });
      skip.addEventListener('input', () => set('skipRows', Math.max(0, parseInt(skip.value, 10) || 0)));
      rows.push(field('Skip rows:', skip, 'before the header'));
      rows.push(field('', check('First row has column names', st.source.header, v => set('header', v))));
    }
    sourceForm.replaceChildren(...rows);
    if (st.previewError) previewInfo.textContent = st.previewError;
    else if (p) previewInfo.textContent = `${fmtNum(p.totalRows)}${p.complete ? '' : '+'} rows, ${p.columns.length} columns${p.rows.length < p.totalRows ? ` – showing the first ${p.rows.length}` : ''}`;
    else previewInfo.textContent = '';
    grid.setData(p ? p.columns.map((c, i) => ({ name: p.header[i] || c.name, readOnly: true, title: `${c.name}: ${c.type} (guessed)` })) : [], p ? p.rows : []);
  }

  // ---------------------------------------------------------------- step 2: target and columns
  const targetForm = h('div', { class: 'form2 imp-target' });
  const mapWrap = h('div', { class: 'imp-map-wrap' });

  async function loadTableColumns() {
    st.tableColumns = st.target === 'existing' && st.db && st.table ? await app.getColumns(sid, st.db, st.table) : [];
    if (st.target === 'existing') applyAutoMap();
  }

  async function renderTarget() {
    const dbs = await app.getDatabases(sid);
    if (!st.db) st.db = dbs[0] || '';
    const tables = st.db ? (await app.getObjects(sid, st.db)).filter(o => o.type === 'table').map(o => o.name) : [];
    if (st.target === 'existing' && !tables.includes(st.table)) st.table = tables[0] || '';
    if (st.target === 'existing' && !st.tableColumns.length && st.table) await loadTableColumns();
    const radio = (value, label) => {
      const r = h('input', { type: 'radio', name: 'imp-target', checked: st.target === value });
      r.addEventListener('change', async () => { st.target = value; await loadTableColumns(); renderTarget(); });
      return h('label', { class: 'chk' }, r, ' ' + label);
    };
    const tableSel = select(tables.map(t => [t, t]), st.table, async v => { st.table = v; await loadTableColumns(); renderTarget(); });
    const nameInp = h('input', { class: 'inp', value: st.newName, spellcheck: false, style: { width: '260px' } });
    nameInp.addEventListener('input', () => { st.newName = nameInp.value.trim(); });
    const fileHasId = st.columns.some(c => c.include && c.name.toLowerCase() === 'id');
    targetForm.replaceChildren(
      field('Database:', select(dbs.map(d => [d, d]), st.db, async v => { st.db = v; st.tableColumns = []; renderTarget(); })),
      field('Import into:', h('div', { class: 'imp-radios' }, radio('new', 'a new table'), radio('existing', 'an existing table'))),
      st.target === 'new'
        ? field('Table name:', h('div', { class: 'imp-field' }, nameInp,
          check('Add an auto-increment id column', st.addId && !fileHasId, v => { st.addId = v; }, { disabled: fileHasId, title: fileHasId ? 'The file already has an "id" column.' : '' })))
        : field('Table:', tables.length ? tableSel : h('span', { class: 'muted' }, 'This database has no tables.')));
    renderMapping();
  }

  function renderMapping() {
    const cols = st.columns;
    let table;
    if (st.target === 'new') {
      const dl = h('datalist', { id: 'imp-types' }, COMMON_TYPES.map(t => h('option', { value: t })));
      table = h('table', { class: 'edit-table imp-map' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'File column'), h('th', null, 'Sample'), h('th', null, 'Column name'), h('th', null, 'Type'))),
        h('tbody', null, cols.map(c => {
          const inc = h('input', { type: 'checkbox', checked: c.include });
          const name = h('input', { class: 'inp cell-inp', value: c.name, spellcheck: false, disabled: !c.include });
          const type = h('input', { class: 'inp cell-inp', value: c.type, list: 'imp-types', spellcheck: false, disabled: !c.include });
          inc.addEventListener('change', () => { c.include = inc.checked; name.disabled = type.disabled = !inc.checked; });
          name.addEventListener('input', () => { c.name = name.value; });
          type.addEventListener('input', () => { c.type = type.value; });
          return h('tr', { class: c.include ? '' : 'off' }, h('td', null, inc), h('td', null, c.file), h('td', { class: 'muted imp-sample', title: c.sample ?? '' }, c.sample ?? ''), h('td', null, name), h('td', null, type));
        })), dl);
    } else {
      const options = [['', '— skip —'], ...st.tableColumns.map(t => [t.name, `${t.name}  (${t.type})`])];
      table = h('table', { class: 'edit-table imp-map' },
        h('thead', null, h('tr', null, h('th', null, 'File column'), h('th', null, 'Sample'), h('th', null, ''), h('th', null, 'Table column'))),
        h('tbody', null, cols.map(c => h('tr', { class: c.target ? '' : 'off' },
          h('td', null, c.file), h('td', { class: 'muted imp-sample', title: c.sample ?? '' }, c.sample ?? ''), h('td', { class: 'muted' }, '→'),
          h('td', null, select(options, c.target || '', v => { c.target = v || null; renderMapping(); }))))));
    }
    const mapped = st.target === 'new' ? cols.filter(c => c.include).length : cols.filter(c => c.target).length;
    mapWrap.replaceChildren(h('div', { class: 'imp-map-head' }, h('b', null, 'Columns'), h('span', { class: 'muted' }, `${mapped} of ${cols.length} imported`),
      st.target === 'existing' ? button('Match by name', () => { applyAutoMap(); renderMapping(); }) : null), h('div', { class: 'imp-map-scroll' }, table));
  }

  // ---------------------------------------------------------------- step 3: options
  const optForm = h('div', { class: 'form2 imp-opts' });
  const sqlPreview = h('pre', { class: 'code-preview imp-sql' });

  function targetPayload() {
    const t = buildTarget({ target: st.target, columns: st.columns, addId: st.addId });
    const table = st.target === 'new' ? st.newName : st.table;
    if (!table) throw new Error(st.target === 'new' ? 'Enter a name for the new table.' : 'Choose a table.');
    return {
      fileId: st.file.id, source: st.source, db: st.db, table, create: t.create, addId: st.target === 'new' && st.addId, mapping: t.mapping,
      ...st.opts, truncate: st.target === 'existing' && st.opts.truncate, dateOrder: st.opts.dateOrder || null,
    };
  }

  const refreshSql = debounce(async () => {
    try {
      const r = await post(`/s/${sid}/import/start`, { ...targetPayload(), dryRun: true }, { quiet: true });
      sqlPreview.textContent = [r.createSql && r.createSql + ';', r.truncateSql && r.truncateSql + ';', r.insertSql ? r.insertSql + ';' : '-- the file has no data rows'].filter(Boolean).join('\n\n');
      sqlPreview.classList.remove('err');
    } catch (e) {
      sqlPreview.textContent = e.message;
      sqlPreview.classList.add('err');
    }
  }, 250);

  function renderOptions() {
    const o = st.opts;
    const set = (k, v) => { o[k] = v; if (k in st.optsTouched) { st.optsTouched[k] = true; } refreshSql(); };
    const nullInp = h('input', { class: 'inp', value: o.nullText, spellcheck: false, style: { width: '80px' } });
    nullInp.addEventListener('input', () => set('nullText', nullInp.value));
    const errors = h('div', { class: 'imp-radios' }, ...[[true, 'Stop at the first error'], [false, 'Skip failing rows and continue']].map(([v, l]) => {
      const r = h('input', { type: 'radio', name: 'imp-errors', checked: o.stopOnError === v });
      r.addEventListener('change', () => set('stopOnError', v));
      return h('label', { class: 'chk' }, r, ' ' + l);
    }));
    optForm.replaceChildren(...[
      st.target === 'existing' ? field('Existing keys:', select(MODES, o.mode, v => set('mode', v)), 'rows whose primary/unique key is already in the table') : null,
      field('Empty cells:', select([['auto', 'NULL, except in text columns'], ['null', 'Always NULL'], ['empty', 'Always empty / zero']], o.empty, v => set('empty', v))),
      field('NULL marker:', nullInp, 'cells with exactly this text become NULL'),
      field('Decimal separator:', select([[false, 'Point (1234.56)'], [true, 'Comma (1234,56)']], o.decimalComma, v => set('decimalComma', v === 'true'))),
      field('Dates:', select(DATE_ORDERS, o.dateOrder, v => set('dateOrder', v))),
      field('Errors:', errors),
      field('', check('All or nothing: one transaction, rolled back on error or cancel', o.transaction, v => set('transaction', v))),
      st.target === 'existing' ? field('', h('span', { class: 'imp-danger' }, check('Empty the table first', o.truncate, v => set('truncate', v)))) : null,
    ].filter(Boolean));
    refreshSql();
  }

  // ---------------------------------------------------------------- run
  const bar = h('div', { class: 'progress-bar' });
  const runLabel = h('div', { class: 'imp-run-label' });
  const errList = h('div', { class: 'imp-errors' });
  const runStats = h('div', { class: 'imp-stats' });
  let errorsShown = 0, cancelRequested = false;

  function addMessages(list, kind) {
    for (const e of list) {
      if (errorsShown >= 200) return;
      errorsShown++;
      errList.append(h('div', { class: 'imp-err ' + kind }, h('span', { class: 'imp-row' }, `row ${fmtNum(e.row)}`), h('span', null, e.message)));
    }
  }

  async function runImport() {
    let payload;
    try { payload = targetPayload(); } catch (e) { return app.showError(e); }
    let preview;
    try { preview = await post(`/s/${sid}/import/start`, { ...payload, dryRun: true }, { quiet: true }); } catch (e) { return app.showError(e); }
    const stmts = [preview.createSql, preview.truncateSql, preview.insertSql].filter(Boolean);
    if (!(await app.confirmChanges(sid, { action: `Import ${st.file.name} into ${st.db}.${payload.table}`, statements: stmts }))) return;

    st.step = 4;
    st.running = true;
    cancelRequested = false;
    errorsShown = 0;
    errList.replaceChildren();
    render();
    const t0 = Date.now();
    let r = null;
    try {
      const s = await post(`/s/${sid}/import/start`, payload);
      st.job = s.jobId;
      runLabel.textContent = `Importing ${fmtNum(s.total)} rows…`;
      while (!cancelRequested) {
        r = await post(`/s/${sid}/import/step`, { jobId: st.job, rows: 5000 });
        addMessages(r.errors, 'error');
        addMessages(r.warningSamples, 'warning');
        const pct = r.total ? Math.min(100, (r.processed / r.total) * 100) : 100;
        bar.style.width = pct + '%';
        const eta = r.processed && !r.done ? ` · about ${fmtDuration(((Date.now() - t0) / r.processed) * (r.total - r.processed))} left` : '';
        runLabel.textContent = `${fmtNum(r.processed)} of ${fmtNum(r.total)} rows${eta}`;
        runStats.textContent = `${fmtNum(r.affected)} rows affected · ${fmtNum(r.errorCount)} errors · ${fmtNum(r.warnings)} warnings`;
        if (r.done) break;
      }
      if (cancelRequested && !r?.done) {
        await post(`/s/${sid}/import/cancel`, { jobId: st.job }).catch(() => {});
        runLabel.textContent = payload.transaction ? 'Cancelled – nothing was imported (rolled back).' : `Cancelled after ${fmtNum(r?.processed ?? 0)} rows.`;
      } else if (r.failed) {
        runLabel.textContent = r.rolledBack ? 'Stopped at an error – everything was rolled back.' : `Stopped at an error after ${fmtNum(r.processed - 1)} rows.`;
      } else runLabel.textContent = `Done: ${fmtNum(r.processed)} rows read in ${fmtDuration(Date.now() - t0)}.`;
      st.result = { ok: !cancelRequested && !r.failed, table: payload.table };
      app.log.info(`Import of ${st.file.name} into ${st.db}.${payload.table}: ${runLabel.textContent} ${runStats.textContent}`);
    } catch (e) {
      runLabel.textContent = 'The import failed: ' + e.message;
      st.result = { ok: false, table: payload.table };
    }
    st.job = null;
    st.running = false;
    bar.classList.toggle('done', !!st.result?.ok);
    if (payload.create || st.result?.ok) await app.refreshDb(sid, st.db).catch(() => {});
    render();
  }

  // ---------------------------------------------------------------- frame
  async function go(step) {
    if (step === 2 && !st.preview) return app.showError(new Error(st.previewError || 'Choose a file first.'));
    if (step === 3) {
      try { buildTarget({ target: st.target, columns: st.columns, addId: st.addId }); } catch (e) { return app.showError(e); }
      if (st.target === 'new' && !st.newName) return app.showError(new Error('Enter a name for the new table.'));
      if (st.target === 'existing' && !st.table) return app.showError(new Error('Choose a table.'));
    }
    st.step = step;
    await render();
  }

  async function render() {
    const names = ['File', 'Target & columns', 'Options'];
    steps.replaceChildren(...names.map((n, i) => h('div', { class: 'imp-step' + (st.step === i + 1 ? ' active' : st.step > i + 1 ? ' done' : '') }, h('span', { class: 'imp-num' }, String(i + 1)), n)));
    left.replaceChildren();
    right.replaceChildren();
    if (st.step === 1) {
      content.replaceChildren(fileInfo, sourceForm, previewInfo, h('div', { class: 'imp-grid' }, grid.el));
      renderFile();
      right.append(button('Next', () => go(2), 'primary'), button('Cancel', () => ctx.close()));
    } else if (st.step === 2) {
      content.replaceChildren(targetForm, mapWrap);
      await renderTarget();
      left.append(button('Back', () => go(1)));
      right.append(button('Next', () => go(3), 'primary'), button('Cancel', () => ctx.close()));
    } else if (st.step === 3) {
      content.replaceChildren(optForm, h('div', { class: 'imp-sql-head' }, h('b', null, 'SQL'), h('span', { class: 'muted' }, ' – the first rows, as they will be sent')), sqlPreview);
      renderOptions();
      left.append(button('Back', () => go(2)));
      right.append(button(`Import ${fmtNum(st.preview.totalRows)} rows`, () => runImport(), 'primary'), button('Cancel', () => ctx.close()));
    } else {
      content.replaceChildren(h('div', { class: 'imp-run' }, runLabel, h('div', { class: 'progress' }, bar), runStats, errList));
      if (st.running) right.append(button('Stop', () => { cancelRequested = true; runLabel.textContent = 'Stopping…'; }));
      else {
        if (st.result?.table) right.append(button('Open table', () => { ctx.close(); app.selectObject(sid, st.db, st.result.table, 'table', { tab: 'data' }); }, 'primary'));
        left.append(button('Back to options', () => { bar.style.width = '0'; bar.classList.remove('done'); runStats.textContent = ''; go(3); }));
        right.append(button('Close', () => ctx.close()));
      }
    }
  }

  // Drop a file anywhere on the wizard.
  root.addEventListener('dragover', e => { if (st.step === 1 && !st.running) { e.preventDefault(); root.classList.add('drop'); } });
  root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) root.classList.remove('drop'); });
  root.addEventListener('drop', e => {
    root.classList.remove('drop');
    if (st.step !== 1 || !e.dataTransfer.files.length) return;
    e.preventDefault();
    chooseFile(e.dataTransfer.files[0]);
  });

  const done = modal({
    title: 'Import CSV / Excel',
    width: 980,
    className: 'import-wizard',
    buttons: [],
    body: c => { ctx = c; return root; },
    onOpen: () => render(),
  });
  await done;
  // Closing the wizard stops a running import (rolled back when all-or-nothing) and removes the uploaded copy.
  cancelRequested = true;
  if (st.job) await post(`/s/${sid}/import/cancel`, { jobId: st.job }, { quiet: true }).catch(() => {});
  if (st.file) del(`/import/${st.file.id}`, { quiet: true }).catch(() => {});
}
