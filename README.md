# cap-hana-vector-publisher

Upload a **PDF, TXT or Markdown** file in your SAP CAP app and get it stored in **SAP HANA Cloud** as text chunks with vector embeddings, then find the relevant chunks with similarity search.

Use it in one of two ways:

- **[Plugin mode](#quick-start-plugin-mode)** (new in 1.2.0): add one config entry and get a ready-to-use document service for upload, list, delete, search and re-embedding.
- **[Library mode](#using-only-the-library)**: add one aspect to your schema and call one method in your own handler.

The embeddings are computed **inside HANA** with `VECTOR_EMBEDDING(..., 'DOCUMENT', 'SAP_NEB.20240715')`, so you don't need an external embedding API, API key or extra service binding.

```
upload ─► extract text ─► normalize ─► chunk (with overlap) ─► INSERT chunks ─► HANA VECTOR_EMBEDDING ─► REAL_VECTOR column
```

---

## Contents

- [Requirements](#requirements)
- [Quick start: plugin mode](#quick-start-plugin-mode)
- [Using only the library](#using-only-the-library)
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

## Quick start: plugin mode

Since 1.2.0 the package is also a **CAP plugin**. When you turn it on, your app gets a ready-to-use document service for upload, list, delete, search and re-embedding, plus the entities behind it. You don't write any handlers. Nothing changes until you opt in: without the config entry below, the plugin adds no entities, tables, services, endpoints or background jobs, and the [library](#using-only-the-library) works as before.

### 1. Install

```bash
npm i cap-hana-vector-publisher
```

### 2. Turn it on

In your app's `package.json`:

```json
"cds": {
  "requires": { "hana-vector-publisher": true },
  "server": { "body_parser": { "limit": "15mb" } }
}
```

`true` uses the defaults that the package declares as a `cds.requires.kinds` entry. Run `cds env requires.hana-vector-publisher` to see the resolved configuration. To override some of them, add `kind` and the values you want to change:

```json
"cds": {
  "requires": {
    "hana-vector-publisher": {
      "kind": "hana-vector-publisher",
      "maxFileSize": 20971520,
      "embedding": { "mode": "sync" },
      "publisher": { "chunkSize": 800, "chunkOverlap": 100 }
    }
  }
}
```

The configuration is validated when the server starts. An invalid value, such as `chunkOverlap >= chunkSize`, stops the server with `INVALID_OPTIONS`, so you find out at startup rather than on the first upload.

**Request body limit.** The file arrives as base64 inside a JSON body, which is about 33 % larger than the file itself. Set `cds.server.body_parser.limit` to at least `maxFileSize × 1.4`, for example `"15mb"` for the default 10 MB limit. CAP's default is express' `100kb`, so without this setting larger uploads fail before they reach the service. The plugin logs a warning at startup when the limit is too small. To raise the limit for this service only, annotate it instead:

```cds
using { VectorDocumentService } from 'cap-hana-vector-publisher/srv';
annotate VectorDocumentService with @cds.server.body_parser.limit: '15mb';
```

### 3. Deploy

`cds deploy` (SQLite) or `cds build --production` (HANA) pick up the plugin's model automatically. It adds two tables:

| Entity | Table | Content |
| --- | --- | --- |
| `cap.hana.vector.Documents` | `CAP_HANA_VECTOR_DOCUMENTS` | One row per uploaded document (file info, counters, status) |
| `cap.hana.vector.DocumentChunks` | `CAP_HANA_VECTOR_DOCUMENTCHUNKS` | One row per chunk (the `VectorStore` aspect); `documentId` = `Documents.ID` |

**HDI users:** `cds build` generates the `.hdbtable` files for both tables into your db module, just as it does for your own entities. If you grant access to your container's objects with roles, synonyms or `.hdbgrants`, add these two table names.

### 4. Call the service

The service is served at `/vector` (OData V4).

```http
### Upload: content is the file as base64
POST /vector/upload
Content-Type: application/json

{ "fileName": "handbook.pdf", "mimeType": "application/pdf", "content": "JVBERi0xLjcK...", "metadata": "{\"department\":\"HR\"}" }

### -> { "documentId": "6f1c…", "status": "PENDING", "chunkCount": 42, "pageCount": 12 }

### Replace a document: new file, same ID
POST /vector/upload
Content-Type: application/json

{ "fileName": "handbook-v2.pdf", "content": "JVBERi0xLjcK...", "documentId": "6f1c…", "replace": true }

### List documents, with or without their chunks (the embedding vector is never exposed)
GET /vector/Documents?$orderby=createdAt desc
GET /vector/Documents(6f1c…)?$expand=chunks
GET /vector/Chunks?$filter=documentId eq 6f1c…&$orderby=chunkIndex

### Similarity search, best match first (top and documentId are optional)
GET /vector/search(query='How many vacation days do I get?',top=5)

### -> { "value": [ { "documentId": "6f1c…", "chunkId": "…", "fileName": "handbook.pdf",
###                   "chunkIndex": 17, "content": "…", "score": 0.83 } ] }

### Delete a document and its chunks; returns the number of deleted chunks
POST /vector/deleteDocument
Content-Type: application/json

{ "documentId": "6f1c…" }

### Re-run embedding for one document, or for every pending chunk when documentId is omitted
POST /vector/embedPending
Content-Type: application/json

{ "documentId": "6f1c…" }
```

Errors come back as OData errors with the status of the underlying [`HanaVectorPublisherError`](#error-handling): `400` invalid input (for example `replace` without `documentId`, or an empty query), `404` unknown document, `409` the `documentId` already exists and `replace` is not set, `413` file too large, `415` unsupported file type, `422` no text found (for example a scanned PDF), and `500` database or embedding errors. A failed upload stores nothing.

### 5. Secure the service

`VectorDocumentService` requires an authenticated user (`@requires: 'authenticated-user'`). Restrict it further, or move it, from your own CDS files:

```cds
using { VectorDocumentService } from 'cap-hana-vector-publisher/srv';
annotate VectorDocumentService with @requires: 'DocumentAdminRole' @path: '/documents';

// or: let every user search, but only admins change documents
annotate VectorDocumentService with @requires: 'authenticated-user';
annotate VectorDocumentService.upload with @requires: 'DocumentAdminRole';
annotate VectorDocumentService.deleteDocument with @requires: 'DocumentAdminRole';
annotate VectorDocumentService.embedPending with @requires: 'DocumentAdminRole';
```

### 6. Configuration

All keys are optional. They go under `cds.requires.hana-vector-publisher`.

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `cap-hana-vector-publisher/srv` | `…/srv` loads the entities and the service. `…/db` loads only the entities and serves no endpoint; use the [library](#using-only-the-library) from your own service with `tableName: 'cap.hana.vector.DocumentChunks'`. |
| `maxFileSize` | `10485760` (10 MB) | Upload limit in bytes. It is passed to the publisher as `maxFileSize` and takes precedence over `publisher.maxFileSize`. |
| `embedding.mode` | `background` | `background`: store the chunks and compute the embeddings after the request has committed. `sync`: compute them inside the upload request, as in 1.1.x. Use this only for small files, see [why](#large-documents-embed-in-the-background). |
| `embedding.catchUpInterval` | `900000` (15 min) | Interval of the catch-up job in ms. `0` or `false` turns it off. |
| `search.defaultTop` / `search.maxTop` | `5` / `50` | Default and maximum number of search hits. A larger `top`, or `defaultTop`, is reduced to `maxTop`. `maxTop` can be at most 1000. |
| `publisher` | `{}` | Any [`HanaVectorPublisher` option](#options), e.g. `chunkSize`, `chunkOverlap`, `modelId`, `batchSize`. `onUnsupportedDatabase` defaults to `'skipEmbeddings'` on databases other than HANA and to `'throw'` on HANA; a value you set yourself wins. |

### 7. Document statuses and the catch-up job

| `Documents.status` | Meaning |
| --- | --- |
| `PENDING` | The chunks are stored; the embeddings are not computed yet (`background` mode). |
| `EMBEDDED` | Every chunk has an embedding. `embeddedAt` and `modelId` are set. |
| `FAILED` | Computing the embeddings failed. `statusMessage` has the reason, for example a disabled NLP feature. |
| `SKIPPED` | The database has no `VECTOR_EMBEDDING` (SQLite, local development). The chunks are stored without vectors. |

In `background` mode the upload returns `PENDING`. When the request has committed, the plugin starts the embedding with `req.on('succeeded', () => cds.spawn(...))` and sets the status to `EMBEDDED` or `FAILED`. While a document is `PENDING`, search doesn't find it yet.

**Catch-up job.** On HANA, the plugin runs a job every `catchUpInterval` ms once the server has started. The job embeds every chunk that is still missing an embedding, for example after a `FAILED` run or a restart in the middle of an embedding, and marks the affected documents `EMBEDDED`. Errors are logged and never stop the server. The job does not run during `cds build`, `cds compile` or `cds deploy`. **With several app instances, every instance runs the job.** That is safe because the statement only touches rows `WHERE "EMBEDDING" IS NULL`; at worst some work is repeated. To retry right away, call `embedPending`.

### Local development (plugin)

On SQLite the service works without vectors. Uploads are stored with status `SKIPPED`, `embedPending` returns `0`, and `search` falls back to a case-insensitive substring match on the chunk text with `score: null`; a warning is logged once. For real similarity search, run against HANA Cloud with `cds watch --profile hybrid`.

With `@sap/cds` 8 (cds-compiler 5), the `Vector` type can only be deployed to HANA. On other databases, the plugin turns the `embedding` element of its own chunk entity into a `LargeString` when the model loads, so `cds deploy` and `cds watch` work on SQLite. It doesn't do this during `cds build`, on HANA, or with cds-compiler 6, so HANA artifacts always get the real vector column.

---

## Using only the library

Everything below works as in 1.1.x, with or without the plugin config. Use the library when you want your own entities, service and handlers.

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

`publisher.search()` embeds the question with the same model (embedding type `'QUERY'`) and returns the closest chunks, best match first:

```js
const hits = await publisher.search({
  tableName: 'my.app.DocumentChunks',
  query: 'How many vacation days do I get?',
  top: 5,                // integer 1-1000, default 5
  documentId,            // optional: search one document only
  minScore: 0.6          // optional: drop weaker hits (applied after the query)
});
// [{ ID, documentId, fileName, chunkIndex, content, score }, ...]
```

It runs a single parameterised statement, built by `publisher.buildSearchSql(tableName, { withDocument, top })`. Only chunks that already have an embedding are considered:

```sql
SELECT "ID" AS "ID", "DOCUMENTID" AS "documentId", "FILENAME" AS "fileName", "CHUNKINDEX" AS "chunkIndex", "CONTENT" AS "content",
       COSINE_SIMILARITY("EMBEDDING", TO_REAL_VECTOR(VECTOR_EMBEDDING(?, 'QUERY', 'SAP_NEB.20240715'))) AS "score"
  FROM "MY_APP_DOCUMENTCHUNKS"
 WHERE "EMBEDDING" IS NOT NULL [AND "DOCUMENTID" = ?]
 ORDER BY "score" DESC
 LIMIT 5
```

The query text and `documentId` are bound as parameters. `top` is checked to be an integer before it goes into the SQL, and the column names come from `options.columns`, so custom entities work too. `wrapToRealVector` applies here as well. On databases other than HANA, `search()` throws `UNSUPPORTED_DATABASE`; with `onUnsupportedDatabase: 'skipEmbeddings'` it falls back to a case-insensitive substring match and returns `score: null`.

To combine the similarity with your own filters, write the CQL yourself:

```js
const { DocumentChunks } = cds.entities('my.app');

const top = await SELECT.from(DocumentChunks)
  .columns('content', 'fileName', 'chunkIndex')
  .orderBy`COSINE_SIMILARITY(embedding, VECTOR_EMBEDDING(${question}, 'QUERY', 'SAP_NEB.20240715')) desc`
  .limit(5);
```

---

## Large documents: embed in the background

> The [plugin](#quick-start-plugin-mode) does all of this for you in its default `background` mode, including the catch-up job and document statuses.

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
const { HanaVectorPublisherError } = require('cap-hana-vector-publisher');

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
| `publisher.search({ tableName, query, top?, documentId?, minScore? })` | Similarity search, best match first. Returns `[{ ID, documentId, fileName, chunkIndex, content, score }]` ([details](#3-query-by-similarity-rag)) |
| `publisher.buildSearchSql(tableName, { withDocument?, top? })` | Returns the generated search statement. Its parameters are `[query]`, or `[query, documentId]` with `withDocument: true` |
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
| `SEARCH_FAILED` | 500 | The search statement failed; on HANA the message includes the same NLP hint |

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

  With `skipEmbeddings`, the `embedding` column stays empty, and `search()` falls back to a plain text match. `embed: false` also works on SQLite without `skipEmbeddings`.

**Deploying the `Vector` type to SQLite.** With `@sap/cds` 9 (cds-compiler 6), the `VectorStore` aspect deploys to SQLite unchanged. With `@sap/cds` 8 (cds-compiler 5), `cds deploy` fails with *Type "cds.Vector" is only supported for SQL dialect 'hana'*. For local development, turn vector elements into `LargeString` when the model loads, for example in `server.js`:

```js
const cds = require('@sap/cds');

if (!/hana/.test(cds.env.requires.db?.kind)) cds.on('loaded', csn => {
  for (const def of Object.values(csn.definitions)) {
    for (const [name, element] of Object.entries(def.elements || {})) {
      if (element.type !== 'cds.Vector') continue;
      const { length, ...rest } = element;
      def.elements[name] = { ...rest, type: 'cds.LargeString' };
    }
  }
});

module.exports = cds.server;
```

`server.js` is loaded by `cds watch` and `cds serve`, which also covers their in-memory SQLite deployment. The `cds deploy` CLI does not load `server.js`. The plugin applies the same mapping to its own entity automatically.

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

### 1.2.0

- **New: CAP plugin mode (opt-in).** `cds.requires: { "hana-vector-publisher": true }` adds the entities `cap.hana.vector.Documents` and `cap.hana.vector.DocumentChunks` and the `VectorDocumentService` at `/vector` with `upload`, `deleteDocument`, `embedPending`, `search` and read-only `Documents`/`Chunks`. It includes background embedding, document statuses and an embedding catch-up job. Apps without the config entry get nothing new ([details](#quick-start-plugin-mode)).
- New `publisher.search()` and `publisher.buildSearchSql()` for similarity search, with a text-match fallback on non-HANA databases when `onUnsupportedDatabase: 'skipEmbeddings'` is set ([details](#3-query-by-similarity-rag)). New error code `SEARCH_FAILED`.
- Fix: small PDFs (under 4 KB) could fail with `EXTRACTION_FAILED: bad XRef entry`, depending on what else the process had allocated. pdf.js copies a Node.js `Buffer` into Node's shared buffer pool and then reads from the wrong offset; the PDF is now passed in as a plain `Uint8Array`.
- README: corrected the SQLite section again. With `@sap/cds` 8 the `Vector` type cannot be deployed to SQLite; it shows a workaround ([details](#local-development-sqlite)). The `cds.spawn` error-handling example now shows where `HanaVectorPublisherError` comes from.

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
