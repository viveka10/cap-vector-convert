'use strict';

// embedding.mode 'sync' (set through CDS_CONFIG on top of test/app's `true`), with
// the publisher posing as HANA like in plugin-background.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.CDS_CONFIG = JSON.stringify({
  requires: { 'hana-vector-publisher': { kind: 'hana-vector-publisher', embedding: { mode: 'sync' }, publisher: { chunkSize: 300, chunkOverlap: 30 } } }
});

const cds = require('@sap/cds');
const { testApp, fixture, requester } = require('./support');

const { axios } = cds.test(testApp('app'));
const call = requester(axios);

test('config overrides are merged with the kind defaults', () => {
  const { config } = require('../cds-plugin');
  assert.equal(config.embedding.mode, 'sync');
  assert.equal(config.embedding.catchUpInterval, 900000);
  assert.equal(config.publisher.chunkSize, 300);
  assert.equal(config.publisher.maxFileSize, 10485760);
  assert.equal(config.search.maxTop, 50);
});

test('sync mode embeds inside the upload request', async () => {
  const { publisher } = cds.services.VectorDocumentService.store;
  Object.defineProperty(publisher, 'isHana', { value: true });
  publisher.buildEmbeddingSql = () => `UPDATE cap_hana_vector_DocumentChunks SET embedding = 'v' WHERE documentId = ? AND embedding IS NULL`;
  const embedPending = publisher.embedPending;
  publisher.embedPending = () => assert.fail('no background embedding in sync mode');

  try {
    const res = await call('POST', '/vector/upload', {
      data: { fileName: 'sample.txt', content: fixture('sample.txt').toString('base64') },
      user: 'admin'
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.status, 'EMBEDDED');
    const doc = await SELECT.one.from('cap.hana.vector.Documents', res.data.documentId);
    assert.equal(doc.status, 'EMBEDDED');
    assert.equal(doc.modelId, 'SAP_NEB.20240715');
    assert.ok(doc.embeddedAt);
    const pending = await SELECT.from('cap.hana.vector.DocumentChunks').where({ documentId: res.data.documentId, embedding: null });
    assert.equal(pending.length, 0);
  } finally {
    publisher.embedPending = embedPending;
  }
});
