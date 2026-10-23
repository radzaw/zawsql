// SQL editor brackets: the bracket matching the one at the caret, and what the caret is in (for auto-closing).
// Brackets inside strings, quoted names and comments don't count. Pure functions, unit-tested in tests/js.
import { TOKEN_RE, unclosed } from './sqlsigs.js';

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };

/** Longer texts are not scanned on every caret move. */
export const MAX_SCAN = 300_000;

/** Offsets of the brackets outside strings and comments, in text order. */
function codeBrackets(text) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    const t = m[0];
    if (t.length === 1 && (OPEN[t] || CLOSE[t])) out.push(m.index);
  }
  return out;
}

/**
 * The bracket next to the caret (just before it, else just after it) and its partner: { at, match }, match -1 when
 * it has none. Null when there is no bracket there, or it is in a string or comment.
 */
export function matchBracket(text, pos) {
  if (text.length > MAX_SCAN) return null;
  const isB = i => i >= 0 && i < text.length && (OPEN[text[i]] || CLOSE[text[i]]);
  const cands = [pos - 1, pos].filter(isB);
  if (!cands.length) return null;
  const list = codeBrackets(text);
  for (const at of cands) {
    const k = list.indexOf(at);
    if (k < 0) continue; // in a string or comment
    const ch = text[at];
    let depth = 0;
    if (OPEN[ch]) {
      for (let i = k; i < list.length; i++) {
        const c = text[list[i]];
        if (OPEN[c]) depth++;
        else if (--depth === 0) return { at, match: c === OPEN[ch] ? list[i] : -1 };
      }
    } else {
      for (let i = k; i >= 0; i--) {
        const c = text[list[i]];
        if (CLOSE[c]) depth++;
        else if (--depth === 0) return { at, match: c === CLOSE[ch] ? list[i] : -1 };
      }
    }
    return { at, match: -1 };
  }
  return null;
}

/** What the caret is in: 'code', 'comment', or the quote that opened the string or name it is in (' " `). */
export function caretContext(text, pos) {
  const before = text.slice(0, pos);
  TOKEN_RE.lastIndex = 0;
  let m, last = null;
  while ((m = TOKEN_RE.exec(before))) last = m;
  if (!last || last.index + last[0].length !== before.length || !unclosed(last[0])) return 'code';
  const q = last[0][0];
  return q === "'" || q === '"' || q === '`' ? q : 'comment';
}

/** More opening than closing brackets of this kind in the text's code: a typed closer is then needed, not typed over. */
export function missingCloser(text, close) {
  const open = CLOSE[close];
  let n = 0;
  for (const i of codeBrackets(text)) {
    if (text[i] === open) n++;
    else if (text[i] === close) n--;
  }
  return n > 0;
}
