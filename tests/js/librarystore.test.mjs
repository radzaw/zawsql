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

test('a library that failed to load is never written back', async () => {
  const st = new LibraryStore();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  try { await st.load(); } finally { globalThis.fetch = realFetch; }
  await assert.rejects(st.addQuery({ name: 'a', sql: 'SELECT 1' }), /could not be loaded/);
  assert.equal(st.queries.length, 0);
});
