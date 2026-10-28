import type { Readable, Writable } from 'node:stream';

import { readProtocol } from '@bobsled-inc/loader/runtime';
import {
  CommandError,
  EXIT_VALIDATION,
  PROTOCOL_VERSION,
  type EmbeddedFromMetadata,
  type LogMessage,
  type MetricMessage,
  type RecordMessage,
  type SchemaColumn,
  type SchemaMessage,
} from '@bobsled-inc/protocol';

import { outputColumnName } from '../output-column.js';
import { rewriteBatch } from './batch-rewriter.js';
import { MAX_EMBEDDING_TOKENS, truncateToTokens } from './tokenizer.js';

import type { BatchMessage, JsonObject } from '@bobsled-inc/protocol';

export interface EmbedBatchResult {
  vectors: number[][];
  tokensUsed: number;
}

export interface StreamFieldConfig {
  field: string;
  as?: string;
}

export interface EnrichSchemaOptions {
  streamConfigs: Record<string, StreamFieldConfig[]>;
  dimensions: number;
  provider: string;
  model: string;
}

export interface RunEmbedderOptions {
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  config: {
    streams: Record<string, StreamFieldConfig[]>;
    provider: string;
    model: string;
  };
  dimensions: number;
  batchSize: number;
  embedFn: (texts: string[]) => Promise<EmbedBatchResult>;
  tmpDir?: string;
  logOptions?: EmbedderLogOptions;
}

export interface EmbedderLogOptions {
  logFormat?: 'json' | 'pretty';
  quiet?: boolean;
  verbose?: boolean;
}

interface PendingRecord {
  message: RecordMessage;
  additions: JsonObject;
}

interface PendingText {
  recordIndex: number;
  outputName: string;
  text: string;
}

interface StreamMetrics {
  embedding_api_calls: number;
  embedding_tokens_processed: number;
  embedding_tokens_truncated: number;
  embedding_duration_ms: number;
  embedding_records_processed: number;
}

function createStreamMetrics(): StreamMetrics {
  return {
    embedding_api_calls: 0,
    embedding_tokens_processed: 0,
    embedding_tokens_truncated: 0,
    embedding_duration_ms: 0,
    embedding_records_processed: 0,
  };
}

function assertRecordFitsBatchSize(batchSize: number, requestCount: number, stream: string): void {
  if (requestCount <= batchSize) {
    return;
  }

  throw new CommandError(
    `Embed batch-size ${batchSize} is too small for stream "${stream}": a single record produced ${requestCount} embedding requests. Increase the batch size or reduce the configured embed fields for that stream.`,
    EXIT_VALIDATION
  );
}

async function writeJsonLine(output: Writable, message: unknown): Promise<void> {
  const line = `${JSON.stringify(message)}\n`;
  if (output.write(line)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      output.removeListener('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      output.removeListener('drain', onDrain);
      reject(error);
    };

    output.once('drain', onDrain);
    output.once('error', onError);
  });
}

function getOrCreateMetrics(
  metricsByStream: Map<string, StreamMetrics>,
  stream: string
): StreamMetrics {
  let metrics = metricsByStream.get(stream);
  if (!metrics) {
    metrics = createStreamMetrics();
    metricsByStream.set(stream, metrics);
  }
  return metrics;
}

export function buildWarnLogMessage(message: string): LogMessage {
  return {
    _v: PROTOCOL_VERSION,
    type: 'LOG',
    level: 'warn',
    message,
    time: new Date().toISOString(),
  };
}

export function buildErrorLogMessage(message: string): LogMessage {
  return {
    _v: PROTOCOL_VERSION,
    type: 'LOG',
    level: 'error',
    message,
    time: new Date().toISOString(),
  };
}

function buildDebugLogMessage(message: string): LogMessage {
  return {
    _v: PROTOCOL_VERSION,
    type: 'LOG',
    level: 'debug',
    message,
    time: new Date().toISOString(),
  };
}

function shouldEmitLog(
  message: LogMessage | MetricMessage,
  options: EmbedderLogOptions | undefined
): boolean {
  if ('metrics' in message) {
    return options?.quiet !== true;
  }

  if (message.level === 'error') {
    return true;
  }

  if (message.level === 'debug') {
    return options?.quiet !== true && options?.verbose === true;
  }

  return options?.quiet !== true;
}

function formatPrettyLog(message: LogMessage | MetricMessage): string {
  if ('metrics' in message) {
    const metrics = Object.entries(message.metrics)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return `[metric] stream=${message.stream} ${metrics}`;
  }

  return `[${message.level}] ${message.message}`;
}

export function writeStructuredLog(
  output: Writable,
  message: LogMessage | MetricMessage,
  options: EmbedderLogOptions = {}
): void {
  if (!shouldEmitLog(message, options)) {
    return;
  }

  const line = options.logFormat === 'pretty' ? formatPrettyLog(message) : JSON.stringify(message);
  output.write(`${line}\n`);
}

export function enrichSchema(message: SchemaMessage, options: EnrichSchemaOptions): SchemaMessage {
  const fields = options.streamConfigs[message.stream];
  if (!fields || fields.length === 0) {
    return message;
  }

  const existingColumns = new Set(message.schema.columns.map((column) => column.name));
  const vectorColumns: SchemaColumn[] = [];

  for (const field of fields) {
    if (!existingColumns.has(field.field)) {
      throw new CommandError(
        `Embed field "${field.field}" not found in stream "${message.stream}". Available: ${[...existingColumns].join(', ')}`,
        EXIT_VALIDATION
      );
    }

    const outputName = outputColumnName(field.field, field.as);
    if (existingColumns.has(outputName)) {
      throw new CommandError(
        `Embed output column "${outputName}" already exists in stream "${message.stream}"`,
        EXIT_VALIDATION
      );
    }

    existingColumns.add(outputName);
    const embeddedFrom: EmbeddedFromMetadata = {
      column: field.field,
      provider: options.provider,
      model: options.model,
    };
    vectorColumns.push({
      name: outputName,
      type: 'vector',
      dimension: options.dimensions,
      embedded_from: embeddedFrom,
    });
  }

  return {
    ...message,
    schema: {
      ...message.schema,
      columns: [...message.schema.columns, ...vectorColumns],
    },
  };
}

export async function runEmbedder(options: RunEmbedderOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const logOptions = options.logOptions ?? {};
  const truncationLogKeys = new Set<string>();
  const metricsByStream = new Map<string, StreamMetrics>();
  let activeStream: string | null = null;
  const pendingRecords: PendingRecord[] = [];
  const pendingTexts: PendingText[] = [];

  const flushPending = async (): Promise<void> => {
    if (pendingRecords.length === 0 || !activeStream) {
      pendingRecords.length = 0;
      pendingTexts.length = 0;
      activeStream = null;
      return;
    }

    if (pendingTexts.length > 0) {
      const startedAt = Date.now();
      writeStructuredLog(
        errorOutput,
        buildDebugLogMessage(
          `Embedding ${pendingTexts.length} values for stream "${activeStream}" in one request batch`
        ),
        logOptions
      );
      const result = await options.embedFn(pendingTexts.map((entry) => entry.text));
      const metrics = getOrCreateMetrics(metricsByStream, activeStream);
      metrics.embedding_api_calls += 1;
      metrics.embedding_tokens_processed += result.tokensUsed;
      metrics.embedding_duration_ms += Date.now() - startedAt;

      if (result.vectors.length !== pendingTexts.length) {
        throw new Error(
          `Expected ${pendingTexts.length} embeddings for stream "${activeStream}", received ${result.vectors.length}`
        );
      }

      for (const [index, pendingText] of pendingTexts.entries()) {
        pendingRecords[pendingText.recordIndex]!.additions[pendingText.outputName] =
          result.vectors[index]!;
      }
    }

    const streamMetrics = getOrCreateMetrics(metricsByStream, activeStream);
    for (const pendingRecord of pendingRecords) {
      await writeJsonLine(output, {
        ...pendingRecord.message,
        record: {
          ...pendingRecord.message.record,
          ...pendingRecord.additions,
        },
      });
      streamMetrics.embedding_records_processed += 1;
    }

    pendingRecords.length = 0;
    pendingTexts.length = 0;
    activeStream = null;
  };

  const noteTruncation = (stream: string, field: string, originalTokens: number): void => {
    const key = `${stream}::${field}`;
    const metrics = getOrCreateMetrics(metricsByStream, stream);
    metrics.embedding_tokens_truncated += 1;

    if (truncationLogKeys.has(key)) {
      return;
    }

    truncationLogKeys.add(key);
    writeStructuredLog(
      errorOutput,
      buildWarnLogMessage(
        `Truncating field "${field}" in stream "${stream}" to ${MAX_EMBEDDING_TOKENS} tokens (first occurrence, original length ${originalTokens} tokens)`
      ),
      logOptions
    );
  };

  for await (const message of readProtocol(input)) {
    if (message.type === 'SCHEMA') {
      await flushPending();
      await writeJsonLine(
        output,
        enrichSchema(message, {
          streamConfigs: options.config.streams,
          dimensions: options.dimensions,
          provider: options.config.provider,
          model: options.config.model,
        })
      );
      continue;
    }

    if (message.type === 'BATCH') {
      await flushPending();
      const fields = options.config.streams[message.stream];
      if (!fields || fields.length === 0) {
        await writeJsonLine(output, message);
        continue;
      }

      writeStructuredLog(
        errorOutput,
        buildDebugLogMessage(
          `Rewriting BATCH payload for stream "${message.stream}" with ${fields.length} embedding field${fields.length === 1 ? '' : 's'}`
        ),
        logOptions
      );
      const streamMetrics = getOrCreateMetrics(metricsByStream, message.stream);
      const rewrittenBatch = await rewriteBatch({
        message: message as BatchMessage,
        fields,
        batchSize: options.batchSize,
        embedFn: options.embedFn,
        tmpDir: options.tmpDir,
        onTruncation: (stream, field, originalTokens) => {
          noteTruncation(stream, field, originalTokens);
        },
        onApiCall: (tokensUsed, durationMs) => {
          streamMetrics.embedding_api_calls += 1;
          streamMetrics.embedding_tokens_processed += tokensUsed;
          streamMetrics.embedding_duration_ms += durationMs;
        },
        onRecord: () => {
          streamMetrics.embedding_records_processed += 1;
        },
      });
      await writeJsonLine(output, rewrittenBatch);
      continue;
    }

    if (message.type === 'RECORD') {
      const fields = options.config.streams[message.stream];
      if (!fields || fields.length === 0) {
        await flushPending();
        await writeJsonLine(output, message);
        continue;
      }

      if (activeStream !== null && activeStream !== message.stream) {
        await flushPending();
      }

      const additions: JsonObject = {};
      const requests: Array<{ outputName: string; text: string }> = [];
      for (const field of fields) {
        const outputName = outputColumnName(field.field, field.as);
        const value = message.record[field.field];
        if (value === null || value === undefined || value === '') {
          additions[outputName] = null;
          continue;
        }

        const truncated = truncateToTokens(String(value), MAX_EMBEDDING_TOKENS);
        if (truncated.truncated) {
          noteTruncation(message.stream, field.field, truncated.originalTokens);
        }

        requests.push({
          outputName,
          text: truncated.text,
        });
      }

      assertRecordFitsBatchSize(options.batchSize, requests.length, message.stream);

      if (pendingTexts.length > 0 && pendingTexts.length + requests.length > options.batchSize) {
        await flushPending();
      }

      activeStream = message.stream;
      const recordIndex =
        pendingRecords.push({
          message,
          additions,
        }) - 1;

      for (const request of requests) {
        pendingTexts.push({
          recordIndex,
          outputName: request.outputName,
          text: request.text,
        });
      }

      if (requests.length === 0) {
        await flushPending();
      }

      continue;
    }

    await flushPending();
    await writeJsonLine(output, message);
  }

  await flushPending();

  for (const [stream, metrics] of metricsByStream.entries()) {
    writeStructuredLog(
      errorOutput,
      {
        _v: PROTOCOL_VERSION,
        type: 'METRIC',
        stream,
        metrics,
        time: new Date().toISOString(),
      },
      logOptions
    );
  }
}
