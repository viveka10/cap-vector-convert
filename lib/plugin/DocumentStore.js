'use strict';

const { HanaVectorPublisher } = require('../HanaVectorPublisher');
const { SUPPORTED_TYPES } = require('../extractors');
const { HanaVectorPublisherError, ERROR_CODES } = require('../errors');
const { randomUUID } = require('../utils');

// @sap/cds is a peer dependency: always use the parent application's instance
let _cds;
function cds() {
  if (!_cds) _cds = require('@sap/cds');
  return _cds;
}

const DOCUMENTS = 'cap.hana.vector.Documents';
const CHUNKS = 'cap.hana.vector.DocumentChunks';

const STATUS = Object.freeze({ PENDING: 'PENDING', EMBEDDED: 'EMBEDDED', FAILED: 'FAILED', SKIPPED: 'SKIPPED' });
const MAX_STATUS_MESSAGE = 1000;

/** Header fields reset on every (re-)upload */
const RESET = Object.freeze({
  fileType: null,
  pageCount: null,
  chunkCount: null,
  characterCount: null,
  status: STATUS.PENDING,
  statusMessage: null,
  modelId: null,
  embeddedAt: null
});

/**
 * Keeps cap.hana.vector.Documents (one row per upload) in sync with the chunks
 * stored by HanaVectorPublisher in cap.hana.vector.DocumentChunks. Shared by the
 * VectorDocumentService handlers and the catch-up job of the CAP plugin.
 */
class DocumentStore {
  /**
   * @param {object} db     CAP database service
   * @param {object} config result of resolvePluginConfig()
   */
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.publisher = new HanaVectorPublisher(db, config.publisher);
    this.LOG = cds().log('hana-vector-publisher');
  }

  get isHana() {
    return this.publisher.isHana;
  }

  /**
   * Stores the header row and the chunks in the current transaction. In background
   * mode on HANA the result has embedLater: true; the caller starts embedDocument()
   * once the transaction has committed.
   */
  async upload({ fileName, mimeType, content, metadata, documentId, replace } = {}) {
    if (typeof fileName !== 'string' || !fileName.trim()) throw badInput('fileName must be a non-empty string');
    if (content === undefined || content === null || content === '') throw badInput('content is required');
    if (replace && !documentId) throw badInput('replace: true requires a documentId');
    if (documentId !== undefined && documentId !== null && (typeof documentId !== 'string' || !documentId)) {
      throw badInput('documentId must be a non-empty string');
    }
    let metadataJson = metadata === undefined || metadata === '' ? null : metadata;
    if (metadataJson !== null && typeof metadataJson !== 'string') {
      try {
        metadataJson = JSON.stringify(metadataJson);
      } catch (err) {
        throw new HanaVectorPublisherError('metadata must be JSON-serialisable', ERROR_CODES.INVALID_INPUT, { cause: err, status: 400 });
      }
    }

    const { SELECT, INSERT, UPDATE } = cds().ql;
    const ID = documentId || randomUUID();
    const existing = documentId ? await this.db.run(SELECT.one.from(DOCUMENTS, documentId).columns('ID')) : null;
    if (existing && !replace) {
      throw new HanaVectorPublisherError(`Document ${documentId} already exists - pass replace: true to replace it`, ERROR_CODES.INVALID_INPUT, {
        status: 409
      });
    }

    const header = { ...RESET, fileName, mimeType: mimeType || null, metadata: metadataJson };
    if (existing) await this.db.run(UPDATE(DOCUMENTS, ID).set(header));
    else await this.db.run(INSERT.into(DOCUMENTS).entries({ ID, ...header }));

    const sync = this.config.embedding.mode === 'sync';
    const result = await this.publisher.processAndStore({
      fileBuffer: content,
      fileName,
      mimeType: mimeType || undefined,
      documentId: ID,
      replace: !!existing,
      metadata: metadataJson === null ? undefined : metadataJson,
      tableName: CHUNKS,
      embed: sync
    });

    let status = STATUS.PENDING;
    if (result.embedded) status = STATUS.EMBEDDED;
    else if (!this.isHana) status = STATUS.SKIPPED;
    await this.db.run(
      UPDATE(DOCUMENTS, ID).set({
        mimeType: mimeType || SUPPORTED_TYPES[result.fileType],
        fileType: result.fileType,
        pageCount: result.pageCount === undefined ? null : result.pageCount,
        chunkCount: result.chunkCount,
        characterCount: result.characterCount,
        status,
        ...(result.embedded && { modelId: result.modelId, embeddedAt: new Date().toISOString() })
      })
    );

    return {
      documentId: ID,
      status,
      chunkCount: result.chunkCount,
      pageCount: result.pageCount === undefined ? null : result.pageCount,
      embedLater: status === STATUS.PENDING
    };
  }

  /** Deletes the header row and its chunks. Returns the number of deleted chunks. */
  async deleteDocument(documentId) {
    const { DELETE } = cds().ql;
    await this._assertExists(documentId);
    const chunks = await this.publisher.deleteDocument({ tableName: CHUNKS, documentId });
    await this.db.run(DELETE.from(DOCUMENTS, documentId));
    return typeof chunks === 'number' ? chunks : 0;
  }

  /**
   * Embeds the pending chunks of one document and marks it EMBEDDED.
   * Errors are thrown; mark the document FAILED with markFailed().
   * Returns the number of embedded chunks (0 on databases without VECTOR_EMBEDDING).
   */
  async embedDocument(documentId) {
    const { UPDATE } = cds().ql;
    await this._assertExists(documentId);
    if (!this.isHana) return 0;
    const count = await this.publisher.embedPending({ tableName: CHUNKS, documentId });
    await this.db.run(UPDATE(DOCUMENTS, documentId).set(this._embeddedState()));
    return count;
  }

  /** embedDocument() for background jobs: never throws, records failures as FAILED. */
  async embedAndTrack(documentId) {
    try {
      return await this.embedDocument(documentId);
    } catch (err) {
      this.LOG.error(`Embedding of document ${documentId} failed`, err);
      try {
        await this.markFailed(documentId, err);
      } catch (e) {
        this.LOG.error(`Could not mark document ${documentId} as ${STATUS.FAILED}`, e);
      }
      return 0;
    }
  }

  async markFailed(documentId, err) {
    const { UPDATE } = cds().ql;
    const message = String((err && err.message) || err).slice(0, MAX_STATUS_MESSAGE);
    await this.db.run(UPDATE(DOCUMENTS, documentId).set({ status: STATUS.FAILED, statusMessage: message }));
  }

  /**
   * Embeds every pending chunk of the table, then marks each PENDING/FAILED
   * document whose chunks all have an embedding as EMBEDDED.
   * Returns the number of embedded chunks (0 on databases without VECTOR_EMBEDDING).
   */
  async embedAllPending() {
    if (!this.isHana) return 0;
    const { SELECT, UPDATE } = cds().ql;
    const count = await this.publisher.embedPending({ tableName: CHUNKS });
    const stillPending = SELECT.from(CHUNKS).columns('documentId').where('embedding is null and documentId is not null');
    await this.db.run(
      UPDATE(DOCUMENTS)
        .set(this._embeddedState())
        .where({ status: { in: [STATUS.PENDING, STATUS.FAILED] }, ID: { 'not in': stillPending } })
    );
    return count;
  }

  /** Similarity search (text match on non-HANA databases). top is clamped to search.maxTop. */
  async search({ query, top, documentId } = {}) {
    const { defaultTop, maxTop } = this.config.search;
    if (top === undefined || top === null) top = defaultTop;
    if (!Number.isInteger(top) || top < 1) throw badInput('top must be a positive integer');
    const hits = await this.publisher.search({
      tableName: CHUNKS,
      query,
      top: Math.min(top, maxTop),
      documentId: documentId || undefined
    });
    return hits.map(h => ({
      documentId: h.documentId,
      chunkId: h.ID,
      fileName: h.fileName,
      chunkIndex: h.chunkIndex,
      content: h.content,
      score: h.score
    }));
  }

  _embeddedState() {
    return { status: STATUS.EMBEDDED, statusMessage: null, modelId: this.publisher.options.modelId, embeddedAt: new Date().toISOString() };
  }

  async _assertExists(documentId) {
    const { SELECT } = cds().ql;
    if (typeof documentId !== 'string' || !documentId) throw badInput('documentId must be a non-empty string');
    const row = await this.db.run(SELECT.one.from(DOCUMENTS, documentId).columns('ID'));
    if (!row) {
      throw new HanaVectorPublisherError(`Document ${documentId} not found`, ERROR_CODES.INVALID_INPUT, { status: 404 });
    }
  }
}

function badInput(message) {
  return new HanaVectorPublisherError(message, ERROR_CODES.INVALID_INPUT, { status: 400 });
}

module.exports = { DocumentStore, DOCUMENTS, CHUNKS, STATUS };
