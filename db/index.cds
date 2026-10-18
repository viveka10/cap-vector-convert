// Entities used by the CAP plugin (cds.requires['hana-vector-publisher'].model = 'cap-hana-vector-publisher/db').
// Tables: CAP_HANA_VECTOR_DOCUMENTS, CAP_HANA_VECTOR_DOCUMENTCHUNKS
namespace cap.hana.vector;

using { cuid, managed } from '@sap/cds/common';
using { cap.hana.vector.VectorStore } from '../cds/index';

/** One row per uploaded document */
entity Documents : cuid, managed {
  fileName       : String(255) @title: 'File Name';
  mimeType       : String(100) @title: 'MIME Type';
  /** pdf | txt | md */
  fileType       : String(10) @title: 'File Type';
  pageCount      : Integer @title: 'Pages';
  chunkCount     : Integer @title: 'Chunks';
  characterCount : Integer @title: 'Characters';
  /** Optional JSON metadata supplied at upload time */
  metadata       : LargeString @title: 'Metadata';
  /** SKIPPED = stored on a database without VECTOR_EMBEDDING (e.g. SQLite) */
  @title: 'Status'
  status         : String(20) enum { PENDING; EMBEDDED; FAILED; SKIPPED } default 'PENDING';
  statusMessage  : String(1000) @title: 'Status Message';
  modelId        : String(100) @title: 'Embedding Model';
  embeddedAt     : Timestamp @title: 'Embedded At';
  chunks         : Composition of many DocumentChunks on chunks.document = $self;
}

/** One row per chunk; documentId (from VectorStore) equals Documents.ID */
entity DocumentChunks : VectorStore {
  document : Association to Documents on document.ID = documentId;
}
