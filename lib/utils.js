'use strict';

const { HanaVectorPublisherError, ERROR_CODES } = require('./errors');

function tooLarge(maxBytes) {
  return new HanaVectorPublisherError(
    `File exceeds the maximum allowed size of ${maxBytes} bytes`,
    ERROR_CODES.FILE_TOO_LARGE,
    { status: 413 }
  );
}

/**
 * Accepts what CAP handlers typically hand over for uploads - a Buffer, a
 * Uint8Array / ArrayBuffer, a base64 string, or a Readable stream (LargeBinary
 * `@Core.MediaType` properties arrive as streams) - and returns a Buffer.
 * Streams are consumed with a size cap so a huge upload cannot exhaust memory.
 */
async function toBuffer(input, maxBytes) {
  let buffer;
  if (Buffer.isBuffer(input)) buffer = input;
  else if (input instanceof ArrayBuffer) buffer = Buffer.from(input);
  else if (ArrayBuffer.isView(input)) buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  else if (typeof input === 'string') buffer = Buffer.from(input, 'base64');
  else if (input && typeof input[Symbol.asyncIterator] === 'function') {
    const parts = [];
    let size = 0;
    try {
      for await (const chunk of input) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += part.length;
        if (maxBytes && size > maxBytes) {
          if (typeof input.destroy === 'function') input.destroy();
          throw tooLarge(maxBytes);
        }
        parts.push(part);
      }
    } catch (err) {
      if (err instanceof HanaVectorPublisherError) throw err;
      throw new HanaVectorPublisherError(`Failed to read upload stream: ${err.message}`, ERROR_CODES.INVALID_INPUT, { cause: err, status: 400 });
    }
    buffer = Buffer.concat(parts, size);
  } else {
    throw new HanaVectorPublisherError(
      'fileBuffer must be a Buffer, Uint8Array, ArrayBuffer, base64 string or Readable stream',
      ERROR_CODES.INVALID_INPUT,
      { status: 400 }
    );
  }
  if (maxBytes && buffer.length > maxBytes) throw tooLarge(maxBytes);
  return buffer;
}

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$#]*$/;

/** Double-quotes a HANA identifier; rejects anything that is not a plain identifier. */
function quoteIdentifier(name, what = 'identifier') {
  if (typeof name !== 'string' || !SQL_IDENTIFIER.test(name)) {
    throw new HanaVectorPublisherError(`Invalid SQL ${what}: ${JSON.stringify(name)}`, ERROR_CODES.INVALID_OPTIONS, { status: 500 });
  }
  return `"${name}"`;
}

/**
 * Database name of a CDS entity or element under CAP's default `plain`
 * naming mode (dots -> underscores, upper case), unless it is annotated
 * with `@cds.persistence.name`.
 */
function persistenceName(cdsName, definition) {
  const explicit = definition && definition['@cds.persistence.name'];
  if (explicit) return explicit;
  return String(cdsName).replace(/\./g, '_').toUpperCase();
}

function randomUUID() {
  return require('crypto').randomUUID();
}

module.exports = { toBuffer, quoteIdentifier, persistenceName, randomUUID };
