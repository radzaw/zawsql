import { test } from 'node:test';
import assert from 'node:assert/strict';

// The store talks to /api/library; a fake backend whose saves can be made to fail.
let failPut = false;
globalThis.fetch = async (url, o) => ({
  status: 200,
  json: async () => (o.method === 'PUT' && failPut ? { ok: false, error: 'disk full' } : { ok: true, data: null }),
});
const { LibraryStore } = await import('../../src/ZawSQL/wwwroot/js/views/library.js');

test('a change whose save fails is undone', async () => {
  failPut = false;
  const st = new LibraryStore();
  await st.load();
  const q = await st.addQuery({ name: 'a', sql: 'SELECT 1' });

  failPut = true;
  await assert.rejects(st.addQuery({ name: 'b', sql: 'SELECT 2' }), /disk full/);
  assert.deepEqual(st.queries.map(x => x.name), ['a']);
  await assert.rejects(st.updateQuery(q.id, { name: 'renamed' }), /disk full/);
  assert.equal(st.query(q.id).name, 'a');
  await assert.rejects(st.remove('query', q.id), /disk full/);
  assert.equal(st.queries.length, 1);

  failPut = false;
  await st.updateQuery(q.id, { name: 'renamed' });
  assert.equal(st.query(q.id).name, 'renamed');
});

test('two windows saving the library keep both changes', async () => {
  // A backend that numbers saves and refuses one based on an older revision, like SessionStore.SaveLibrary.
  let saved = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    let body = { ok: true, data: saved };
    if (o.method === 'PUT') {
      const doc = JSON.parse(o.body), current = saved?.revision ?? 0;
      if (doc.revision !== current) body = { ok: false, error: 'changed in another window', code: 9002 };
      else { saved = { ...doc, revision: current + 1 }; body = { ok: true, data: { revision: current + 1 } }; }
    }
    return { status: 200, json: async () => structuredClone(body) };
  };
  try {
    const a = new LibraryStore(), b = new LibraryStore();
    await a.load();
    await b.load();
    const q = await a.addQuery({ name: 'from A', sql: 'SELECT 1' });
    await b.addQuery({ name: 'from B', sql: 'SELECT 2' }); // B's copy is stale: it reloads and adds to A's library
    assert.deepEqual(saved.queries.map(x => x.name).sort(), ['from A', 'from B']);
    await a.updateQuery(q.id, { name: 'renamed by A' }); // and A, now stale, keeps B's query
    assert.deepEqual(saved.queries.map(x => x.name).sort(), ['from B', 'renamed by A']);
    assert.deepEqual(a.queries.map(x => x.name).sort(), ['from B', 'renamed by A']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a library that failed to load is never written back', async () => {
  const st = new LibraryStore();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  try { await st.load(); } finally { globalThis.fetch = realFetch; }
  await assert.rejects(st.addQuery({ name: 'a', sql: 'SELECT 1' }), /could not be loaded/);
  assert.equal(st.queries.length, 0);
});
