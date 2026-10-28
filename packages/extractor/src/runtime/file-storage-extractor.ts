import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FileResourceSpec } from '../framework/extractor/index.js';
import { FileStorageSourceTypeValues } from '../framework/core/index.js';
import type { ListedFile } from '../framework/core/index.js';
import type { ExtractorState, IntegrationSpec } from '../types/index.js';
import type { ControlLogger } from './control.js';
import { DuckDbEngine } from './duckdb-engine.js';
import type { Emitter } from './emitter.js';
import { ExtractorConfigError, ExtractorDataError } from './errors.js';
import { createFileStorageClient } from './file-storage-client.js';
import { readFileRecords } from './file-format-reader.js';
import type { StateStore, StreamBookmark } from './state.js';

export interface FileStorageExtractOptions {
  integration: IntegrationSpec;
  resource: FileResourceSpec;
  integrationName: string;
  emitter: Emitter;
  logger: ControlLogger;
  state: ExtractorState;
  stateStore: StateStore;
  advanceState?: boolean;
  fullRefresh?: boolean;
  limit?: number;
  signal?: AbortSignal;
}

export interface FileStorageExtractResult {
  recordCount: number;
  bookmark: StreamBookmark;
  durableBookmark?: StreamBookmark;
}

export interface FileBookmark {
  last_modified?: string;
  etag?: string;
  size?: number;
  document_version_id?: string;
}

interface FileStreamState {
  files?: Record<string, FileBookmark>;
}

interface FileStorageResources {
  engine: DuckDbEngine;
  tempDir: string;
}

async function acquireFileStorageResources(): Promise<FileStorageResources> {
  const engine = await DuckDbEngine.create();
  try {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dogsled-file-source-'));
    return { engine, tempDir };
  } catch (error) {
    await engine.close();
    throw error;
  }
}

export function isFileStorageSource(integration: IntegrationSpec): boolean {
  return (
    'source_type' in integration &&
    (FileStorageSourceTypeValues as readonly string[]).includes(String(integration.source_type))
  );
}

/**
 * Type-safe `source_type` accessor for any IntegrationSpec. Returns the file-storage
 * provider key (s3 / gcs / sftp / local) when the integration is a file-storage variant,
 * undefined otherwise. Lets callers stop reaching into the integration union with
 * `(integration as { source_type?: string }).source_type` casts.
 */
export function getFileStorageSourceType(integration: IntegrationSpec): string | undefined {
  if (!('source_type' in integration)) return undefined;
  const raw = (integration as { source_type?: unknown }).source_type;
  if (typeof raw !== 'string') return undefined;
  return (FileStorageSourceTypeValues as readonly string[]).includes(raw) ? raw : undefined;
}

export function streamKey(integrationName: string, resourceName: string): string {
  return `${integrationName}/${resourceName}`;
}

function getFileState(
  state: ExtractorState,
  integrationName: string,
  resourceName: string
): FileStreamState {
  const value = state.streams[streamKey(integrationName, resourceName)];
  if (value && typeof value === 'object' && 'files' in value) {
    return value as FileStreamState;
  }
  return {};
}

export function shouldProcessFile(file: ListedFile, existing: FileBookmark | undefined): boolean {
  const lastModified =
    file.last_modified instanceof Date ? file.last_modified.toISOString() : file.last_modified;
  if (!existing) return true;
  return (
    existing.last_modified !== lastModified ||
    existing.etag !== file.etag ||
    existing.size !== file.size
  );
}

function bookmarkFor(file: ListedFile): FileBookmark {
  return {
    last_modified:
      file.last_modified instanceof Date ? file.last_modified.toISOString() : file.last_modified,
    etag: file.etag,
    size: file.size,
  };
}

export function safeStagePath(tempDir: string, file: ListedFile): string {
  // Strip traversal segments before joining; provider controls file.path
  const sanitized = file.path
    .split(/[/\\]/)
    .filter((segment) => segment !== '..' && segment !== '.')
    .join('_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+/, '');
  const hash = createHash('sha1').update(file.path).digest('hex').slice(0, 10);
  const parsed = path.parse(sanitized || 'file');
  const filename = `${parsed.name || 'file'}-${hash}${parsed.ext}`;
  const staged = path.join(tempDir, filename);
  if (!staged.startsWith(tempDir + path.sep)) {
    throw new ExtractorConfigError(`Internal error: staged path escaped temp directory: ${staged}`);
  }
  return staged;
}

export async function extractFileStorageResource({
  integration,
  resource,
  integrationName,
  emitter,
  logger,
  state,
  stateStore,
  advanceState,
  fullRefresh,
  limit,
  signal,
}: FileStorageExtractOptions): Promise<FileStorageExtractResult> {
  const client = await createFileStorageClient(integration);
  let resources: FileStorageResources;
  try {
    resources = await acquireFileStorageResources();
  } catch (error) {
    await client.close();
    throw error;
  }
  const { engine, tempDir } = resources;
  // A full_refresh resource rereads every file: its load replaces the table, so
  // skipping unchanged files would replace the table with an empty stream.
  const readAllFiles = fullRefresh === true || resource.replication.method === 'full_refresh';
  const existingState = readAllFiles ? {} : getFileState(state, integrationName, resource.name);
  const nextFiles: Record<string, FileBookmark> = { ...(existingState.files ?? {}) };
  const maxFiles = resource.limits?.max_files_per_run ?? 10_000;
  const maxFileSize = resource.limits?.max_file_size_bytes ?? 5_368_709_120;

  let filesListed = 0;
  let filesSkipped = 0;
  let filesProcessed = 0;
  let bytesDownloaded = 0;
  let recordCount = 0;
  let schemaEmitted = false;

  try {
    for await (const file of client.list({ path: resource.source.path, maxFiles })) {
      signal?.throwIfAborted();
      filesListed += 1;
      if (filesProcessed >= maxFiles) break;
      if (file.size !== undefined && file.size > maxFileSize) {
        filesSkipped += 1;
        await logger.warn(`Skipping ${file.uri}: file size exceeds max_file_size_bytes`);
        continue;
      }
      if (!readAllFiles && !shouldProcessFile(file, existingState.files?.[file.uri])) {
        filesSkipped += 1;
        continue;
      }

      const stagedPath = safeStagePath(tempDir, file);
      let downloadedBytes = 0;
      let read: Awaited<ReturnType<typeof readFileRecords>>;
      try {
        signal?.throwIfAborted();
        const downloaded = await client.download(
          file,
          stagedPath,
          signal === undefined ? undefined : { signal }
        );
        downloadedBytes = downloaded.bytes_downloaded;
        if (downloadedBytes > maxFileSize) {
          throw new ExtractorDataError(
            `File ${file.uri} exceeds max_file_size_bytes (${maxFileSize}) after download`
          );
        }
        read = await readFileRecords(engine, file, downloaded.path, resource, signal);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        // A private Blob resource selects one known object. Skipping a failed
        // download or parse would turn a missing/revoked attachment into a
        // successful empty load, so fail the entire extraction attempt.
        if (integration.source_type === 'vercel_blob') throw error;
        filesSkipped += 1;
        await logger.warn(
          `Skipping ${file.uri}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      bytesDownloaded += downloadedBytes;
      let limitHitMidFile = false;
      try {
        signal?.throwIfAborted();
        if (!schemaEmitted) {
          await emitter.emitSchema({ ...resource, output: read.columns }, { fullRefresh });
          schemaEmitted = true;
        }
        const pageTime = new Date().toISOString();
        for await (const record of read.records) {
          signal?.throwIfAborted();
          if (limit !== undefined && recordCount >= limit) {
            limitHitMidFile = true;
            break;
          }
          await emitter.emitRecord(resource.name, record, pageTime);
          recordCount += 1;
        }
      } finally {
        await read.close();
      }
      // Only bookmark files we fully consumed; a mid-file limit stop would permanently skip the tail
      if (!limitHitMidFile) {
        nextFiles[file.uri] = bookmarkFor(file);
        filesProcessed += 1;
      }
      if (limit !== undefined && recordCount >= limit) break;
    }

    signal?.throwIfAborted();
    if (!schemaEmitted) {
      await emitter.emitSchema(resource, { fullRefresh });
    }

    await logger.metric(resource.name, {
      files_listed: filesListed,
      files_skipped: filesSkipped,
      files_processed: filesProcessed,
      bytes_downloaded: bytesDownloaded,
      records_emitted: recordCount,
    } as Parameters<ControlLogger['metric']>[1]);

    const runAt = new Date().toISOString();
    const bookmark: StreamBookmark = {
      last_run_at: runAt,
      record_count: recordCount,
      files: nextFiles,
    };
    // Persist durable state before emitting the STATE protocol message so a save failure
    // does not leave the consumer with a bookmark that the on-disk state doesn't reflect.
    let durableBookmark: StreamBookmark | undefined;
    if (advanceState && limit == null) {
      durableBookmark = bookmark;
      state.streams[streamKey(integrationName, resource.name)] = bookmark;
      await stateStore.save(state);
    }

    await emitter.emitState(resource.name, bookmark);

    return { recordCount, bookmark, durableBookmark };
  } finally {
    await client.close();
    await engine.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}
