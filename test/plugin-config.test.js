'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolvePluginConfig, PLUGIN_DEFAULTS } = require('../lib/plugin/config');
const { testApp, ROOT } = require('./support');

const APP = testApp('app');
const CDS_SERVE = path.join(ROOT, 'node_modules', '@sap', 'cds', 'bin', 'serve.js');
const pluginConfig = conf => JSON.stringify({ requires: { 'hana-vector-publisher': { kind: 'hana-vector-publisher', ...conf } } });

test('true resolves to the defaults; onUnsupportedDatabase follows the database kind', () => {
  const sqlite = resolvePluginConfig(true, { dbKind: 'sqlite' });
  assert.equal(sqlite.model, 'cap-hana-vector-publisher/srv');
  assert.equal(sqlite.maxFileSize, 10485760);
  assert.deepEqual(sqlite.embedding, { mode: 'background', catchUpInterval: 900000 });
  assert.deepEqual(sqlite.search, { defaultTop: 5, maxTop: 50 });
  assert.equal(sqlite.publisher.onUnsupportedDatabase, 'skipEmbeddings');
  assert.equal(sqlite.publisher.maxFileSize, 10485760);
  assert.equal(sqlite.publisher.chunkSize, 1000);

  assert.equal(resolvePluginConfig(true, { dbKind: 'hana' }).publisher.onUnsupportedDatabase, 'throw');
  assert.equal(resolvePluginConfig({ publisher: { onUnsupportedDatabase: 'throw' } }, { dbKind: 'sqlite' }).publisher.onUnsupportedDatabase, 'throw');
});

test('the kind in package.json matches the built-in defaults', () => {
  const kind = require('../package.json').cds.requires.kinds['hana-vector-publisher'];
  assert.deepEqual(JSON.parse(JSON.stringify(PLUGIN_DEFAULTS)), kind);
});

test('overrides are applied and validated', () => {
  const config = resolvePluginConfig(
    { maxFileSize: 20971520, embedding: { mode: 'sync', catchUpInterval: false }, publisher: { chunkSize: 800, chunkOverlap: 100, maxFileSize: 1 } },
    { dbKind: 'hana' }
  );
  assert.equal(config.embedding.mode, 'sync');
  assert.equal(config.embedding.catchUpInterval, 0);
  assert.equal(config.publisher.chunkSize, 800);
  assert.equal(config.publisher.chunkOverlap, 100);
  assert.equal(config.publisher.maxFileSize, 20971520, 'top-level maxFileSize wins');
  assert.equal(resolvePluginConfig({ model: 'cap-hana-vector-publisher/db' }).model, 'cap-hana-vector-publisher/db');
  assert.deepEqual(resolvePluginConfig({ search: { maxTop: 3 } }).search, { defaultTop: 3, maxTop: 3 });
});

test('invalid values throw INVALID_OPTIONS', () => {
  const bad = [
    'yes',
    { model: '' },
    { maxFileSize: 0 },
    { maxFileSize: '10mb' },
    { embedding: 'sync' },
    { embedding: { mode: 'later' } },
    { embedding: { catchUpInterval: -1 } },
    { embedding: { catchUpInterval: '15m' } },
    { search: { maxTop: 0 } },
    { search: { maxTop: 5000 } },
    { publisher: 'x' },
    { publisher: { chunkOverlap: 5000 } },
    { publisher: { modelId: "x'; DROP TABLE y; --" } },
    { publisher: { onUnsupportedDatabase: 'ignore' } }
  ];
  for (const conf of bad) {
    assert.throws(() => resolvePluginConfig(conf), { code: 'INVALID_OPTIONS', message: /cds\.requires\.hana-vector-publisher/ }, JSON.stringify(conf));
  }
});

test('an invalid plugin configuration stops the server at startup', () => {
  const res = spawnSync(process.execPath, [CDS_SERVE, '--port', '0'], {
    cwd: APP,
    env: { ...process.env, CDS_CONFIG: pluginConfig({ publisher: { chunkOverlap: 5000 } }) },
    encoding: 'utf8',
    timeout: 60000
  });
  assert.notEqual(res.status, 0, 'server must not start');
  assert.match(res.stderr + res.stdout, /INVALID_OPTIONS/);
  assert.match(res.stderr + res.stdout, /chunkOverlap/);
});

test('a too small body-parser limit is reported at startup', async () => {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CDS_SERVE, '--port', '0'], {
      cwd: APP,
      env: { ...process.env, CDS_CONFIG: JSON.stringify({ server: { body_parser: { limit: '1mb' } } }) }
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not start:\n${out}`));
    }, 60000);
    const collect = data => {
      out += data;
      if (/server listening/.test(out)) {
        clearTimeout(timer);
        child.kill();
        resolve(out);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
  });
  assert.match(output, /request body limit \(1mb\) is smaller than 1\.4 x maxFileSize/);
  assert.match(output, /cds\.server\.body_parser\.limit to at least "14mb"/);
});

test('compile and deploy do not start the catch-up job', () => {
  const script = `
    const cds = require('@sap/cds');
    (async () => {
      let served = false;
      cds.on('served', () => { served = true; });
      await cds.plugins;
      const plugin = require(${JSON.stringify(path.join(ROOT, 'cds-plugin.js'))});
      const csn = await cds.load('*');
      cds.compile.to.sql(csn);
      const db = await cds.connect.to('db');
      await cds.deploy(csn).to(db);
      console.log(JSON.stringify({ configured: !!plugin.config, served, job: plugin.catchUpJob === undefined ? null : 'started' }));
      await db.disconnect();
    })().catch(err => { console.error(err); process.exit(1); });
  `;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: APP, encoding: 'utf8', timeout: 60000 });
  assert.equal(res.status, 0, res.stderr);
  const result = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.deepEqual(result, { configured: true, served: false, job: null });
});
