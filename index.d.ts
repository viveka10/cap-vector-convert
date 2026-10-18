/// <reference types="node" />

export type FileInput = Buffer | Uint8Array | ArrayBuffer | string | NodeJS.ReadableStream | AsyncIterable<Uint8Array>;

export interface ColumnMapping {
  /** Set to null to let the database generate the key */
  id?: string | null;
  documentId?: string;
  fileName?: string | null;
  mimeType?: string | null;
  chunkIndex?: string | null;
  content?: string;
  metadata?: string | null;
  embedding?: string;
}

export interface HanaVectorPublisherOptions {
  /** Max chunk length in characters (Unicode code points). Default 1000 */
  chunkSize?: number;
  /** Characters shared between consecutive chunks. Default 150 */
  chunkOverlap?: number;
  /** HANA embedding model. Default 'SAP_NEB.20240715' */
  modelId?: string;
  /** Default 'DOCUMENT' */
  embeddingType?: 'DOCUMENT' | 'QUERY';
  /** Wrap VECTOR_EMBEDDING in TO_REAL_VECTOR(). Default true */
  wrapToRealVector?: boolean;
  /** Rows per INSERT statement. Default 200 */
  batchSize?: number;
  /** Max upload size in bytes. Default 50 MB */
  maxFileSize?: number;
  /** Max chunks per document. Default 10000 */
  maxChunks?: number;
  /** Keep Markdown syntax instead of stripping it. Default false */
  keepMarkdown?: boolean;
  /** Force a text encoding for TXT/MD (otherwise BOM / UTF-8) */
  encoding?: string;
  /** What to do on non-HANA databases (e.g. SQLite). Default 'throw' */
  onUnsupportedDatabase?: 'throw' | 'skipEmbeddings';
  /** Override the physical table name used for the embedding UPDATE */
  sqlTableName?: string;
  columns?: ColumnMapping;
}

export interface ProcessAndStoreParams {
  fileBuffer: FileInput;
  fileName: string;
  tableName: string;
  mimeType?: string;
  documentId?: string;
  /** Delete existing chunks of documentId first. Requires documentId */
  replace?: boolean;
  /** false stores the chunks only; compute the vectors later with embedPending(). Default true */
  embed?: boolean;
  metadata?: Record<string, unknown> | string;
}

export interface ProcessAndStoreResult {
  documentId: string;
  fileName: string;
  fileType: 'pdf' | 'txt' | 'md';
  tableName: string;
  chunkCount: number;
  characterCount: number;
  pageCount?: number;
  embedded: boolean;
  modelId?: string;
}

export interface SearchParams {
  /** CDS entity name of the chunk table */
  tableName: string;
  /** Search text (max 2000 characters), embedded with the 'QUERY' embedding type */
  query: string;
  /** Max number of hits, integer 1-1000. Default 5 */
  top?: number;
  /** Restrict the search to one document */
  documentId?: string;
  /** Drop hits with a lower cosine similarity (applied after the query) */
  minScore?: number;
}

export interface SearchHit {
  ID: string;
  documentId: string;
  fileName?: string;
  chunkIndex?: number;
  content: string;
  /** Cosine similarity; null for the text-match fallback on non-HANA databases */
  score: number | null;
}

/** cds.requires['hana-vector-publisher'] when the app enables the CAP plugin */
export interface PluginConfig {
  kind?: 'hana-vector-publisher';
  /** 'cap-hana-vector-publisher/srv' (entities + service, default) or 'cap-hana-vector-publisher/db' (entities only) */
  model?: string;
  /** Upload limit in bytes, passed as publisher.maxFileSize. Default 10 MB */
  maxFileSize?: number;
  embedding?: {
    /** 'background' (default): embed after the upload request committed. 'sync': embed inside the request */
    mode?: 'background' | 'sync';
    /** Interval of the catch-up job in ms; 0 or false disables it. Default 900000 (15 min) */
    catchUpInterval?: number | false;
  };
  search?: {
    /** Default 5 */
    defaultTop?: number;
    /** Default 50, at most 1000 */
    maxTop?: number;
  };
  /** Any HanaVectorPublisher option. onUnsupportedDatabase defaults to 'skipEmbeddings' on non-HANA databases */
  publisher?: HanaVectorPublisherOptions;
}

export declare class HanaVectorPublisher {
  constructor(db: any, options?: HanaVectorPublisherOptions);
  readonly db: any;
  readonly options: Readonly<Required<Omit<HanaVectorPublisherOptions, 'encoding' | 'sqlTableName'>>> & HanaVectorPublisherOptions;
  readonly isHana: boolean;
  processAndStore(params: ProcessAndStoreParams): Promise<ProcessAndStoreResult>;
  extractText(params: { fileBuffer: FileInput; fileName: string; mimeType?: string }): Promise<{ type: 'pdf' | 'txt' | 'md'; text: string; pages?: number }>;
  chunk(text: string): string[];
  deleteDocument(params: { tableName: string; documentId: string }): Promise<number>;
  /** Embeds chunks whose embedding is NULL (one document, or the whole table). Returns the updated row count */
  embedPending(params: { tableName: string; documentId?: string }): Promise<number>;
  buildEmbeddingSql(tableName: string, opts?: { allPending?: boolean }): string;
  /** Similarity search, best match first. Falls back to a text match on non-HANA databases with onUnsupportedDatabase: 'skipEmbeddings' */
  search(params: SearchParams): Promise<SearchHit[]>;
  /** The parameterised search statement; parameters are [query] or, with withDocument, [query, documentId] */
  buildSearchSql(tableName: string, opts?: { withDocument?: boolean; top?: number }): string;
}

export declare const ERROR_CODES: Readonly<{
  INVALID_DB: 'INVALID_DB';
  INVALID_OPTIONS: 'INVALID_OPTIONS';
  INVALID_INPUT: 'INVALID_INPUT';
  FILE_TOO_LARGE: 'FILE_TOO_LARGE';
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE';
  EXTRACTION_FAILED: 'EXTRACTION_FAILED';
  NO_TEXT_EXTRACTED: 'NO_TEXT_EXTRACTED';
  UNSUPPORTED_DATABASE: 'UNSUPPORTED_DATABASE';
  DB_INSERT_FAILED: 'DB_INSERT_FAILED';
  EMBEDDING_FAILED: 'EMBEDDING_FAILED';
  SEARCH_FAILED: 'SEARCH_FAILED';
}>;

export declare class HanaVectorPublisherError extends Error {
  code: keyof typeof ERROR_CODES;
  status: number;
  details?: unknown;
  cause?: unknown;
}

export declare const DEFAULTS: Readonly<HanaVectorPublisherOptions>;
export declare const SUPPORTED_TYPES: Readonly<{ pdf: string; txt: string; md: string }>;
export declare function chunkText(text: string, opts?: { chunkSize?: number; chunkOverlap?: number; normalize?: boolean }): string[];
export declare function normalizeText(text: string): string;
export declare function extractText(
  buffer: Buffer,
  opts?: { fileName?: string; mimeType?: string; encoding?: string; keepMarkdown?: boolean }
): Promise<{ type: 'pdf' | 'txt' | 'md'; text: string; pages?: number }>;
export declare function detectFileType(opts: { fileName?: string; mimeType?: string; buffer?: Buffer }): 'pdf' | 'txt' | 'md' | null;

/** Reads a Buffer / stream / base64 string into a Buffer, rejecting inputs larger than maxBytes. */
export declare function toBuffer(input: FileInput, maxBytes?: number): Promise<Buffer>;

export default HanaVectorPublisher;
