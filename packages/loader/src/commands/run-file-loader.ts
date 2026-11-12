import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Writable } from 'node:stream';

import { createDestination } from '../runtime/destinations/index.js';
import { sanitizeStreamName } from '../runtime/utils.js';
import type { DuckDbWriter } from '../runtime/duckdb-writer.js';
import { getFormatDef } from '../runtime/formats.js';
import { readProtocol } from '../runtime/protocol-reader.js';
import { RecordBuffer } from '../runtime/record-buffer.js';
import { type FileDestConfig } from '../schemas/config.js';
import { CommandError } from '@bobsled-inc/protocol';
import { createLogger } from '../runtime/logger.js';

import type { BatchEncoding, SchemaMessage } from '@bobsled-inc/protocol';
import { buildTempFileName, nextOutputIndex } from './run-helpers.js';
import type { PublishedFile, RunLoaderDependencies, RunLoaderResult } from './run.js';

export async function writeLine(stream: Writable, line: string): Promise<void> {
  if (stream.write(line)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      stream.removeListener('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      stream.removeListener('drain', onDrain);
      reject(err);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

/**
 * Convert a file:// URI from a BATCH manifest into a filesystem path.
 *
 * Trust boundary: BATCH file URIs originate from the extractor process and can
 * legitimately reference any path on disk where the extractor wrote its output.
 * This is by design in the Dogsled protocol — the loader trusts the
 * extractor's manifest entries. No path-containment check is applied here.
 */
export function fileUriToPath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'file:') {
    throw new Error(`Unsupported batch URI "${uri}". Only file:// URIs are supported.`);
  }
  return fileURLToPath(url);
}

export const DEFAULT_JSONL_ENCODING: BatchEncoding = Object.freeze({ format: 'jsonl' as const });

function canDirectlyPublishSource(
  targetFormat: FileDestConfig['format'],
  sourceEncoding: BatchEncoding
): boolean {
  if (sourceEncoding.format !== targetFormat) {
    return false;
  }

  return sourceEncoding.format !== 'jsonl' || sourceEncoding.compression === undefined;
}

export async function runFileLoader(
  rawConfig: FileDestConfig,
  dependencies: RunLoaderDependencies = {}
): Promise<RunLoaderResult> {
  const destination = dependencies.createDestination?.(rawConfig) ?? createDestination(rawConfig);
  let duckdb: DuckDbWriter;
  if (dependencies.createDuckDbWriter) {
    duckdb = await dependencies.createDuckDbWriter();
  } else {
    const { createDuckDbWriter } = await import('../runtime/duckdb-writer.js');
    duckdb = await createDuckDbWriter();
  }
  const input = dependencies.input ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const logger = createLogger(stderr, rawConfig.logFormat);
  const formatDef = getFormatDef(rawConfig.format);
  const streamSubfolder = rawConfig.streamSubfolder ? `${rawConfig.streamSubfolder}/` : '';
  const utcTimestamps = rawConfig.utcTimestamps === true;

  const providedTempRoot = dependencies.tempRootDir ? path.resolve(dependencies.tempRootDir) : null;

  if (providedTempRoot) {
    await fs.mkdir(providedTempRoot, { recursive: true });
  }

  const ownedTempDir = await fs.mkdtemp(
    path.join(providedTempRoot ?? os.tmpdir(), 'dogsled-loader-')
  );

  const bufferRootDir = path.join(ownedTempDir, 'buffer');
  const outputRootDir = path.join(ownedTempDir, 'output');
  await fs.mkdir(bufferRootDir, { recursive: true });
  await fs.mkdir(outputRootDir, { recursive: true });

  const schemas = new Map<string, SchemaMessage['schema']>();
  const buffers = new Map<string, RecordBuffer>();
  const outputIndexes = new Map<string, number>();
  const publishedFiles: PublishedFile[] = [];
  let statesForwarded = 0;
  const flushCounts = new Map<string, number>();
  let totalFlushBytes = 0;

  const getOrCreateBuffer = (stream: string): RecordBuffer => {
    let buffer = buffers.get(stream);
    if (!buffer) {
      buffer = new RecordBuffer({
        stream,
        flushThreshold: rawConfig.bufferSize,
        tempDir: bufferRootDir,
      });
      buffers.set(stream, buffer);
    }
    return buffer;
  };

  const convertAndPublish = async (
    sourcePath: string,
    stream: string,
    cleanupSource: boolean,
    sourceEncoding: BatchEncoding = DEFAULT_JSONL_ENCODING
  ): Promise<void> => {
    const safeStream = sanitizeStreamName(stream);
    const outputIndex = nextOutputIndex(outputIndexes, safeStream);
    const destinationPath = `${safeStream}/${streamSubfolder}${safeStream}-${outputIndex}${formatDef.extension}`;
    const tempOutputPath = path.join(
      outputRootDir,
      buildTempFileName(safeStream, outputIndex, formatDef.extension)
    );
    let publishSourcePath = sourcePath;
    let removeTempOutput = false;
    let convertMs = 0;

    try {
      if (
        !cleanupSource &&
        !utcTimestamps &&
        canDirectlyPublishSource(rawConfig.format, sourceEncoding)
      ) {
        await fs.copyFile(sourcePath, tempOutputPath);
        publishSourcePath = tempOutputPath;
        removeTempOutput = true;
      } else {
        const convertStart = performance.now();
        try {
          await duckdb.convertFile({
            sourcePath,
            outputPath: tempOutputPath,
            format: rawConfig.format,
            sourceEncoding,
            columns: schemas.get(stream)?.columns,
            ...(utcTimestamps ? { utcTimestamps: true } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Failed to convert stream "${stream}" to ${rawConfig.format}: ${message}. ` +
              `Check that the source data matches the declared schema.`
          );
        }
        convertMs = performance.now() - convertStart;
        publishSourcePath = tempOutputPath;
        removeTempOutput = true;
      }

      const publishStart = performance.now();
      const sourceStat = await fs.stat(publishSourcePath).catch(() => null);
      const uri = await destination.publish(publishSourcePath, destinationPath);
      const publishMs = performance.now() - publishStart;

      publishedFiles.push({ stream, destinationPath, uri });
      const count = (flushCounts.get(stream) ?? 0) + 1;
      flushCounts.set(stream, count);

      if (sourceStat) {
        totalFlushBytes += sourceStat.size;
        logger.metric('flush_bytes', sourceStat.size, { stream });
      }
      logger.metric('conversion_ms', Math.round(convertMs), { stream });
      logger.metric('publish_ms', Math.round(publishMs), { stream });
      logger.info(`${stream}: wrote ${uri}`);
    } finally {
      if (cleanupSource) {
        await fs.rm(sourcePath, { force: true });
      }
      if (removeTempOutput) {
        await fs.rm(tempOutputPath, { force: true });
      }
    }
  };

  try {
    for await (const message of readProtocol(input)) {
      switch (message.type) {
        case 'SCHEMA': {
          const safeStream = sanitizeStreamName(message.stream);
          // Flush any records buffered under the previous schema before updating
          const existingBuffer = buffers.get(safeStream);
          if (existingBuffer) {
            const flushedPath = await existingBuffer.flush();
            if (flushedPath) {
              await convertAndPublish(flushedPath, safeStream, true, DEFAULT_JSONL_ENCODING);
            }
          }
          schemas.set(safeStream, message.schema);
          break;
        }
        case 'BATCH': {
          const safeStream = sanitizeStreamName(message.stream);
          for (const uri of message.manifest) {
            await convertAndPublish(fileUriToPath(uri), safeStream, false, message.encoding);
          }
          break;
        }
        case 'RECORD': {
          const safeStream = sanitizeStreamName(message.stream);
          if (!schemas.has(safeStream)) {
            throw new CommandError(
              `Received data for stream "${message.stream}" before SCHEMA message`
            );
          }
          const record = {
            ...message.record,
            _time_extracted: message.time_extracted,
          };
          const buffer = getOrCreateBuffer(safeStream);
          const flushedPath = await buffer.addRecord(record);
          if (flushedPath) {
            await convertAndPublish(flushedPath, safeStream, true, DEFAULT_JSONL_ENCODING);
          }
          break;
        }
        case 'REPLACE':
          // File destinations publish each flush as new files and apply no load strategy.
          break;
        case 'STATE': {
          const safeStream = sanitizeStreamName(message.stream);
          const buffer = buffers.get(safeStream);
          const flushedPath = (await buffer?.flush()) ?? null;
          if (flushedPath) {
            await convertAndPublish(flushedPath, safeStream, true, DEFAULT_JSONL_ENCODING);
          }

          await writeLine(stdout, `${JSON.stringify(message)}\n`);
          statesForwarded += 1;
          break;
        }
      }
    }

    for (const [stream, buffer] of buffers) {
      const flushedPath = await buffer.flush();
      if (flushedPath) {
        await convertAndPublish(flushedPath, stream, true, DEFAULT_JSONL_ENCODING);
      }
    }

    for (const [stream, count] of flushCounts) {
      logger.metric('flush_count', count, { stream });
    }
    if (totalFlushBytes > 0) {
      logger.metric('total_flush_bytes', totalFlushBytes, {});
    }

    return {
      publishedFiles,
      statesForwarded,
    };
  } finally {
    for (const buffer of buffers.values()) {
      await buffer.cleanup();
    }

    try {
      await duckdb.close();
    } catch {
      // Preserve the original error if the pipeline already failed
    }
    await fs.rm(ownedTempDir, { recursive: true, force: true });
  }
}
