// Self-update: "Check for updates" dialog (release notes, download with progress, restart into the new version)
// and the once-a-day automatic check that shows a notice in the status bar.
import { h } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { modal, confirmDlg } from '../dialogs.js';
import { shouldAutoCheck, worthTelling, renderNotes, progressText } from '../updatelogic.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Checks quietly (once a day) and shows a status-bar notice when a newer version exists. */
export async function autoCheckUpdates(app) {
  const updates = (app.state.updates ||= {});
  if (!shouldAutoCheck(app.prefs, updates)) return showNotice(app, updates.found);
  try {
    const r = await post('/update/check', {}, { quiet: true });
    updates.lastCheck = Date.now();
    updates.found = worthTelling(r, updates) ? r.latest : null;
    app.saveStateSoon();
    showNotice(app, updates.found);
  } catch { /* offline, rate-limited or no release yet: try again tomorrow */ }
}

function showNotice(app, version) {
  const el = app.sbUpdate;
  if (!el) return;
  const current = app.version?.version;
  el.style.display = version && version !== current && version !== app.state.updates?.skipped ? '' : 'none';
  el.innerHTML = `${icon('next')}<span>ZawSQL ${version} is available</span>`;
  el.onclick = () => updateDialog(app);
}

/** Help › Check for updates: release notes, then download, verify and restart. */
export async function updateDialog(app) {
  const body = h('div', { class: 'upd' }, h('div', { class: 'muted' }, 'Checking for updates…'));
  const buttons = h('div', { class: 'upd-buttons' });
  let ctx;
  const done = modal({ title: 'Check for updates', width: 560, className: 'upd-dialog', buttons: [], body: c => { ctx = c; return h('div', null, body, buttons); } });

  let r;
  try {
    r = await post('/update/check', {}, { quiet: true });
    (app.state.updates ||= {}).lastCheck = Date.now();
  } catch (e) {
    body.replaceChildren(h('div', { class: 'upd-line' }, h('span', { html: icon('warning') }), h('span', null, `The update check failed: ${e.message}`)),
      h('div', { class: 'muted' }, `You are running ZawSQL ${app.version?.version ?? ''}.`));
    buttons.replaceChildren(h('button', { class: 'btn', onclick: () => ctx.close() }, 'Close'));
    return done;
  }

  const page = r.page ? h('button', { class: 'btn', onclick: () => window.open(r.page, '_blank', 'noopener') }, 'Open release page') : '';
  if (!r.newer) {
    app.state.updates.found = null;
    showNotice(app, null);
    body.replaceChildren(h('div', { class: 'upd-line' }, h('span', { html: icon('check') }), h('b', null, `ZawSQL ${r.current} is up to date.`)),
      h('div', { class: 'muted' }, `The latest release is ${r.latest}${r.published ? `, published ${new Date(r.published).toLocaleDateString()}` : ''}.`));
    buttons.replaceChildren(page, h('button', { class: 'btn primary', onclick: () => ctx.close() }, 'Close'));
    app.saveStateSoon();
    return done;
  }

  const progress = h('div', { class: 'progress' }, h('div', { class: 'progress-bar' }));
  const status = h('div', { class: 'muted upd-status' });
  progress.style.display = 'none';
  body.replaceChildren(
    h('div', { class: 'upd-line' }, h('span', { html: icon('next') }), h('b', null, `ZawSQL ${r.latest} is available`), h('span', { class: 'muted' }, `– you have ${r.current}`)),
    r.published ? h('div', { class: 'muted' }, `Published ${new Date(r.published).toLocaleDateString()}${r.asset ? ` · ${(r.asset.size / 1048576).toFixed(0)} MB download` : ''}`) : '',
    h('div', { class: 'upd-notes', html: renderNotes(r.notes) || '<p class="muted">No release notes.</p>' }),
    r.canInstall ? '' : h('div', { class: 'upd-line' }, h('span', { html: icon('info') }), h('span', null, r.reason)),
    progress, status);

  const skip = h('button', { class: 'btn', title: "Don't announce this version again", onclick: () => {
    app.state.updates.skipped = r.latest;
    app.state.updates.found = null;
    app.saveStateSoon();
    showNotice(app, null);
    ctx.close();
  } }, 'Skip this version');
  const install = h('button', { class: 'btn primary', disabled: !r.canInstall }, 'Download and install');
  install.onclick = () => download(app, r, { install, skip, progress, status, buttons, ctx });
  buttons.replaceChildren(skip, h('div', { class: 'grow' }), page, install, h('button', { class: 'btn', onclick: () => ctx.close() }, 'Later'));
  return done;
}

async function download(app, r, ui) {
  ui.install.disabled = ui.skip.disabled = true;
  ui.progress.style.display = '';
  const bar = ui.progress.firstChild;
  let s;
  try {
    await post('/update/download', {}, { quiet: true });
    for (;;) {
      s = await get('/update/status', null, { quiet: true });
      bar.style.width = s.total ? `${(s.received / s.total) * 100}%` : '0';
      ui.status.textContent = s.state === 'downloading' ? `Downloading… ${progressText(s.received, s.total)}` : '';
      if (s.state === 'error') throw new Error(s.error);
      if (s.state === 'ready') break;
      await sleep(300);
    }
  } catch (e) {
    ui.status.textContent = '';
    ui.progress.style.display = 'none';
    ui.install.disabled = ui.skip.disabled = false;
    return app.showError(e);
  }
  bar.style.width = '100%';
  ui.status.textContent = `Downloaded and verified (SHA-256${s.signer ? `, signed by ${s.signer}` : ''}). ZawSQL restarts into version ${r.latest}.`;
  ui.install.textContent = 'Restart now';
  ui.install.disabled = false;
  ui.install.onclick = () => restart(app, r, ui);
}

async function restart(app, r, ui) {
  const open = app.conns.size;
  if (open && !(await confirmDlg(`Restart ZawSQL ${r.latest} now? ${open} open connection${open === 1 ? ' is' : 's are'} closed; query tabs, saved queries and settings are kept.`, { ok: 'Restart now' }))) return;
  await app.saveState();
  ui.install.disabled = true;
  ui.status.textContent = 'Restarting…';
  try {
    await post('/update/install', {}, { quiet: true });
  } catch (e) {
    ui.install.disabled = false;
    return app.showError(e);
  }
  // The new version takes over this port and token; reload once it answers.
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    await sleep(500);
    try {
      const v = await get('/version', null, { quiet: true });
      if (v.version === r.latest) { location.reload(); return; }
    } catch { /* not up yet */ }
  }
  ui.status.textContent = `ZawSQL ${r.latest} didn't start within a minute. Close this window and start ZawSQL again.`;
}
