// Showing Claude's explanations: plain text with "- " lists, `inline code` and ```sql blocks.

/**
 * Splits an answer into blocks to render: { type: 'p', text } | { type: 'ul', items: [text] } | { type: 'code', lang, text }.
 * Paragraphs are separated by blank lines; consecutive "- " / "* " / "1. " lines form a list.
 */
export function answerBlocks(text) {
  const out = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let para = [], list = null;
  const flushPara = () => { if (para.length) out.push({ type: 'p', text: para.join(' ').trim() }); para = []; };
  const flushList = () => { if (list) out.push({ type: 'ul', items: list }); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([A-Za-z]*)/.exec(line);
    if (fence) {
      flushPara(); flushList();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ type: 'code', lang: fence[1].toLowerCase(), text: body.join('\n').trim() });
      continue;
    }
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      (list ??= []).push(item[1].trim());
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else if (list && /^\s{2,}\S/.test(line)) {
      list[list.length - 1] += ' ' + line.trim(); // a list item wrapped onto the next line
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out.filter(b => b.type !== 'p' || b.text);
}

/** Text split at `inline code`: [{ code: bool, text }]. Bold/italic markers are dropped. */
export function inlineParts(text) {
  const out = [];
  const re = /`([^`]+)`/g;
  let last = 0, m;
  const plain = s => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\W)__(.+?)__(?=\W|$)/g, '$1$2');
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ code: false, text: plain(text.slice(last, m.index)) });
    out.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: plain(text.slice(last)) });
  return out;
}
