import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DogsledRuntimeError } from '@bobsled-inc/protocol';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  chunkText,
  chunkerConfigHash,
  chunkId,
  createDefaultRegistry,
  documentId,
  documentVersionId,
  sanitizeUriForError,
  sha256Hex,
  type ChunkOptions,
  type ParseResult,
} from '@bobsled-inc/document-parsers';

import {
  type FileResourceSpec,
  type DocumentFileSourceConfig,
  isDocumentFileSource,
} from '../framework/extractor/index.js';
import type { ExtractorState, IntegrationSpec } from '../types/index.js';

import { aclBackendFor, type AclEvidenceRow } from './acl-capture.js';
import type { ControlLogger } from './control.js';
import type { Emitter } from './emitter.js';
import { ExtractorDataError } from './errors.js';
import { createFileStorageClient } from './file-storage-client.js';
import {
  getFileStorageSourceType,
  maxFilesReachedMessage,
  safeStagePath,
  shouldProcessFile,
  streamKey,
  type FileBookmark,
} from './file-storage-extractor.js';
import type { StateStore, StreamBookmark } from './state.js';

/**
 * Document-resource extraction. Mirrors `extractFileStorageResource` but emits the
 * three streams from §Document Stream Schema Contract instead of a single record stream.
 *
 *   <resource>__documents      — 1 row per file
 *   <resource>__chunks         — N rows per file
 *   <resource>__parse_errors   — 1 row per failure
 *
 * No new envelope-level message types (per §SourceKind Dispatch Contract). All four
 * streams flow through existing SCHEMA + RECORD + STATE.
 */

interface DocumentStreamState {
  files?: Record<string, FileBookmark>;
}

const DEFAULT_CHUNK_OPTS: ChunkOptions = {
  maxTokens: 800,
  overlapTokens: 120,
  tokenizer: 'cl100k_base',
};

const DEFAULT_MAX_FILE_SIZE_MB = 100;

export interface DocumentExtractOptions {
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
  startedAt: number;
}

export interface DocumentExtractResult {
  documentsEmitted: number;
  chunksEmitted: number;
  parseErrorsEmitted: number;
  bookmark: StreamBookmark;
}

function getDocumentState(
  state: ExtractorState,
  integrationName: string,
  resourceName: string
): DocumentStreamState {
  const value = state.streams[streamKey(integrationName, resourceName)];
  if (value && typeof value === 'object' && 'files' in value) {
    return value as DocumentStreamState;
  }
  return {};
}

function chunkOptionsFromResource(source: DocumentFileSourceConfig): ChunkOptions {
  const cfg = source.chunk;
  const maxTokens = cfg?.max_tokens ?? DEFAULT_CHUNK_OPTS.maxTokens;
  const tokenizer = cfg?.tokenizer ?? DEFAULT_CHUNK_OPTS.tokenizer;
  if (cfg?.strategy === 'paragraph') {
    const overlapTokens = cfg.overlap_tokens ?? 0;
    return {
      strategy: 'paragraph',
      maxTokens,
      overlapTokens,
      minTokens: cfg.min_tokens,
      tokenizer,
    };
  }
  const overlapTokens = cfg?.overlap_tokens ?? DEFAULT_CHUNK_OPTS.overlapTokens;
  return { maxTokens, overlapTokens, tokenizer };
}

const DOCUMENTS_OUTPUT: FileResourceSpec['output'] = {
  document_id: { type: 'string' },
  document_version_id: { type: 'string' },
  source_uri: { type: 'string' },
  content_hash: { type: 'string' },
  source_revision: { type: 'string' },
  parser_version: { type: 'string' },
  format: { type: 'string' },
  text: { type: 'string' },
  byte_length: { type: 'integer' },
  extracted_at: { type: 'timestamp' },
};

const CHUNKS_OUTPUT: FileResourceSpec['output'] = {
  chunk_id: { type: 'string' },
  document_version_id: { type: 'string' },
  document_id: { type: 'string' },
  chunk_index: { type: 'integer' },
  text: { type: 'string' },
  token_count: { type: 'integer' },
  chunker_config_hash: { type: 'string' },
};

const PARSE_ERRORS_OUTPUT: FileResourceSpec['output'] = {
  document_id: { type: 'string' },
  source_uri: { type: 'string' },
  format: { type: 'string' },
  error_code: { type: 'string' },
  error_message: { type: 'string' },
  parser_version: { type: 'string' },
  failed_at: { type: 'timestamp' },
};

/**
 * Permission Evidence (`__acl`) Contract. Dogsled OSS extracts and stores ACL evidence
 * whenever a source backend exposes it; OSS does NOT enforce. Emitting the schema even
 * when no rows are produced keeps the downstream consumer contract stable so app-layer
 * consumers can rely on the column shape regardless of which providers have ACL
 * backends wired.
 */
const ACL_OUTPUT: FileResourceSpec['output'] = {
  document_id: { type: 'string' },
  row_id: { type: 'string' },
  row_type: { type: 'string' },
  principal_id: { type: 'string' },
  source_grant_type: { type: 'string' },
  source_provider: { type: 'string' },
  source_revision: { type: 'string' },
  captured_at: { type: 'timestamp' },
};

export async function extractDocumentResource(
  opts: DocumentExtractOptions
): Promise<DocumentExtractResult> {
  const { integration, resource, integrationName, emitter, logger, state, stateStore } = opts;
  if (!isDocumentFileSource(resource.source)) {
    throw new ExtractorDataError(
      `extractDocumentResource called with non-document source on resource "${resource.name}"`
    );
  }
  const source = resource.source;

  const registry = createDefaultRegistry();
  const chunkOpts = chunkOptionsFromResource(source);
  const cfgHash = chunkerConfigHash(chunkOpts);
  const maxBytes = (source.parse?.max_file_size_mb ?? DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024;

  const client = await createFileStorageClient(integration);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dogsled-document-'));
  // See extractFileStorageResource: full_refresh rereads every file.
  const readAllFiles = opts.fullRefresh === true || resource.replication.method === 'full_refresh';
  const existingState = readAllFiles ? {} : getDocumentState(state, integrationName, resource.name);
  const nextFiles: Record<string, FileBookmark> = { ...(existingState.files ?? {}) };
  const maxFiles = resource.limits?.max_files_per_run ?? 10_000;
  const onError = source.parse?.on_error ?? 'record';

  const documentsStream = `${resource.name}__documents`;
  const chunksStream = `${resource.name}__chunks`;
  const parseErrorsStream = `${resource.name}__parse_errors`;
  const aclStream = `${resource.name}__acl`;
  const capturePermissions = source.permissions?.capture ?? true;

  let filesAttempted = 0;
  let filesProcessed = 0;
  let documentsEmitted = 0;
  let chunksEmitted = 0;
  let parseErrorsEmitted = 0;
  let schemaEmitted = false;

  const allowedFormats = source.parse?.formats;
  const allowedFormatSet = allowedFormats ? new Set<string>(allowedFormats) : null;

  // A full read replaces every table. An incremental run appends and sends REPLACE per
  // file, so a changed file's previous rows in every stream go before its new rows land.
  const extract = {
    table: { load_strategy: readAllFiles ? ('full_refresh' as const) : ('append' as const) },
  };
  const fileStreams = [documentsStream, chunksStream, parseErrorsStream];
  if (capturePermissions) fileStreams.push(aclStream);

  async function ensureSchemasEmitted(): Promise<void> {
    if (schemaEmitted) return;
    await emitter.emitSchema({ name: documentsStream, output: DOCUMENTS_OUTPUT, extract });
    await emitter.emitSchema({ name: chunksStream, output: CHUNKS_OUTPUT, extract });
    await emitter.emitSchema({ name: parseErrorsStream, output: PARSE_ERRORS_OUTPUT, extract });
    if (capturePermissions) {
      await emitter.emitSchema({ name: aclStream, output: ACL_OUTPUT, extract });
    }
    schemaEmitted = true;
  }

  /** Replace this file's rows in the given streams; a full read already replaces all. */
  async function replaceFileRows(docId: string, streams = fileStreams): Promise<void> {
    await ensureSchemasEmitted();
    if (readAllFiles) return;
    for (const stream of streams) {
      await emitter.emitReplace(stream, 'document_id', [docId]);
    }
  }

  try {
    // The listing has no cap. max_files_per_run counts the files this run reads, so a
    // capped listing would stop among files already read and never reach newer ones.
    for await (const file of client.list({ path: source.path })) {
      // Strip query string + fragment so pre-signed URLs don't leak credentials into
      // the __parse_errors data stream or any thrown error message in this loop.
      const safeUri = sanitizeUriForError(file.uri);
      if (file.size !== undefined && file.size > maxBytes) {
        // The file was not read, so its last good rows stay; only the error is current.
        // This also emits the schemas before the first RECORD.
        await replaceFileRows(documentId(file.uri), [parseErrorsStream]);
        await emitParseError(emitter, parseErrorsStream, {
          document_id: documentId(file.uri),
          source_uri: safeUri,
          format: 'unknown',
          error_code: 'file_too_large',
          error_message: `File ${file.size} bytes exceeds max_file_size_bytes ${maxBytes}`,
          parser_version: 'runtime:1.0.0',
        });
        parseErrorsEmitted += 1;
        if (onError === 'fail') {
          throw new ExtractorDataError(
            `File exceeds size limit (${file.size} bytes > ${maxBytes}); on_error=fail`
          );
        }
        continue;
      }
      if (!readAllFiles && !shouldProcessFile(file, existingState.files?.[file.uri])) {
        continue;
      }
      // Failed reads count too, so a path full of unreadable files cannot make one
      // run download without bound.
      if (filesAttempted >= maxFiles) {
        await logger.warn(
          maxFilesReachedMessage(
            resource.name,
            maxFiles,
            resource.replication.method === 'full_refresh'
          )
        );
        break;
      }
      filesAttempted += 1;

      const stagedPath = safeStagePath(tempDir, file);
      let bytes: Uint8Array;
      try {
        await client.download(file, stagedPath);
        bytes = await readFile(stagedPath);
      } catch (err) {
        // Connection-level failures (lost connection, timeout, cancel) fail the run;
        // only per-file problems become parse-error rows.
        if (err instanceof DogsledRuntimeError) throw err;
        // The new version was not read, so its last good rows stay; only the error is current.
        await replaceFileRows(documentId(file.uri), [parseErrorsStream]);
        const rawMessage = err instanceof Error ? err.message : String(err);
        // Storage clients may surface the pre-signed URL inside their own error
        // messages; scrub any occurrence before persisting or rethrowing.
        const scrubbedMessage = rawMessage.split(file.uri).join(safeUri);
        await emitParseError(emitter, parseErrorsStream, {
          document_id: documentId(file.uri),
          source_uri: safeUri,
          format: 'unknown',
          error_code: 'download_failed',
          error_message: scrubbedMessage,
          parser_version: 'runtime:1.0.0',
        });
        parseErrorsEmitted += 1;
        if (onError === 'fail') {
          throw new ExtractorDataError(
            `Download failed for ${safeUri}; on_error=fail: ${scrubbedMessage}`
          );
        }
        continue;
      } finally {
        // Free disk immediately — staged files can pile up to max_files_per_run × file_size
        // (10k × 100 MB = 1 TB worst case) under the temp dir before the final cleanup.
        await rm(stagedPath, { force: true });
      }

      const contentHash = sha256Hex(bytes);
      const docId = documentId(file.uri);
      const docVerId = documentVersionId({
        sourceUri: file.uri,
        contentHash,
        sourceRevision: file.etag,
      });

      const parser = registry.parserForUri(file.uri);
      let result: ParseResult;
      if (parser && allowedFormatSet && !allowedFormatSet.has(parser.format)) {
        result = {
          status: 'error',
          format: parser.format,
          errorCode: 'unsupported_format',
          message:
            `File format "${parser.format}" not in source.parse.formats: ` +
            `${[...allowedFormatSet].join(', ')}`,
          parserVersion: 'runtime:1.0.0',
        };
      } else {
        // Delegate to registry.parse so the unsupported_format path uses the registry's
        // sanitizeUriForError (pre-signed S3/GCS query strings carry credentials and must
        // not land in __parse_errors).
        result = await registry.parse(file.uri, bytes, {
          sourceUri: file.uri,
          contentHash,
          sourceRevision: file.etag,
          maxFileSizeBytes: maxBytes,
        });
      }

      await replaceFileRows(docId);

      const extractedAt = new Date().toISOString();
      if (result.status === 'error') {
        await emitParseError(emitter, parseErrorsStream, {
          document_id: docId,
          source_uri: safeUri,
          format: result.format,
          error_code: result.errorCode,
          error_message: result.message,
          parser_version: result.parserVersion,
          failed_at: extractedAt,
        });
        parseErrorsEmitted += 1;
        if (onError === 'fail') {
          // result.message comes from registry.parse and is already URI-sanitized;
          // do not re-introduce the raw file.uri (pre-signed URLs leak credentials).
          throw new ExtractorDataError(`Parse error: ${result.errorCode} — ${result.message}`);
        }
        if (onError === 'skip') {
          // Skip without bookmarking the file so a re-run retries.
          continue;
        }
      } else {
        await emitter.emitRecord(
          documentsStream,
          {
            document_id: docId,
            document_version_id: docVerId,
            source_uri: file.uri,
            content_hash: contentHash,
            source_revision: file.etag ?? null,
            parser_version: result.parserVersion,
            format: result.format,
            text: result.text,
            byte_length: bytes.byteLength,
            extracted_at: extractedAt,
          },
          extractedAt
        );
        documentsEmitted += 1;

        const chunks = chunkText(result.text, chunkOpts);
        let limitTruncated = false;
        for (const chunk of chunks) {
          if (opts.limit !== undefined && chunksEmitted >= opts.limit) {
            limitTruncated = true;
            break;
          }
          const id = chunkId({
            documentVersionId: docVerId,
            chunkerConfigHash: cfgHash,
            chunkIndex: chunk.chunkIndex,
            chunkText: chunk.text,
          });
          await emitter.emitRecord(
            chunksStream,
            {
              chunk_id: id,
              document_version_id: docVerId,
              document_id: docId,
              chunk_index: chunk.chunkIndex,
              text: chunk.text,
              token_count: chunk.tokenCount,
              chunker_config_hash: cfgHash,
            },
            extractedAt
          );
          chunksEmitted += 1;
        }
        if (limitTruncated) {
          // Don't advance the bookmark for files whose chunk emission was cut short by
          // --limit; otherwise a subsequent run would skip the file even though some
          // chunks were never emitted. Mirror the file-storage extractor's behavior.
          break;
        }
      }

      // ACL evidence capture — `capturePermissions` already gates on registered
      // backends. Look up by the integration's typed source-type (no unsafe cast).
      if (capturePermissions) {
        const provider = getFileStorageSourceType(integration);
        const backend = aclBackendFor(provider);
        if (backend) {
          let aclRows: AclEvidenceRow[] = [];
          try {
            aclRows = await backend.captureForFile({ documentId: docId, file });
          } catch (err) {
            await logger.warn(
              `ACL capture for ${safeUri} failed (${err instanceof Error ? err.message : String(err)}); continuing without evidence rows.`
            );
          }
          for (const row of aclRows) {
            await emitter.emitRecord(aclStream, { ...row, document_id: docId }, row.captured_at);
          }
        }
      }

      nextFiles[file.uri] = {
        last_modified:
          file.last_modified instanceof Date
            ? file.last_modified.toISOString()
            : file.last_modified,
        etag: file.etag,
        size: file.size,
        document_version_id: docVerId,
      };
      filesProcessed += 1;
      if (opts.limit !== undefined && chunksEmitted >= opts.limit) break;
    }

    // Empty-state flush: downstream consumers wire on schema presence, so the full
    // schema set must be declared even when no files matched.
    await ensureSchemasEmitted();

    await logger.metric(resource.name, {
      files_processed: filesProcessed,
      documents_emitted: documentsEmitted,
      chunks_emitted: chunksEmitted,
      parse_errors_emitted: parseErrorsEmitted,
      records_emitted: documentsEmitted + chunksEmitted + parseErrorsEmitted,
    });

    const bookmark: StreamBookmark = {
      last_run_at: new Date().toISOString(),
      record_count: documentsEmitted + chunksEmitted + parseErrorsEmitted,
      files: nextFiles,
    };
    if (opts.advanceState && opts.limit == null) {
      state.streams[streamKey(integrationName, resource.name)] = bookmark;
      await stateStore.save(state);
    }
    // The STATE message leaves out the per-file map. The loader ignores it, and it grows with
    // the path until the message passes the loader's line limit. The state file keeps it.
    await emitter.emitState(resource.name, {
      last_run_at: bookmark.last_run_at,
      record_count: bookmark.record_count,
    });

    return { documentsEmitted, chunksEmitted, parseErrorsEmitted, bookmark };
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function emitParseError(
  emitter: Emitter,
  stream: string,
  row: {
    document_id: string;
    source_uri: string;
    format: string;
    error_code: string;
    error_message: string;
    parser_version: string;
    failed_at?: string;
  }
): Promise<void> {
  const failedAt = row.failed_at ?? new Date().toISOString();
  await emitter.emitRecord(stream, { ...row, failed_at: failedAt }, failedAt);
}
