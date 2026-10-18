namespace cap.hana.vector;

using { cuid, managed } from '@sap/cds/common';

/**
 * Reusable vector store aspect. Include it in your own entity:
 *
 *   using { cap.hana.vector.VectorStore } from 'cap-hana-vector-publisher';
 *   entity DocumentChunks : VectorStore {}
 *
 * The element names below are the defaults expected by HanaVectorPublisher
 * (see options.columns to map them to differently named elements).
 */
aspect VectorStore : cuid, managed {
  /** Groups all chunks of one uploaded document */
  documentId : UUID @title: 'Document ID';
  fileName   : String(255) @title: 'File Name';
  mimeType   : String(100) @title: 'MIME Type';
  chunkIndex : Integer @title: 'Chunk Index';
  /** Plain-text chunk that the embedding was computed from */
  content    : LargeString @title: 'Content';
  /** Optional JSON metadata supplied at upload time */
  metadata   : LargeString @title: 'Metadata';
  /**
   * 768 dimensions = output of SAP_NEB.20240715. Change the dimension when
   * using a different model. Hidden from OData APIs, which cannot serialise vectors.
   */
  embedding  : Vector(768) @cds.api.ignore;
}
