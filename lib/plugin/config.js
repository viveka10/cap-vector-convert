'use strict';

const { resolveOptions, MAX_SEARCH_TOP } = require('../HanaVectorPublisher');
const { HanaVectorPublisherError, ERROR_CODES } = require('../errors');

/** Key under cds.requires that activates the plugin */
const CONFIG_KEY = 'hana-vector-publisher';

/** Mirrors cds.requires.kinds['hana-vector-publisher'] in package.json, used when the kind did not resolve */
const PLUGIN_DEFAULTS = Object.freeze({
  model: 'cap-hana-vector-publisher/srv',
  maxFileSize: 10 * 1024 * 1024,
  embedding: Object.freeze({ mode: 'background', catchUpInterval: 15 * 60 * 1000 }),
  search: Object.freeze({ defaultTop: 5, maxTop: 50 }),
  publisher: Object.freeze({})
});

const isHanaKind = kind => /hana/i.test(kind || '');

function invalid(message, cause) {
  return new HanaVectorPublisherError(
    `Invalid cds.requires.${CONFIG_KEY} configuration: ${message}`,
    ERROR_CODES.INVALID_OPTIONS,
    cause ? { cause, status: 500 } : { status: 500 }
  );
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw invalid(`${name} must be a positive integer`);
  return value;
}

/**
 * Validates cds.requires['hana-vector-publisher'] and fills in the defaults.
 * Throws INVALID_OPTIONS on the first bad value, so mistakes surface at startup.
 *
 * @param {true|object} conf the resolved cds.requires entry
 * @param {object} [env]
 * @param {string} [env.dbKind] kind of the primary database, decides the onUnsupportedDatabase default
 */
function resolvePluginConfig(conf, { dbKind } = {}) {
  if (conf === true) conf = {};
  if (!isObject(conf)) throw invalid('expected true or an object');
  for (const key of ['embedding', 'search', 'publisher']) {
    if (conf[key] !== undefined && conf[key] !== null && !isObject(conf[key])) throw invalid(`${key} must be an object`);
  }

  const model = conf.model === undefined ? PLUGIN_DEFAULTS.model : conf.model;
  if (typeof model !== 'string' || !model) throw invalid('model must be a non-empty string');
  const maxFileSize = positiveInteger(conf.maxFileSize === undefined ? PLUGIN_DEFAULTS.maxFileSize : conf.maxFileSize, 'maxFileSize');

  const embedding = { ...PLUGIN_DEFAULTS.embedding, ...conf.embedding };
  if (!['background', 'sync'].includes(embedding.mode)) throw invalid("embedding.mode must be 'background' or 'sync'");
  if (embedding.catchUpInterval === false || embedding.catchUpInterval === 0 || embedding.catchUpInterval === null) {
    embedding.catchUpInterval = 0;
  } else {
    positiveInteger(embedding.catchUpInterval, 'embedding.catchUpInterval (ms, or 0/false to disable)');
  }

  const search = { ...PLUGIN_DEFAULTS.search, ...conf.search };
  positiveInteger(search.defaultTop, 'search.defaultTop');
  positiveInteger(search.maxTop, 'search.maxTop');
  if (search.maxTop > MAX_SEARCH_TOP) throw invalid(`search.maxTop must not exceed ${MAX_SEARCH_TOP}`);
  // like a requested top, the default is capped by maxTop (e.g. when only maxTop is configured)
  search.defaultTop = Math.min(search.defaultTop, search.maxTop);

  // an explicit publisher.onUnsupportedDatabase wins; the top-level maxFileSize always applies
  const publisherOptions = {
    onUnsupportedDatabase: isHanaKind(dbKind) ? 'throw' : 'skipEmbeddings',
    ...conf.publisher,
    maxFileSize
  };
  let publisher;
  try {
    publisher = resolveOptions(publisherOptions);
  } catch (err) {
    throw invalid(`publisher: ${err.message}`, err);
  }

  return Object.freeze({
    model,
    maxFileSize,
    embedding: Object.freeze(embedding),
    search: Object.freeze(search),
    publisher
  });
}

module.exports = { CONFIG_KEY, PLUGIN_DEFAULTS, resolvePluginConfig, isHanaKind };
