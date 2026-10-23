// Choosing files to read and saving text to files. Browsers and WebView2 (Windows) have file pickers and downloads for
// the page; the macOS and Linux web views of the native window (WKWebView, WebKitGTK) don't, so there the native
// window's own dialogs are used, through the backend.
import { h, NATIVE } from './util.js';
import { post, token } from './api.js';

export const NATIVE_DIALOGS = NATIVE && !/Windows/.test(globalThis.navigator?.userAgent ?? '');

export function download(name, text, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Files the user chose (accept: ".csv,.txt,…" as for an input element); an empty list when cancelled. */
export async function pickFiles(accept = '', multiple = false) {
  if (NATIVE_DIALOGS) {
    const chosen = await post('/native/open', { accept, multiple });
    return Promise.all(chosen.map(async f => {
      const r = await fetch(`/api/native/file/${encodeURIComponent(f.id)}`, { headers: { 'X-Token': token } });
      if (!r.ok) throw new Error(`${f.name} could not be read.`);
      return new File([await r.blob()], f.name);
    }));
  }
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

/** The file the user chose, or null. */
export async function pickFile(accept = '') {
  return (await pickFiles(accept))[0] ?? null;
}

/** Saves text through the native save dialog when available, else as a download. The file name, or null when cancelled. */
export async function saveTextFile(name, text, description = 'SQL files', ext = '.sql') {
  if (NATIVE_DIALOGS) return (await post('/native/save', { description, ext, text }))?.name ?? null;
  if (window.showSaveFilePicker) {
    try {
      const fh = await window.showSaveFilePicker({ suggestedName: name, types: [{ description, accept: { 'text/plain': [ext] } }] });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      return fh.name;
    } catch (e) {
      if (e.name === 'AbortError') return null;
    }
  }
  download(name, text);
  return name;
}
