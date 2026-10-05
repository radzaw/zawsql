// Full-text preview of a grid cell whose value doesn't fit: what to show, and when.

export const PREVIEW_LIMIT = 4000; // characters shown; the rest is summarised
export const PREVIEW_DELAY = 350; // ms the pointer rests on a cell before the preview opens

/**
 * Whether a cell needs a preview: its text is cut off (overflow), or the grid shows it altered,
 * with line breaks as ¶ or shortened to 400 characters.
 */
export function needsPreview(value, overflow) {
  if (value == null || value === '') return false;
  const s = String(value);
  return !!overflow || /[\r\n]/.test(s) || s.length > 400;
}

/** JSON objects and arrays are shown indented; anything else as it is. */
export function prettyValue(value) {
  const s = String(value);
  const t = s.trim();
  if (t.length > 1 && t.length < 200_000 && ((t[0] === '{' && t.at(-1) === '}') || (t[0] === '[' && t.at(-1) === ']'))) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') return { text: JSON.stringify(v, null, 2), json: true };
    } catch { /* not JSON */ }
  }
  return { text: s.replace(/\r\n?/g, '\n'), json: false };
}

/** The preview: the (pretty) text up to the limit, and a note on what was left out. */
export function previewText(value, limit = PREVIEW_LIMIT) {
  const { text, json } = prettyValue(value);
  const len = String(value).length;
  const lines = text.split('\n').length;
  const info = [`${len.toLocaleString('en-US')} character${len === 1 ? '' : 's'}`];
  if (lines > 1) info.push(`${lines.toLocaleString('en-US')} lines`);
  if (json) info.push('JSON');
  if (text.length <= limit) return { text, more: 0, json, info: info.join(' · ') };
  return { text: text.slice(0, limit), more: text.length - limit, json, info: info.join(' · ') };
}

/**
 * Where to put the preview (viewport px): below the cell, or above when there is no room below;
 * kept inside the window horizontally.
 */
export function placePreview(cell, size, viewport, gap = 2) {
  let left = Math.min(cell.left, viewport.width - size.width - 4);
  left = Math.max(4, left);
  let top = cell.bottom + gap;
  if (top + size.height > viewport.height - 4 && cell.top - gap - size.height >= 4) top = cell.top - gap - size.height;
  else if (top + size.height > viewport.height - 4) top = Math.max(4, viewport.height - 4 - size.height);
  return { left: Math.round(left), top: Math.round(top) };
}
