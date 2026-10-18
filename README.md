# cap-hana-vector-publisher

Upload a **PDF, TXT or Markdown** file in your SAP CAP app and get it stored in **SAP HANA Cloud** as text chunks with vector embeddings. You add one aspect to your schema and call one method in your handler.

The embeddings are computed **inside HANA** with `VECTOR_EMBEDDING(..., 'DOCUMENT', 'SAP_NEB.20240715')`, so you don't need an external embedding API, API key or extra service binding.

```
upload ─► extract text ─► normalize ─► chunk (with overlap) ─► INSERT chunks ─► HANA VECTOR_EMBEDDING ─► REAL_VECTOR column
```

---

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [1. Extend your schema](#1-extend-your-schema)
- [2. Use it in a service handler](#2-use-it-in-a-service-handler)
- [3. Query by similarity (RAG)](#3-query-by-similarity-rag)
- [Large documents: embed in the background](#large-documents-embed-in-the-background)
- [Options](#options)
- [API](#api)
- [Error handling](#error-handling)
- [How it works](#how-it-works)
- [Local development (SQLite)](#local-development-sqlite)
- [Publishing this package](#publishing-this-package)
- [Changelog](#changelog)

---

## Requirements

| What | Version / setting |
| --- | --- |
| Node.js | 18 or later |
| `@sap/cds` | 7.8 or later (that release added the `Vector` type) |
| Database service | `@cap-js/hana` (recommended) or `@sap/cds-hana` |
| SAP HANA Cloud | The **Natural Language Processing (NLP)** additional feature must be enabled on the instance (HANA Cloud Central → *Manage Configuration* → *Additional Features*) |

---

## Installation

```bash
npm install cap-hana-vector-publisher
```

If your project doesn't use HANA yet:

```bash
npm add @cap-js/hana
cds add hana --for production
```

---

## 1. Extend your schema

The package ships a reusable `VectorStore` aspect. Import it in **`db/schema.cds`**:

```cds
namespace my.app;

using { cap.hana.vector.VectorStore } from 'cap-hana-vector-publisher';

/** One row per text chunk */
entity DocumentChunks : VectorStore {
  // add your own fields if needed, e.g.
  // category : String(50);
}
```

`VectorStore` contributes these elements:

| Element | Type | Purpose |
| --- | --- | --- |
| `ID` | `UUID` (key, from `cuid`) | Chunk key |
| `createdAt/By`, `modifiedAt/By` | from `managed` | Audit fields |
| `documentId` | `UUID` | Groups all chunks of one upload |
| `fileName` | `String(255)` | Original file name |
| `mimeType` | `String(100)` | Detected or supplied MIME type |
| `chunkIndex` | `Integer` | Position of the chunk in the document |
| `content` | `LargeString` | Chunk text, which is the input for the embedding |
| `metadata` | `LargeString` | Optional JSON you pass at upload |
| `embedding` | `Vector(768)` | `REAL_VECTOR` from `SAP_NEB.20240715`. It is hidden from OData (`@cds.api.ignore`) |

> **Using a different model?** Its output dimension may not be 768. Override the element:
> `entity DocumentChunks : VectorStore { embedding : Vector(1024) @cds.api.ignore; }`

Deploy: `cds deploy --to hana` (or `cds build --production` for MTA builds).

---

## 2. Use it in a service handler

### `srv/service.cds`

```cds
using { my.app as db } from '../db/schema';

service DocumentService {
  @readonly entity Chunks as projection on db.DocumentChunks;

  /** content: the file as base64 (Edm.Binary) */
  action uploadDocument(fileName : String, mimeType : String, content : LargeBinary) returns {
    documentId : UUID;
    chunkCount : Integer;
  };

  action deleteDocument(documentId : UUID) returns Integer;
}
```

### `srv/service.js`

```js
const cds = require('@sap/cds');
const { HanaVectorPublisher, HanaVectorPublisherError } = require('cap-hana-vector-publisher');

module.exports = class DocumentService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');

    const publisher = new HanaVectorPublisher(db, {
      chunkSize: 1000,             // characters per chunk
      chunkOverlap: 150,           // characters shared between neighbouring chunks
      modelId: 'SAP_NEB.20240715'  // the default; shown here for clarity
    });

    this.on('uploadDocument', async req => {
      const { fileName, mimeType, content } = req.data;
      try {
        const result = await publisher.processAndStore({
          fileBuffer: content,          // Buffer, stream, or base64 string all work
          fileName,
          mimeType,
          tableName: 'my.app.DocumentChunks',
          metadata: { uploadedBy: req.user.id }
        });
        return { documentId: result.documentId, chunkCount: result.chunkCount };
      } catch (err) {
        if (err instanceof HanaVectorPublisherError) return req.reject(err.status, err.message);
        throw err;
      }
    });

    this.on('deleteDocument', req =>
      publisher.deleteDocument({ tableName: 'my.app.DocumentChunks', documentId: req.data.documentId })
    );

    return super.init();
  }
};
```

Call it:

```http
POST /odata/v4/document/uploadDocument
Content-Type: application/json

{ "fileName": "handbook.pdf", "mimeType": "application/pdf", "content": "JVBERi0xLjcK..." }
```

Because the call runs inside a CAP request, the inserts and the embedding update join the **request's transaction**. If the request fails, nothing is stored.

### Variant: media entity upload (stream)

When you upload through a media element (`PUT .../Documents(ID)/content`), CAP passes the content as a **Readable stream**. A stream can only be read once. Read it into a buffer first, then use the same buffer for the publisher and for the stored file:

```cds
entity Documents : cuid {
  fileName : String;
  mimeType : String @Core.IsMediaType;
  content  : LargeBinary @Core.MediaType: mimeType;
}
```

```js
const { HanaVectorPublisher, toBuffer } = require('cap-hana-vector-publisher');

this.on('UPDATE', 'Documents', async (req, next) => {
  if (!req.data.content) return next();

  const buffer = await toBuffer(req.data.content, 50 * 1024 * 1024);
  const doc = await SELECT.one.from('my.app.Documents', req.data.ID).columns('fileName', 'mimeType');

  await publisher.processAndStore({
    fileBuffer: buffer,
    fileName: doc?.fileName || 'upload',
    mimeType: req.data.mimeType || doc?.mimeType,
    tableName: 'my.app.DocumentChunks',
    documentId: req.data.ID,   // link the chunks to the document
    replace: true              // re-uploads replace the old chunks
  });

  req.data.content = buffer;   // let CAP store the original file as well
  return next();
});
```

---

## 3. Query by similarity (RAG)

The search side is short, so the package doesn't wrap it. Embed the question with the same model, using `'QUERY'`:

```js
const { DocumentChunks } = cds.entities('my.app');

const top = await SELECT.from(DocumentChunks)
  .columns('content', 'fileName', 'chunkIndex')
  .orderBy`COSINE_SIMILARITY(embedding, VECTOR_EMBEDDING(${question}, 'QUERY', 'SAP_NEB.20240715')) desc`
  .limit(5);
```

---

## Large documents: embed in the background

By default `processAndStore` computes every embedding inside the caller's request. For documents with hundreds or thousands of chunks, the `VECTOR_EMBEDDING` update can take longer than typical approuter or SAP Build Work Zone route timeouts (about 30 s). The HTTP request then fails even though the work itself would have succeeded.

To avoid this, store the chunks with `embed: false` and compute the vectors in the background once the request has committed:

```js
this.on('uploadDocument', async req => {
  const { fileName, mimeType, content } = req.data;
  const r = await publisher.processAndStore({ fileBuffer: content, fileName, mimeType, tableName, embed: false });

  // runs only after the request's transaction has committed
  req.on('succeeded', () =>
    cds.spawn(() => publisher.embedPending({ tableName, documentId: r.documentId }))
  );

  return { documentId: r.documentId, chunkCount: r.chunkCount };
});
```

**Why `req.on('succeeded')`:** `cds.spawn` runs in a new transaction, and HANA only shows committed rows to other transactions. If the background job starts before the request has committed (for example with `cds.spawn({ after: 0 }, …)` directly in the handler), its `UPDATE` matches no rows, `embedPending` returns `0`, and the chunks are never embedded. No error is raised. The `succeeded` event fires only after the request's transaction has committed.

**Schedule a catch-up job.** A background job can still fail, for example if the NLP feature is disabled or the instance restarts while it runs. Schedule a periodic job that embeds every row still pending. `embedPending({ tableName })` without a `documentId` does exactly that:

```js
cds.spawn({ every: 15 * 60 * 1000 }, () => publisher.embedPending({ tableName }));
```

**Handle errors yourself if you need to.** `cds.spawn` only logs errors thrown by its callback. If your app needs to react to failures (alerting, marking the document as failed, …), catch `HanaVectorPublisherError` inside the callback:

```js
cds.spawn(async () => {
  try {
    await publisher.embedPending({ tableName, documentId });
  } catch (err) {
    if (err instanceof HanaVectorPublisherError) cds.log('embedding').error(`Embedding failed (${err.code})`, err);
    else throw err;
  }
});
```

Until `embedPending` finishes, those chunks have `embedding IS NULL` and similarity search won't find them. Filter them out in your queries:

```js
SELECT.from(DocumentChunks).where`embedding is not null`.orderBy`COSINE_SIMILARITY(...) desc`
```

---

## Options

All options are optional. Pass them as the second constructor argument.

| Option | Default | Description |
| --- | --- | --- |
| `chunkSize` | `1000` | Maximum chunk length in characters (Unicode code points). Keep it within your model's input token limit; the model truncates longer text. |
| `chunkOverlap` | `150` | Characters of trailing context repeated at the start of the next chunk. Must be smaller than `chunkSize`. |
| `modelId` | `'SAP_NEB.20240715'` | HANA embedding model. It is validated against `[A-Za-z0-9_.-]`. |
| `embeddingType` | `'DOCUMENT'` | `'DOCUMENT'` or `'QUERY'`. |
| `wrapToRealVector` | `true` | Wraps the expression as `TO_REAL_VECTOR(VECTOR_EMBEDDING(...))`. Set to `false` to store the result of `VECTOR_EMBEDDING` directly. `VECTOR_EMBEDDING` already returns `REAL_VECTOR`, so the wrapper is probably redundant. The default stays `true` until it has been verified on HANA Cloud without the wrapper. |
| `batchSize` | `200` | Rows per `INSERT` statement. |
| `maxFileSize` | `52428800` (50 MB) | Larger uploads are rejected, including streams while they are being read. |
| `maxChunks` | `10000` | Safety limit on the number of chunks per document. |
| `keepMarkdown` | `false` | `false` strips Markdown syntax (headings, links, emphasis) before chunking. |
| `encoding` | auto | Forces a decoder for TXT/MD files, e.g. `'latin1'`. Without it, the BOM is honoured and UTF-8 is the default. |
| `onUnsupportedDatabase` | `'throw'` | Set to `'skipEmbeddings'` to store chunks without vectors on SQLite/Postgres. |
| `sqlTableName` | derived | Physical table name for the embedding `UPDATE`. Only set it if you use a custom `@cds.persistence.name` or a non-default naming mode. |
| `columns` | see below | Maps the publisher's fields to your element names. |

Default `columns`, for entities that don't use the aspect:

```js
{
  id: 'ID', documentId: 'documentId', fileName: 'fileName', mimeType: 'mimeType',
  chunkIndex: 'chunkIndex', content: 'content', metadata: 'metadata', embedding: 'embedding'
}
```

Set `id`, `fileName`, `mimeType`, `chunkIndex` or `metadata` to `null` to leave that field out. `documentId`, `content` and `embedding` are required.

---

## API

### `new HanaVectorPublisher(db, options?)`

`db` is the CAP database service (`cds.db` or `await cds.connect.to('db')`). The constructor throws `INVALID_DB` or `INVALID_OPTIONS` right away, so configuration mistakes show up at startup.

### `await publisher.processAndStore(params)`

| Param | Required | Description |
| --- | --- | --- |
| `fileBuffer` | ✔ | A `Buffer`, `Uint8Array`, `ArrayBuffer`, base64 string or Readable stream |
| `fileName` | ✔ | Used for type detection and stored on each chunk |
| `tableName` | ✔ | Fully qualified CDS entity name, e.g. `'my.app.DocumentChunks'` |
| `mimeType` | | Takes precedence over the file extension |
| `documentId` | | Your own ID for the document. One is generated if you leave it out |
| `replace` | | `true` deletes the existing chunks of `documentId` first, in the same transaction. Requires `documentId` (otherwise `INVALID_INPUT`) |
| `embed` | | `false` stores the chunks without computing embeddings; call `embedPending()` later. Default `true` |
| `metadata` | | An object or JSON string, stored on each chunk |

Returns:

```js
{ documentId, fileName, fileType: 'pdf'|'txt'|'md', tableName,
  chunkCount, characterCount, pageCount, embedded, modelId }
```

### Other methods and helpers

| Method / helper | Description |
| --- | --- |
| `publisher.extractText({ fileBuffer, fileName, mimeType? })` | Returns `{ type, text, pages? }` without writing to the database |
| `publisher.chunk(text)` | Chunks text using the configured options |
| `publisher.deleteDocument({ tableName, documentId })` | Deletes all chunks of a document |
| `publisher.embedPending({ tableName, documentId? })` | Computes embeddings for chunks that don't have one yet (one document, or the whole table without `documentId`). Returns the number of updated rows, or `0` when embeddings are skipped |
| `publisher.buildEmbeddingSql(tableName, { allPending? })` | Returns the generated `UPDATE` statement, for inspection or logging. `allPending: true` drops the `documentId` condition |
| `chunkText(text, { chunkSize, chunkOverlap })`, `normalizeText(text)`, `extractText(buffer, opts)`, `detectFileType(opts)`, `toBuffer(input, maxBytes)` | Standalone helpers |

---

## Error handling

Every error the package throws is a `HanaVectorPublisherError` with `code`, an HTTP-style `status`, and, where applicable, the original error in `cause`.

| `code` | `status` | When |
| --- | --- | --- |
| `INVALID_DB` | 500 | No usable `db` was passed to the constructor |
| `INVALID_OPTIONS` | 500 | A bad option value or column name |
| `INVALID_INPUT` | 400 | A required parameter is missing, the file is empty, or the stream errored |
| `FILE_TOO_LARGE` | 413 | The file exceeds `maxFileSize` or produces more than `maxChunks` chunks |
| `UNSUPPORTED_FILE_TYPE` | 415 | The file is not PDF, TXT or MD |
| `EXTRACTION_FAILED` | 422 | The PDF is corrupt or encrypted, or the text can't be decoded |
| `NO_TEXT_EXTRACTED` | 422 | The file has no text, e.g. a scanned PDF without OCR |
| `UNSUPPORTED_DATABASE` | 500 | The database isn't HANA and `onUnsupportedDatabase` is `'throw'` |
| `DB_INSERT_FAILED` | 500 | An `INSERT` or `DELETE` failed |
| `EMBEDDING_FAILED` | 500 | `VECTOR_EMBEDDING` failed; the message includes a hint about the NLP feature |

```js
catch (err) {
  if (err.code === 'NO_TEXT_EXTRACTED') return req.reject(422, 'Please upload a text-based PDF');
  if (err instanceof HanaVectorPublisherError) return req.reject(err.status, err.message);
  throw err;
}
```

---

## How it works

1. **Read input.** Buffers, typed arrays, base64 strings and streams are all accepted. Streams are read with a size limit.
2. **Detect type.** The MIME type is checked first, then the file extension, then the `%PDF-` magic bytes.
3. **Extract.**
   - PDFs go through [`pdf-parse`](https://www.npmjs.com/package/pdf-parse), which is loaded only when a PDF arrives.
   - Text is decoded with BOM detection (UTF-8 / UTF-16). Invalid bytes don't cause an error.
   - Markdown is reduced to plain prose. Code blocks, link text and image alt text are kept.
4. **Normalize.** This step cleans up characters that break HANA or the chunker:
   - Unicode NFKC normalization and unified line endings
   - Control characters, lone surrogates (which HANA rejects in `NCLOB`) and zero-width characters are removed
   - Words hyphenated across PDF line breaks are joined again
   - Whitespace is collapsed
5. **Chunk.** The text is split recursively on paragraphs, then lines, sentences (including CJK punctuation) and words. Pieces are packed into chunks of at most `chunkSize` characters, with up to `chunkOverlap` characters repeated between neighbours. Very long tokens with no spaces are cut on code-point boundaries, so emoji and other non-ASCII characters are never broken in half.
6. **Store.** The chunks are written with `db.run(INSERT.into(tableName).entries(batch))` in batches.
7. **Embed.** One set-based statement computes all vectors inside HANA:

   ```sql
   UPDATE "MY_APP_DOCUMENTCHUNKS"
      SET "EMBEDDING" = TO_REAL_VECTOR(VECTOR_EMBEDDING("CONTENT", 'DOCUMENT', 'SAP_NEB.20240715'))
    WHERE "DOCUMENTID" = ? AND "EMBEDDING" IS NULL
   ```

   The `TO_REAL_VECTOR(...)` wrapper comes from the `wrapToRealVector` option (default `true`). With `wrapToRealVector: false`, the statement sets `"EMBEDDING" = VECTOR_EMBEDDING(...)` directly.

   This is a separate step because CQL binds every value in `INSERT.entries()` as a parameter, so a SQL function like `VECTOR_EMBEDDING()` can't be placed there. As a side benefit, HANA reads the text from the column it just stored, so the text is sent to the database only once. The model ID and embedding type are strictly validated before they are placed in the SQL, and the document ID is bound as a parameter.

Steps 6 and 7 run in a single transaction. Inside a CAP request that is the request's own transaction; outside a request it is a dedicated `db.tx()`.

---

## Local development (SQLite)

SQLite has no `VECTOR_EMBEDDING`. You have two options:

- **Hybrid testing** against a real HANA Cloud instance: `cds bind -2 my-hana` and then `cds watch --profile hybrid`.
- **Text only**: store chunks without vectors.

  ```js
  new HanaVectorPublisher(db, {
    onUnsupportedDatabase: process.env.NODE_ENV === 'production' ? 'throw' : 'skipEmbeddings'
  });
  ```

  The `VectorStore` aspect deploys to SQLite as is (`Vector` becomes a `FLOAT32` column), so you don't need a separate model. With `skipEmbeddings`, the `embedding` column stays empty and similarity search only works on HANA. `embed: false` also works on SQLite without `skipEmbeddings`.

---

## Publishing this package

```bash
npm test                         # node:test unit tests (also runs automatically before publish)
npm pack --dry-run               # check which files will be published
npm login
npm publish --access public      # public package
```

For a **private** package, use a scoped name such as `@your-org/cap-hana-vector-publisher` in `package.json`. Publish it with `npm publish` (scoped packages are private by default and need a paid npm org) and update the `using ... from '@your-org/cap-hana-vector-publisher'` lines to match.

### Automated releases (GitHub Actions)

`.github/workflows/publish.yml` publishes to npm with provenance whenever a version tag is pushed. It first checks that the tag matches `package.json` and that the tests pass.

```bash
npm version patch                # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags           # the tag push triggers the publish workflow
```

The workflow authenticates with npm **trusted publishing** (OIDC) once you configure it under the package's *Settings → Trusted Publisher* on npmjs.com (workflow `publish.yml`, environment `npm`). Until then, it falls back to an `NPM_TOKEN` repository secret.

---

## Changelog

### 1.1.1

- `embedPending()` now returns the number of updated rows as a number (1.1.0 returned the database driver's result object).
- README: the background embedding example now waits for the request to commit (`req.on('succeeded')`) and recommends a periodic catch-up job ([details](#large-documents-embed-in-the-background)).

### 1.1.0

- `processAndStore` rejects `replace: true` without a `documentId` (`INVALID_INPUT`). Before, old chunks silently stayed and new ones were added next to them.
- New `embed: false` option on `processAndStore` and new `embedPending()` method to compute embeddings outside the upload request ([details](#large-documents-embed-in-the-background)). `buildEmbeddingSql()` accepts `{ allPending: true }`.
- `wrapToRealVector`: the README now notes that the `TO_REAL_VECTOR` wrapper is probably redundant. The default is still `true` until it has been verified on HANA Cloud.
- README: corrected the SQLite section. The `VectorStore` aspect deploys to SQLite unchanged.

---

## License

Apache-2.0
