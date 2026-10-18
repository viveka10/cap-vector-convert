'use strict';

const { chunkText, normalizeText } = require('./chunker');
const { extractText, SUPPORTED_TYPES } = require('./extractors');
const { toBuffer, quoteIdentifier, persistenceName, affectedRows, randomUUID } = require('./utils');
const { HanaVectorPublisherError, ERROR_CODES } = require('./errors');

// @sap/cds is a peer dependency: always use the parent application's instance
let _cds;
function cds() {
  if (!_cds) _cds = require('@sap/cds');
  return _cds;
}

const DEFAULT_COLUMNS = Object.freeze({
  id: 'ID',
  documentId: 'documentId',
  fileName: 'fileName',
  mimeType: 'mimeType',
  chunkIndex: 'chunkIndex',
  content: 'content',
  metadata: 'metadata',
  embedding: 'embedding'
});

const DEFAULTS = Object.freeze({
  chunkSize: 1000,
  chunkOverlap: 150,
  modelId: 'SAP_NEB.20240715',
  embeddingType: 'DOCUMENT',
  wrapToRealVector: true,
  batchSize: 200,
  maxFileSize: 50 * 1024 * 1024,
  maxChunks: 10000,
  keepMarkdown: false,
  encoding: undefined,
  onUnsupportedDatabase: 'throw',
  sqlTableName: undefined,
  columns: DEFAULT_COLUMNS
});

const MODEL_ID = /^[A-Za-z0-9_.\-]+$/;

/** Upper bound for search({ top }); top is inlined into the SQL, so it must be a validated integer */
const MAX_SEARCH_TOP = 1000;
const MAX_QUERY_LENGTH = 2000;

function invalid(message) {
  return new HanaVectorPublisherError(message, ERROR_CODES.INVALID_OPTIONS, { status: 500 });
}

function resolveOptions(options) {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw invalid('options must be an object');
  }
  const o = { ...DEFAULTS, ...options, columns: { ...DEFAULT_COLUMNS, ...(options && options.columns) } };

  for (const key of ['chunkSize', 'batchSize', 'maxFileSize', 'maxChunks']) {
    if (!Number.isInteger(o[key]) || o[key] < 1) throw invalid(`options.${key} must be a positive integer`);
  }
  if (!Number.isInteger(o.chunkOverlap) || o.chunkOverlap < 0 || o.chunkOverlap >= o.chunkSize) {
    throw invalid('options.chunkOverlap must be an integer >= 0 and smaller than options.chunkSize');
  }
  // modelId and embeddingType are inlined as SQL literals, so they are strictly validated
  if (typeof o.modelId !== 'string' || !MODEL_ID.test(o.modelId)) {
    throw invalid(`options.modelId contains invalid characters: ${JSON.stringify(o.modelId)}`);
  }
  o.embeddingType = String(o.embeddingType).toUpperCase();
  if (!['DOCUMENT', 'QUERY'].includes(o.embeddingType)) throw invalid("options.embeddingType must be 'DOCUMENT' or 'QUERY'");
  if (!['throw', 'skipEmbeddings'].includes(o.onUnsupportedDatabase)) {
    throw invalid("options.onUnsupportedDatabase must be 'throw' or 'skipEmbeddings'");
  }
  for (const key of ['documentId', 'content', 'embedding']) {
    if (!o.columns[key]) throw invalid(`options.columns.${key} is required`);
  }
  return Object.freeze(o);
}

/** [columns key, result key] of the fields a search hit carries */
const SEARCH_FIELDS = [
  ['id', 'ID'],
  ['documentId', 'documentId'],
  ['fileName', 'fileName'],
  ['chunkIndex', 'chunkIndex'],
  ['content', 'content']
];

function toHit(row, score) {
  const hit = {};
  for (const [, key] of SEARCH_FIELDS) if (row[key] !== undefined) hit[key] = row[key];
  hit.score = score;
  return hit;
}

function validTop(top) {
  if (!Number.isInteger(top) || top < 1 || top > MAX_SEARCH_TOP) {
    throw new HanaVectorPublisherError(`top must be an integer between 1 and ${MAX_SEARCH_TOP}`, ERROR_CODES.INVALID_INPUT, { status: 400 });
  }
  return top;
}

/**
 * Converts uploaded documents (PDF, TXT, MD) into overlapping text chunks and
 * stores them in SAP HANA Cloud, letting HANA compute the embeddings in-database
 * with VECTOR_EMBEDDING - no external embedding service or API key required.
 */
class HanaVectorPublisher {
  /**
   * @param {object} db   CAP database service, e.g. `cds.db` or `await cds.connect.to('db')`
   * @param {object} [options] see DEFAULTS / README
   */
  constructor(db, options) {
    if (!db || typeof db.run !== 'function') {
      throw new HanaVectorPublisherError(
        'A CAP database service with a run() method is required, e.g. cds.db or await cds.connect.to("db")',
        ERROR_CODES.INVALID_DB,
        { status: 500 }
      );
    }
    this.db = db;
    this.options = resolveOptions(options);
  }

  /** True when the bound database is SAP HANA (VECTOR_EMBEDDING available). */
  get isHana() {
    const kind = this.db.kind || (this.db.options && this.db.options.kind) || '';
    return /hana/i.test(kind);
  }

  /**
   * Extracts, chunks and stores one document.
   *
   * @param {object} params
   * @param {Buffer|Uint8Array|ArrayBuffer|string|NodeJS.ReadableStream} params.fileBuffer  file content (string = base64)
   * @param {string} params.fileName   original file name, used for type detection and stored per chunk
   * @param {string} params.tableName  CDS entity name (e.g. 'my.app.DocumentChunks') whose entity includes VectorStore
   * @param {string} [params.mimeType] overrides type detection by extension
   * @param {string} [params.documentId] groups the chunks; generated when omitted
   * @param {boolean} [params.replace] delete existing chunks of `documentId` first (same transaction)
   * @param {object} [params.metadata] JSON-serialisable data stored with every chunk
   * @param {boolean} [params.embed] false stores the chunks only; compute the vectors later with embedPending()
   */
  async processAndStore({ fileBuffer, fileName, tableName, mimeType, documentId, replace = false, metadata, embed = true } = {}) {
    if (fileBuffer === undefined || fileBuffer === null) throw this._badInput('fileBuffer is required');
    if (typeof fileName !== 'string' || !fileName.trim()) throw this._badInput('fileName must be a non-empty string');
    if (typeof tableName !== 'string' || !tableName.trim()) throw this._badInput('tableName must be a non-empty string');
    if (documentId !== undefined && (typeof documentId !== 'string' || !documentId)) throw this._badInput('documentId must be a non-empty string');
    if (replace && !documentId) throw this._badInput('replace: true requires a documentId');

    const o = this.options;
    const embedNow = embed !== false && this._shouldEmbed();
    const buffer = await toBuffer(fileBuffer, o.maxFileSize);
    if (!buffer.length) throw this._badInput('The uploaded file is empty');

    const { type, text, pages } = await extractText(buffer, {
      fileName,
      mimeType,
      encoding: o.encoding,
      keepMarkdown: o.keepMarkdown
    });

    const chunks = this.chunk(text);
    if (!chunks.length) {
      throw new HanaVectorPublisherError(
        type === 'pdf'
          ? `No text could be extracted from "${fileName}". Scanned/image-only PDFs need OCR before upload.`
          : `"${fileName}" contains no text`,
        ERROR_CODES.NO_TEXT_EXTRACTED,
        { status: 422 }
      );
    }
    if (chunks.length > o.maxChunks) {
      throw new HanaVectorPublisherError(
        `"${fileName}" produced ${chunks.length} chunks, more than options.maxChunks (${o.maxChunks})`,
        ERROR_CODES.FILE_TOO_LARGE,
        { status: 413 }
      );
    }

    const docId = documentId || randomUUID();
    const rows = this._buildRows(chunks, { documentId: docId, fileName, mimeType: mimeType || SUPPORTED_TYPES[type], metadata });

    await this._inTransaction(async tx => {
      if (replace) await this._delete(tx, tableName, documentId);
      await this._insertRows(tx, tableName, rows);
      if (embedNow) await this._embed(tx, tableName, docId);
    });

    return {
      documentId: docId,
      fileName,
      fileType: type,
      tableName,
      chunkCount: chunks.length,
      characterCount: chunks.reduce((n, c) => n + c.length, 0),
      pageCount: pages,
      embedded: embedNow,
      modelId: embedNow ? o.modelId : undefined
    };
  }

  /** Extracts text only - useful for previews or custom pipelines. */
  async extractText({ fileBuffer, fileName, mimeType } = {}) {
    const buffer = await toBuffer(fileBuffer, this.options.maxFileSize);
    const { text, ...rest } = await extractText(buffer, {
      fileName,
      mimeType,
      encoding: this.options.encoding,
      keepMarkdown: this.options.keepMarkdown
    });
    return { ...rest, text: normalizeText(text) };
  }

  /** Chunks text with the configured chunkSize / chunkOverlap. */
  chunk(text) {
    return chunkText(text, { chunkSize: this.options.chunkSize, chunkOverlap: this.options.chunkOverlap });
  }

  /** Removes every chunk stored for a document. Returns the number of deleted rows. */
  async deleteDocument({ tableName, documentId } = {}) {
    if (typeof tableName !== 'string' || !tableName) throw this._badInput('tableName must be a non-empty string');
    if (typeof documentId !== 'string' || !documentId) throw this._badInput('documentId must be a non-empty string');
    return this._delete(this.db, tableName, documentId);
  }

  /**
   * Computes embeddings for chunks that don't have one yet.
   * With documentId: only that document. Without: every pending row in the table.
   * Returns the number of updated rows.
   */
  async embedPending({ tableName, documentId } = {}) {
    if (typeof tableName !== 'string' || !tableName.trim()) throw this._badInput('tableName must be a non-empty string');
    if (documentId !== undefined && (typeof documentId !== 'string' || !documentId)) throw this._badInput('documentId must be a non-empty string');
    if (!this._shouldEmbed()) return 0;
    return this._inTransaction(tx => this._embed(tx, tableName, documentId));
  }

  // ---------------------------------------------------------------- internals

  _badInput(message) {
    return new HanaVectorPublisherError(message, ERROR_CODES.INVALID_INPUT, { status: 400 });
  }

  _shouldEmbed() {
    if (this.isHana) return true;
    if (this.options.onUnsupportedDatabase === 'skipEmbeddings') {
      cds().log('hana-vector-publisher').warn(
        `Database kind "${this.db.kind}" does not support VECTOR_EMBEDDING - storing chunks without embeddings`
      );
      return false;
    }
    throw this._unsupportedDatabase();
  }

  _buildRows(chunks, { documentId, fileName, mimeType, metadata }) {
    const c = this.options.columns;
    let metadataJson;
    if (metadata !== undefined && metadata !== null) {
      try {
        metadataJson = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
      } catch (err) {
        throw new HanaVectorPublisherError('metadata must be JSON-serialisable', ERROR_CODES.INVALID_INPUT, { cause: err, status: 400 });
      }
    }
    return chunks.map((content, index) => {
      const row = {};
      if (c.id) row[c.id] = randomUUID();
      row[c.documentId] = documentId;
      if (c.fileName) row[c.fileName] = fileName;
      if (c.mimeType) row[c.mimeType] = mimeType;
      if (c.chunkIndex) row[c.chunkIndex] = index;
      row[c.content] = content;
      if (c.metadata && metadataJson !== undefined) row[c.metadata] = metadataJson;
      return row;
    });
  }

  /**
   * Inside a CAP request handler cds.context.tx exists and db.run() joins it, so
   * the upload commits or rolls back together with the request. Elsewhere
   * (scripts, jobs) a dedicated transaction keeps insert + embedding atomic.
   */
  async _inTransaction(fn) {
    const ctx = cds().context;
    if ((ctx && ctx.tx) || typeof this.db.tx !== 'function') return fn(this.db);
    return this.db.tx(fn);
  }

  async _insertRows(tx, tableName, rows) {
    const { INSERT } = cds().ql;
    const { batchSize } = this.options;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      try {
        await tx.run(INSERT.into(tableName).entries(batch));
      } catch (err) {
        throw new HanaVectorPublisherError(
          `Failed to insert chunks ${i}-${i + batch.length - 1} into ${tableName}: ${err.message}`,
          ERROR_CODES.DB_INSERT_FAILED,
          { cause: err, status: 500 }
        );
      }
    }
  }

  /**
   * CQL binds every value as a parameter, so INSERT.entries() cannot carry the
   * VECTOR_EMBEDDING() SQL function. The chunks are therefore inserted via CQL
   * first and their embeddings computed in one set-based UPDATE that reads the
   * text straight from the content column - the text never travels twice.
   *
   * With allPending: true the statement covers every row without an embedding
   * and takes no parameters.
   */
  buildEmbeddingSql(tableName, { allPending = false } = {}) {
    const o = this.options;
    const c = o.columns;
    const { table, col } = this._sqlNames(tableName);

    let expr = `VECTOR_EMBEDDING(${col(c.content)}, '${o.embeddingType}', '${o.modelId}')`;
    if (o.wrapToRealVector) expr = `TO_REAL_VECTOR(${expr})`;
    const where = allPending ? `${col(c.embedding)} IS NULL` : `${col(c.documentId)} = ? AND ${col(c.embedding)} IS NULL`;
    return `UPDATE ${table} SET ${col(c.embedding)} = ${expr} WHERE ${where}`;
  }

  /**
   * Similarity search. Returns [{ ID, documentId, fileName, chunkIndex, content, score }],
   * best match first. On databases without VECTOR_EMBEDDING and with
   * onUnsupportedDatabase: 'skipEmbeddings', falls back to a case-insensitive
   * substring match on the content column (score: null).
   *
   * @param {object} params
   * @param {string} params.tableName  CDS entity name of the chunk table
   * @param {string} params.query      search text, embedded with the 'QUERY' embedding type
   * @param {number} [params.top]      max number of hits (integer 1-1000). Default 5
   * @param {string} [params.documentId] restrict the search to one document
   * @param {number} [params.minScore] drop hits with a lower cosine similarity (applied after the query)
   */
  async search({ tableName, query, top = 5, documentId, minScore } = {}) {
    if (typeof tableName !== 'string' || !tableName.trim()) throw this._badInput('tableName must be a non-empty string');
    if (typeof query !== 'string' || !query.trim()) throw this._badInput('query must be a non-empty string');
    if (query.length > MAX_QUERY_LENGTH) throw this._badInput(`query must not be longer than ${MAX_QUERY_LENGTH} characters`);
    if (documentId !== undefined && documentId !== null && (typeof documentId !== 'string' || !documentId)) {
      throw this._badInput('documentId must be a non-empty string');
    }
    if (minScore !== undefined && minScore !== null && !Number.isFinite(minScore)) throw this._badInput('minScore must be a number');
    validTop(top);
    const withDocument = documentId !== undefined && documentId !== null;

    if (!this.isHana) {
      if (this.options.onUnsupportedDatabase !== 'skipEmbeddings') throw this._unsupportedDatabase();
      return this._textSearch(tableName, { query, top, documentId: withDocument ? documentId : undefined });
    }

    const sql = this.buildSearchSql(tableName, { withDocument, top });
    let rows;
    try {
      rows = await this.db.run(sql, withDocument ? [query, documentId] : [query]);
    } catch (err) {
      throw new HanaVectorPublisherError(`Similarity search on ${tableName} failed: ${err.message}${this._nlpHint(err)}`, ERROR_CODES.SEARCH_FAILED, {
        cause: err,
        status: 500
      });
    }
    const hits = (rows || []).map(row => toHit(row, row.score === null || row.score === undefined ? null : Number(row.score)));
    return typeof minScore === 'number' ? hits.filter(h => h.score !== null && h.score >= minScore) : hits;
  }

  /**
   * Returns the parameterised similarity search statement. Parameters:
   * [query] or, with withDocument: true, [query, documentId].
   * The column aliases match the keys of the hits returned by search().
   */
  buildSearchSql(tableName, { withDocument = false, top = 5 } = {}) {
    const o = this.options;
    const c = o.columns;
    const { table, col } = this._sqlNames(tableName);
    const limit = validTop(top);

    let queryVector = `VECTOR_EMBEDDING(?, 'QUERY', '${o.modelId}')`;
    if (o.wrapToRealVector) queryVector = `TO_REAL_VECTOR(${queryVector})`;
    const select = [];
    for (const [field, alias] of SEARCH_FIELDS) if (c[field]) select.push(`${col(c[field])} AS "${alias}"`);
    select.push(`COSINE_SIMILARITY(${col(c.embedding)}, ${queryVector}) AS "score"`);
    const where = withDocument ? `${col(c.embedding)} IS NOT NULL AND ${col(c.documentId)} = ?` : `${col(c.embedding)} IS NOT NULL`;
    return `SELECT ${select.join(', ')} FROM ${table} WHERE ${where} ORDER BY "score" DESC LIMIT ${limit}`;
  }

  /** Without documentId every pending row of the table is embedded. Returns the affected row count. */
  async _embed(tx, tableName, documentId) {
    const sql = documentId === undefined ? this.buildEmbeddingSql(tableName, { allPending: true }) : this.buildEmbeddingSql(tableName);
    try {
      const res = await (documentId === undefined ? tx.run(sql) : tx.run(sql, [documentId]));
      return affectedRows(res);
    } catch (err) {
      throw new HanaVectorPublisherError(`Failed to compute embeddings for ${tableName}: ${err.message}${this._nlpHint(err)}`, ERROR_CODES.EMBEDDING_FAILED, {
        cause: err,
        status: 500
      });
    }
  }

  async _delete(tx, tableName, documentId) {
    const { DELETE } = cds().ql;
    try {
      return await tx.run(DELETE.from(tableName).where({ [this.options.columns.documentId]: documentId }));
    } catch (err) {
      throw new HanaVectorPublisherError(`Failed to delete chunks of document ${documentId}: ${err.message}`, ERROR_CODES.DB_INSERT_FAILED, {
        cause: err,
        status: 500
      });
    }
  }

  _nlpHint(err) {
    if (!/vector_embedding|nlp|not (enabled|supported)|invalid (function|name)/i.test((err && err.message) || '')) return '';
    return (
      " - make sure the 'Natural Language Processing (NLP)' additional feature is enabled on your SAP HANA Cloud instance" +
      ` and that model '${this.options.modelId}' is available`
    );
  }

  /** Quoted physical table name and a column-name helper for the hand-written SQL statements. */
  _sqlNames(tableName) {
    const definition = this._definition(tableName);
    const col = name => quoteIdentifier(persistenceName(name, definition && definition.elements && definition.elements[name]), 'column');
    const table = quoteIdentifier(this.options.sqlTableName || persistenceName(tableName, definition), 'table name');
    return { table, col };
  }

  /** Fallback for databases without VECTOR_EMBEDDING: case-insensitive substring match, no ranking. */
  async _textSearch(tableName, { query, top, documentId }) {
    const { SELECT } = cds().ql;
    const c = this.options.columns;
    if (!this._textSearchWarned) {
      this._textSearchWarned = true;
      cds().log('hana-vector-publisher').warn(
        `Database kind "${this.db.kind}" does not support VECTOR_EMBEDDING - search falls back to a plain text match without scores`
      );
    }
    const columns = SEARCH_FIELDS.filter(([field]) => c[field]).map(([field, alias]) => ({ ref: [c[field]], as: alias }));
    const where = [{ func: 'contains', args: [{ func: 'tolower', args: [{ ref: [c.content] }] }, { val: query.trim().toLowerCase() }] }];
    if (documentId !== undefined) where.push('and', { ref: [c.documentId] }, '=', { val: documentId });
    const q = SELECT.from(tableName).columns(columns).where(where).limit(top);
    q.orderBy(...[c.documentId, c.chunkIndex].filter(Boolean));
    let rows;
    try {
      rows = await this.db.run(q);
    } catch (err) {
      throw new HanaVectorPublisherError(`Text search on ${tableName} failed: ${err.message}`, ERROR_CODES.SEARCH_FAILED, { cause: err, status: 500 });
    }
    return (rows || []).map(row => toHit(row, null));
  }

  _unsupportedDatabase() {
    return new HanaVectorPublisherError(
      `VECTOR_EMBEDDING requires SAP HANA Cloud, but the bound database is "${this.db.kind || 'unknown'}". ` +
        "Use the 'hybrid'/'production' profile or set options.onUnsupportedDatabase = 'skipEmbeddings' for local tests.",
      ERROR_CODES.UNSUPPORTED_DATABASE,
      { status: 500 }
    );
  }

  _definition(tableName) {
    const model = this.db.model || cds().model;
    return model && model.definitions ? model.definitions[tableName] : undefined;
  }
}

module.exports = { HanaVectorPublisher, DEFAULTS, MAX_SEARCH_TOP, resolveOptions };
