// The "Query parameters" dialog: asks for the values of :name placeholders before a query tab runs its statements.
import { h } from '../util.js';
import { modal } from '../dialogs.js';
import { PARAM_TYPES, paramNames, bindParams, literal, guessType, rememberParams } from '../queryparams.js';

let listId = 0;

/**
 * Statements with their parameters filled in, or the statements unchanged when they have none. Resolves to null when
 * the user cancels. Each statement object keeps its other fields (positions in the editor); only `sql` changes.
 */
export async function fillParams(app, stmts, { action = 'Run' } = {}) {
  const sqls = stmts.map(s => s.sql);
  const names = paramNames(sqls);
  if (!names.length) return stmts;
  const store = app.state.params || {};

  const preview = h('pre', { class: 'qp-preview' });
  const rows = names.map(name => {
    const saved = store[name];
    const type = h('select', { class: 'inp qp-type' }, PARAM_TYPES.map(([v, l]) => h('option', { value: v }, l)));
    type.value = guessType(sqls, name, saved);
    const id = `qp-list-${++listId}`;
    const input = h('input', { class: 'inp qp-value', value: saved?.value ?? '', spellcheck: false, list: id, autocomplete: 'off' });
    const list = h('datalist', { id }, (saved?.recent ?? []).map(v => h('option', { value: v })));
    const err = h('div', { class: 'qp-err' });
    const sync = () => {
      input.disabled = type.value === 'null';
      input.placeholder = { text: 'text, quoted for you', number: 'e.g. 42 or 3.5', null: '', sql: 'e.g. 1, 2, 3 or NOW()' }[type.value];
      update();
    };
    type.addEventListener('change', sync);
    input.addEventListener('input', () => update());
    return { name, type, input, list, err, sync };
  });
  const values = () => Object.fromEntries(rows.map(r => [r.name, { type: r.type.value, value: r.input.value }]));

  function update(final = false) {
    let ok = true;
    for (const r of rows) {
      try {
        literal(r.type.value, r.input.value);
        r.err.textContent = '';
      } catch (e) {
        r.err.textContent = r.input.value === '' && !final ? '' : e.message;
        ok = false;
      }
    }
    // Shows what will run; empty number fields show the placeholder itself.
    const v = values();
    const shown = sqls.filter(s => paramNames([s]).length).slice(0, 3).map(s => {
      try { return bindParams(s, v); } catch { return s; }
    }).join(';\n');
    preview.textContent = shown.length > 2000 ? shown.slice(0, 2000) + '…' : shown;
    return ok;
  }

  for (const r of rows) r.sync();
  const bound = await modal({
    title: names.length === 1 ? `Query parameter :${names[0]}` : `Query parameters (${names.length})`,
    width: 620,
    className: 'qp-dialog',
    body: h('div', { class: 'qp' },
      h('div', { class: 'qp-grid' },
        h('span', { class: 'muted' }, 'Parameter'), h('span', { class: 'muted' }, 'Type'), h('span', { class: 'muted' }, 'Value'),
        ...rows.flatMap(r => [h('code', { class: 'qp-name' }, `:${r.name}`), r.type, h('div', null, r.input, r.list, r.err)])),
      h('div', { class: 'muted qp-hint' }, 'Text values are quoted and escaped. "SQL as written" inserts the value unchanged, for lists like 1, 2, 3 or expressions.'),
      preview),
    buttons: [
      {
        label: action, primary: true, onClick: () => {
          if (!update(true)) {
            rows.find(r => r.err.textContent || (r.type.value !== 'null' && r.input.value === ''))?.input.focus();
            return false;
          }
          const v = values();
          app.state.params = rememberParams(store, v);
          app.saveStateSoon();
          return stmts.map(s => ({ ...s, sql: bindParams(s.sql, v) }));
        },
      },
      { label: 'Cancel', value: null },
    ],
  });
  return bound ?? null;
}
