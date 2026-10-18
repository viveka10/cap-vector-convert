'use strict';

const path = require('path');
const { HanaVectorPublisherError, ERROR_CODES } = require('./errors');

const SUPPORTED_TYPES = Object.freeze({
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown'
});

const EXTENSION_MAP = {
  '.pdf': 'pdf',
  '.txt': 'txt',
  '.text': 'txt',
  '.log': 'txt',
  '.csv': 'txt',
  '.md': 'md',
  '.markdown': 'md',
  '.mdx': 'md'
};

const MIME_MAP = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md'
};

function isPdfBuffer(buffer) {
  // "%PDF-" may be preceded by a few junk bytes; the spec allows it within the first 1 KB
  return buffer.subarray(0, 1024).includes('%PDF-', 0, 'latin1');
}

/**
 * Resolves 'pdf' | 'txt' | 'md' from (in order) the MIME type, the file
 * extension and finally the PDF magic bytes. Returns null when unknown.
 */
function detectFileType({ fileName, mimeType, buffer } = {}) {
  const mime = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
  if (MIME_MAP[mime]) return MIME_MAP[mime];

  const ext = typeof fileName === 'string' ? path.extname(fileName).toLowerCase() : '';
  if (EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];

  if (Buffer.isBuffer(buffer) && isPdfBuffer(buffer)) return 'pdf';
  if (mime.startsWith('text/')) return 'txt';
  return null;
}

/** Decodes text honouring UTF-8 / UTF-16 BOMs; invalid bytes become U+FFFD instead of throwing. */
function decodeText(buffer, encoding) {
  if (encoding) return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  // TextDecoder strips a UTF-8 BOM by default
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

/**
 * Reduces Markdown to readable prose so that syntax characters do not dilute
 * the embedding. Code blocks, link texts and image alt texts are kept.
 */
function stripMarkdown(md) {
  return md
    .replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, '') // YAML front matter
    .replace(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm, '$2') // fenced code: keep body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, '') // reference link definitions
    .replace(/<\/?[A-Za-z][^>]*>/g, '') // inline HTML tags
    .replace(/^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/gm, '$1') // ATX headings
    .replace(/^ {0,3}>[ \t]?/gm, '') // blockquotes
    .replace(/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/gm, '') // horizontal rules
    .replace(/^\s*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?\s*$/gm, '') // table separator rows
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // bold
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2') // italic *x*
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2') // italic _x_
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
}

let pdfParse; // lazy: only loaded when a PDF is actually processed
function loadPdfParse() {
  if (!pdfParse) {
    // Require the library file directly: pdf-parse's index.js runs a debug
    // routine that reads a test PDF from disk when it thinks it is the main module.
    pdfParse = require('pdf-parse/lib/pdf-parse.js');
  }
  return pdfParse;
}

async function extractPdf(buffer, { pdfOptions } = {}) {
  let result;
  try {
    result = await loadPdfParse()(buffer, pdfOptions);
  } catch (err) {
    const encrypted = /password|encrypt/i.test(err?.message || '');
    throw new HanaVectorPublisherError(
      encrypted ? 'PDF is password protected or encrypted' : `Failed to parse PDF: ${err?.message || err}`,
      ERROR_CODES.EXTRACTION_FAILED,
      { cause: err, status: 422 }
    );
  }
  return { text: result?.text || '', pages: result?.numpages, info: result?.info };
}

/**
 * Extracts raw text from a document buffer.
 * @returns {Promise<{ type: 'pdf'|'txt'|'md', text: string, pages?: number }>}
 */
async function extractText(buffer, { fileName, mimeType, encoding, keepMarkdown = false, pdfOptions } = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new HanaVectorPublisherError('extractText expects a Buffer', ERROR_CODES.INVALID_INPUT, { status: 400 });
  }
  const type = detectFileType({ fileName, mimeType, buffer });
  if (!type) {
    throw new HanaVectorPublisherError(
      `Unsupported file type for "${fileName}"${mimeType ? ` (${mimeType})` : ''}. Supported: ${Object.keys(SUPPORTED_TYPES).join(', ')}`,
      ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      { status: 415 }
    );
  }

  if (type === 'pdf') {
    const { text, pages } = await extractPdf(buffer, { pdfOptions });
    return { type, text, pages };
  }

  let text;
  try {
    text = decodeText(buffer, encoding);
  } catch (err) {
    throw new HanaVectorPublisherError(`Failed to decode text: ${err.message}`, ERROR_CODES.EXTRACTION_FAILED, { cause: err, status: 422 });
  }
  if (type === 'md' && !keepMarkdown) text = stripMarkdown(text);
  return { type, text };
}

module.exports = { extractText, detectFileType, decodeText, stripMarkdown, SUPPORTED_TYPES };
