import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';

import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import type { BatchMessage } from '@bobsled-inc/protocol';

import { outputColumnName } from '../output-column.js';
import type { EmbedBatchResult } from './processor.js';
import { MAX_EMBEDDING_TOKENS, truncateToTokens } from './tokenizer.js';

export interface RewriteFieldConfig {
  field: string;
  as?: string;
}

export interface RewriteBatchOptions {
  message: BatchMessage;
  fields: RewriteFieldConfig[];
  batchSize: number;
  embedFn: (texts: string[]) => Promise<EmbedBatchResult>;
  tmpDir?: string;
  onTruncation: (stream: string, field: string, originalTokens: number) => void;
  onApiCall: (tokensUsed: number, durationMs: number) => void;
  onRecord: () => void;
}

interface PendingRecord {
  record: Record<string, unknown>;
  additions: Record<string, number[] | null>;
  requests: Array<{
    outputName: string;
    text: string;
  }>;
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

async function writeLine(output: Writable, line: string): Promise<void> {
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

async function finalizeOutput(output: Writable, destination: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    destination.once('finish', resolve);
    destination.once('error', reject);
    output.end();
  });
}

function toSafePathSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : 'stream';
}

async function rewriteFile(
  inputPath: string,
  outputPath: string,
  options: RewriteBatchOptions
): Promise<void> {
  const gzip =
    options.message.encoding.format === 'jsonl' && options.message.encoding.compression === 'gzip';
  const input = gzip
    ? createReadStream(inputPath).pipe(createGunzip())
    : createReadStream(inputPath);
  const diskStream = createWriteStream(outputPath, { mode: 0o600 });
  let output: Writable = diskStream;
  if (gzip) {
    const gzipStream = createGzip();
    gzipStream.pipe(diskStream);
    output = gzipStream;
  }
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });
  const pendingRecords: PendingRecord[] = [];
  const pendingTexts: Array<{
    recordIndex: number;
    outputName: string;
    text: string;
  }> = [];

  const flushPending = async (): Promise<void> => {
    if (pendingRecords.length === 0) {
      return;
    }

    if (pendingTexts.length > 0) {
      const startedAt = Date.now();
      const result = await options.embedFn(pendingTexts.map((entry) => entry.text));
      options.onApiCall(result.tokensUsed, Date.now() - startedAt);

      if (result.vectors.length !== pendingTexts.length) {
        throw new Error(
          `Expected ${pendingTexts.length} embeddings for batch rewrite, received ${result.vectors.length}`
        );
      }

      for (const [index, entry] of pendingTexts.entries()) {
        pendingRecords[entry.recordIndex]!.additions[entry.outputName] = result.vectors[index]!;
      }
    }

    for (const pendingRecord of pendingRecords) {
      await writeLine(
        output,
        `${JSON.stringify({ ...pendingRecord.record, ...pendingRecord.additions })}\n`
      );
      options.onRecord();
    }

    pendingRecords.length = 0;
    pendingTexts.length = 0;
  };

  for await (const line of reader) {
    if (line.length === 0) {
      continue;
    }

    const record = JSON.parse(line) as Record<string, unknown>;
    const additions: Record<string, number[] | null> = {};
    const requests: PendingRecord['requests'] = [];

    for (const field of options.fields) {
      const value = record[field.field];
      const outputName = outputColumnName(field.field, field.as);

      if (value === null || value === undefined || value === '') {
        additions[outputName] = null;
        continue;
      }

      const truncated = truncateToTokens(String(value), MAX_EMBEDDING_TOKENS);
      if (truncated.truncated) {
        options.onTruncation(options.message.stream, field.field, truncated.originalTokens);
      }

      requests.push({
        outputName,
        text: truncated.text,
      });
    }

    assertRecordFitsBatchSize(options.batchSize, requests.length, options.message.stream);

    if (pendingTexts.length > 0 && pendingTexts.length + requests.length > options.batchSize) {
      await flushPending();
    }

    const pendingRecord: PendingRecord = {
      record,
      additions,
      requests,
    };
    const recordIndex = pendingRecords.push(pendingRecord) - 1;

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
  }

  await flushPending();
  await finalizeOutput(output, diskStream);
}

export async function rewriteBatch(options: RewriteBatchOptions): Promise<BatchMessage> {
  if (options.message.encoding.format === 'parquet') {
    throw new CommandError(
      `Parquet BATCH encoding is not yet supported by dogsled embed. Set your extractor's batch format to "jsonl" or "jsonl+gzip" when using embeddings, or remove the embed config for stream "${options.message.stream}".`,
      EXIT_VALIDATION
    );
  }

  const tmpRoot =
    options.tmpDir ??
    path.join(
      process.env['BOBSLED_CORE_EMBEDDER_TMP_DIR'] ?? '/tmp',
      `dogsled-embed-${process.pid}`
    );
  const safeStream = toSafePathSegment(options.message.stream);
  const streamDir = path.join(tmpRoot, safeStream);
  mkdirSync(streamDir, { recursive: true });

  const rewrittenManifest: string[] = [];
  const gzip = options.message.encoding.compression === 'gzip';

  for (const [index, manifestEntry] of options.message.manifest.entries()) {
    const inputPath = fileURLToPath(manifestEntry);
    const outputPath = path.join(
      streamDir,
      `${safeStream}-embed-${Date.now()}-${index}-${randomUUID()}${gzip ? '.jsonl.gz' : '.jsonl'}`
    );
    await rewriteFile(inputPath, outputPath, options);
    rewrittenManifest.push(pathToFileURL(outputPath).href);
  }

  return {
    ...options.message,
    manifest: rewrittenManifest,
  };
}
