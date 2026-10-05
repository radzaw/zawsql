// SQL log panel at the bottom of the window, like HeidiSQL's, with a timestamp (date, time, milliseconds) per line.
import { h, fmtLogTime } from './util.js';
import { highlightSql } from './editor.js';
import { contextMenu } from './dialogs.js';

const MAX_LINES = 3000;

export class LogPanel {
  /** opts.timestamps: () => boolean, whether timestamps are shown; opts.setTimestamps(on) remembers the choice. */
  constructor(el, { timestamps = () => true, setTimestamps = () => {} } = {}) {
    this.el = el;
    this.count = 0;
    this.timestamps = timestamps;
    this.setTimestamps = setTimestamps;
    el.classList.add('logpanel');
    el.tabIndex = 0;
    this.syncTimestamps();
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => navigator.clipboard.writeText(getSelection().toString() || this.text()) },
        { label: 'Copy all', onClick: () => navigator.clipboard.writeText(this.text()) },
        '-',
        { label: 'Show timestamps', checked: this.timestamps(), onClick: () => { this.setTimestamps(!this.timestamps()); this.syncTimestamps(); } },
        { label: 'Clear', icon: 'trash', onClick: () => this.clear() },
      ]);
    });
  }

  syncTimestamps() {
    this.el.classList.toggle('no-ts', !this.timestamps());
  }

  /** The log as text; timestamps are included when they are shown. */
  text() {
    const ts = this.timestamps();
    return [...this.el.children].map(c => {
      const t = c.querySelector('.log-ts')?.textContent;
      const body = c.querySelector('.log-text')?.textContent ?? c.textContent;
      return ts && t ? `${t} ${body}` : body;
    }).join('\n');
  }

  clear() {
    this.el.innerHTML = '';
    this.count = 0;
  }

  /** times: when each line was logged (Unix ms, from the server); lines without one get the current time. */
  add(lines, cls = '', times = null) {
    const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 6;
    const frag = document.createDocumentFragment();
    const now = Date.now();
    lines.forEach((line, i) => {
      if (line.length > 3000) line = line.slice(0, 3000) + ' …';
      const err = /^\/\* (SQL )?Error/.test(line);
      frag.append(h('div', { class: 'log-line' + (err ? ' err' : '') + (cls ? ' ' + cls : '') },
        h('span', { class: 'log-ts' }, fmtLogTime(times?.[i] ?? now)),
        h('span', { class: 'log-text', html: highlightSql(line) })));
      this.count++;
    });
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
