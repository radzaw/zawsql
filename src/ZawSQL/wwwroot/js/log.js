// SQL log panel at the bottom of the window, like HeidiSQL's.
import { h } from './util.js';
import { highlightSql } from './editor.js';
import { contextMenu } from './dialogs.js';

const MAX_LINES = 3000;

export class LogPanel {
  constructor(el) {
    this.el = el;
    this.count = 0;
    el.classList.add('logpanel');
    el.tabIndex = 0;
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => navigator.clipboard.writeText(getSelection().toString() || this.text()) },
        { label: 'Copy all', onClick: () => navigator.clipboard.writeText(this.text()) },
        '-',
        { label: 'Clear', icon: 'trash', onClick: () => this.clear() },
      ]);
    });
  }

  text() {
    return [...this.el.children].map(c => c.textContent).join('\n');
  }

  clear() {
    this.el.innerHTML = '';
    this.count = 0;
  }

  add(lines, cls = '') {
    const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 6;
    const frag = document.createDocumentFragment();
    for (let line of lines) {
      if (line.length > 3000) line = line.slice(0, 3000) + ' …';
      const err = /^\/\* (SQL )?Error/.test(line);
      frag.append(h('div', { class: 'log-line' + (err ? ' err' : '') + (cls ? ' ' + cls : ''), html: highlightSql(line) }));
      this.count++;
    }
    this.el.append(frag);
    while (this.count > MAX_LINES) {
      this.el.firstChild.remove();
      this.count--;
    }
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  info(msg) { this.add([`/* ${msg} */`]); }
  error(msg) { this.add([`/* Error: ${msg} */`], 'err'); }
}
