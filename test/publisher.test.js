'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const HanaVectorPublisher = require('..');

function mockDb(kind = 'hana', { failOn } = {}) {
  return {
    kind,
    calls: [],
    async run(query, args) {
      this.calls.push({ query, args });
      if (failOn && failOn(query)) throw new Error('boom');
      return 1;
    },
    async tx(fn) {
      this.txCount = (this.txCount || 0) + 1;
      return fn(this);
    }
  };
}

const longText = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about vectors and “special” chars – ok.`).join('\n\n');

test('constructor validates db and options', () => {
  assert.throws(() => new HanaVectorPublisher(), { code: 'INVALID_DB' });
  assert.throws(() => new HanaVectorPublisher(mockDb(), { chunkOverlap: 5000 }), { code: 'INVALID_OPTIONS' });
  assert.throws(() => new HanaVectorPublisher(mockDb(), { modelId: "x'); DROP TABLE y; --" }), { code: 'INVALID_OPTIONS' });
});

test('inserts chunks via CQL, then embeds in one UPDATE inside a transaction', async () => {
  const db = mockDb();
  const publisher = new HanaVectorPublisher(db, { chunkSize: 200, chunkOverlap: 40, batchSize: 5 });
  const result = await publisher.processAndStore({ fileBuffer: Buffer.from(longText), fileName: 'doc.txt', tableName: 'my.app.Chunks', metadata: { source: 'test' } });

  assert.equal(db.txCount, 1);
  assert.equal(result.embedded, true);
  assert.equal(result.fileType, 'txt');

  const inserts = db.calls.filter(c => c.query.INSERT);
  const rows = inserts.flatMap(c => c.query.INSERT.entries);
  assert.equal(rows.length, result.chunkCount);
  assert.ok(inserts.every(c => c.query.INSERT.entries.length <= 5));
  assert.deepEqual(rows.map(r => r.chunkIndex), rows.map((_, i) => i));
  assert.ok(rows.every(r => r.documentId === result.documentId && r.fileName === 'doc.txt' && r.mimeType === 'text/plain'));
  assert.equal(rows[0].metadata, '{"source":"test"}');

  const update = db.calls.at(-1);
  assert.equal(
    update.query,
    `UPDATE "MY_APP_CHUNKS" SET "EMBEDDING" = TO_REAL_VECTOR(VECTOR_EMBEDDING("CONTENT", 'DOCUMENT', 'SAP_NEB.20240715')) WHERE "DOCUMENTID" = ? AND "EMBEDDING" IS NULL`
  );
  assert.deepEqual(update.args, [result.documentId]);
});

test('accepts readable streams and enforces maxFileSize', async () => {
  const db = mockDb();
  const publisher = new HanaVectorPublisher(db, { maxFileSize: 10 });
  await assert.rejects(
    publisher.processAndStore({ fileBuffer: Readable.from([Buffer.from('0123456789'), Buffer.from('abc')]), fileName: 'a.txt', tableName: 'T' }),
    { code: 'FILE_TOO_LARGE', status: 413 }
  );
  const ok = await new HanaVectorPublisher(mockDb()).processAndStore({ fileBuffer: Readable.from([Buffer.from('hello stream')]), fileName: 'a.md', tableName: 'T' });
  assert.equal(ok.chunkCount, 1);
});

test('throws on non-HANA databases unless skipEmbeddings is set', async () => {
  const params = { fileBuffer: Buffer.from('text'), fileName: 'a.txt', tableName: 'T' };
  await assert.rejects(new HanaVectorPublisher(mockDb('sqlite')).processAndStore(params), { code: 'UNSUPPORTED_DATABASE' });

  const db = mockDb('sqlite');
  const result = await new HanaVectorPublisher(db, { onUnsupportedDatabase: 'skipEmbeddings' }).processAndStore(params);
  assert.equal(result.embedded, false);
  assert.ok(db.calls.every(c => typeof c.query !== 'string'));
});

test('replace deletes existing chunks first', async () => {
  const db = mockDb();
  await new HanaVectorPublisher(db).processAndStore({ fileBuffer: Buffer.from('new'), fileName: 'a.txt', tableName: 'T', documentId: 'doc-1', replace: true });
  assert.ok(db.calls[0].query.DELETE);
  assert.ok(db.calls[1].query.INSERT);
});

test('reports empty files and embedding failures with codes', async () => {
  const publisher = new HanaVectorPublisher(mockDb());
  await assert.rejects(publisher.processAndStore({ fileBuffer: Buffer.alloc(0), fileName: 'a.txt', tableName: 'T' }), { code: 'INVALID_INPUT' });
  await assert.rejects(publisher.processAndStore({ fileBuffer: Buffer.from(' \n\u0000 '), fileName: 'a.txt', tableName: 'T' }), { code: 'NO_TEXT_EXTRACTED' });

  const failing = new HanaVectorPublisher(mockDb('hana', { failOn: q => typeof q === 'string' }));
  await assert.rejects(failing.processAndStore({ fileBuffer: Buffer.from('x'), fileName: 'a.txt', tableName: 'T' }), { code: 'EMBEDDING_FAILED' });
});

test('custom column mapping and table override', () => {
  const publisher = new HanaVectorPublisher(mockDb(), {
    sqlTableName: 'CUSTOM_TABLE',
    wrapToRealVector: false,
    columns: { content: 'text', embedding: 'vec', documentId: 'docId' }
  });
  assert.equal(
    publisher.buildEmbeddingSql('ignored.Name'),
    `UPDATE "CUSTOM_TABLE" SET "VEC" = VECTOR_EMBEDDING("TEXT", 'DOCUMENT', 'SAP_NEB.20240715') WHERE "DOCID" = ? AND "VEC" IS NULL`
  );
});

test('replace: true without documentId is rejected before any SQL runs', async () => {
  const db = mockDb();
  await assert.rejects(
    new HanaVectorPublisher(db).processAndStore({ fileBuffer: Buffer.from('new'), fileName: 'a.txt', tableName: 'T', replace: true }),
    err => err instanceof HanaVectorPublisher.HanaVectorPublisherError && err.code === 'INVALID_INPUT' && err.status === 400
  );
  assert.equal(db.calls.length, 0);
});

test('wrapToRealVector: true still produces the wrapped expression', () => {
  const publisher = new HanaVectorPublisher(mockDb(), { sqlTableName: 'T', wrapToRealVector: true });
  assert.equal(
    publisher.buildEmbeddingSql('T'),
    `UPDATE "T" SET "EMBEDDING" = TO_REAL_VECTOR(VECTOR_EMBEDDING("CONTENT", 'DOCUMENT', 'SAP_NEB.20240715')) WHERE "DOCUMENTID" = ? AND "EMBEDDING" IS NULL`
  );
  assert.equal(
    publisher.buildEmbeddingSql('T', { allPending: true }),
    `UPDATE "T" SET "EMBEDDING" = TO_REAL_VECTOR(VECTOR_EMBEDDING("CONTENT", 'DOCUMENT', 'SAP_NEB.20240715')) WHERE "EMBEDDING" IS NULL`
  );
});

test('embed: false stores chunks only', async () => {
  const db = mockDb();
  const result = await new HanaVectorPublisher(db).processAndStore({ fileBuffer: Buffer.from(longText), fileName: 'a.txt', tableName: 'T', embed: false });
  assert.equal(result.embedded, false);
  assert.equal(result.modelId, undefined);
  assert.ok(db.calls.length > 0);
  assert.ok(db.calls.every(c => c.query.INSERT));
});

test('embed: false works on non-HANA databases even with onUnsupportedDatabase: throw', async () => {
  const db = mockDb('sqlite');
  const result = await new HanaVectorPublisher(db, { onUnsupportedDatabase: 'throw' }).processAndStore({
    fileBuffer: Buffer.from('text'),
    fileName: 'a.txt',
    tableName: 'T',
    embed: false
  });
  assert.equal(result.embedded, false);
});

test('embedPending embeds one document', async () => {
  const db = mockDb();
  const count = await new HanaVectorPublisher(db, { sqlTableName: 'T' }).embedPending({ tableName: 'T', documentId: 'doc-1' });
  assert.equal(count, 1);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].query, /^UPDATE "T" SET "EMBEDDING" = .* WHERE "DOCUMENTID" = \? AND "EMBEDDING" IS NULL$/);
  assert.deepEqual(db.calls[0].args, ['doc-1']);
  assert.equal(db.txCount, 1);
});

test('embedPending without documentId embeds every pending row', async () => {
  const db = mockDb();
  await new HanaVectorPublisher(db, { sqlTableName: 'T' }).embedPending({ tableName: 'T' });
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].query, / WHERE "EMBEDDING" IS NULL$/);
  assert.doesNotMatch(db.calls[0].query, /\?/);
  assert.equal(db.calls[0].args, undefined);
});

test('embedPending validates input and respects skipEmbeddings', async () => {
  const publisher = new HanaVectorPublisher(mockDb());
  await assert.rejects(publisher.embedPending({}), { code: 'INVALID_INPUT', status: 400 });
  await assert.rejects(publisher.embedPending({ tableName: 'T', documentId: '' }), { code: 'INVALID_INPUT', status: 400 });

  const db = mockDb('sqlite');
  assert.equal(await new HanaVectorPublisher(db, { onUnsupportedDatabase: 'skipEmbeddings' }).embedPending({ tableName: 'T' }), 0);
  assert.equal(db.calls.length, 0);
  await assert.rejects(new HanaVectorPublisher(mockDb('sqlite')).embedPending({ tableName: 'T' }), { code: 'UNSUPPORTED_DATABASE' });
});

test('embedPending wraps database errors in EMBEDDING_FAILED', async () => {
  const publisher = new HanaVectorPublisher(mockDb('hana', { failOn: () => true }));
  await assert.rejects(publisher.embedPending({ tableName: 'T', documentId: 'doc-1' }), { code: 'EMBEDDING_FAILED', status: 500 });
});
