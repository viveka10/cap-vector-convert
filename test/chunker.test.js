'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chunkText, normalizeText, cpLength } = require('../lib/chunker');

test('returns no chunks for empty / whitespace input', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n\t '), []);
  assert.deepEqual(chunkText(undefined), []);
});

test('short text is a single chunk', () => {
  assert.deepEqual(chunkText('Hello world.'), ['Hello world.']);
});

test('chunks never exceed chunkSize and overlap carries context', () => {
  const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about SAP HANA vectors.`);
  const chunks = chunkText(sentences.join(' '), { chunkSize: 200, chunkOverlap: 60 });
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(cpLength(c) <= 200, `chunk too long: ${cpLength(c)}`);
  for (let i = 1; i < chunks.length; i++) {
    const firstSentence = chunks[i].split('. ')[0];
    assert.ok(chunks[i - 1].includes(firstSentence), `chunk ${i} does not overlap with chunk ${i - 1}`);
  }
});

test('prefers paragraph boundaries', () => {
  const p1 = 'A'.repeat(50) + ' first paragraph.';
  const p2 = 'B'.repeat(50) + ' second paragraph.';
  const chunks = chunkText(`${p1}\n\n${p2}`, { chunkSize: 80, chunkOverlap: 0 });
  assert.deepEqual(chunks, [p1, p2]);
});

test('hard-splits unbroken tokens without breaking surrogate pairs', () => {
  const text = '😀'.repeat(25);
  const chunks = chunkText(text, { chunkSize: 10, chunkOverlap: 2 });
  assert.equal(chunks.join(''), text);
  for (const c of chunks) {
    assert.ok(cpLength(c) <= 10);
    assert.doesNotMatch(c, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});

test('normalizeText removes control chars, lone surrogates and zero-width noise', () => {
  const dirty = 'Hel\u0000lo​\r\nwor\uD800ld ﻿\t\t tab\f next page';
  assert.equal(normalizeText(dirty), 'Hel lo\nworld tab\n\nnext page');
});

test('normalizeText re-joins hyphenated line breaks and keeps special characters', () => {
  assert.equal(normalizeText('embed-\nding'), 'embedding');
  assert.equal(normalizeText('Café – naïve “quotes” ’ & <tags> 中文。'), 'Café – naïve “quotes” ’ & <tags> 中文。');
});

test('rejects invalid chunk options', () => {
  assert.throws(() => chunkText('x', { chunkSize: 0 }), { code: 'INVALID_OPTIONS' });
  assert.throws(() => chunkText('x', { chunkSize: 10, chunkOverlap: 10 }), { code: 'INVALID_OPTIONS' });
});
