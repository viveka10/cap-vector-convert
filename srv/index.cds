// Document service of the CAP plugin (default cds.requires['hana-vector-publisher'].model).
// Tighten or move it from your app, e.g.
//   annotate VectorDocumentService with @requires: 'DocumentAdminRole' @path: '/documents';
using { cap.hana.vector as db } from '../db';

@path: '/vector'
@requires: 'authenticated-user'
@impl: 'cap-hana-vector-publisher/srv/service.js'
service VectorDocumentService {

  @readonly entity Documents as projection on db.Documents;
  @readonly entity Chunks as projection on db.DocumentChunks excluding { embedding };

  type UploadResult {
    documentId : UUID;
    status     : String;
    chunkCount : Integer;
    pageCount  : Integer;
  }

  type SearchHit {
    documentId : UUID;
    chunkId    : UUID;
    fileName   : String;
    chunkIndex : Integer;
    content    : LargeString;
    /** Cosine similarity; null for the text-match fallback on non-HANA databases */
    score      : Double;
  }

  /** content = file as base64 (Edm.Binary) */
  action upload(fileName : String not null, mimeType : String, content : LargeBinary not null,
                metadata : LargeString, documentId : UUID, replace : Boolean) returns UploadResult;

  /** Deletes the document and its chunks; returns the number of deleted chunks */
  action deleteDocument(documentId : UUID not null) returns Integer;

  /** Re-runs embedding for one document, or for all pending rows when documentId is empty */
  action embedPending(documentId : UUID) returns Integer;

  function search(query : String not null, top : Integer, documentId : UUID) returns many SearchHit;
}
