'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractText, detectFileType, stripMarkdown, decodeText } = require('../lib/extractors');

test('detects file types by mime, extension and magic bytes', () => {
  assert.equal(detectFileType({ fileName: 'a.PDF' }), 'pdf');
  assert.equal(detectFileType({ fileName: 'notes.md' }), 'md');
  assert.equal(detectFileType({ fileName: 'x.bin', mimeType: 'text/plain; charset=utf-8' }), 'txt');
  assert.equal(detectFileType({ fileName: 'noext', buffer: Buffer.from('%PDF-1.7 ...') }), 'pdf');
  assert.equal(detectFileType({ fileName: 'image.png' }), null);
});

test('rejects unsupported types', async () => {
  await assert.rejects(extractText(Buffer.from('x'), { fileName: 'image.png' }), { code: 'UNSUPPORTED_FILE_TYPE', status: 415 });
});

test('decodes UTF-8 and UTF-16 with BOM', () => {
  assert.equal(decodeText(Buffer.from('﻿hällo', 'utf8')), 'hällo');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hällo', 'utf16le')])), 'hällo');
});

test('invalid UTF-8 does not throw', () => {
  assert.equal(decodeText(Buffer.from([0x61, 0xff, 0x62])), 'a�b');
});

test('strips markdown syntax but keeps text', () => {
  const md = '---\ntitle: x\n---\n# Title\n\nSome **bold** and _italic_ with [a link](http://x) and ![alt](i.png).\n\n```js\nconst a = 1;\n```\n> quote';
  const out = stripMarkdown(md);
  assert.match(out, /^Title$/m);
  assert.match(out, /Some bold and italic with a link and alt\./);
  assert.match(out, /const a = 1;/);
  assert.match(out, /^quote$/m);
  assert.doesNotMatch(out, /title: x|```|\*\*|\]\(/);
});

test('extracts text files', async () => {
  const { type, text } = await extractText(Buffer.from('plain text'), { fileName: 'a.txt' });
  assert.equal(type, 'txt');
  assert.equal(text, 'plain text');
});

test('wraps PDF parser failures', async () => {
  await assert.rejects(extractText(Buffer.from('%PDF-1.4 not really a pdf'), { fileName: 'broken.pdf' }), { code: 'EXTRACTION_FAILED' });
});

test('parses small PDFs regardless of the state of the shared Buffer pool', async () => {
  const pdf = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'sample.pdf'));
  assert.ok(pdf.length < 4096, 'the fixture must be small enough for pooled Buffers');
  // a failed parse first moves the pool offset away from 0 (pdf.js copies Buffers into the pool)
  await assert.rejects(extractText(Buffer.from('%PDF-1.4 not really a pdf'), { fileName: 'broken.pdf' }));
  for (let i = 0; i < 3; i++) {
    Buffer.allocUnsafe(100 + i); // shift the pool offset
    const { text, pages } = await extractText(Buffer.from(pdf), { fileName: 'small.pdf' });
    assert.equal(pages, 2);
    assert.match(text, /pineapple/);
  }
});
