'use strict';

// Runs plain SQL through a real CAP database service (@cap-js/sqlite) to check
// the result shape embedPending() has to normalise. VECTOR_EMBEDDING itself
// cannot run on SQLite, so the tests use an ordinary UPDATE.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const HanaVectorPublisher = require('..');
const { affectedRows } = require('../lib/utils');

let db;

before(async () => {
  db = await cds.connect.to('db', { impl: '@cap-js/sqlite', kind: 'sqlite', credentials: { url: ':memory:' } });
  await db.run('CREATE TABLE T (ID INTEGER, DOCUMENTID TEXT, EMBEDDING TEXT)');
});

after(() => db.disconnect());

async function reset() {
  await db.run('DELETE FROM T');
  await db.run("INSERT INTO T VALUES (1, 'a', NULL), (2, 'a', NULL), (3, 'b', NULL), (4, 'b', 'done')");
}

test('plain SQL UPDATE through cds.db.run is normalised to a row count', async () => {
  await reset();
  const res = await db.run("UPDATE T SET EMBEDDING = 'v' WHERE DOCUMENTID = ? AND EMBEDDING IS NULL", ['a']);
  assert.equal(typeof res, 'object'); // the reason affectedRows() exists
  assert.equal(affectedRows(res), 2);
  assert.equal(affectedRows(await db.run("UPDATE T SET EMBEDDING = 'v' WHERE ID = 99")), 0);
});

test('embedPending returns a number against a real CAP database service', async () => {
  await reset();
  // Pose as HANA and swap the VECTOR_EMBEDDING statement for one SQLite can run.
  const hanaLike = { kind: 'hana', run: (...args) => db.run(...args), tx: fn => db.tx(fn) };
  const publisher = new HanaVectorPublisher(hanaLike, { sqlTableName: 'T' });
  publisher.buildEmbeddingSql = (tableName, { allPending } = {}) =>
    `UPDATE T SET EMBEDDING = 'v' WHERE ${allPending ? '' : 'DOCUMENTID = ? AND '}EMBEDDING IS NULL`;

  assert.equal(await publisher.embedPending({ tableName: 'T', documentId: 'a' }), 2);
  assert.equal(await publisher.embedPending({ tableName: 'T', documentId: 'a' }), 0);
  assert.equal(await publisher.embedPending({ tableName: 'T' }), 1);
});
