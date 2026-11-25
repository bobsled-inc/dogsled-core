/**
 * Document parser contract — shared types across all format parsers.
 *
 * The Document Stream Schema Contract defines the full three-tier deterministic
 * identity scheme that consumers (the extractor's document runtime) layer on top
 * of these primitives.
 */

export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'html' | 'md' | 'txt' | 'eml';

/** Inputs every parser needs from the runtime. */
export interface ParseOptions {
  /** Provider-relative source URI (e.g. `s3://acme-docs/quarterly.pdf`, `file:./docs/a.md`). */
  readonly sourceUri: string;
  /** SHA-256 of `bytes`, hex-encoded. Computed by caller for cache invalidation. */
  readonly contentHash: string;
  /** Optional revision token from the source backend (S3 ETag, Confluence version, MCP rev). */
  readonly sourceRevision?: string;
  /** Cap on file size in bytes; parser fails with `file_too_large` above this. */
  readonly maxFileSizeBytes?: number;
}

/** Successful parse output — text + per-format metadata. */
export interface ParsedDocument {
  readonly status: 'parsed';
  readonly format: DocumentFormat;
  /** Extracted plain-text body. Whitespace normalized; line endings LF. */
  readonly text: string;
  /** Parser version string `<format>:<semver>`. Tracked in document streams for cache invalidation. */
  readonly parserVersion: string;
  /** Format-specific metadata (page count for PDF, sheet names for XLSX, headers for EML, etc.). */
  readonly metadata: Record<string, unknown>;
}

/** Parse failure — surfaces in the `__parse_errors` stream. Never thrown. */
export interface ParseError {
  readonly status: 'error';
  /**
   * Format that the parser claimed when it failed. `'unknown'` is reserved for the
   * registry's "no parser registered for this extension" path so we don't lie and
   * label e.g. an `.xyz` file as `'txt'`. Real parser failures always set their own
   * `DocumentFormat`.
   */
  readonly format: DocumentFormat | 'unknown';
  readonly errorCode:
    | 'unsupported_format'
    | 'corrupt_input'
    | 'encrypted_input'
    | 'file_too_large'
    | 'parser_internal_error';
  readonly message: string;
  readonly parserVersion: string;
}

export type ParseResult = ParsedDocument | ParseError;

/** Minimal interface for a per-format parser. */
export interface DocumentParser {
  readonly format: DocumentFormat;
  readonly version: string;
  /** Lowercased file extensions this parser claims (without leading dot). */
  readonly supportedExtensions: readonly string[];
  parse(input: Uint8Array, opts: ParseOptions): Promise<ParseResult>;
}

/** Chunker config — identical shape to `chunk:` block in resource YAML. */
export interface ChunkOptions {
  /** How text is cut. Defaults to `recursive`. */
  readonly strategy?: 'recursive' | 'paragraph';
  readonly maxTokens: number;
  /** Tokens repeated from the previous chunk. Must be 0 with `paragraph`. */
  readonly overlapTokens: number;
  /** `paragraph` only: join paragraphs up to this size. Defaults to 60, or `maxTokens` if smaller. */
  readonly minTokens?: number;
  readonly tokenizer: 'cl100k_base' | 'o200k_base' | 'p50k_base';
}

/** A produced chunk. The deterministic IDs are computed by the caller from
 *  `(documentVersionId, chunkerConfigHash, chunkIndex, sha256(text))`. */
export interface Chunk {
  readonly chunkIndex: number;
  readonly text: string;
  readonly tokenCount: number;
}
