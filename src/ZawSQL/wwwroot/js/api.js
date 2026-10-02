// Thin client for the local ZawSQL backend. Every call carries the per-process token.
const TOKEN_KEY = 'zawsql-token';

function readToken() {
  const m = location.hash.match(/token=([A-Za-z0-9_-]+)/);
  if (m) {
    try { sessionStorage.setItem(TOKEN_KEY, m[1]); } catch { /* storage unavailable */ }
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  }
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export const token = readToken();
export const pageId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);

let logSink = () => {};
export function setLogSink(fn) { logSink = fn; }

export class ApiError extends Error {
  constructor(message, code, data) { super(message); this.code = code; this.data = data; }
}

/** Error code: the SSH server's host key isn't trusted yet (data: host, port, fingerprint). */
export const SSH_HOSTKEY_UNKNOWN = 9001;

function qs(q) {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

export async function api(method, path, body, { signal, quiet } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'X-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Cannot reach the ZawSQL backend. Is the application still running?');
  }
  if (res.status === 401) throw new ApiError('Not authorized. Restart ZawSQL to open a new window.');
  let j;
  try { j = await res.json(); } catch { throw new ApiError(`Unexpected response from the backend (HTTP ${res.status}).`); }
  if (j.log?.length && !quiet) logSink(j.log);
  if (!j.ok) throw new ApiError(j.error || 'Unknown error', j.code, j.data);
  return j.data;
}

export const get = (path, q, o) => api('GET', path + qs(q), undefined, o);
export const post = (path, body, o) => api('POST', path, body ?? {}, o);
export const put = (path, body, o) => api('PUT', path, body, o);
export const del = (path, o) => api('DELETE', path, undefined, o);

export function urlWithToken(path, q) {
  return '/api' + path + qs({ ...q, token });
}

export function startHeartbeat() {
  const ping = () => fetch(`/api/ping?page=${pageId}`, { method: 'POST', headers: { 'X-Token': token } }).catch(() => {});
  ping();
  setInterval(ping, 5000);
  window.addEventListener('pagehide', () => navigator.sendBeacon(`/api/bye?page=${pageId}&token=${token}`));
}
