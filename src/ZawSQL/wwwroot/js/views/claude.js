// "Ask Claude": writes SQL from a description with the Claude Code command line (the user's own subscription).
import { h, esc, fmtElapsed } from '../util.js';
import { post } from '../api.js';
import { modal } from '../dialogs.js';
import { highlightSql } from '../editor.js';
import { answerBlocks, inlineParts } from '../claudelogic.js';

/** The last requests, newest first, offered again in the dialog. */
const RECENT_MAX = 15;

/**
 * Asks for a description, sends it to Claude Code with the database's schema (and the editor's SQL, if wanted), and
 * puts the answer into the editor: in place of the selection or the whole text it was asked to change, otherwise at
 * the caret. Nothing is run. One undo step takes it back.
 */
export async function askClaudeDialog(app, view) {
  const { sid, db } = app.sel;
  if (!sid) return app.showError(new Error('Not connected. Open a session first.'));
  const ed = view.editor;
  const sel = ed.selection();
  const hasSel = sel.start !== sel.end;
  const editorText = hasSel ? sel.text : ed.value;

  const recent = app.state.claudeRecent || [];
  const prompt = h('textarea', { class: 'inp', rows: 5, spellcheck: true, placeholder: 'e.g. Customers who ordered more than 3 times in the last 30 days, with their total spent, highest first' });
  const recentSel = recent.length
    ? h('select', { class: 'inp', onchange: () => { if (recentSel.value) { prompt.value = recentSel.value; prompt.focus(); } recentSel.value = ''; } },
      h('option', { value: '' }, 'Recent requests…'), recent.map(t => h('option', { value: t }, t.length > 90 ? t.slice(0, 90) + '…' : t)))
    : null;
  const schema = h('input', { type: 'checkbox', checked: !!db, disabled: !db });
  const withSql = h('input', { type: 'checkbox', checked: hasSel, disabled: !editorText.trim() });
  const status = h('div', { class: 'muted claude-status' }, 'Uses the Claude Code command line and your Claude subscription. The SQL goes into the editor; nothing is run.');
  let ctl = null, timer = null;

  const result = await modal({
    title: 'Ask Claude to write SQL',
    width: 560,
    body: h('div', { class: 'form2 claude-dlg' },
      h('div', null, 'Describe the query:'),
      prompt,
      recentSel,
      h('label', { class: 'chk', title: 'Table and column names, types and keys – never row data' }, schema, db ? ` Include the schema of ${db} (names and types, no data)` : ' Include the schema (select a database first)'),
      h('label', { class: 'chk' }, withSql, hasSel ? ' Change the selected SQL (it is replaced)' : " Change the editor's SQL (it is replaced)"),
      status),
    onOpen: ctx => {
      prompt.focus();
      // Ctrl+Enter sends (Enter adds a line in the description).
      prompt.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ctx.dialog.querySelector('.modal-buttons .primary')?.click(); }
      });
    },
    buttons: [{
      label: 'Write SQL', primary: true, onClick: async () => {
        const text = prompt.value.trim();
        if (!text) { prompt.focus(); return false; }
        ctl = new AbortController();
        const t0 = Date.now();
        status.className = 'muted claude-status';
        status.textContent = 'Claude is writing…';
        timer = setInterval(() => { status.textContent = `Claude is writing… ${fmtElapsed(Date.now() - t0)}`; }, 500);
        prompt.disabled = true;
        try {
          const r = await post(`/s/${sid}/claude/sql`, {
            prompt: text,
            database: db,
            sql: withSql.checked ? editorText : null,
            schema: schema.checked,
            model: app.prefs.claudeModel || null,
            claudePath: app.prefs.claudePath || null,
          }, { signal: ctl.signal });
          remember(app, text);
          return { ...r, replace: withSql.checked };
        } catch (e) {
          if (e.name === 'AbortError') return false;
          status.className = 'claude-status err';
          status.textContent = e.message;
          return false;
        } finally {
          clearInterval(timer);
          prompt.disabled = false;
          ctl = null;
        }
      },
    }, { label: 'Cancel', value: null }],
  });
  // Closed while Claude was still writing: stop the claude process too.
  ctl?.abort();
  clearInterval(timer);
  if (!result?.sql) return;

  const sql = result.sql.trim();
  if (result.replace) {
    if (hasSel) ed.selectRange(sel.start, sel.end);
    else ed.selectRange(0, ed.value.length);
    ed.insert(sql);
  } else {
    // At the caret, on lines of its own.
    const v = ed.value, at = ed.selection().start;
    const before = at > 0 && v[at - 1] !== '\n' ? '\n\n' : '';
    const after = at < v.length && v[at] !== '\n' ? '\n' : '';
    ed.insert(before + sql + after);
  }
  app.setStatus(`Claude wrote the SQL${result.durationMs ? ` in ${(result.durationMs / 1000).toFixed(1)} s` : ''}. Review it before running.`);
}

/**
 * "Ask Claude to explain": a failed statement (req.kind 'error') or a query plan ('plan'). Opens at once and asks;
 * the answer is shown as text, with its suggested SQL (if any) offered to put into the editor via `onUseSql(sql)`.
 * A follow-up question asks again with the same material. Nothing is run.
 */
export function explainWithClaude(app, { sid, db, req, onUseSql }) {
  if (!sid) return app.showError(new Error('Not connected. Open a session first.'));
  const plan = req.kind === 'plan';
  const status = h('div', { class: 'muted claude-status' });
  const answerEl = h('div', { class: 'claude-answer' });
  const useBtn = h('button', { class: 'btn primary', style: { display: 'none' } }, plan ? 'Open suggested SQL in the editor' : 'Put the fix in the editor');
  const copyBtn = h('button', { class: 'btn', style: { display: 'none' } }, 'Copy answer');
  const question = h('input', { class: 'inp', placeholder: 'Ask a follow-up question (Enter)', spellcheck: true });
  const askBtn = h('button', { class: 'btn' }, 'Ask');
  const schema = h('input', { type: 'checkbox', checked: true });
  const what = plan ? 'the statement, its plan and the definitions of its tables' : `the statement, the error message${db ? ` and the table and column names of ${db}` : ''}`;
  let ctl = null, timer = null, last = null, closed = false;

  const ask = async q => {
    ctl?.abort();
    const mine = (ctl = new AbortController());
    const t0 = Date.now();
    status.className = 'muted claude-status';
    status.textContent = 'Claude is reading…';
    clearInterval(timer);
    timer = setInterval(() => { status.textContent = `Claude is reading… ${fmtElapsed(Date.now() - t0)}`; }, 500);
    askBtn.disabled = question.disabled = true;
    try {
      const r = await post(`/s/${sid}/claude/explain`, {
        ...req, database: db || null, schema: schema.checked, question: q || null,
        model: app.prefs.claudeModel || null, claudePath: app.prefs.claudePath || null,
      }, { signal: mine.signal });
      if (closed || mine !== ctl) return;
      last = r;
      renderAnswer(answerEl, r.answer);
      status.textContent = `Answered in ${fmtElapsed(r.durationMs ?? Date.now() - t0)}${q ? ` – follow-up: ${q}` : ''}. Check it before acting on it.`;
      useBtn.style.display = r.sql && onUseSql ? '' : 'none';
      copyBtn.style.display = '';
      question.value = '';
    } catch (e) {
      if (e.name === 'AbortError' || closed) return;
      status.className = 'claude-status err';
      status.textContent = e.message;
    } finally {
      if (mine === ctl) {
        clearInterval(timer);
        askBtn.disabled = question.disabled = false;
        ctl = null;
        if (!closed) question.focus();
      }
    }
  };
  askBtn.onclick = () => ask(question.value.trim());
  question.addEventListener('keydown', e => { if (e.key === 'Enter' && question.value.trim()) { e.preventDefault(); ask(question.value.trim()); } });
  schema.onchange = () => ask(question.value.trim());
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(last?.answer ?? ''); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy answer'; }, 1500); } catch { /* clipboard denied */ }
  };

  const done = modal({
    title: plan ? 'Claude explains the plan' : 'Claude explains the error',
    width: 680,
    className: 'claude-explain-dlg',
    body: ctx => {
      useBtn.onclick = () => { if (last?.sql) { onUseSql(last.sql); ctx.close(); } };
      return h('div', { class: 'form2 claude-dlg' },
        h('div', { class: 'claude-what muted' }, `Sends ${what} to Claude Code (your Claude subscription). No row data is sent, and nothing is run.`),
        h('label', { class: 'chk', title: plan ? 'CREATE TABLE of each table in the plan: columns, types and indexes' : 'Table and column names, types and keys' },
          schema, plan ? ' Include the table definitions (columns and indexes)' : ' Include the schema (names and types)'),
        answerEl, status,
        h('div', { class: 'claude-follow' }, question, askBtn),
        h('div', { class: 'claude-actions' }, useBtn, copyBtn));
    },
    buttons: [{ label: 'Close', value: null }],
  });
  ask('');
  return done.then(() => { closed = true; ctl?.abort(); clearInterval(timer); });
}

function renderAnswer(el, text) {
  const inline = s => inlineParts(s).map(p => (p.code ? h('code', null, p.text) : p.text));
  el.replaceChildren(...answerBlocks(text).map(b =>
    b.type === 'code' ? h('pre', { class: 'claude-code mono', html: b.lang === 'sql' || b.lang === 'mysql' || !b.lang ? highlightSql(b.text) : esc(b.text) })
      : b.type === 'ul' ? h('ul', null, b.items.map(t => h('li', null, ...inline(t))))
        : h('p', null, ...inline(b.text))));
}

function remember(app, text) {
  app.state.claudeRecent = [text, ...(app.state.claudeRecent || []).filter(t => t !== text)].slice(0, RECENT_MAX);
  app.saveStateSoon();
}
