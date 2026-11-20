import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Writable } from 'node:stream';

import { createDestination } from '../runtime/destinations/index.js';
import { normalizeDestinationPath } from '../runtime/destinations/types.js';
import { escapeUnprintable, sanitizeStreamName } from '../runtime/utils.js';
import type { DuckDbWriter } from '../runtime/duckdb-writer.js';
import { getFormatDef } from '../runtime/formats.js';
import { readProtocol } from '../runtime/protocol-reader.js';
import { RecordBuffer } from '../runtime/record-buffer.js';
import { type FileDestConfig } from '../schemas/config.js';
import { CommandError } from '@bobsled-inc/protocol';
import { createLogger } from '../runtime/logger.js';

import type { BatchEncoding, FileMessage, SchemaMessage } from '@bobsled-inc/protocol';
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

/** Files written at once for FILE messages. */
const COPY_CONCURRENCY = 8;

/**
 * Names the stream and destination in a copy failure, as every other load failure does, so a
 * pipeline can tell which stream failed and why.
 */
function describeCopyFailure(error: unknown, stream: string, destination: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const message = `Failed to load stream "${stream}" to ${destination}: ${detail}`;
  return error instanceof CommandError
    ? new CommandError(message, error.exitCode, error.payload)
    : new Error(message, { cause: error });
}

/** A key from the sender, cut short and made safe to print. */
const printableKey = (key: string): string => escapeUnprintable(key.slice(0, 200));

/**
 * Where a copied file goes: `<stream>/<subfolder>/<key>`. The key comes from the sender, so it
 * must already be a clean path. A key the destination would rewrite, such as one with a
 * backslash or a `..` folder, is refused instead of landing somewhere the sender did not name.
 */
function copyDestinationPath(stream: string, subfolder: string, relativeKey: string): string {
  const named = printableKey(relativeKey);
  const refuse = (why: string): never => {
    throw new CommandError(`Refusing to copy "${named}": ${why}.`, 2);
  };
  if (/\p{Cc}/u.test(relativeKey)) refuse('its name has a control character');
  if (relativeKey.includes('\\')) refuse('its name has a backslash');
  if (relativeKey.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    refuse('its name has an empty, "." or ".." folder');
  }
  const destinationPath = `${stream}/${subfolder}${relativeKey}`;
  const normalized = normalizeDestinationPath(destinationPath);
  if (normalized !== destinationPath || !normalized.startsWith(`${stream}/`)) {
    refuse('the destination would change its name');
  }
  return destinationPath;
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
      if (!cleanupSource && canDirectlyPublishSource(rawConfig.format, sourceEncoding)) {
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

  const copying = new Set<Promise<void>>();
  let copyFailure: { error: unknown } | undefined;

  const copyOne = async (message: FileMessage): Promise<void> => {
    const stream = sanitizeStreamName(message.stream);
    const destinationPath = copyDestinationPath(stream, streamSubfolder, message.relative_key);
    const sourcePath = fileUriToPath(message.uri);
    const folder = path.dirname(sourcePath);
    const refuse = (why: string): never => {
      throw new CommandError(
        `Refusing to copy "${printableKey(message.relative_key)}": ${why}.`,
        2
      );
    };
    // This loader moves or deletes the file it is given, so it takes only a temp file the
    // extractor made. That sits in a folder with this prefix which only the extractor's user can
    // write to. A link in place of the folder, a folder others can write to, or a file with a
    // second link would let the loader move or delete a file the extractor never made.
    if (!path.basename(folder).startsWith('dogsled-copy-')) {
      refuse('its temp file is not in a dogsled-copy- folder');
    }
    const folderInfo = await fs.lstat(folder);
    if (!folderInfo.isDirectory()) refuse('its temp folder is a link, or is not a folder');
    if (process.platform !== 'win32') {
      const user = process.getuid?.();
      if (folderInfo.uid !== user) {
        refuse(
          `its temp folder belongs to user ${folderInfo.uid}, not to the user running the loader (${user})`
        );
      }
      if ((folderInfo.mode & 0o022) !== 0) {
        refuse(
          `its temp folder can be written by other users (mode ${(folderInfo.mode & 0o777).toString(8)})`
        );
      }
    }
    const info = await fs.lstat(sourcePath);
    if (!info.isFile() || info.nlink !== 1 || info.size !== message.size) {
      refuse(
        `its temp file is not a file with one link and the size the message states (${message.size} bytes)`
      );
    }
    const publishStart = performance.now();
    const uri = await destination.publish(sourcePath, destinationPath, { copy: true });
    const publishMs = performance.now() - publishStart;
    // The sender counts a deleted temp file as written, so delete it only after the write.
    await fs.rm(sourcePath, { force: true });

    publishedFiles.push({ stream, destinationPath, uri });
    flushCounts.set(stream, (flushCounts.get(stream) ?? 0) + 1);
    totalFlushBytes += info.size;
    logger.metric('flush_bytes', info.size, { stream });
    logger.metric('publish_ms', Math.round(publishMs), { stream });
    logger.info(`${stream}: wrote ${escapeUnprintable(uri)}`);
  };

  const startCopy = async (message: FileMessage): Promise<void> => {
    while (copying.size >= COPY_CONCURRENCY && copyFailure === undefined) {
      await Promise.race(copying);
    }
    if (copyFailure !== undefined) throw copyFailure.error;
    const task: Promise<void> = copyOne(message)
      .catch((error: unknown) => {
        const failure = describeCopyFailure(
          error,
          sanitizeStreamName(message.stream),
          rawConfig.dest
        );
        copyFailure ??= { error: failure };
        // The sender waits for its files to be written, so it may send nothing more. Stop
        // reading now, or this run would wait on it for good.
        if (!input.destroyed && !input.readableEnded) input.destroy(failure);
      })
      .finally(() => copying.delete(task));
    copying.add(task);
  };

  const finishCopies = async (): Promise<void> => {
    await Promise.all(copying);
    if (copyFailure !== undefined) throw copyFailure.error;
  };

  try {
    for await (const message of readProtocol(input)) {
      if (copyFailure !== undefined) throw copyFailure.error;
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
        case 'FILE':
          await startCopy(message);
          break;
        case 'STATE': {
          // STATE says the stream's earlier files are done, so wait for their writes.
          await finishCopies();
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

    await finishCopies();

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
