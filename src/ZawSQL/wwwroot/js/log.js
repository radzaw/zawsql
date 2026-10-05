// SQL log panel at the bottom of the window, like HeidiSQL's, with a timestamp (date, time, milliseconds) per line
// and markers on statements that took longer than a threshold.
import { h, fmtLogTime } from './util.js';
import { highlightSql } from './editor.js';
import { contextMenu } from './dialogs.js';
import { SLOW_CHOICES, fmtDuration, slowLevel, thresholdLabel, nextSlow } from './logslow.js';

const MAX_LINES = 3000;

export class LogPanel {
  /**
   * opts.timestamps: () => boolean, whether timestamps are shown; opts.setTimestamps(on) remembers the choice.
   * opts.slowMs: () => threshold in ms (0 = no markers); opts.setSlowMs(ms) remembers it.
   */
  constructor(el, { timestamps = () => true, setTimestamps = () => {}, slowMs = () => 0, setSlowMs = () => {} } = {}) {
    this.el = el;
    this.count = 0;
    this.timestamps = timestamps;
    this.setTimestamps = setTimestamps;
    this.slowMs = slowMs;
    this.setSlowMs = setSlowMs;
    this.cursor = -1; // line "Next slow statement" stopped at
    el.classList.add('logpanel');
    el.tabIndex = 0;
    this.syncTimestamps();
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const cur = this.slowMs();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => navigator.clipboard.writeText(getSelection().toString() || this.text()) },
        { label: 'Copy all', onClick: () => navigator.clipboard.writeText(this.text()) },
        '-',
        { label: 'Show timestamps', checked: this.timestamps(), onClick: () => { this.setTimestamps(!this.timestamps()); this.syncTimestamps(); } },
        { label: 'Mark slow statements', submenu: SLOW_CHOICES.map(ms => ({ label: thresholdLabel(ms), checked: ms === cur, onClick: () => this.setThreshold(ms) })) },
        { label: 'Next slow statement', disabled: !this.slowCount(), onClick: () => this.nextSlow() },
        { label: 'Clear', icon: 'trash', onClick: () => this.clear() },
      ]);
    });
  }

  syncTimestamps() {
    this.el.classList.toggle('no-ts', !this.timestamps());
  }

  setThreshold(ms) {
    this.setSlowMs(ms);
    this.markAll();
  }

  /** Marks (or unmarks) every line against the current threshold. */
  markAll() {
    for (const line of this.el.children) this.mark(line);
  }

  mark(line) {
    const ms = line.dataset.ms === undefined ? null : Number(line.dataset.ms);
    const level = slowLevel(ms, this.slowMs());
    line.classList.toggle('log-slow', !!level);
    line.classList.toggle('log-very-slow', level === 'very');
    line.querySelector('.log-dur')?.remove();
    if (level) line.append(h('span', { class: 'log-dur' }, fmtDuration(ms)));
  }

  slowCount() {
    return this.el.querySelectorAll('.log-slow').length;
  }

  /** Scrolls to the next slow statement after the last one shown (or the top of the view) and highlights it. */
  nextSlow() {
    const lines = [...this.el.children];
    if (this.cursor < 0 || this.cursor >= lines.length || !lines[this.cursor].classList.contains('log-hit')) {
      // Start from the first line in view.
      const top = this.el.scrollTop;
      this.cursor = Math.max(-1, lines.findIndex(l => l.offsetTop + l.offsetHeight > top) - 1);
    }
    const i = nextSlow(lines.map(l => l.classList.contains('log-slow')), this.cursor);
    if (i < 0) return;
    for (const l of this.el.querySelectorAll('.log-hit')) l.classList.remove('log-hit');
    this.cursor = i;
    lines[i].classList.add('log-hit');
    lines[i].scrollIntoView({ block: 'nearest' });
  }

  /** The log as text; timestamps are included when they are shown, and slow statements say how long they took. */
  text() {
    const ts = this.timestamps();
    return [...this.el.children].map(c => {
      const t = c.querySelector('.log-ts')?.textContent;
      let body = c.querySelector('.log-text')?.textContent ?? c.textContent;
      const dur = c.querySelector('.log-dur')?.textContent;
      if (dur) body += ` /* took ${dur} */`;
      return ts && t ? `${t} ${body}` : body;
    }).join('\n');
  }

  clear() {
    this.el.innerHTML = '';
    this.count = 0;
    this.cursor = -1;
  }

  /**
   * times: when each line was logged (Unix ms, from the server); lines without one get the current time.
   * durations: how long each statement took (ms), null for comments and unmeasured lines.
   */
  add(lines, cls = '', times = null, durations = null) {
    const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 6;
    const frag = document.createDocumentFragment();
    const now = Date.now();
    lines.forEach((line, i) => {
      if (line.length > 3000) line = line.slice(0, 3000) + ' …';
      const err = /^\/\* (SQL )?Error/.test(line);
      const ms = durations?.[i];
      const el = h('div', { class: 'log-line' + (err ? ' err' : '') + (cls ? ' ' + cls : ''), title: ms != null ? `Took ${fmtDuration(ms)}` : null },
        h('span', { class: 'log-ts' }, fmtLogTime(times?.[i] ?? now)),
        h('span', { class: 'log-text', html: highlightSql(line) }));
      if (ms != null) {
        el.dataset.ms = String(ms);
        this.mark(el);
      }
      frag.append(el);
      this.count++;
    });
    this.el.append(frag);
    while (this.count > MAX_LINES) {
      this.el.firstChild.remove();
      this.count--;
      this.cursor--;
    }
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  info(msg) { this.add([`/* ${msg} */`]); }
  error(msg) { this.add([`/* Error: ${msg} */`], 'err'); }
}
