'use strict';

// CAP loads this file for every app that depends on cap-hana-vector-publisher.
// It does nothing unless the app opts in with cds.requires['hana-vector-publisher'].

const cds = require('@sap/cds');
const { resolvePluginConfig, isHanaKind, CONFIG_KEY } = require('./lib/plugin/config');
const { DocumentStore, DOCUMENTS, CHUNKS } = require('./lib/plugin/DocumentStore');

const LOG = cds.log('hana-vector-publisher');
const SERVICE = 'VectorDocumentService';
/** express.json() default, used by CAP when cds.server.body_parser.limit is not set */
const EXPRESS_DEFAULT_LIMIT = '100kb';
/** base64 in a JSON body is ~4/3 of the file size, plus the other parameters */
const BASE64_OVERHEAD = 1.4;

const state = { config: undefined, catchUpJob: undefined };

const conf = cds.env.requires && cds.env.requires[CONFIG_KEY];
if (conf) {
  // fail fast: a bad value throws INVALID_OPTIONS while the server starts
  state.config = resolvePluginConfig(conf, { dbKind: cds.env.requires.db && cds.env.requires.db.kind });
  cds.on('loaded', csn => {
    if (needsVectorWorkaround()) withoutVectorType(csn);
  });
  cds.once('served', () => {
    checkBodyParserLimit(state.config);
    startCatchUpJob(state.config);
  });
}

/**
 * @sap/cds-compiler 5 (@sap/cds 8) accepts cds.Vector only for the HANA dialect, so
 * deploying the plugin's chunk table to SQLite or PostgreSQL would fail. The column
 * stays empty on those databases anyway, so it becomes a LargeString there - in the
 * chunk entity and in every projection on it. cds-compiler 6 supports Vector everywhere.
 */
function needsVectorWorkaround() {
  if (isHanaKind(cds.env.requires.db && cds.env.requires.db.kind)) return false;
  // keep build output (e.g. .hdbtable files built in the development profile) unchanged
  if (cds.cli && cds.cli.command === 'build') return false;
  const version = typeof cds.compiler.version === 'function' ? cds.compiler.version() : '';
  return parseInt(version, 10) < 6;
}

function withoutVectorType(csn) {
  const defs = csn && csn.definitions;
  if (!defs || !defs[CHUNKS]) return;
  const source = def => {
    const from = (def.projection && def.projection.from) || (def.query && def.query.SELECT && def.query.SELECT.from);
    return from && from.ref && from.ref.length === 1 ? from.ref[0] : undefined;
  };
  const basedOnChunks = name => {
    for (let n = name, seen = 0; n && seen < 20; n = defs[n] && source(defs[n]), seen++) if (n === CHUNKS) return true;
    return false;
  };
  for (const name in defs) {
    const element = defs[name].elements && defs[name].elements.embedding;
    if (!element || element.type !== 'cds.Vector' || !basedOnChunks(name)) continue;
    const { length, ...rest } = element;
    defs[name].elements.embedding = { ...rest, type: 'cds.LargeString' };
  }
}

function checkBodyParserLimit(config) {
  const definition = cds.model && cds.model.definitions[SERVICE];
  if (!definition || !cds.services[SERVICE]) return;
  const configured = definition['@cds.server.body_parser.limit'] || (cds.env.server && cds.env.server.body_parser && cds.env.server.body_parser.limit);
  const limit = parseBytes(configured || EXPRESS_DEFAULT_LIMIT);
  const needed = Math.ceil(config.maxFileSize * BASE64_OVERHEAD);
  if (limit !== undefined && limit < needed) {
    LOG.warn(
      `The request body limit (${configured || `${EXPRESS_DEFAULT_LIMIT}, the default`}) is smaller than ` +
        `${BASE64_OVERHEAD} x maxFileSize (${needed} bytes): larger uploads to ${SERVICE} will fail. ` +
        `Set cds.server.body_parser.limit to at least "${Math.ceil(needed / 1048576)}mb".`
    );
  }
}

function startCatchUpJob(config) {
  const { catchUpInterval } = config.embedding;
  const db = cds.db;
  if (!catchUpInterval || !db || !isHanaKind(db.kind)) return;
  if (!cds.model || !cds.model.definitions[DOCUMENTS]) {
    LOG.warn(`${DOCUMENTS} is not part of the model - the embedding catch-up job is not started`);
    return;
  }
  const service = cds.services[SERVICE];
  const store = (service && service.store) || new DocumentStore(db, config);
  state.catchUpJob = cds.spawn({ every: catchUpInterval }, () => runCatchUp(store));
  LOG.info(`Embedding catch-up job runs every ${catchUpInterval} ms`);
}

/** One run of the catch-up job. Never throws, so a failure cannot take the server down. */
async function runCatchUp(store) {
  try {
    const count = await store.embedAllPending();
    if (count) LOG.info(`Catch-up job embedded ${count} pending chunks`);
    return count;
  } catch (err) {
    LOG.error('Embedding catch-up job failed', err);
    return 0;
  }
}

/** '15mb' / '100kb' / 1024 -> bytes (1024-based, like the express body parser); undefined if unknown */
function parseBytes(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(String(value));
  if (!m) return undefined;
  const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] || 'b').toLowerCase()];
  return Math.floor(parseFloat(m[1]) * factor);
}

module.exports = {
  get config() {
    return state.config;
  },
  get catchUpJob() {
    return state.catchUpJob;
  },
  // exported for tests
  startCatchUpJob,
  runCatchUp,
  parseBytes
};
