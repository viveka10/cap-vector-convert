'use strict';

// End-to-end tests of the plugin in test/app (SQLite, mocked auth): chunks are
// stored without vectors (status SKIPPED) and search uses the text fallback.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { testApp, fixture, requester } = require('./support');

const { axios } = cds.test(testApp('app'));
const call = requester(axios);
const ADMIN = 'admin';
const READER = 'reader';

const b64 = buffer => Buffer.from(buffer).toString('base64');
const upload = (data, user = ADMIN) => call('POST', '/vector/upload', { data, user });
const documentRow = ID => SELECT.one.from('cap.hana.vector.Documents', ID);
const chunkRows = documentId => SELECT.from('cap.hana.vector.DocumentChunks').where({ documentId }).orderBy('chunkIndex');

test('upload stores a TXT document with status SKIPPED on SQLite', async () => {
  const res = await upload({ fileName: 'sample.txt', content: b64(fixture('sample.txt')), metadata: '{"source":"test"}' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const { documentId, status, chunkCount, pageCount } = res.data;
  assert.match(documentId, /^[0-9a-f-]{36}$/);
  assert.equal(status, 'SKIPPED');
  assert.ok(chunkCount >= 1);
  assert.equal(pageCount, null);

  const doc = await documentRow(documentId);
  assert.equal(doc.status, 'SKIPPED');
  assert.equal(doc.chunkCount, chunkCount);
  assert.equal(doc.fileType, 'txt');
  assert.equal(doc.mimeType, 'text/plain');
  assert.equal(doc.metadata, '{"source":"test"}');
  assert.equal(doc.createdBy, ADMIN);
  assert.ok(doc.characterCount > 0);
  assert.equal((await chunkRows(documentId)).length, chunkCount);
});

test('upload extracts a PDF; chunks are readable without the embedding', async () => {
  const res = await upload({ fileName: 'sample.pdf', mimeType: 'application/pdf', content: b64(fixture('sample.pdf')) });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const { documentId, chunkCount } = res.data;
  assert.equal(res.data.pageCount, 2);

  const chunks = await call('GET', `/vector/Chunks?$filter=documentId eq ${documentId}&$orderby=chunkIndex`, { user: READER });
  assert.equal(chunks.status, 200);
  assert.equal(chunks.data.value.length, chunkCount);
  assert.match(chunks.data.value.map(c => c.content).join(' '), /pineapple/);
  for (const chunk of chunks.data.value) assert.equal('embedding' in chunk, false);

  const docs = await call('GET', `/vector/Documents(${documentId})?$expand=chunks`, { user: READER });
  assert.equal(docs.status, 200);
  assert.equal(docs.data.fileType, 'pdf');
  assert.equal(docs.data.chunks.length, chunkCount);
});

test('upload rejects bad input with the publisher status codes', async () => {
  const png = await upload({ fileName: 'image.png', mimeType: 'image/png', content: b64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])) });
  assert.equal(png.status, 415);

  const imageOnly = await upload({ fileName: 'scan.pdf', content: b64(fixture('image-only.pdf')) });
  assert.equal(imageOnly.status, 422);
  const blank = await upload({ fileName: 'blank.txt', content: b64(' \n\n ') });
  assert.equal(blank.status, 422);

  const tooLarge = await upload({ fileName: 'big.txt', content: b64(Buffer.alloc(10 * 1024 * 1024 + 1, 'a')) });
  assert.equal(tooLarge.status, 413);

  const replace = await upload({ fileName: 'a.txt', content: b64('hello'), replace: true });
  assert.equal(replace.status, 400);
  assert.match(replace.data.error.message, /replace: true requires a documentId/);

  // nothing of the failed uploads was kept
  const names = (await SELECT.from('cap.hana.vector.Documents').columns('fileName')).map(d => d.fileName);
  for (const name of ['image.png', 'scan.pdf', 'blank.txt', 'big.txt', 'a.txt']) assert.ok(!names.includes(name), name);
});

test('replace: true replaces the chunks and resets the document row', async () => {
  const first = await upload({ fileName: 'sample.pdf', content: b64(fixture('sample.pdf')) });
  const { documentId } = first.data;

  const again = await upload({ fileName: 'other.txt', content: b64('hello'), documentId });
  assert.equal(again.status, 409);

  const res = await upload({ fileName: 'replaced.txt', content: b64('Just one short chunk.'), documentId, replace: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.documentId, documentId);
  assert.equal(res.data.chunkCount, 1);
  assert.equal(res.data.pageCount, null);

  const doc = await documentRow(documentId);
  assert.equal(doc.fileName, 'replaced.txt');
  assert.equal(doc.fileType, 'txt');
  assert.equal(doc.pageCount, null);
  assert.equal(doc.chunkCount, 1);
  assert.equal(doc.status, 'SKIPPED');
  const chunks = await chunkRows(documentId);
  assert.deepEqual(chunks.map(c => c.content), ['Just one short chunk.']);
});

test('the service requires a user; changes require DocumentAdminRole in this app', async () => {
  assert.equal((await call('GET', '/vector/Documents')).status, 401);
  assert.equal((await call('GET', `/vector/search(query='x')`)).status, 401);

  assert.equal((await call('GET', '/vector/Documents', { user: READER })).status, 200);
  assert.equal((await call('GET', `/vector/search(query='x')`, { user: READER })).status, 200);
  assert.equal((await upload({ fileName: 'a.txt', content: b64('hello') }, READER)).status, 403);
  assert.equal((await call('POST', '/vector/deleteDocument', { data: { documentId: cds.utils.uuid() }, user: READER })).status, 403);
  assert.equal((await call('POST', '/vector/embedPending', { data: {}, user: READER })).status, 403);
});

test('deleteDocument removes the header and its chunks', async () => {
  const { documentId, chunkCount } = (await upload({ fileName: 'sample.pdf', content: b64(fixture('sample.pdf')) })).data;
  const res = await call('POST', '/vector/deleteDocument', { data: { documentId }, user: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.data.value, chunkCount);
  assert.equal(await documentRow(documentId), undefined);
  assert.equal((await chunkRows(documentId)).length, 0);

  const unknown = await call('POST', '/vector/deleteDocument', { data: { documentId }, user: ADMIN });
  assert.equal(unknown.status, 404);
});

test('search falls back to a text match on SQLite', async () => {
  const { documentId } = (await upload({ fileName: 'fruit.pdf', content: b64(fixture('sample.pdf')) })).data;

  const res = await call('GET', `/vector/search(query='PINEAPPLE',documentId=${documentId})`, { user: READER });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.value.length, 1);
  const [hit] = res.data.value;
  assert.equal(hit.documentId, documentId);
  assert.equal(hit.fileName, 'fruit.pdf');
  assert.equal(typeof hit.chunkId, 'string');
  assert.equal(typeof hit.chunkIndex, 'number');
  assert.match(hit.content, /pineapple/);
  assert.equal(hit.score, null);

  const none = await call('GET', `/vector/search(query='no such words here')`, { user: READER });
  assert.deepEqual(none.data.value, []);

  // LIKE wildcards are matched literally
  assert.deepEqual((await call('GET', `/vector/search(query='%25')`, { user: READER })).data.value, []);
});

test('search clamps top to search.maxTop and validates the query', async () => {
  const paragraph = i => `Paragraph ${i} mentions the needle. ` + 'Filler text without meaning. '.repeat(30);
  const text = Array.from({ length: 70 }, (_, i) => paragraph(i)).join('\n\n');
  const { documentId, chunkCount } = (await upload({ fileName: 'haystack.txt', content: b64(text) })).data;
  assert.ok(chunkCount > 50, `chunkCount ${chunkCount}`);

  const all = await call('GET', `/vector/search(query='needle',top=500,documentId=${documentId})`, { user: READER });
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.equal(all.data.value.length, 50);

  const byDefault = await call('GET', `/vector/search(query='needle',documentId=${documentId})`, { user: READER });
  assert.equal(byDefault.data.value.length, 5);

  assert.equal((await call('GET', `/vector/search(query='')`, { user: READER })).status, 400);
  assert.equal((await call('GET', `/vector/search(query='   ')`, { user: READER })).status, 400);
  assert.equal((await call('GET', `/vector/search(query='needle',top=0)`, { user: READER })).status, 400);
  assert.equal((await call('GET', `/vector/search(query='${'x'.repeat(2001)}')`, { user: READER })).status, 400);
});

test('embedPending returns 0 on SQLite', async () => {
  const res = await call('POST', '/vector/embedPending', { data: {}, user: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.data.value, 0);
  const missing = await call('POST', '/vector/embedPending', { data: { documentId: cds.utils.uuid() }, user: ADMIN });
  assert.equal(missing.status, 404);
});

test('no catch-up job runs on SQLite', () => {
  const plugin = require('../cds-plugin');
  assert.equal(plugin.config.embedding.mode, 'background');
  assert.equal(plugin.config.publisher.onUnsupportedDatabase, 'skipEmbeddings');
  assert.equal(plugin.catchUpJob, undefined);
});
