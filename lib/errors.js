'use strict';

const ERROR_CODES = Object.freeze({
  INVALID_DB: 'INVALID_DB',
  INVALID_OPTIONS: 'INVALID_OPTIONS',
  INVALID_INPUT: 'INVALID_INPUT',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  NO_TEXT_EXTRACTED: 'NO_TEXT_EXTRACTED',
  UNSUPPORTED_DATABASE: 'UNSUPPORTED_DATABASE',
  DB_INSERT_FAILED: 'DB_INSERT_FAILED',
  EMBEDDING_FAILED: 'EMBEDDING_FAILED',
  SEARCH_FAILED: 'SEARCH_FAILED'
});

/**
 * Single error type thrown by this package. Inspect `code` to branch on the
 * failure; `cause` carries the underlying error (pdf-parse, database driver, ...).
 * `status` maps to an HTTP status so CAP handlers can pass it to `req.reject`.
 */
class HanaVectorPublisherError extends Error {
  constructor(message, code, { cause, status = 500, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HanaVectorPublisherError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { HanaVectorPublisherError, ERROR_CODES };
