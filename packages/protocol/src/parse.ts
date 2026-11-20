import {
  COLUMN_TYPE_SET,
  CURSOR_TYPE_SET,
  CommandError,
  EMBEDDING_DISTANCE_METRIC_SET,
  PROGRESS_EVENT_SET,
  PROTOCOL_VERSION,
  REPLACE_MAX_VALUES,
  SCHEMA_BEHAVIOR_SET,
  isColumnType,
  isEmbeddingDistanceMetric,
  isJsonObject,
  isLineageSourceType,
  isLoadStrategy,
  isPlainObject,
  isProgressEventType,
  isSchemaBehavior,
} from './definitions.js';

import type {
  BatchMessage,
  EmbeddedFromMetadata,
  FileMessage,
  LineageMessage,
  LineageUpstreamEntry,
  LogMessage,
  MetricMessage,
  ProgressMessage,
  RecordMessage,
  ReplaceMessage,
  SchemaColumn,
  SchemaMessage,
  StateMessage,
  StderrMessage,
  StdoutMessage,
} from './definitions.js';

const MAX_IDENTIFIER_LENGTH = 300;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function assertIso8601(value: string, field: string): void {
  if (!ISO_8601_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new CommandError(`${field} must be an ISO 8601 timestamp`);
  }
}

function failValidation(message: string): never {
  throw new CommandError(message);
}
const LOG_LEVELS = new Set<LogMessage['level']>(['debug', 'info', 'warn', 'error']);
const METRIC_CONFIDENCE_LEVELS = new Set<
  NonNullable<MetricMessage['metrics']['estimate_confidence']>
>(['exact', 'upper_bound', 'unknown']);

interface RawObject {
  [key: string]: unknown;
}

interface RawEnvelope extends RawObject {
  _v: number;
  type: string;
}

function validateIdentifier(
  value: string,
  label: string,
  messageType: string,
  index?: number
): void {
  const suffix = index === undefined ? '' : ` ${index}`;

  if (value.length === 0) {
    failValidation(`${messageType} ${label}${suffix} has an empty name`);
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    failValidation(
      `${messageType} ${label}${suffix} name exceeds ${MAX_IDENTIFIER_LENGTH} characters (got ${value.length})`
    );
  }
  if (value.includes('\0')) {
    failValidation(`${messageType} ${label}${suffix} name contains a null byte`);
  }
}

function readStream(
  value: RawEnvelope,
  messageType: 'SCHEMA' | 'RECORD' | 'STATE' | 'BATCH' | 'METRIC' | 'LINEAGE' | 'REPLACE' | 'FILE'
): string {
  if (typeof value['stream'] !== 'string') {
    failValidation(`${messageType} message must include a stream`);
  }

  validateIdentifier(value['stream'], 'stream', `${messageType} message`);
  return value['stream'];
}

function parseEmbeddedFrom(value: unknown, index: number): EmbeddedFromMetadata {
  if (!isPlainObject(value)) {
    failValidation(`SCHEMA message column ${index} embedded_from must be an object`);
  }

  const obj = value;
  const column = obj['column'];
  const provider = obj['provider'];
  const model = obj['model'];

  if (typeof column !== 'string' || column.length === 0) {
    failValidation(
      `SCHEMA message column ${index} embedded_from.column must be a non-empty string`
    );
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    failValidation(
      `SCHEMA message column ${index} embedded_from.provider must be a non-empty string`
    );
  }
  if (typeof model !== 'string' || model.length === 0) {
    failValidation(`SCHEMA message column ${index} embedded_from.model must be a non-empty string`);
  }

  const result: EmbeddedFromMetadata = { column, provider, model };

  if ('distance_metric' in obj && obj['distance_metric'] !== undefined) {
    const metric = obj['distance_metric'];
    if (typeof metric !== 'string' || !isEmbeddingDistanceMetric(metric)) {
      failValidation(
        `SCHEMA message column ${index} embedded_from.distance_metric must be one of: ${[
          ...EMBEDDING_DISTANCE_METRIC_SET,
        ].join(', ')}`
      );
    }
    result.distance_metric = metric;
  }

  const allowedKeys = new Set(['column', 'provider', 'model', 'distance_metric']);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      failValidation(`SCHEMA message column ${index} embedded_from has unknown field "${key}"`);
    }
  }

  return result;
}

function asSchemaColumns(value: unknown): SchemaColumn[] {
  if (!Array.isArray(value)) {
    failValidation('SCHEMA message must include schema.columns');
  }

  return value.map((column, index) => {
    if (
      !isPlainObject(column) ||
      typeof column['name'] !== 'string' ||
      typeof column['type'] !== 'string'
    ) {
      failValidation(`SCHEMA message column ${index} is invalid`);
    }

    validateIdentifier(column['name'], 'column', 'SCHEMA message', index);

    if (!isColumnType(column['type'])) {
      failValidation(
        `SCHEMA message column ${index} has unknown type "${column['type']}". ` +
          `Expected one of: ${[...COLUMN_TYPE_SET].join(', ')}`
      );
    }

    const type = column['type'];

    if (type === 'vector') {
      if (!Number.isInteger(column['dimension']) || (column['dimension'] as number) <= 0) {
        failValidation(
          `SCHEMA message column ${index} must include a positive integer dimension for vector types`
        );
      }

      const nextColumn: SchemaColumn = {
        name: column['name'],
        type,
        dimension: column['dimension'] as number,
      };

      if ('primary_key' in column) {
        if (typeof column['primary_key'] !== 'boolean') {
          failValidation(`SCHEMA message column ${index} has an invalid primary_key flag`);
        }

        nextColumn.primary_key = column['primary_key'];
      }

      if ('embedded_from' in column && column['embedded_from'] !== undefined) {
        nextColumn.embedded_from = parseEmbeddedFrom(column['embedded_from'], index);
      }

      return nextColumn;
    }

    if ('dimension' in column) {
      failValidation(`SCHEMA message column ${index} can only declare dimension for vector types`);
    }

    if ('embedded_from' in column) {
      failValidation(
        `SCHEMA message column ${index} can only declare embedded_from for vector types`
      );
    }

    const nextColumn: SchemaColumn = {
      name: column['name'],
      type,
    };

    if ('primary_key' in column) {
      if (typeof column['primary_key'] !== 'boolean') {
        failValidation(`SCHEMA message column ${index} has an invalid primary_key flag`);
      }

      nextColumn.primary_key = column['primary_key'];
    }

    return nextColumn;
  });
}

function readOptionalString(
  value: RawObject,
  key: 'cursor_field' | 'cursor_value' | 'last_run_at',
  messageType: string
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== 'string') {
    failValidation(`${messageType} message value.${key} must be a string`);
  }
  return candidate;
}

function readOptionalCursorType(value: RawObject): StateMessage['value']['cursor_type'] {
  const candidate = value['cursor_type'];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== 'string' || !CURSOR_TYPE_SET.has(candidate)) {
    failValidation(
      `STATE message value.cursor_type must be one of: ${[...CURSOR_TYPE_SET].join(', ')}`
    );
  }
  return candidate as StateMessage['value']['cursor_type'];
}

function parseSchemaMessage(value: RawEnvelope): SchemaMessage {
  const stream = readStream(value, 'SCHEMA');

  if (!isPlainObject(value['schema'])) {
    failValidation('SCHEMA message must include a schema object');
  }

  const keyProperties = value['key_properties'];
  if (!Array.isArray(keyProperties) || !keyProperties.every((item) => typeof item === 'string')) {
    failValidation('SCHEMA message must include key_properties');
  }

  const columns = asSchemaColumns(value['schema']['columns']);
  const columnNames = new Set<string>();
  for (const column of columns) {
    if (columnNames.has(column.name)) {
      failValidation(`SCHEMA message contains duplicate column "${column.name}"`);
    }
    columnNames.add(column.name);
  }
  // Provenance integrity: an `embedded_from.column` typo would otherwise
  // propagate broken metadata through the loader → Model Spec → SDK → agent
  // host path. Fail loud here so the producer learns at extract time.
  for (const column of columns) {
    if (
      column.type === 'vector' &&
      column.embedded_from !== undefined &&
      !columnNames.has(column.embedded_from.column)
    ) {
      failValidation(
        `SCHEMA message column "${column.name}" embedded_from.column ` +
          `"${column.embedded_from.column}" must reference a declared column`
      );
    }
  }
  for (const key of keyProperties) {
    if (!columnNames.has(key)) {
      failValidation(`SCHEMA message key_properties contains unknown column "${key}"`);
    }
  }

  if (typeof value['load_strategy'] !== 'string' || !isLoadStrategy(value['load_strategy'])) {
    failValidation(
      'SCHEMA message must include a valid load_strategy (append, merge, or full_refresh)'
    );
  }

  const cursorField = value['cursor_field'];
  if (cursorField !== undefined) {
    if (typeof cursorField !== 'string') {
      failValidation('SCHEMA message cursor_field must be a string when provided');
    }
    if (!columnNames.has(cursorField)) {
      failValidation(
        `SCHEMA message cursor_field "${cursorField}" must reference a declared column`
      );
    }
  }

  const partitionBy = value['partition_by'];
  if (partitionBy !== undefined) {
    if (typeof partitionBy !== 'string') {
      failValidation('SCHEMA message partition_by must be a string when provided');
    }
    if (!columnNames.has(partitionBy)) {
      failValidation(`SCHEMA message partition_by "${partitionBy}" is not a valid column name`);
    }
  }

  const schemaBehavior = value['schema_behavior'];
  if (schemaBehavior !== undefined) {
    if (typeof schemaBehavior !== 'string' || !isSchemaBehavior(schemaBehavior)) {
      failValidation(
        `SCHEMA message schema_behavior must be one of: ${[...SCHEMA_BEHAVIOR_SET].join(', ')}`
      );
    }
  }

  return {
    _v: PROTOCOL_VERSION,
    type: 'SCHEMA',
    stream,
    schema: {
      columns,
    },
    key_properties: [...keyProperties],
    load_strategy: value['load_strategy'],
    ...(cursorField !== undefined ? { cursor_field: cursorField } : {}),
    ...(partitionBy !== undefined ? { partition_by: partitionBy } : {}),
    ...(schemaBehavior !== undefined ? { schema_behavior: schemaBehavior } : {}),
  };
}

function parseRecordMessage(value: RawEnvelope): RecordMessage {
  const stream = readStream(value, 'RECORD');

  if (!isJsonObject(value['record'])) {
    failValidation('RECORD message must include a JSON-safe record object');
  }
  if (typeof value['time_extracted'] !== 'string') {
    failValidation('RECORD message must include time_extracted');
  }
  assertIso8601(value['time_extracted'], 'RECORD message time_extracted');

  return {
    _v: PROTOCOL_VERSION,
    type: 'RECORD',
    stream,
    record: value['record'],
    time_extracted: value['time_extracted'],
  };
}

/**
 * The parser only validates that each manifest entry is a file:// URI.
 * Path containment and filesystem access checks remain the consumer's responsibility.
 */
function parseBatchMessage(value: RawEnvelope): BatchMessage {
  const stream = readStream(value, 'BATCH');

  if (!isPlainObject(value['encoding'])) {
    failValidation('BATCH message must include an encoding');
  }
  if (!Array.isArray(value['manifest'])) {
    failValidation('BATCH message must include a manifest of file URIs');
  }

  for (const [index, item] of value['manifest'].entries()) {
    if (typeof item !== 'string') {
      failValidation('BATCH message must include a manifest of file URIs');
    }
    try {
      if (new URL(item).protocol !== 'file:') {
        failValidation(`BATCH message manifest entry ${index} must be a file:// URI`);
      }
    } catch (e) {
      if (e instanceof CommandError) throw e;
      failValidation(`BATCH message manifest entry ${index} must be a file:// URI`);
    }
  }

  const format = value['encoding']['format'];
  if (format !== 'jsonl' && format !== 'parquet') {
    failValidation('BATCH message encoding.format must be "jsonl" or "parquet"');
  }

  if (format === 'parquet') {
    if ('compression' in value['encoding']) {
      failValidation('BATCH message compression is only supported for jsonl encoding');
    }

    return {
      _v: PROTOCOL_VERSION,
      type: 'BATCH',
      stream,
      encoding: { format: 'parquet' },
      manifest: [...value['manifest']],
    };
  }

  const encoding: BatchMessage['encoding'] = { format: 'jsonl' };

  if ('compression' in value['encoding']) {
    if (value['encoding']['compression'] !== 'gzip') {
      failValidation('BATCH message compression must be gzip when provided');
    }

    encoding.compression = 'gzip';
  }

  return {
    _v: PROTOCOL_VERSION,
    type: 'BATCH',
    stream,
    encoding,
    manifest: [...value['manifest']],
  };
}

function parseReplaceMessage(value: RawEnvelope): ReplaceMessage {
  const stream = readStream(value, 'REPLACE');
  const key = value['key'];
  if (typeof key !== 'string') {
    failValidation('REPLACE message must include a key');
  }
  validateIdentifier(key, 'key', 'REPLACE message');
  const values = value['values'];
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > REPLACE_MAX_VALUES ||
    !values.every((item) => typeof item === 'string')
  ) {
    failValidation(`REPLACE message values must be 1 to ${REPLACE_MAX_VALUES} strings`);
  }
  return { _v: PROTOCOL_VERSION, type: 'REPLACE', stream, key, values: [...values] };
}

// Only the shape is checked here. A consumer decides whether it may write the key.
function parseFileMessage(value: RawEnvelope): FileMessage {
  const stream = readStream(value, 'FILE');
  const { uri, relative_key: relativeKey, size } = value;
  if (typeof uri !== 'string' || !uri.startsWith('file://')) {
    failValidation('FILE message uri must be a file:// URI');
  }
  if (typeof relativeKey !== 'string' || relativeKey.length === 0 || relativeKey.includes('\0')) {
    failValidation('FILE message must include a non-empty relative_key without null bytes');
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    failValidation('FILE message size must be a non-negative integer');
  }
  const { source_key: sourceKey, modified } = value;
  if (
    sourceKey !== undefined &&
    (typeof sourceKey !== 'string' || sourceKey.length === 0 || sourceKey.includes('\0'))
  ) {
    failValidation('FILE message source_key must be a non-empty string without null bytes');
  }
  if (modified !== undefined) {
    if (typeof modified !== 'string') failValidation('FILE message modified must be a string');
    assertIso8601(modified, 'FILE message modified');
  }
  return {
    _v: PROTOCOL_VERSION,
    type: 'FILE',
    stream,
    uri,
    relative_key: relativeKey,
    size,
    ...(sourceKey === undefined ? {} : { source_key: sourceKey }),
    ...(modified === undefined ? {} : { modified }),
  };
}

function parseStateMessage(value: RawEnvelope): StateMessage {
  const stream = readStream(value, 'STATE');

  if (!isPlainObject(value['value']) || typeof value['value']['record_count'] !== 'number') {
    failValidation('STATE message must include value.record_count');
  }

  const recordCount = value['value']['record_count'];
  if (!Number.isInteger(recordCount) || recordCount < 0 || recordCount > Number.MAX_SAFE_INTEGER) {
    failValidation('STATE message value.record_count must be a non-negative integer');
  }

  const partition = value['partition'];
  if (partition !== undefined && typeof partition !== 'string') {
    failValidation('STATE message partition must be a string when provided');
  }
  if (typeof partition === 'string' && partition.length === 0) {
    failValidation('STATE message partition must be a non-empty string when provided');
  }

  const cursorField = readOptionalString(value['value'], 'cursor_field', 'STATE');
  const cursorType = readOptionalCursorType(value['value']);
  const cursorValue = readOptionalString(value['value'], 'cursor_value', 'STATE');
  const lastRunAt = readOptionalString(value['value'], 'last_run_at', 'STATE');
  if (lastRunAt !== undefined) {
    assertIso8601(lastRunAt, 'STATE message value.last_run_at');
  }

  return {
    _v: PROTOCOL_VERSION,
    type: 'STATE',
    stream,
    ...(typeof partition === 'string' ? { partition } : {}),
    value: {
      record_count: recordCount,
      ...(cursorField !== undefined ? { cursor_field: cursorField } : {}),
      ...(cursorType !== undefined ? { cursor_type: cursorType } : {}),
      ...(cursorValue !== undefined ? { cursor_value: cursorValue } : {}),
      ...(lastRunAt !== undefined ? { last_run_at: lastRunAt } : {}),
    },
  };
}

function parseLogMessage(value: RawEnvelope): LogMessage {
  const level = value['level'];
  if (!LOG_LEVELS.has(level as LogMessage['level'])) {
    failValidation('LOG message level must be one of: debug, info, warn, error');
  }
  if (typeof value['message'] !== 'string') {
    failValidation('LOG message must include a message');
  }
  if (typeof value['time'] !== 'string') {
    failValidation('LOG message time must be an ISO 8601 timestamp');
  }
  assertIso8601(value['time'], 'LOG message time');

  const out: LogMessage = {
    _v: PROTOCOL_VERSION,
    type: 'LOG',
    level: level as LogMessage['level'],
    message: value['message'],
    time: value['time'],
  };
  // Optional structured-event fields. Loaders ignore them; observability
  // sinks (OpenLineage / OTLP exporters) promote `attributes` to span attributes.
  if (typeof value['event'] === 'string' && value['event'].length > 0) {
    out.event = value['event'];
  }
  const attrs = value['attributes'];
  // `isJsonObject` rejects arrays, null, primitives, and prototype-bearing objects
  // (Date, class instances), keeping LOG payloads JSON-safe like the rest of the
  // protocol envelopes.
  if (isJsonObject(attrs)) {
    out.attributes = attrs;
  }
  return out;
}

function parseMetricMessage(value: RawEnvelope): MetricMessage {
  const stream = readStream(value, 'METRIC');

  if (!isPlainObject(value['metrics'])) {
    failValidation('METRIC message must include a metrics object');
  }
  if (typeof value['time'] !== 'string') {
    failValidation('METRIC message time must be an ISO 8601 timestamp');
  }
  assertIso8601(value['time'], 'METRIC message time');

  const metrics = value['metrics'];
  const numericFields = [
    'records_emitted',
    'api_calls',
    'duration_ms',
    'batch_files',
    'batch_bytes',
    'files_listed',
    'files_skipped',
    'files_processed',
    'bytes_downloaded',
    'estimated_requests',
    'estimated_credits',
    'seed_rows_total',
    'seed_rows_executed',
    'embedding_api_calls',
    'embedding_tokens_processed',
    'embedding_tokens_truncated',
    'embedding_duration_ms',
    'embedding_records_processed',
    // Document-extraction metrics. Without these in the whitelist
    // `parseStderrMessage` would silently drop them off the parsed METRIC envelope.
    'documents_emitted',
    'chunks_emitted',
    'parse_errors_emitted',
  ] as const;

  for (const field of numericFields) {
    const candidate = metrics[field];
    if (candidate !== undefined && typeof candidate !== 'number') {
      failValidation(`METRIC message metrics.${field} must be a number when provided`);
    }
  }

  const estimateConfidence = metrics['estimate_confidence'];
  if (
    estimateConfidence !== undefined &&
    (typeof estimateConfidence !== 'string' ||
      !METRIC_CONFIDENCE_LEVELS.has(
        estimateConfidence as NonNullable<MetricMessage['metrics']['estimate_confidence']>
      ))
  ) {
    failValidation(
      'METRIC message metrics.estimate_confidence must be one of: exact, upper_bound, unknown'
    );
  }

  const normalizedMetrics: MetricMessage['metrics'] = {};
  for (const field of numericFields) {
    const v = metrics[field];
    if (v !== undefined) {
      normalizedMetrics[field] = v as number;
    }
  }
  if (estimateConfidence !== undefined) {
    normalizedMetrics.estimate_confidence = estimateConfidence as NonNullable<
      MetricMessage['metrics']['estimate_confidence']
    >;
  }

  return {
    _v: PROTOCOL_VERSION,
    type: 'METRIC',
    stream,
    metrics: normalizedMetrics,
    time: value['time'],
  };
}

function parseProgressMessage(value: RawEnvelope): ProgressMessage {
  const event = value['event'];
  if (typeof event !== 'string' || !isProgressEventType(event)) {
    failValidation(`PROGRESS message event must be one of: ${[...PROGRESS_EVENT_SET].join(', ')}`);
  }
  if (typeof value['timestamp'] !== 'string') {
    failValidation('PROGRESS message timestamp must be an ISO 8601 timestamp');
  }
  assertIso8601(value['timestamp'], 'PROGRESS message timestamp');
  if (value['resource'] !== undefined && typeof value['resource'] !== 'string') {
    failValidation('PROGRESS message resource must be a string when provided');
  }
  if (value['data'] !== undefined && !isJsonObject(value['data'])) {
    failValidation('PROGRESS message data must be a JSON-safe object when provided');
  }

  return {
    _v: PROTOCOL_VERSION,
    type: 'PROGRESS',
    event,
    ...(value['resource'] !== undefined ? { resource: value['resource'] } : {}),
    timestamp: value['timestamp'],
    ...(value['data'] !== undefined ? { data: value['data'] } : {}),
  };
}

function parseLineageMessage(value: RawEnvelope): LineageMessage {
  const stream = readStream(value, 'LINEAGE');

  if (!isPlainObject(value['lineage'])) {
    failValidation('LINEAGE message must include a lineage object');
  }

  const lineage = value['lineage'] as RawObject;

  if (!isPlainObject(lineage['output'])) {
    failValidation('LINEAGE message lineage.output must be an object');
  }

  const output = lineage['output'] as RawObject;
  if (typeof output['table'] !== 'string' || output['table'].length === 0) {
    failValidation('LINEAGE message lineage.output.table must be a non-empty string');
  }
  if ((output['table'] as string).length > MAX_IDENTIFIER_LENGTH) {
    failValidation(
      `LINEAGE message lineage.output.table exceeds ${MAX_IDENTIFIER_LENGTH} characters`
    );
  }
  if (typeof output['column'] !== 'string' || output['column'].length === 0) {
    failValidation('LINEAGE message lineage.output.column must be a non-empty string');
  }
  if ((output['column'] as string).length > MAX_IDENTIFIER_LENGTH) {
    failValidation(
      `LINEAGE message lineage.output.column exceeds ${MAX_IDENTIFIER_LENGTH} characters`
    );
  }

  if (!Array.isArray(lineage['upstream'])) {
    failValidation('LINEAGE message lineage.upstream must be an array');
  }

  const upstream: LineageUpstreamEntry[] = (lineage['upstream'] as unknown[]).map(
    (entry, index) => {
      if (!isPlainObject(entry)) {
        failValidation(`LINEAGE message lineage.upstream[${index}] must be an object`);
      }
      const e = entry as RawObject;
      if (typeof e['source_type'] !== 'string' || !isLineageSourceType(e['source_type'])) {
        failValidation(
          `LINEAGE message lineage.upstream[${index}].source_type must be one of: api, warehouse, model, clean, entity_graph`
        );
      }
      if (typeof e['table'] !== 'string' || e['table'].length === 0) {
        failValidation(
          `LINEAGE message lineage.upstream[${index}].table must be a non-empty string`
        );
      }
      if ((e['table'] as string).length > MAX_IDENTIFIER_LENGTH) {
        failValidation(
          `LINEAGE message lineage.upstream[${index}].table exceeds ${MAX_IDENTIFIER_LENGTH} characters`
        );
      }
      if (typeof e['column'] !== 'string' || e['column'].length === 0) {
        failValidation(
          `LINEAGE message lineage.upstream[${index}].column must be a non-empty string`
        );
      }
      if ((e['column'] as string).length > MAX_IDENTIFIER_LENGTH) {
        failValidation(
          `LINEAGE message lineage.upstream[${index}].column exceeds ${MAX_IDENTIFIER_LENGTH} characters`
        );
      }
      if (e['field_path'] !== undefined && typeof e['field_path'] !== 'string') {
        failValidation(`LINEAGE message lineage.upstream[${index}].field_path must be a string`);
      }
      if (typeof e['field_path'] === 'string' && e['field_path'].length > MAX_IDENTIFIER_LENGTH) {
        failValidation(
          `LINEAGE message lineage.upstream[${index}].field_path exceeds ${MAX_IDENTIFIER_LENGTH} characters`
        );
      }
      const result: LineageUpstreamEntry = {
        source_type: e['source_type'] as LineageUpstreamEntry['source_type'],
        table: e['table'] as string,
        column: e['column'] as string,
      };
      if (typeof e['field_path'] === 'string') {
        result.field_path = e['field_path'];
      }
      return result;
    }
  );

  if (typeof lineage['is_complete'] !== 'boolean') {
    failValidation('LINEAGE message lineage.is_complete must be a boolean');
  }
  if (typeof lineage['generated_at'] !== 'string') {
    failValidation('LINEAGE message lineage.generated_at must be an ISO 8601 timestamp');
  }
  assertIso8601(lineage['generated_at'] as string, 'LINEAGE message lineage.generated_at');

  if (lineage['transform_ref'] !== undefined) {
    if (typeof lineage['transform_ref'] !== 'string') {
      failValidation('LINEAGE message lineage.transform_ref must be a string when provided');
    }
    if ((lineage['transform_ref'] as string).length > MAX_IDENTIFIER_LENGTH) {
      failValidation(
        `LINEAGE message lineage.transform_ref exceeds ${MAX_IDENTIFIER_LENGTH} characters`
      );
    }
  }
  if (lineage['transform_step'] !== undefined) {
    if (typeof lineage['transform_step'] !== 'string') {
      failValidation('LINEAGE message lineage.transform_step must be a string when provided');
    }
    if ((lineage['transform_step'] as string).length > MAX_IDENTIFIER_LENGTH) {
      failValidation(
        `LINEAGE message lineage.transform_step exceeds ${MAX_IDENTIFIER_LENGTH} characters`
      );
    }
  }

  return {
    _v: PROTOCOL_VERSION,
    type: 'LINEAGE',
    stream,
    lineage: {
      output: {
        table: output['table'] as string,
        column: output['column'] as string,
      },
      upstream,
      is_complete: lineage['is_complete'] as boolean,
      generated_at: lineage['generated_at'] as string,
      ...(typeof lineage['transform_ref'] === 'string'
        ? { transform_ref: lineage['transform_ref'] }
        : {}),
      ...(typeof lineage['transform_step'] === 'string'
        ? { transform_step: lineage['transform_step'] }
        : {}),
    },
  };
}

function assertEnvelope(value: unknown): RawEnvelope {
  if (!isPlainObject(value)) {
    failValidation('Protocol line must be a JSON object');
  }
  if (value['_v'] !== PROTOCOL_VERSION) {
    failValidation('Unsupported protocol version');
  }
  if (typeof value['type'] !== 'string') {
    failValidation('Protocol line must include a type');
  }

  return value as RawEnvelope;
}

interface UnsupportedStdoutEnvelope {
  envelopeType: string;
  unsupported: true;
}

function parseStdoutEnvelope(message: RawEnvelope): StdoutMessage | UnsupportedStdoutEnvelope {
  switch (message['type']) {
    case 'SCHEMA':
      return parseSchemaMessage(message);
    case 'RECORD':
      return parseRecordMessage(message);
    case 'BATCH':
      return parseBatchMessage(message);
    case 'STATE':
      return parseStateMessage(message);
    case 'LINEAGE':
      return parseLineageMessage(message);
    case 'REPLACE':
      return parseReplaceMessage(message);
    case 'FILE':
      return parseFileMessage(message);
    default:
      return {
        envelopeType: message['type'],
        unsupported: true,
      };
  }
}

export function parseStdoutMessage(value: unknown): StdoutMessage | null {
  const parsed = parseStdoutEnvelope(assertEnvelope(value));
  return 'unsupported' in parsed ? null : parsed;
}

export function parseRequiredStdoutMessage(value: unknown): StdoutMessage {
  const parsed = parseStdoutEnvelope(assertEnvelope(value));
  if (!('unsupported' in parsed)) {
    return parsed;
  }

  throw new CommandError(`Unsupported stdout message type "${parsed.envelopeType}"`);
}

export function parseStderrMessage(value: unknown): StderrMessage | null {
  const message = assertEnvelope(value);

  switch (message['type']) {
    case 'LOG':
      return parseLogMessage(message);
    case 'METRIC':
      return parseMetricMessage(message);
    case 'PROGRESS':
      return parseProgressMessage(message);
    default:
      return null;
  }
}
