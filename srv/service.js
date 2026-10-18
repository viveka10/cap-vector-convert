'use strict';

const cds = require('@sap/cds');
const { HanaVectorPublisherError } = require('../lib/errors');
const { resolvePluginConfig, CONFIG_KEY } = require('../lib/plugin/config');
const { DocumentStore } = require('../lib/plugin/DocumentStore');

const LOG = cds.log('hana-vector-publisher');

/**
 * Implementation of VectorDocumentService (srv/index.cds), served by the CAP plugin.
 * The logic lives in DocumentStore so the catch-up job can share it.
 */
class VectorDocumentService extends cds.ApplicationService {
  async init() {
    const db = cds.db || (await cds.connect.to('db'));
    const config = resolvePluginConfig(cds.env.requires[CONFIG_KEY] || true, { dbKind: db.kind });
    const store = (this.store = new DocumentStore(db, config));
    const background = config.embedding.mode === 'background';

    this.on('upload', req =>
      handle(req, async () => {
        const { fileName, mimeType, content, metadata, documentId, replace } = req.data;
        const result = await store.upload({ fileName, mimeType, content, metadata, documentId, replace });
        // the chunks are only visible to other transactions once this request has committed
        if (background && result.embedLater) {
          req.on('succeeded', () =>
            cds.spawn(async () => {
              try {
                await store.embedAndTrack(result.documentId);
              } catch (err) {
                LOG.error(`Background embedding of document ${result.documentId} failed`, err);
              }
            })
          );
        }
        const { embedLater, ...uploadResult } = result;
        return uploadResult;
      })
    );

    this.on('deleteDocument', req => handle(req, () => store.deleteDocument(req.data.documentId)));

    this.on('embedPending', req =>
      handle(req, async () => {
        const { documentId } = req.data;
        if (!documentId) return store.embedAllPending();
        try {
          return await store.embedDocument(documentId);
        } catch (err) {
          // this request rolls back, so record the failure in a transaction of its own
          if (err instanceof HanaVectorPublisherError && err.status !== 404) {
            req.on('failed', () => cds.spawn(() => store.markFailed(documentId, err)));
          }
          throw err;
        }
      })
    );

    this.on('search', req =>
      handle(req, () => {
        const { query, top, documentId } = req.data;
        return store.search({ query, top, documentId });
      })
    );

    return super.init();
  }
}

/** Maps HanaVectorPublisherError to req.reject(status, message); anything else is rethrown. */
async function handle(req, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof HanaVectorPublisherError)) throw err;
    if (err.cause) LOG.error(`${req.event} failed (${err.code}):`, err.cause);
    return req.reject(err.status, err.message);
  }
}

module.exports = VectorDocumentService;
