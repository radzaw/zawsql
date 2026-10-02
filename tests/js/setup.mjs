// Minimal browser globals so the UI modules can be imported in Node. Loaded with `node --import`.
const store = new Map();
globalThis.window = globalThis;
globalThis.location = { hash: '', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };
globalThis.sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
// editor.js and grid.js create a canvas at load time to measure text.
globalThis.document = {
  createElement: () => ({ getContext: () => ({ measureText: s => ({ width: s.length * 7 }) }) }),
};
