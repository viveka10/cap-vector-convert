'use strict';

// test/app-library uses the package the 1.1.x way (VectorStore aspect + library)
// and has no cds.requires['hana-vector-publisher']: the plugin must add nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { testApp, requester } = require('./support');
const { HanaVectorPublisher } = require('..');

// @sap/cds 8 cannot deploy cds.Vector to SQLite; the README shows this hook for local development
cds.on('loaded', csn => {
  for (const def of Object.values(csn.definitions)) {
    for (const [name, element] of Object.entries(def.elements || {})) {
      if (element.type !== 'cds.Vector') continue;
      const { length, ...rest } = element;
      def.elements[name] = { ...rest, type: 'cds.LargeString' };
    }
  }
});

const { axios } = cds.test(testApp('app-library'));
const call = requester(axios);

test('the plugin adds no entities, services or endpoints without its config', async () => {
  assert.equal(cds.env.requires['hana-vector-publisher'], undefined);
  assert.ok(cds.model.definitions['my.app.DocumentChunks']);
  for (const name of ['VectorDocumentService', 'cap.hana.vector.Documents', 'cap.hana.vector.DocumentChunks']) {
    assert.equal(cds.model.definitions[name], undefined, name);
  }
  assert.equal(cds.services.VectorDocumentService, undefined);
  assert.deepEqual(Object.keys(cds.services).filter(name => name !== 'db').sort(), ['my.app.LibraryService']);
  assert.equal((await call('GET', '/vector/Documents', { user: 'alice' })).status, 404);
  const tables = await cds.db.run(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cap_hana_vector%'`);
  assert.deepEqual(tables, []);
});

test('the plugin starts no job and registers no hooks without its config', () => {
  const plugin = require('../cds-plugin');
  assert.equal(plugin.config, undefined);
  assert.equal(plugin.catchUpJob, undefined);
});

test('the library works as in 1.1.x next to the plugin', async () => {
  const publisher = new HanaVectorPublisher(cds.db, { onUnsupportedDatabase: 'skipEmbeddings' });
  const result = await publisher.processAndStore({
    fileBuffer: Buffer.from('Library mode stores chunks in your own entity.'),
    fileName: 'own.txt',
    tableName: 'my.app.DocumentChunks'
  });
  assert.equal(result.embedded, false);
  assert.equal(result.chunkCount, 1);

  const res = await call('GET', `/odata/v4/library/Chunks?$filter=documentId eq ${result.documentId}`, { user: 'alice' });
  assert.equal(res.status, 200);
  assert.equal(res.data.value.length, 1);

  const hits = await publisher.search({ tableName: 'my.app.DocumentChunks', query: 'own ENTITY' });
  assert.deepEqual(hits.map(h => [h.documentId, h.fileName, h.chunkIndex, h.score]), [[result.documentId, 'own.txt', 0, null]]);
  assert.equal(await publisher.deleteDocument({ tableName: 'my.app.DocumentChunks', documentId: result.documentId }), 1);
});
