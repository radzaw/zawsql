// Modal dialogs and context menus.
import { h } from './util.js';
import { icon } from './icons.js';

const stack = [];

/**
 * Shows a modal dialog. Resolves with the clicked button's `value` (or the value returned by its
 * `onClick`), or `closeValue` when dismissed. `onClick` returning false keeps the dialog open.
 */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], width = 420, className = '', onOpen, closeValue = null }) {
  return new Promise(resolve => {
    const bg = h('div', { class: 'modal-bg' });
    const titleEl = h('div', { class: 'modal-title' }, h('span', null, title), h('button', { class: 'modal-x', title: 'Close', onclick: () => close(closeValue) }, '×'));
    const bodyEl = h('div', { class: 'modal-body' });
    const left = h('div', { class: 'left' }), right = h('div', { class: 'right' });
    const dlg = h('div', { class: 'modal ' + className, style: { width: typeof width === 'number' ? width + 'px' : width } },
      titleEl, bodyEl, buttons.length ? h('div', { class: 'modal-buttons' }, left, right) : null);
    bg.append(dlg);
    const prevFocus = document.activeElement;
    let closed = false;

    function close(v) {
      if (closed) return;
      closed = true;
      bg.remove();
      stack.splice(stack.indexOf(bg), 1);
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.({ preventScroll: true });
      resolve(v);
    }

    const ctx = { close, dialog: dlg, body: bodyEl };
    const content = typeof body === 'function' ? body(ctx) : body;
    if (typeof content === 'string') bodyEl.append(h('div', { class: 'modal-msg' }, content));
    else if (content) bodyEl.append(content);

    let primary = null;
    for (const b of buttons) {
      const el = h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '') }, b.label);
      el.addEventListener('click', async () => {
        if (b.onClick) {
          let r;
          try {
            el.disabled = true;
            r = await b.onClick(ctx);
          } catch (err) {
            await alertError(err.message);
            return;
          } finally {
            el.disabled = false;
          }
          if (r === false || closed) return;
          if (r !== undefined && b.value === undefined) return close(r);
        }
        close(b.value);
      });
      (b.align === 'left' ? left : right).append(el);
      if (b.primary) primary = el;
    }

    function onKey(e) {
      if (stack[stack.length - 1] !== bg) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(closeValue);
      } else if (e.key === 'Enter' && primary && !e.shiftKey && !['TEXTAREA', 'BUTTON', 'SELECT'].includes(e.target.tagName) && !e.target.closest('.no-enter')) {
        e.preventDefault();
        primary.click();
      }
    }
    document.addEventListener('keydown', onKey, true);

    // Drag by title bar.
    titleEl.addEventListener('mousedown', e => {
      if (e.target.closest('.modal-x')) return;
      const r = dlg.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => {
        dlg.style.position = 'fixed';
        dlg.style.margin = '0';
        dlg.style.left = Math.max(0, ev.clientX - dx) + 'px';
        dlg.style.top = Math.max(0, ev.clientY - dy) + 'px';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    stack.push(bg);
    document.body.append(bg);
    const f = dlg.querySelector('[autofocus]') || dlg.querySelector('.modal-body input:not([type=hidden]):not([disabled]):not([type=checkbox]):not([type=radio]), .modal-body textarea, .modal-body select') || primary;
    f?.focus();
    if (f?.tagName === 'INPUT') f.select();
    onOpen?.(ctx);
  });
}

function messageBody(kind, msg) {
  return h('div', { class: 'msgbox' }, h('span', { class: 'msgbox-ic', html: icon(kind).replace('width="16" height="16"', 'width="32" height="32"') }), h('div', { class: 'msgbox-text' }, msg));
}

export function alertError(msg, title = 'Error') {
  return modal({ title, body: messageBody('error', msg), width: 480 });
}

export function alertInfo(msg, title = 'Information') {
  return modal({ title, body: messageBody('info', msg), width: 440 });
}

export async function confirmDlg(msg, { title = 'Confirm', ok = 'OK', danger = false, kind = 'question' } = {}) {
  const r = await modal({
    title,
    body: messageBody(kind, msg),
    width: 460,
    buttons: [{ label: ok, value: true, primary: true, danger }, { label: 'Cancel', value: false }],
  });
  return r === true;
}

export async function promptDlg(title, label, value = '', { width = 400, placeholder = '' } = {}) {
  const input = h('input', { class: 'inp wide', value, placeholder, spellcheck: false });
  const r = await modal({
    title,
    width,
    body: h('div', { class: 'form' }, h('label', null, label), input),
    buttons: [{ label: 'OK', primary: true, onClick: () => input.value }, { label: 'Cancel', value: null }],
  });
  return r;
}

// ---------- context menus ----------

let openMenu = null;
let menuOnClose = null;

export function closeMenus() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', menuKey, true);
  window.removeEventListener('blur', closeMenus);
  const cb = menuOnClose;
  menuOnClose = null;
  cb?.();
}

function outside(e) {
  if (openMenu && !openMenu.contains(e.target) && !e.target.closest?.('.menubar-item.open')) closeMenus();
}

function menuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(); return; }
  // Up / Down move through the items of the open menu, Enter picks the highlighted one.
  if (!openMenu) return;
  const items = [...openMenu.querySelectorAll(':scope > .menu-item:not(.disabled)')];
  const cur = openMenu.querySelector(':scope > .menu-item.kbd');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    if (!items.length) return;
    const i = items.indexOf(cur);
    const next = items[i < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    cur?.classList.remove('kbd');
    next.classList.add('kbd');
    next.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && cur) {
    e.preventDefault();
    e.stopPropagation();
    cur.click();
  }
}

/** Opens a context menu. Items: {label, icon, shortcut, disabled, checked, onClick, submenu} or '-'. */
export function contextMenu(x, y, items, { onClose } = {}) {
  closeMenus();
  const root = buildMenu(items);
  root.classList.add('ctx-root');
  root.style.left = x + 'px';
  root.style.top = y + 'px';
  document.body.append(root);
  const r = root.getBoundingClientRect();
  if (r.right > innerWidth) root.style.left = Math.max(0, innerWidth - r.width - 2) + 'px';
  if (r.bottom > innerHeight) root.style.top = Math.max(0, innerHeight - r.height - 2) + 'px';
  openMenu = root;
  menuOnClose = onClose || null;
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', menuKey, true);
  window.addEventListener('blur', closeMenus);
}

export const menuIsOpen = () => !!openMenu;

function buildMenu(items) {
  const m = h('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      if (m.lastChild && !m.lastChild.classList.contains('menu-sep')) m.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    const row = h('div', { class: 'menu-item' + (it.disabled ? ' disabled' : '') + (it.submenu ? ' has-sub' : ''), title: it.title || null },
      h('span', { class: 'menu-ic', html: it.icon ? icon(it.icon) : it.checked ? '✓' : '' }),
      h('span', { class: 'menu-label' }, it.label),
      h('span', { class: 'menu-key' }, it.shortcut || ''),
      h('span', { class: 'menu-arrow' }, it.submenu ? '▸' : ''));
    row.addEventListener('mouseenter', () => {
      for (const s of m.querySelectorAll(':scope > .menu-item > .menu')) if (s.parentElement !== row) s.remove();
      if (it.submenu && !it.disabled && !row.querySelector(':scope > .menu')) {
        const sub = buildMenu(it.submenu);
        sub.classList.add('submenu');
        row.append(sub);
        sub.style.left = row.offsetWidth - 3 + 'px';
        sub.style.top = '-4px';
        const r = sub.getBoundingClientRect();
        if (r.right > innerWidth) sub.style.left = -sub.offsetWidth + 3 + 'px';
        if (r.bottom > innerHeight) sub.style.top = innerHeight - r.bottom - 4 + 'px';
      }
    });
    if (!it.submenu && !it.disabled) {
      row.addEventListener('click', e => {
        e.stopPropagation();
        closeMenus();
        it.onClick?.();
      });
    }
    m.append(row);
  }
  if (m.lastChild?.classList.contains('menu-sep')) m.lastChild.remove();
  return m;
}
