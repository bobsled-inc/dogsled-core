/**
 * @bobsled-inc/protocol — Shared Dogsled protocol message types.
 *
 * Single source of truth for the JSONL message protocol used between
 * @bobsled-inc/extractor (producer) and @bobsled-inc/loader (consumer).
 */

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const RUN_SUMMARY_VERSION = 1 as const;
export type RunSummaryVersion = typeof RUN_SUMMARY_VERSION;

export const PIPELINE_SUMMARY_VERSION = 1 as const;
export type PipelineSummaryVersion = typeof PIPELINE_SUMMARY_VERSION;

export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {}

// ── Column types ──

export const COLUMN_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'timestamp',
  'array',
  'object',
  'vector',
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

export const COLUMN_TYPE_SET: ReadonlySet<string> = new Set<string>(COLUMN_TYPES);

/** Type guard that narrows a string to ColumnType. */
export function isColumnType(value: string): value is ColumnType {
  return COLUMN_TYPE_SET.has(value);
}

// ── Schema ──

export interface BaseSchemaColumn {
  name: string;
  primary_key?: boolean;
}

export interface ScalarSchemaColumn extends BaseSchemaColumn {
  type: Exclude<ColumnType, 'vector'>;
}

/**
 * Provenance for an embedding column. Declared on the vector column itself
 * so downstream consumers (the loader's DDL inference, the SDK IR, the
 * host agent) know which source column was embedded and which
 * provider/model produced it. The model identity is required to generate
 * a query embedding in the same family at vector-search time.
 */
export interface EmbeddedFromMetadata {
  column: string;
  provider: string;
  model: string;
  distance_metric?: EmbeddingDistanceMetric;
}

export const EMBEDDING_DISTANCE_METRICS = ['cosine', 'l2', 'dot'] as const;
export type EmbeddingDistanceMetric = (typeof EMBEDDING_DISTANCE_METRICS)[number];

export const EMBEDDING_DISTANCE_METRIC_SET: ReadonlySet<string> = new Set<string>(
  EMBEDDING_DISTANCE_METRICS
);

/** Type guard that narrows a string to EmbeddingDistanceMetric. */
export function isEmbeddingDistanceMetric(value: string): value is EmbeddingDistanceMetric {
  return EMBEDDING_DISTANCE_METRIC_SET.has(value);
}

export interface VectorSchemaColumn extends BaseSchemaColumn {
  type: 'vector';
  dimension: number;
  embedded_from?: EmbeddedFromMetadata;
}

export type SchemaColumn = ScalarSchemaColumn | VectorSchemaColumn;

// ── Messages ──

export const LOAD_STRATEGIES = ['append', 'merge', 'full_refresh'] as const;
export type LoadStrategy = (typeof LOAD_STRATEGIES)[number];

export const LOAD_STRATEGY_SET: ReadonlySet<string> = new Set<string>(LOAD_STRATEGIES);

/** Type guard that narrows a string to LoadStrategy. */
export function isLoadStrategy(value: string): value is LoadStrategy {
  return LOAD_STRATEGY_SET.has(value);
}

export const CURSOR_TYPES = ['string', 'number', 'integer', 'timestamp', 'lsn'] as const;
export type CursorType = (typeof CURSOR_TYPES)[number];

export const CURSOR_TYPE_SET: ReadonlySet<string> = new Set<string>(CURSOR_TYPES);

/** Type guard that narrows a string to CursorType. */
export function isCursorType(value: string): value is CursorType {
  return CURSOR_TYPE_SET.has(value);
}

export interface SchemaMessage {
  _v: ProtocolVersion;
  type: 'SCHEMA';
  stream: string;
  schema: {
    columns: SchemaColumn[];
  };
  key_properties: string[];
  load_strategy: LoadStrategy;
  cursor_field?: string;
  partition_by?: string;
  schema_behavior?: SchemaBehavior;
}

export interface RecordMessage {
  _v: ProtocolVersion;
  type: 'RECORD';
  stream: string;
  record: JsonObject;
  time_extracted: string;
}

export interface StateMessage {
  _v: ProtocolVersion;
  type: 'STATE';
  stream: string;
  /**
   * Opaque sub-stream identifier used when the producer fans the same
   * `stream` out across iterations (e.g. an extractor `for_each` loop). When
   * present, consumers MUST treat `stream + partition` as the bookmark key
   * so each iteration carries its own cursor. The destination table identity
   * stays at `stream`. Absent when the stream is not partitioned.
   */
  partition?: string;
  value: {
    cursor_field?: string;
    cursor_type?: CursorType;
    cursor_value?: string;
    last_run_at?: string;
    record_count: number;
  };
}

export const BATCH_FORMATS = ['jsonl', 'parquet'] as const;
export type BatchFormat = (typeof BATCH_FORMATS)[number];

export const BATCH_FORMAT_SET: ReadonlySet<string> = new Set<string>(BATCH_FORMATS);

/** Type guard that narrows a string to BatchFormat. */
export function isBatchFormat(value: string): value is BatchFormat {
  return BATCH_FORMAT_SET.has(value);
}

export interface JsonlBatchEncoding {
  format: 'jsonl';
  compression?: 'gzip';
}

export interface ParquetBatchEncoding {
  format: 'parquet';
}

export type BatchEncoding = JsonlBatchEncoding | ParquetBatchEncoding;

export interface BatchMessage {
  _v: ProtocolVersion;
  type: 'BATCH';
  stream: string;
  encoding: BatchEncoding;
  manifest: string[];
}

/**
 * Document-extraction LogMessage subtypes. These are structured
 * named events emitted by the extractor's document runtime. They flow through the
 * existing LOG envelope (no new top-level message type per §SourceKind Dispatch
 * Contract) — consumers can switch on the optional `event` field.
 *
 * - `extraction_started`: emitted at the beginning of a document resource extraction
 * - `extraction_completed`: emitted when a document resource finishes extracting
 * - `mode_resolved`: emitted when read-in-place mode resolution settles
 * - `cache_hit_summary`: emitted at end-of-run summarizing cache hits/misses
 */
export type DocumentLogEvent =
  'extraction_started' | 'extraction_completed' | 'mode_resolved' | 'cache_hit_summary';

export interface LogMessage {
  _v: ProtocolVersion;
  type: 'LOG';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  time: string;
  /**
   * Optional structured event tag. When set, downstream consumers can route by
   * event name instead of pattern-matching the human-readable `message` string.
   */
  event?: DocumentLogEvent | string;
  /**
   * Optional structured payload for events that carry data beyond `message`.
   * Loaders ignore this field; observability sinks (OpenLineage / OTLP exporters)
   * promote it to attributes. Must be JSON-safe (`JsonObject`) — non-plain objects
   * (Date, class instances) and non-JSON values (functions, undefined) are rejected
   * by `parseLogMessage`.
   */
  attributes?: JsonObject;
}

export interface MetricMessage {
  _v: ProtocolVersion;
  type: 'METRIC';
  stream: string;
  metrics: {
    records_emitted?: number;
    api_calls?: number;
    duration_ms?: number;
    batch_files?: number;
    batch_bytes?: number;
    files_listed?: number;
    files_skipped?: number;
    files_processed?: number;
    bytes_downloaded?: number;
    estimated_requests?: number;
    estimated_credits?: number;
    estimate_confidence?: 'exact' | 'upper_bound' | 'unknown';
    seed_rows_total?: number;
    seed_rows_executed?: number;
    embedding_api_calls?: number;
    embedding_tokens_processed?: number;
    embedding_tokens_truncated?: number;
    embedding_duration_ms?: number;
    embedding_records_processed?: number;
    // Document-extraction metrics. Emitted by
    // `extractDocumentResource` for `<resource>__documents`/`__chunks`/
    // `__parse_errors` accounting, per the Document Stream Schema Contract.
    documents_emitted?: number;
    chunks_emitted?: number;
    parse_errors_emitted?: number;
  };
  time: string;
}

// ── Lineage ──

export const LINEAGE_SOURCE_TYPES = ['api', 'warehouse', 'model', 'clean', 'entity_graph'] as const;
export type LineageSourceType = (typeof LINEAGE_SOURCE_TYPES)[number];

export const LINEAGE_SOURCE_TYPE_SET: ReadonlySet<string> = new Set<string>(LINEAGE_SOURCE_TYPES);

/** Type guard that narrows a string to LineageSourceType. */
export function isLineageSourceType(value: string): value is LineageSourceType {
  return LINEAGE_SOURCE_TYPE_SET.has(value);
}

export interface LineageUpstreamEntry {
  source_type: LineageSourceType;
  table: string;
  column: string;
  field_path?: string;
}

export interface LineageOutput {
  table: string;
  column: string;
}

export interface LineagePayload {
  output: LineageOutput;
  upstream: LineageUpstreamEntry[];
  transform_ref?: string;
  transform_step?: string;
  is_complete: boolean;
  generated_at: string;
}

export interface LineageMessage {
  _v: ProtocolVersion;
  type: 'LINEAGE';
  stream: string;
  lineage: LineagePayload;
}

/** Most values one REPLACE message may carry. */
export const REPLACE_MAX_VALUES = 1000;

/**
 * Replace a slice of a stream's rows. A consumer deletes the destination rows whose
 * `key` column equals one of `values` before it writes this run's rows for those
 * values. The producer emits it after the stream's SCHEMA and before any RECORD of
 * those values, and also when no rows follow, so the slice ends up empty.
 */
export interface ReplaceMessage {
  _v: ProtocolVersion;
  type: 'REPLACE';
  stream: string;
  key: string;
  values: string[];
}

/**
 * Copy one file as it is. `uri` names a temp file the producer owns. The consumer writes
 * its bytes to `<stream>/<relative_key>` at the destination and then deletes the temp file;
 * the producer treats a deleted file as written, so it must not delete the file itself
 * until then. `size` is the file's size in bytes. A consumer that cannot copy files must
 * fail instead of ignoring the message.
 */
export interface FileMessage {
  _v: ProtocolVersion;
  type: 'FILE';
  stream: string;
  uri: string;
  relative_key: string;
  size: number;
}

/** Data messages emitted on stdout. */
export type StdoutMessage =
  | SchemaMessage
  | RecordMessage
  | StateMessage
  | BatchMessage
  | LineageMessage
  | ReplaceMessage
  | FileMessage;

// ── Failure reasons ──

export const FAILURE_REASONS = [
  'auth_failure',
  'rate_limit_exhausted',
  'timeout',
  'data_error',
  'config_error',
  'transient_error',
  'circuit_breaker',
  'schema_conflict',
  'destination_error',
  'partial_success',
  // A `for_each` child resource ran without its parent in the same extraction
  // process, so it could not see the parent's in-memory cache. Distinct from
  // `config_error` because the resource YAML is valid; callers must select the
  // parent and child together.
  'for_each_parent_not_co_scheduled',
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

// ── Skipped reasons ──

/**
 * Structured reasons a resource/stream can be skipped during extraction.
 * Mirrors the `data.reason` payloads emitted on `resource_skip` PROGRESS
 * events by the extractor (see `@bobsled-inc/extractor` extract command). A
 * typed enum lets Dogsled PIPELINE_SUMMARY consumers and host applications
 * branch on the skip cause instead of substring-matching
 * a warn log line.
 */
export const SKIPPED_REASONS = [
  'for_each_parent_empty',
  'for_each_incomplete_bindings',
  'timeout',
  'circuit_breaker',
] as const;

export type SkippedReason = (typeof SKIPPED_REASONS)[number];

export const SKIPPED_REASON_SET: ReadonlySet<string> = new Set<string>(SKIPPED_REASONS);

/** Type guard that narrows a string to SkippedReason. */
export function isSkippedReason(value: string): value is SkippedReason {
  return SKIPPED_REASON_SET.has(value);
}

// ── Progress events ──

export const PROGRESS_EVENTS = [
  'run_start',
  'run_complete',
  'resource_start',
  'resource_complete',
  'resource_error',
  'resource_skip',
  'health_check_complete',
] as const;

export type ProgressEventType = (typeof PROGRESS_EVENTS)[number];

export const PROGRESS_EVENT_SET: ReadonlySet<string> = new Set<string>(PROGRESS_EVENTS);

/** Type guard that narrows a string to ProgressEventType. */
export function isProgressEventType(value: string): value is ProgressEventType {
  return PROGRESS_EVENT_SET.has(value);
}

export interface ProgressMessage {
  _v: ProtocolVersion;
  type: 'PROGRESS';
  event: ProgressEventType;
  resource?: string;
  timestamp: string;
  data?: JsonObject;
}

// ── Schema behaviors ──

export const SCHEMA_BEHAVIORS = ['evolve', 'strict', 'freeze'] as const;

export type SchemaBehavior = (typeof SCHEMA_BEHAVIORS)[number];

export const SCHEMA_BEHAVIOR_SET: ReadonlySet<string> = new Set<string>(SCHEMA_BEHAVIORS);

/** Type guard that narrows a string to SchemaBehavior. */
export function isSchemaBehavior(value: string): value is SchemaBehavior {
  return SCHEMA_BEHAVIOR_SET.has(value);
}

/** Control messages emitted on stderr. */
export type StderrMessage = LogMessage | MetricMessage | ProgressMessage;

// ── Summary messages ──

/**
 * Per-output-field match telemetry for a resource extraction. `matched` counts
 * the records where at least one configured JSONPath resolved to a value;
 * `total` is the number of records the field was evaluated against. A field
 * with `matched: 0` flags a JSONPath that silently matched zero elements.
 */
export interface FieldCoverage {
  matched: number;
  total: number;
}

export interface RunSummaryResourceEntry {
  status: 'success' | 'error' | 'skipped' | 'circuit_breaker';
  records_emitted: number;
  api_calls: number;
  duration_ms: number;
  error?: string;
  /** Stable `DogsledRuntimeError.code` (for example `SFTP_CONNECTION_LOST`) when one caused the failure. */
  error_code?: string;
  failure_reason?: FailureReason;
  cursor_value?: string;
  field_coverage?: Record<string, FieldCoverage>;
}

export interface RunSummaryMessage {
  _v: RunSummaryVersion;
  type: 'RUN_SUMMARY';
  integration: string;
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  status: 'success' | 'partial_success' | 'failure';
  failure_reason?: FailureReason;
  totals: {
    resources_total: number;
    resources_succeeded: number;
    resources_failed: number;
    resources_skipped: number;
    records_emitted: number;
    api_calls: number;
  };
  resources: Record<string, RunSummaryResourceEntry>;
}

export interface PipelineStreamSummary {
  status: 'success' | 'failure' | 'skipped';
  records_extracted: number;
  records_emitted: number;
  rows_loaded: number;
  api_calls: number;
  extract_ms: number;
  load_ms: number;
  duration_ms: number;
  error?: string;
  /** Stable `DogsledRuntimeError.code` reported by the extractor for this stream. */
  error_code?: string;
  /** Present only when `status === 'skipped'`; the structured skip cause. */
  skipped_reason?: SkippedReason;
}

export interface PipelineSummaryMessage {
  _v: PipelineSummaryVersion;
  type: 'PIPELINE_SUMMARY';
  integration: string;
  elapsed_seconds: number;
  total_streams: number;
  succeeded: number;
  failed: number;
  /** Streams that were listed for the run but did not execute (see SkippedReason). */
  skipped: number;
  total_records_extracted: number;
  total_rows_loaded: number;
  total_api_calls: number;
  streams: Record<string, PipelineStreamSummary>;
}

// ── Shared utilities ──

/** Type guard for plain objects (not null, not array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Type guard for recursively JSON-safe values. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((entry) => isJsonValue(entry));
}

/** Type guard for plain objects whose nested values are all JSON-safe. */
export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value) && Object.values(value).every((entry) => isJsonValue(entry));
}

/** Backward-compatible alias for callers that only need plain-object semantics. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

/** Parse a CLI option as a positive integer with overflow protection. */
export function parsePositiveInt(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CommandError(`Expected a positive integer, received "${value}"`);
  }
  const n = Number(value);
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new CommandError(`Expected a positive integer, received "${value}"`);
  }
  return n;
}

// ── Exit codes ──

export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1; // Runtime/system error
export const EXIT_VALIDATION = 2; // User input/schema error
export const EXIT_DRIFT = 3; // Changes detected (plan)

// ── Shared errors ──

export class CommandError extends Error {
  readonly exitCode: number;
  readonly payload?: unknown;

  constructor(message: string, exitCode = EXIT_VALIDATION, payload?: unknown) {
    super(message);
    this.name = 'CommandError';
    this.exitCode = exitCode;
    this.payload = payload;
  }
}
