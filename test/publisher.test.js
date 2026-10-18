'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const HanaVectorPublisher = require('..');

function mockDb(kind = 'hana', opts = {}) {
  const { failOn } = opts;
  return {
    kind,
    calls: [],
    async run(query, args) {
      this.calls.push({ query, args });
      if (failOn && failOn(query)) throw new Error('boom');
      return 'result' in opts ? opts.result : 1;
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

test('embedPending returns the row count for every driver result shape', async () => {
  // CQL writes resolve to a number, plain SQL to { changes, lastInsertRowid }
  const cases = [
    [{ changes: 3, lastInsertRowid: 7 }, 3],
    [3, 3],
    [undefined, 0]
  ];
  for (const [result, expected] of cases) {
    const publisher = new HanaVectorPublisher(mockDb('hana', { result }), { sqlTableName: 'T' });
    assert.equal(await publisher.embedPending({ tableName: 'T', documentId: 'doc-1' }), expected);
    assert.equal(await publisher.embedPending({ tableName: 'T' }), expected);
  }
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

// ------------------------------------------------------------------ search (1.2.0)

test('buildSearchSql with and without document filter', () => {
  const publisher = new HanaVectorPublisher(mockDb(), { sqlTableName: 'T' });
  assert.equal(
    publisher.buildSearchSql('T'),
    `SELECT "ID" AS "ID", "DOCUMENTID" AS "documentId", "FILENAME" AS "fileName", "CHUNKINDEX" AS "chunkIndex", "CONTENT" AS "content", ` +
      `COSINE_SIMILARITY("EMBEDDING", TO_REAL_VECTOR(VECTOR_EMBEDDING(?, 'QUERY', 'SAP_NEB.20240715'))) AS "score" ` +
      `FROM "T" WHERE "EMBEDDING" IS NOT NULL ORDER BY "score" DESC LIMIT 5`
  );
  assert.match(publisher.buildSearchSql('T', { withDocument: true, top: 12 }), / WHERE "EMBEDDING" IS NOT NULL AND "DOCUMENTID" = \? ORDER BY "score" DESC LIMIT 12$/);
  assert.match(new HanaVectorPublisher(mockDb()).buildSearchSql('my.app.Chunks'), / FROM "MY_APP_CHUNKS" /);
});

test('buildSearchSql respects wrapToRealVector, modelId and the column mapping', () => {
  const publisher = new HanaVectorPublisher(mockDb(), {
    sqlTableName: 'CUSTOM',
    wrapToRealVector: false,
    modelId: 'MY_MODEL.1',
    columns: { id: null, fileName: null, chunkIndex: 'pos', content: 'text', embedding: 'vec', documentId: 'docId' }
  });
  assert.equal(
    publisher.buildSearchSql('ignored', { withDocument: true }),
    `SELECT "DOCID" AS "documentId", "POS" AS "chunkIndex", "TEXT" AS "content", ` +
      `COSINE_SIMILARITY("VEC", VECTOR_EMBEDDING(?, 'QUERY', 'MY_MODEL.1')) AS "score" ` +
      `FROM "CUSTOM" WHERE "VEC" IS NOT NULL AND "DOCID" = ? ORDER BY "score" DESC LIMIT 5`
  );
});

test('buildSearchSql and search reject a top that is not an integer between 1 and 1000', async () => {
  const db = mockDb();
  const publisher = new HanaVectorPublisher(db, { sqlTableName: 'T' });
  for (const top of [0, -1, 1.5, '5; DROP TABLE T', '5', 1001, NaN, null]) {
    assert.throws(() => publisher.buildSearchSql('T', { top }), { code: 'INVALID_INPUT', status: 400 }, String(top));
    await assert.rejects(publisher.search({ tableName: 'T', query: 'q', top }), { code: 'INVALID_INPUT', status: 400 }, String(top));
  }
  assert.equal(db.calls.length, 0);
});

test('search binds the query (and documentId) as parameters and returns hits best first', async () => {
  const rows = [
    { ID: 'c1', documentId: 'd1', fileName: 'a.pdf', chunkIndex: 0, content: 'x', score: 0.9 },
    { ID: 'c2', documentId: 'd1', fileName: 'a.pdf', chunkIndex: 1, content: 'y', score: '0.4' }
  ];
  const db = mockDb('hana', { result: rows });
  const publisher = new HanaVectorPublisher(db, { sqlTableName: 'T' });

  const hits = await publisher.search({ tableName: 'T', query: "what's new?" });
  assert.deepEqual(db.calls[0].args, ["what's new?"]);
  assert.doesNotMatch(db.calls[0].query, /what/);
  assert.deepEqual(hits, [
    { ID: 'c1', documentId: 'd1', fileName: 'a.pdf', chunkIndex: 0, content: 'x', score: 0.9 },
    { ID: 'c2', documentId: 'd1', fileName: 'a.pdf', chunkIndex: 1, content: 'y', score: 0.4 }
  ]);

  await publisher.search({ tableName: 'T', query: 'q', documentId: 'd1', top: 3 });
  assert.deepEqual(db.calls[1].args, ['q', 'd1']);
  assert.match(db.calls[1].query, /"DOCUMENTID" = \? ORDER BY "score" DESC LIMIT 3$/);

  const filtered = await publisher.search({ tableName: 'T', query: 'q', minScore: 0.5 });
  assert.deepEqual(filtered.map(h => h.ID), ['c1']);
});

test('search validates its input', async () => {
  const publisher = new HanaVectorPublisher(mockDb());
  for (const params of [
    {},
    { tableName: 'T' },
    { tableName: 'T', query: '' },
    { tableName: 'T', query: '   ' },
    { tableName: 'T', query: 42 },
    { tableName: 'T', query: 'x'.repeat(2001) },
    { tableName: 'T', query: 'q', documentId: '' },
    { tableName: 'T', query: 'q', minScore: 'high' }
  ]) {
    await assert.rejects(publisher.search(params), { code: 'INVALID_INPUT', status: 400 }, JSON.stringify(params));
  }
});

test('search wraps database errors in SEARCH_FAILED', async () => {
  const publisher = new HanaVectorPublisher(mockDb('hana', { failOn: () => true }), { sqlTableName: 'T' });
  await assert.rejects(publisher.search({ tableName: 'T', query: 'q' }), { code: 'SEARCH_FAILED', status: 500 });
});

test('search on non-HANA databases: UNSUPPORTED_DATABASE, or a text match with skipEmbeddings', async () => {
  await assert.rejects(new HanaVectorPublisher(mockDb('sqlite')).search({ tableName: 'T', query: 'q' }), { code: 'UNSUPPORTED_DATABASE' });

  const db = mockDb('sqlite', { result: [{ ID: 'c1', documentId: 'd1', fileName: 'a.txt', chunkIndex: 0, content: 'Hello World' }] });
  const publisher = new HanaVectorPublisher(db, { onUnsupportedDatabase: 'skipEmbeddings', columns: { fileName: null } });
  const hits = await publisher.search({ tableName: 'my.app.Chunks', query: ' World ', documentId: 'd1', top: 7 });
  assert.deepEqual(hits, [{ ID: 'c1', documentId: 'd1', fileName: 'a.txt', chunkIndex: 0, content: 'Hello World', score: null }]);

  const { SELECT } = db.calls[0].query;
  assert.equal(SELECT.from.ref[0], 'my.app.Chunks');
  assert.deepEqual(SELECT.columns.map(c => c.as), ['ID', 'documentId', 'chunkIndex', 'content']);
  assert.deepEqual(SELECT.limit.rows, { val: 7 });
  const where = JSON.stringify(SELECT.where);
  assert.match(where, /"func":"contains"/);
  assert.match(where, /"val":"world"/);
  assert.match(where, /"val":"d1"/);
});
