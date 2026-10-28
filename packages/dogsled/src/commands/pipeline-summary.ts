import * as fs from 'node:fs';

import {
  PIPELINE_SUMMARY_VERSION,
  isObject,
  isSkippedReason,
  parseStderrMessage,
} from '@bobsled-inc/protocol';
import { escapeRegExp } from '../lib/regex.js';
import { extractErrorMessage } from './pipeline-fanout.js';

import type {
  PipelineSummaryMessage,
  SerializedErrorCause,
  SkippedReason,
} from '@bobsled-inc/protocol';

export interface StreamSummary {
  records_emitted: number;
  rows_loaded: number;
  api_calls: number;
  extract_ms: number;
  load_ms: number;
  error?: string;
  cause?: SerializedErrorCause;
  /** Set when the extractor emits a `resource_skip` PROGRESS event for this stream. */
  skipped?: boolean;
  skipped_reason?: SkippedReason;
}

export interface PipelineSummary {
  streams: Map<string, StreamSummary>;
  startTime: number;
}

function mergeStreamError(existingError?: string, nextError?: string): string | undefined {
  if (!existingError) {
    return nextError;
  }
  if (!nextError || nextError === existingError) {
    return existingError;
  }
  return `${existingError} | ${nextError}`;
}

function getOrCreateStream(summary: PipelineSummary, name: string): StreamSummary {
  let stream = summary.streams.get(name);
  if (!stream) {
    stream = { records_emitted: 0, rows_loaded: 0, api_calls: 0, extract_ms: 0, load_ms: 0 };
    summary.streams.set(name, stream);
  }
  return stream;
}

function buildLoaderRowRegex(tablePrefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(tablePrefix)}(\\w+): loaded (\\d+) rows$`);
}

function extractLoaderErrorStream(message: string): string | undefined {
  const match = message.match(/^Failed to load stream "([^"]+)" to [^:]+:/);
  return match?.[1];
}

function parseStderrLine(summary: PipelineSummary, line: string, loaderRowRegex: RegExp): void {
  if (!line.startsWith('{')) return;
  try {
    const rawParsed: unknown = JSON.parse(line);
    if (!isObject(rawParsed)) return;
    const parsed = rawParsed;

    // The loader emits its own JSON logger envelope (`level` + `event`, without
    // a protocol `type`). Preserve its complete wrapped provider error in the
    // stream summary so single-destination public runs expose the same detail
    // that fan-out manifests already retain.
    const loaderError = extractErrorMessage(line);
    const loaderErrorStream = loaderError ? extractLoaderErrorStream(loaderError) : undefined;
    if (loaderError && loaderErrorStream) {
      const stream = getOrCreateStream(summary, loaderErrorStream);
      stream.error = mergeStreamError(stream.error, loaderError);
    }

    let message: ReturnType<typeof parseStderrMessage> | null = null;
    try {
      message = parseStderrMessage(parsed);
    } catch {
      message = null;
    }

    if (message?.type === 'METRIC') {
      const stream = getOrCreateStream(summary, message.stream);
      stream.records_emitted += message.metrics.records_emitted ?? 0;
      stream.api_calls +=
        (message.metrics.api_calls ?? 0) + (message.metrics.embedding_api_calls ?? 0);
      stream.extract_ms +=
        (message.metrics.duration_ms ?? 0) + (message.metrics.embedding_duration_ms ?? 0);
    }

    if (message?.type === 'LOG' && message.level === 'error') {
      const match = message.message.match(/^Failed: [^/]+\/([^:]+): (.+)$/);
      if (match) {
        const stream = getOrCreateStream(summary, match[1]!);
        stream.error = mergeStreamError(stream.error, match[2]!);
      }
    }

    if (message?.type === 'LOG' && message.event === 'progress.resource_error') {
      const resource = message.attributes?.['resource'];
      const error = message.attributes?.['error'];
      const cause = message.attributes?.['cause'];
      if (typeof resource === 'string') {
        const stream = getOrCreateStream(summary, resource);
        if (typeof error === 'string') stream.error = mergeStreamError(stream.error, error);
        if (isSerializedErrorCause(cause)) stream.cause = cause;
      }
    }

    // A skipped resource emits no METRIC and no loader-row line, so without
    // this branch it would never appear in `streams` at all. Record it as a
    // first-class skip with its structured reason so the summary distinguishes
    // "did not run" from "ran successfully with zero rows".
    if (message?.type === 'PROGRESS' && message.event === 'resource_skip' && message.resource) {
      const stream = getOrCreateStream(summary, message.resource);
      stream.skipped = true;
      const reason = message.data?.['reason'];
      if (typeof reason === 'string' && isSkippedReason(reason)) {
        stream.skipped_reason = reason;
      }
    }

    if (parsed['level'] === 'info' && typeof parsed['event'] === 'string') {
      const loadMatch = String(parsed['event']).match(loaderRowRegex);
      // New loaders include the raw protocol stream explicitly because a
      // per-resource `table:` override can replace the prefix-based table name
      // entirely. Keep the regex fallback for older loader versions and for
      // hand-authored structured logs.
      const structuredStream =
        typeof parsed['stream'] === 'string' && parsed['stream'].length > 0
          ? parsed['stream']
          : undefined;
      const loadMs =
        typeof parsed['loadMs'] === 'number' ? parsed['loadMs'] : Number(parsed['loadMs']);
      const rowsAffected =
        typeof parsed['rowsAffected'] === 'number'
          ? parsed['rowsAffected']
          : Number(parsed['rowsAffected']);
      if (structuredStream && Number.isFinite(loadMs) && Number.isFinite(rowsAffected)) {
        const stream = getOrCreateStream(summary, structuredStream);
        stream.rows_loaded += rowsAffected;
        stream.load_ms += loadMs;
      } else if (loadMatch && Number.isFinite(loadMs)) {
        const stream = getOrCreateStream(summary, loadMatch[1]!);
        stream.rows_loaded += Number(loadMatch[2]);
        stream.load_ms += loadMs;
      }
    }
  } catch {
    // Not JSON or parse error - ignore.
  }
}

function isSerializedErrorCause(value: unknown): value is SerializedErrorCause {
  if (!isObject(value)) return false;
  if (typeof value['name'] !== 'string' || typeof value['message'] !== 'string') return false;
  if (value['code'] !== undefined && !['string', 'number'].includes(typeof value['code'])) {
    return false;
  }
  if (value['status'] !== undefined && typeof value['status'] !== 'number') return false;
  return value['cause'] === undefined || isSerializedErrorCause(value['cause']);
}

export function createPipelineSummary(): PipelineSummary {
  return { streams: new Map(), startTime: Date.now() };
}

export function clonePipelineSummary(summary: PipelineSummary): PipelineSummary {
  return {
    startTime: summary.startTime,
    streams: new Map([...summary.streams.entries()].map(([name, stream]) => [name, { ...stream }])),
  };
}

export function mergeSummary(target: PipelineSummary, source: PipelineSummary): void {
  for (const [name, stream] of source.streams) {
    const existing = target.streams.get(name);
    if (existing) {
      existing.records_emitted += stream.records_emitted;
      existing.api_calls += stream.api_calls;
      existing.extract_ms += stream.extract_ms;
      existing.rows_loaded += stream.rows_loaded;
      existing.load_ms += stream.load_ms;
      existing.error = mergeStreamError(existing.error, stream.error);
      existing.cause = existing.cause ?? stream.cause;
      existing.skipped = existing.skipped || stream.skipped;
      existing.skipped_reason = existing.skipped_reason ?? stream.skipped_reason;
    } else {
      target.streams.set(name, { ...stream });
    }
  }
}

export function buildPipelineSummaryMessage(
  summary: PipelineSummary,
  integration: string
): PipelineSummaryMessage {
  const elapsed = ((Date.now() - summary.startTime) / 1000).toFixed(1);
  const succeeded: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  let totalRecords = 0;
  let totalRows = 0;
  let totalApiCalls = 0;

  for (const [name, stream] of summary.streams) {
    // error takes precedence: never hide a failure behind a skip.
    if (stream.error) {
      failed.push(name);
    } else if (stream.skipped) {
      skipped.push(name);
    } else {
      succeeded.push(name);
    }
    totalRecords += stream.records_emitted;
    totalRows += stream.rows_loaded;
    totalApiCalls += stream.api_calls;
  }

  return {
    _v: PIPELINE_SUMMARY_VERSION,
    type: 'PIPELINE_SUMMARY',
    integration,
    elapsed_seconds: Number(elapsed),
    total_streams: summary.streams.size,
    succeeded: succeeded.length,
    failed: failed.length,
    skipped: skipped.length,
    total_records_extracted: totalRecords,
    total_rows_loaded: totalRows,
    total_api_calls: totalApiCalls,
    streams: Object.fromEntries(
      [...summary.streams.entries()].map(([name, stream]) => {
        const status = stream.error ? 'failure' : stream.skipped ? 'skipped' : 'success';
        return [
          name,
          {
            status,
            records_extracted: stream.records_emitted,
            records_emitted: stream.records_emitted,
            rows_loaded: stream.rows_loaded,
            api_calls: stream.api_calls,
            extract_ms: stream.extract_ms,
            load_ms: stream.load_ms,
            duration_ms: stream.extract_ms + stream.load_ms,
            ...(stream.error ? { error: stream.error } : {}),
            ...(status === 'skipped' && stream.skipped_reason
              ? { skipped_reason: stream.skipped_reason }
              : {}),
          },
        ];
      })
    ),
  } satisfies PipelineSummaryMessage;
}

export function emitPipelineSummary(
  summary: PipelineSummary,
  integration: string,
  logStream?: fs.WriteStream
): void {
  const line = JSON.stringify(buildPipelineSummaryMessage(summary, integration)) + '\n';
  process.stderr.write(line);
  logStream?.write(line);
}

export function createChunkProcessor(
  summary: PipelineSummary,
  tablePrefix: string,
  lineHandler?: (line: string) => void,
  lineTransform?: (line: string) => string
): { flush: () => void; handle: (chunk: Buffer) => void } {
  let buffer = '';
  const loaderRowRegex = buildLoaderRowRegex(tablePrefix);
  const processLine = (line: string) => {
    if (!line) {
      return;
    }
    const processedLine = lineTransform ? lineTransform(line) : line;
    lineHandler?.(processedLine);
    parseStderrLine(summary, processedLine, loaderRowRegex);
  };

  return {
    flush: () => {
      processLine(buffer);
      buffer = '';
    },
    handle: (chunk: Buffer) => {
      const text = buffer + chunk.toString();
      const lines = text.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        processLine(line);
      }
    },
  };
}

export {
  buildLogMessage,
  formatDestinationLogLine,
  formatPipelineLogLine,
  shouldDisplayPipelineLogLine,
  writeLogLine,
  writePipelineLogLine,
} from './pipeline-log-lines.js';
