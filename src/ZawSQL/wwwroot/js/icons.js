// 16x16 inline SVG icons, styled after classic Windows database tools.
const P = {
  server: '<rect x="2" y="1.5" width="12" height="5.5" rx="1" fill="#7aa0d4" stroke="#2f5590"/><rect x="2" y="9" width="12" height="5.5" rx="1" fill="#7aa0d4" stroke="#2f5590"/><circle cx="4.6" cy="4.2" r="1" fill="#7f7"/><circle cx="4.6" cy="11.7" r="1" fill="#7f7"/><path d="M8 4.2h4M8 11.7h4" stroke="#24467a"/>',
  database: '<path d="M2.5 3.5v9c0 1.2 2.5 2 5.5 2s5.5-.8 5.5-2v-9" fill="#e9c75b" stroke="#9c7a1e"/><ellipse cx="8" cy="3.5" rx="5.5" ry="2" fill="#f7df8d" stroke="#9c7a1e"/><path d="M2.5 7c0 1.2 2.5 2 5.5 2s5.5-.8 5.5-2M2.5 10c0 1.2 2.5 2 5.5 2s5.5-.8 5.5-2" fill="none" stroke="#9c7a1e" stroke-width=".7"/>',
  table: '<rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#3a6ab0"/><rect x="1.5" y="2.5" width="13" height="3" fill="#6d9ad8" stroke="#3a6ab0"/><path d="M1.5 8.5h13M1.5 11h13M6 5.5v8M10.5 5.5v8" stroke="#8fb0de" stroke-width=".8"/>',
  view: '<rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#3c8a4a"/><rect x="1.5" y="2.5" width="13" height="3" fill="#7cc18a" stroke="#3c8a4a"/><path d="M3.5 10c1.3-2 3-3 4.5-3s3.2 1 4.5 3c-1.3 2-3 2.7-4.5 2.7S4.8 12 3.5 10z" fill="#e6f4e8" stroke="#3c8a4a" stroke-width=".8"/><circle cx="8" cy="9.9" r="1.3" fill="#3c8a4a"/>',
  procedure: '<rect x="2" y="2" width="12" height="12" rx="2" fill="#efe3fb" stroke="#7a4bb0"/><text x="8" y="11.6" font-size="9" font-family="Segoe UI,Arial" font-weight="700" text-anchor="middle" fill="#7a4bb0">P</text>',
  function: '<rect x="2" y="2" width="12" height="12" rx="2" fill="#e3f0fb" stroke="#2f72b5"/><text x="8" y="11.6" font-size="9" font-family="Georgia,serif" font-style="italic" font-weight="700" text-anchor="middle" fill="#2f72b5">f</text>',
  trigger: '<path d="M9.5 1.5 3.5 9h4l-1 5.5 6-7.5h-4z" fill="#f5c542" stroke="#a87b08" stroke-linejoin="round"/>',
  event: '<circle cx="8" cy="8" r="6" fill="#fff" stroke="#b5552f"/><path d="M8 4.2V8l2.6 1.6" fill="none" stroke="#b5552f" stroke-width="1.3" stroke-linecap="round"/>',
  play: '<path d="M4 2.5v11l9-5.5z" fill="#2fa84f" stroke="#1d7a37" stroke-linejoin="round"/>',
  playsel: '<path d="M2.5 2.5v11l8-5.5z" fill="#2fa84f" stroke="#1d7a37" stroke-linejoin="round"/><path d="M11.5 3v10M14 3v10" stroke="#1d7a37" stroke-width="1.3"/>',
  playline: '<path d="M2.5 3.5v9l6.5-4.5z" fill="#2fa84f" stroke="#1d7a37" stroke-linejoin="round"/><path d="M10 6h4.5M10 8h4.5M10 10h4.5" stroke="#555" stroke-width="1.1"/>',
  stop: '<rect x="3" y="3" width="10" height="10" rx="1" fill="#e04b3b" stroke="#a52a1d"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6" fill="none" stroke="#2f72b5" stroke-width="1.8"/><path d="M12.8 1.6v3.6H9.2" fill="none" stroke="#2f72b5" stroke-width="1.8" stroke-linejoin="round"/>',
  plus: '<path d="M8 2.5v11M2.5 8h11" stroke="#2fa84f" stroke-width="2.2"/>',
  minus: '<path d="M2.5 8h11" stroke="#e04b3b" stroke-width="2.2"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8" stroke="#666" stroke-width="1.6"/>',
  save: '<path d="M2 2h10l2 2v10H2z" fill="#4a7fc1" stroke="#244f86"/><rect x="4.5" y="2" width="6" height="4" fill="#fff"/><rect x="4" y="9" width="8" height="5" fill="#e8eef7"/>',
  open: '<path d="M1.5 4V13h11.5l1.5-6H4.5L3 13" fill="#f2cf63" stroke="#a5852a" stroke-linejoin="round"/><path d="M1.5 4h4l1 1.2h5V7" fill="none" stroke="#a5852a"/>',
  export: '<path d="M3 2h7l3 3v9H3z" fill="#fff" stroke="#666"/><path d="M8 7v6M5.5 10.5 8 13l2.5-2.5" fill="none" stroke="#2fa84f" stroke-width="1.5"/>',
  import: '<path d="M3 2h7l3 3v9H3z" fill="#fff" stroke="#666"/><path d="M8 13V7M5.5 9.5 8 7l2.5 2.5" fill="none" stroke="#2f72b5" stroke-width="1.5"/>',
  key: '<circle cx="5" cy="8" r="3" fill="#f5c542" stroke="#a87b08"/><path d="M8 8h6.5M12 8v2.5M14 8v2" stroke="#a87b08" stroke-width="1.6"/>',
  keyu: '<circle cx="5" cy="8" r="3" fill="#7fb5f0" stroke="#2f72b5"/><path d="M8 8h6.5M12 8v2.5M14 8v2" stroke="#2f72b5" stroke-width="1.6"/>',
  keyi: '<circle cx="5" cy="8" r="3" fill="#7cc18a" stroke="#3c8a4a"/><path d="M8 8h6.5M12 8v2.5M14 8v2" stroke="#3c8a4a" stroke-width="1.6"/>',
  filter: '<path d="M1.5 2.5h13L9.5 8.5v5l-3-1.5V8.5z" fill="#f2cf63" stroke="#a5852a" stroke-linejoin="round"/>',
  query: '<path d="M3 1.5h7l3 3v10H3z" fill="#fff" stroke="#3a6ab0"/><text x="8" y="12" font-size="5.6" font-family="Segoe UI,Arial" font-weight="700" text-anchor="middle" fill="#3a6ab0">SQL</text>',
  host: '<rect x="1.5" y="2" width="13" height="9" rx="1" fill="#cfe0f5" stroke="#3a6ab0"/><path d="M5 14h6M8 11v3" stroke="#3a6ab0" stroke-width="1.4"/>',
  disconnect: '<path d="M6 10 2.5 13.5M10 6l3.5-3.5" stroke="#666" stroke-width="1.6"/><path d="M4.5 7.5 8.5 11.5l-1 1a2.8 2.8 0 0 1-4-4z" fill="#e04b3b" stroke="#a52a1d"/><path d="M11.5 8.5 7.5 4.5l1-1a2.8 2.8 0 0 1 4 4z" fill="#e04b3b" stroke="#a52a1d"/>',
  maintenance: '<path d="M10.6 1.6a3.6 3.6 0 0 0-3.4 4.8L1.9 11.7a1.6 1.6 0 0 0 2.3 2.3l5.3-5.3a3.6 3.6 0 0 0 4.8-3.4l-2 2-2.1-.6-.6-2.1z" fill="#8aa4c8" stroke="#3a5a86" stroke-linejoin="round"/>',
  moon: '<path d="M10.8 2.2A6 6 0 1 0 13.8 11 5 5 0 0 1 10.8 2.2z" fill="#5b6ee1" stroke="#3a47a8" stroke-linejoin="round"/>',
  sun: '<circle cx="8" cy="8" r="3.2" fill="#f5c542" stroke="#c99a12"/><path d="M8 1.2v2M8 12.8v2M1.2 8h2M12.8 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4" stroke="#f5c542" stroke-width="1.5" stroke-linecap="round"/>',
  user: '<circle cx="8" cy="5" r="3" fill="#f2c29b" stroke="#a0673a"/><path d="M2.5 14.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5z" fill="#4a7fc1" stroke="#244f86" stroke-linejoin="round"/>',
  sessions: '<rect x="1.5" y="1.5" width="10" height="4" rx="1" fill="#7aa0d4" stroke="#2f5590"/><rect x="4.5" y="6.5" width="10" height="4" rx="1" fill="#7aa0d4" stroke="#2f5590"/><path d="M3 12.5h6" stroke="#2fa84f" stroke-width="2"/><path d="M6 9.5v6" stroke="#2fa84f" stroke-width="2" transform="translate(0 -1)"/>',
  up: '<path d="M8 3 3 9h3.5v4h3V9H13z" fill="#4a7fc1" stroke="#244f86" stroke-linejoin="round"/>',
  down: '<path d="M8 13 3 7h3.5V3h3v4H13z" fill="#4a7fc1" stroke="#244f86" stroke-linejoin="round"/>',
  next: '<path d="M3 3.5v9l5-4.5zM8.5 3.5v9l5-4.5z" fill="#4a7fc1" stroke="#244f86" stroke-linejoin="round"/>',
  all: '<path d="M2 3.5v9l4.5-4.5zM6.5 3.5v9L11 8z" fill="#4a7fc1" stroke="#244f86" stroke-linejoin="round"/><path d="M12.5 3v10" stroke="#244f86" stroke-width="1.8"/>',
  check: '<path d="M2.5 8.5 6 12l7.5-8" fill="none" stroke="#2fa84f" stroke-width="2.2"/>',
  cancel: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="#e04b3b" stroke-width="2.2"/>',
  txauto: '<path d="M9.5 1.5 3.5 9h4.2l-1.2 5.5 6-7.5H8.3z" fill="#3a8ee6" stroke="#22609e" stroke-width=".7" stroke-linejoin="round"/>',
  txmanual: '<path d="M5.2 7V5.3a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="#8a6d00" stroke-width="1.5"/><rect x="3" y="7" width="10" height="7" rx="1.2" fill="#f0c23b" stroke="#8a6d00"/><circle cx="8" cy="10.3" r="1.1" fill="#8a6d00"/>',
  history: '<circle cx="8.5" cy="8" r="5.5" fill="#fff" stroke="#555"/><path d="M8.5 5v3.3l2.2 1.4" fill="none" stroke="#555" stroke-width="1.3"/><path d="M1.5 6.5 3 9l2-2.2" fill="none" stroke="#2f72b5" stroke-width="1.3"/>',
  bookmark: '<path d="M4 1.5h8v13l-4-3.2-4 3.2z" fill="#f2b632" stroke="#a5761a" stroke-linejoin="round"/>',
  snippet: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="#e3f0fb" stroke="#2f72b5"/><path d="M5.5 5.5 3.3 8l2.2 2.5M10.5 5.5 12.7 8l-2.2 2.5" fill="none" stroke="#2f72b5" stroke-width="1.3" stroke-linejoin="round"/><path d="M8.8 5 7.2 11" stroke="#2f72b5" stroke-width="1.1"/>',
  explain: '<rect x="5.5" y="1.5" width="5" height="3.5" rx=".6" fill="#e3f0fb" stroke="#2f72b5"/><rect x="1.5" y="11" width="5" height="3.5" rx=".6" fill="#e6f4e8" stroke="#3c8a4a"/><rect x="9.5" y="11" width="5" height="3.5" rx=".6" fill="#fde9e7" stroke="#c0392b"/><path d="M8 5v3M4 11V8h8v3" fill="none" stroke="#666"/>',
  library: '<rect x="1.5" y="2" width="3" height="12" fill="#6d9ad8" stroke="#3a6ab0"/><rect x="5.5" y="2" width="3" height="12" fill="#f2b632" stroke="#a5761a"/><path d="m9.6 3.2 2.9-.8 2.9 11-2.9.8z" fill="#7cc18a" stroke="#3c8a4a" stroke-linejoin="round"/>',
  folder: '<path d="M1.5 3.5h4.5l1.2 1.5h7.3v8.5h-13z" fill="#f2cf63" stroke="#a5852a" stroke-linejoin="round"/>',
  copy: '<rect x="5" y="5" width="8.5" height="9" fill="#fff" stroke="#666"/><path d="M3 11V2.5h7.5" fill="none" stroke="#666"/>',
  settings: '<circle cx="8" cy="8" r="2.4" fill="none" stroke="#555" stroke-width="1.5"/><path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.6 1.6M11 11l1.6 1.6M3.4 12.6 5 11M11 5l1.6-1.6" stroke="#555" stroke-width="1.5"/>',
  info: '<circle cx="8" cy="8" r="6.5" fill="#2f72b5"/><path d="M8 7v5" stroke="#fff" stroke-width="1.8"/><circle cx="8" cy="4.6" r="1.1" fill="#fff"/>',
  error: '<circle cx="8" cy="8" r="6.5" fill="#e04b3b"/><path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" stroke="#fff" stroke-width="1.8"/>',
  warning: '<path d="M8 1.5 15 14H1z" fill="#f5c542" stroke="#a87b08" stroke-linejoin="round"/><path d="M8 6v4" stroke="#333" stroke-width="1.6"/><circle cx="8" cy="12" r=".9" fill="#333"/>',
  question: '<circle cx="8" cy="8" r="6.5" fill="#2f72b5"/><text x="8" y="11.8" font-size="10" font-family="Segoe UI,Arial" font-weight="700" text-anchor="middle" fill="#fff">?</text>',
  trash: '<path d="M3.5 4.5h9l-1 9.5h-7z" fill="#eee" stroke="#666"/><path d="M2 4.5h12M6 2.5h4" stroke="#666" stroke-width="1.4"/><path d="M6.5 7v5M9.5 7v5" stroke="#999"/>',
  empty: '<path d="M3.5 4.5h9l-1 9.5h-7z" fill="#fff" stroke="#888"/><path d="M2 4.5h12" stroke="#888" stroke-width="1.4"/>',
  newtab: '<path d="M2 4h12v9.5H2z" fill="#fff" stroke="#3a6ab0"/><path d="M2 4h5V2.5h7V4" fill="#cfe0f5" stroke="#3a6ab0"/><path d="M8 6.5v5M5.5 9h5" stroke="#2fa84f" stroke-width="1.6"/>',
  format: '<path d="M2 3.5h12M5 6.5h9M5 9.5h9M2 12.5h12" stroke="#555" stroke-width="1.4"/>',
  columns: '<rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#666"/><path d="M6 2.5v11M10.5 2.5v11" stroke="#666"/>',
};

// Icons whose white parts are glyphs on a colored disc and must stay white in every theme.
const KEEP_WHITE = new Set(['info', 'error', 'question']);

/**
 * Neutral greys become currentColor and white "paper" fills get a marker color, so the stylesheet
 * can recolor both for the dark theme (CSS overrides SVG presentation attributes).
 */
function themeable(name, body) {
  body = body.replace(/(stroke|fill)="#(?:555|666|888|999)"/g, '$1="currentColor"');
  if (!KEEP_WHITE.has(name)) body = body.replace(/fill="#(?:fff|eee|e8eef7)"/g, 'fill="#fffffe"');
  return body;
}

const cache = new Map();

export function icon(name, cls = '') {
  if (!P[name]) return '';
  let body = cache.get(name);
  if (!body) cache.set(name, (body = themeable(name, P[name])));
  return `<svg class="ic ${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${body}</svg>`;
}
