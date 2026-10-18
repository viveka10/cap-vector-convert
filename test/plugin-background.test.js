'use strict';

// Background embedding in test/app with the publisher posing as HANA: the
// VECTOR_EMBEDDING statement is swapped for an UPDATE that SQLite can run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { testApp, fixture, requester, waitFor } = require('./support');

const { axios } = cds.test(testApp('app'));
const call = requester(axios);
const b64 = buffer => Buffer.from(buffer).toString('base64');

const fakeEmbeddingSql = (tableName, { allPending } = {}) =>
  `UPDATE cap_hana_vector_DocumentChunks SET embedding = 'v' WHERE ${allPending ? '' : 'documentId = ? AND '}embedding IS NULL`;

let srv, publisher, events;

/** Runs once, after cds.test has started the server */
function setup() {
  if (srv) return;
  srv = cds.services.VectorDocumentService;
  publisher = srv.store.publisher;
  Object.defineProperty(publisher, 'isHana', { value: true });
  publisher.buildEmbeddingSql = fakeEmbeddingSql;

  const embedPending = publisher.embedPending.bind(publisher);
  publisher.embedPending = async params => {
    events.push('embedPending');
    return embedPending(params);
  };
  // runs before the plugin's handler; its 'succeeded' listener is registered first
  srv.prepend(() =>
    srv.on('upload', async (req, next) => {
      req.on('succeeded', () => events.push('succeeded'));
      const result = await next();
      events.push('handler done');
      return result;
    })
  );
}

const documentRow = ID => SELECT.one.from('cap.hana.vector.Documents', ID);
const pendingChunks = documentId => SELECT.from('cap.hana.vector.DocumentChunks').where({ documentId, embedding: null });
const settled = ID => waitFor(async () => {
  const doc = await documentRow(ID);
  return doc && doc.status !== 'PENDING' && doc;
});

test('upload returns PENDING and embeds only after the request succeeded', async () => {
  setup();
  events = [];
  const res = await call('POST', '/vector/upload', { data: { fileName: 'sample.pdf', content: b64(fixture('sample.pdf')) }, user: 'admin' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'PENDING');

  const doc = await settled(res.data.documentId);
  assert.deepEqual(events, ['handler done', 'succeeded', 'embedPending']);
  assert.equal(doc.status, 'EMBEDDED');
  assert.equal(doc.modelId, 'SAP_NEB.20240715');
  assert.ok(doc.embeddedAt);
  assert.equal(doc.statusMessage, null);
  assert.equal((await pendingChunks(res.data.documentId)).length, 0);
});

test('a failing background embedding marks the document FAILED', async () => {
  setup();
  events = [];
  publisher.buildEmbeddingSql = () => 'UPDATE no_such_table SET x = 1 WHERE ? IS NULL';
  try {
    const res = await call('POST', '/vector/upload', { data: { fileName: 'sample.txt', content: b64(fixture('sample.txt')) }, user: 'admin' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const doc = await settled(res.data.documentId);
    assert.equal(doc.status, 'FAILED');
    assert.match(doc.statusMessage, /Failed to compute embeddings/);
    assert.equal(doc.embeddedAt, null);
    assert.ok((await pendingChunks(res.data.documentId)).length > 0);
  } finally {
    publisher.buildEmbeddingSql = fakeEmbeddingSql;
  }
});

test('embedPending for one document re-embeds and returns the row count', async () => {
  setup();
  publisher.buildEmbeddingSql = () => 'UPDATE no_such_table SET x = 1 WHERE ? IS NULL';
  const res = await call('POST', '/vector/upload', { data: { fileName: 'sample.txt', content: b64(fixture('sample.txt')) }, user: 'admin' });
  const { documentId, chunkCount } = res.data;
  await settled(documentId);

  // the failed action rolls back, the FAILED status is recorded afterwards
  const failed = await call('POST', '/vector/embedPending', { data: { documentId }, user: 'admin' });
  assert.equal(failed.status, 500);
  publisher.buildEmbeddingSql = fakeEmbeddingSql;

  const ok = await call('POST', '/vector/embedPending', { data: { documentId }, user: 'admin' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.value, chunkCount);
  const doc = await documentRow(documentId);
  assert.equal(doc.status, 'EMBEDDED');
  assert.equal(doc.statusMessage, null);
});

test('embedPending without documentId embeds every pending row and updates the statuses', async () => {
  setup();
  publisher.buildEmbeddingSql = () => 'UPDATE no_such_table SET x = 1 WHERE ? IS NULL';
  const ids = [];
  for (const name of ['a.txt', 'b.txt']) {
    const res = await call('POST', '/vector/upload', { data: { fileName: name, content: b64(fixture('sample.txt')) }, user: 'admin' });
    ids.push(res.data.documentId);
  }
  for (const ID of ids) assert.equal((await settled(ID)).status, 'FAILED');
  publisher.buildEmbeddingSql = fakeEmbeddingSql;

  const res = await call('POST', '/vector/embedPending', { data: {}, user: 'admin' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.value >= 2);
  for (const ID of ids) assert.equal((await documentRow(ID)).status, 'EMBEDDED');
});

test('the catch-up job runs the same logic and never throws', async () => {
  setup();
  const { runCatchUp } = require('../cds-plugin');
  publisher.buildEmbeddingSql = () => 'UPDATE no_such_table SET x = 1 WHERE ? IS NULL';
  const res = await call('POST', '/vector/upload', { data: { fileName: 'c.txt', content: b64(fixture('sample.txt')) }, user: 'admin' });
  await settled(res.data.documentId);

  assert.equal(await cds.tx(() => runCatchUp(srv.store)), 0); // fails, logs, returns 0
  publisher.buildEmbeddingSql = fakeEmbeddingSql;
  assert.ok((await cds.tx(() => runCatchUp(srv.store))) > 0);
  assert.equal((await documentRow(res.data.documentId)).status, 'EMBEDDED');
});

test('on HANA the catch-up job is started with the configured interval', async () => {
  setup();
  const plugin = require('../cds-plugin');
  publisher.buildEmbeddingSql = () => 'UPDATE no_such_table SET x = 1 WHERE ? IS NULL';
  const res = await call('POST', '/vector/upload', { data: { fileName: 'd.txt', content: b64(fixture('sample.txt')) }, user: 'admin' });
  assert.equal((await settled(res.data.documentId)).status, 'FAILED');
  publisher.buildEmbeddingSql = fakeEmbeddingSql;

  assert.equal(plugin.catchUpJob, undefined, 'not started on SQLite');
  const kind = Object.getOwnPropertyDescriptor(cds.db, 'kind');
  Object.defineProperty(cds.db, 'kind', { value: 'hana', configurable: true });
  try {
    plugin.startCatchUpJob({ ...plugin.config, embedding: { ...plugin.config.embedding, catchUpInterval: 50 } });
  } finally {
    if (kind) Object.defineProperty(cds.db, 'kind', kind);
    else delete cds.db.kind;
  }
  try {
    assert.ok(plugin.catchUpJob);
    await waitFor(async () => (await documentRow(res.data.documentId)).status === 'EMBEDDED');
  } finally {
    clearInterval(plugin.catchUpJob.timer);
  }
});
