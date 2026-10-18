'use strict';

const { HanaVectorPublisherError, ERROR_CODES } = require('./errors');

// Boundaries tried from coarsest to finest. Each piece remembers the joiner of
// the level it was split at, so merged chunks keep paragraph/line/word breaks.
const SPLIT_LEVELS = [
  { pattern: /\n{2,}/, joiner: '\n\n' }, // paragraphs
  { pattern: /\n/, joiner: '\n' }, // lines
  { pattern: /(?<=[.!?;:。！？])\s+/u, joiner: ' ' }, // sentences (incl. CJK punctuation)
  { pattern: /\s+/, joiner: ' ' } // words
];

/** Length in Unicode code points, so emoji / astral characters count as one. */
function cpLength(str) {
  let n = 0;
  for (const _ of str) n++; // eslint-disable-line no-unused-vars
  return n;
}

/**
 * Cleans extracted text so it is safe to bind as NVARCHAR/NCLOB and chunk:
 * Unicode NFKC normalisation, unified line endings, no control characters,
 * no lone surrogates, no zero-width noise, collapsed whitespace and
 * re-joined words that PDFs hyphenate across line breaks.
 */
function normalizeText(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') // lone surrogates
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g, ' ') // control chars (keeps \t, \n, \f)
    .replace(/\f/g, '\n\n') // PDF page breaks become paragraph breaks
    .replace(/[​⁠﻿­]/g, '') // zero-width space, word joiner, BOM, soft hyphen
    .replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1') // "embed-\nding" -> "embedding"
    .replace(/[ \t\v  -   　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hardSplit(text, chunkSize, joiner) {
  const chars = Array.from(text); // never cuts a surrogate pair in half
  const out = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    out.push({ text: chars.slice(i, i + chunkSize).join(''), joiner: i === 0 ? joiner : '' });
  }
  return out;
}

function splitRecursive(text, chunkSize, level, joiner) {
  if (cpLength(text) <= chunkSize) return [{ text, joiner }];
  if (level >= SPLIT_LEVELS.length) return hardSplit(text, chunkSize, joiner);

  const { pattern, joiner: levelJoiner } = SPLIT_LEVELS[level];
  const parts = text.split(pattern).map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return splitRecursive(text, chunkSize, level + 1, joiner);

  const pieces = [];
  parts.forEach((part, i) => {
    const sub = splitRecursive(part, chunkSize, level + 1, levelJoiner);
    // the first piece of the first part keeps the joiner inherited from the parent level
    if (i === 0 && sub.length) sub[0] = { ...sub[0], joiner };
    pieces.push(...sub);
  });
  return pieces;
}

function windowLength(win) {
  return win.reduce((sum, p, i) => sum + p.len + (i > 0 ? cpLength(p.joiner) : 0), 0);
}

function joinWindow(win) {
  return win.map((p, i) => (i > 0 ? p.joiner + p.text : p.text)).join('');
}

/**
 * Splits text into overlapping chunks of at most `chunkSize` code points.
 * Prefers paragraph, then line, sentence and word boundaries; only falls back
 * to a hard character split for tokens longer than `chunkSize` (e.g. base64).
 * Consecutive chunks share up to `chunkOverlap` code points of trailing context.
 *
 * @param {string} text
 * @param {{ chunkSize?: number, chunkOverlap?: number, normalize?: boolean }} [opts]
 * @returns {string[]}
 */
function chunkText(text, { chunkSize = 1000, chunkOverlap = 150, normalize = true } = {}) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new HanaVectorPublisherError('chunkSize must be a positive integer', ERROR_CODES.INVALID_OPTIONS, { status: 400 });
  }
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new HanaVectorPublisherError(
      'chunkOverlap must be an integer >= 0 and smaller than chunkSize',
      ERROR_CODES.INVALID_OPTIONS,
      { status: 400 }
    );
  }

  const clean = normalize ? normalizeText(text) : String(text ?? '').trim();
  if (!clean) return [];

  const pieces = splitRecursive(clean, chunkSize, 0, '').map(p => ({ ...p, len: cpLength(p.text) }));

  const chunks = [];
  let win = [];
  for (const piece of pieces) {
    const added = win.length ? cpLength(piece.joiner) + piece.len : piece.len;
    if (win.length && windowLength(win) + added > chunkSize) {
      chunks.push(joinWindow(win));
      // keep a tail of the previous chunk as overlap, as long as the new piece still fits
      while (win.length && (windowLength(win) > chunkOverlap || windowLength(win) + cpLength(piece.joiner) + piece.len > chunkSize)) {
        win.shift();
      }
    }
    win.push(piece);
  }
  if (win.length) chunks.push(joinWindow(win));

  return chunks.map(c => c.trim()).filter(Boolean);
}

module.exports = { chunkText, normalizeText, cpLength };
