import { setMaxListeners } from 'node:events';
import { rmSync } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import type { ListedFile } from '../framework/core/index.js';
import { COPY_DEFAULT_LOOKBACK_SECONDS } from '../framework/extractor/file-copy-resource.js';
import type { FileCopyResourceSpec } from '../framework/extractor/index.js';
import type { ExtractorState, IntegrationSpec } from '../types/index.js';
import { fixedFolder } from './clients/path-glob.js';
import type { ControlLogger } from './control.js';
import type { Emitter } from './emitter.js';
import { ExtractorConfigError, ExtractorDataError } from './errors.js';
import { createFileStorageClient } from './file-storage-client.js';
import {
  bookmarkFor,
  getFileStorageSourceType,
  shouldProcessFile,
  streamKey,
} from './file-storage-extractor.js';
import type { StateStore, StreamBookmark } from './state.js';

/** Downloads that run at once. SFTP reads one file at a time: its downloads share one connection. */
const MAX_DOWNLOADS = 8;

/**
 * Bytes of temp files on disk at once: files being downloaded plus files the loader has not
 * deleted yet. One file is always admitted, so a file bigger than this still copies, alone.
 */
export const COPY_STAGING_BUDGET_BYTES = 1024 ** 3;

const DEFAULT_POLL_MS = 100;

/** How often a run that is only waiting writes an empty line to its reader. */
const DEFAULT_PING_MS = 1000;

/** After this long without progress, say what the run is waiting for. */
const STALL_NOTICE_MS = 5000;

export interface FileCopyOptions {
  integration: IntegrationSpec;
  resource: FileCopyResourceSpec;
  integrationName: string;
  emitter: Emitter;
  logger: ControlLogger;
  state: ExtractorState;
  stateStore: StateStore;
  advanceState?: boolean;
  fullRefresh?: boolean;
  /** Caps the files copied, like a record cap on other Resources. A capped run saves no state. */
  limit?: number;
  signal?: AbortSignal;
  stagingBudgetBytes?: number;
  /** How often to look for temp files the loader has deleted. */
  pollMs?: number;
  /** How often to write an empty line while waiting. */
  pingMs?: number;
  /** The present, in milliseconds. The watermark never moves past it. */
  nowMs?: () => number;
}

export interface FileCopyResult {
  filesCopied: number;
  bytesCopied: number;
}

/** Decides which listed files a run copies, and what state the run leaves behind. */
interface Tracker {
  wants(file: ListedFile): boolean;
  next(copied: ListedFile[]): Partial<StreamBookmark>;
}

/** A name from the source, made safe to print: control and format characters become \uXXXX. */
const printable = (text: string): string =>
  text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`
  );

/** When this version of a file was written, if the store says; else its modified time. */
const timeOf = (file: ListedFile): string | Date | undefined => file.created ?? file.last_modified;

function modifiedMs(file: ListedFile): number {
  const stamp = timeOf(file);
  const time = stamp === undefined ? Number.NaN : new Date(stamp).getTime();
  if (Number.isNaN(time)) {
    throw new ExtractorDataError(
      `${printable(file.uri)} has no usable last_modified time, so a copy cannot tell whether it is new.`
    );
  }
  return time;
}

/** A file's version. GCS gives each content version a generation, and its ETag also moves when only metadata does. */
const versionOf = (file: ListedFile): string => file.generation ?? file.etag ?? '';

/**
 * S3 and GCS set `last_modified` on the server, so it only moves forward. A run takes files at
 * or after the watermark minus the lookback, except those it already copied unchanged (`recent`).
 * The lookback catches a file that lands late with an older time, such as a slow upload.
 * `scope` is where the copy reads from: a run for another scope starts over, because the files
 * it now reads may be older than the watermark.
 */
function watermarkTracker(
  previous: StreamBookmark | undefined,
  lookbackMs: number,
  scope: string,
  nowMs: () => number
): Tracker {
  const prior = previous?.scope === scope ? previous : undefined;
  const recent = new Map(Object.entries(prior?.recent ?? {}));
  const oldWatermark = prior?.watermark === undefined ? undefined : Date.parse(prior.watermark);
  const cutoff = oldWatermark === undefined ? Number.NEGATIVE_INFINITY : oldWatermark - lookbackMs;
  const modifiedOfRecent = new Map<string, number>();

  return {
    wants(file) {
      const modified = modifiedMs(file);
      if (recent.has(file.path)) modifiedOfRecent.set(file.path, modified);
      return modified >= cutoff && recent.get(file.path) !== versionOf(file);
    },
    next(copied) {
      // The watermark never moves back: a late file inside the window would pull it behind
      // files already copied. It never moves past the present either: a store whose clock runs
      // ahead would otherwise carry it beyond files that arrive later, and skip them for good.
      const now = nowMs();
      let watermark = oldWatermark ?? Number.NEGATIVE_INFINITY;
      for (const file of copied) watermark = Math.max(watermark, Math.min(modifiedMs(file), now));
      if (watermark === Number.NEGATIVE_INFINITY) return {};
      const windowStart = watermark - lookbackMs;
      const inWindow = new Map<string, string>();
      // An old entry stays only while its file is still listed and inside the window.
      for (const [key, version] of recent) {
        if ((modifiedOfRecent.get(key) ?? Number.NEGATIVE_INFINITY) >= windowStart) {
          inWindow.set(key, version);
        }
      }
      for (const file of copied) {
        if (modifiedMs(file) >= windowStart) inWindow.set(file.path, versionOf(file));
      }
      return {
        scope,
        watermark: new Date(watermark).toISOString(),
        recent: Object.fromEntries(inWindow),
      };
    },
  };
}

/**
 * SFTP and local folders let a client set any time, so each file keeps its own bookmark. State
 * from another `scope`, or from a structured Resource of the same name, which has none, says
 * nothing about which files a copy took, so it is not used.
 */
function bookmarkTracker(previous: StreamBookmark | undefined, scope: string): Tracker {
  const files = previous?.scope === scope ? (previous.files ?? {}) : {};
  return {
    wants: (file) => shouldProcessFile(file, files[file.uri]),
    next: (copied) => ({
      scope,
      files: {
        ...files,
        ...Object.fromEntries(copied.map((file) => [file.uri, bookmarkFor(file)])),
      },
    }),
  };
}

function oldestFirst(files: ListedFile[]): ListedFile[] {
  const time = (file: ListedFile): number => {
    const stamp = timeOf(file);
    return stamp === undefined ? 0 : new Date(stamp).getTime();
  };
  return files.sort(
    (a, b) => time(a) - time(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

/** Whether the file is still there. Any other failure is not a sign the loader wrote it. */
const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  );

/**
 * Copy each new file in a file Resource, as it is, to the loader. Each file is downloaded to a
 * temp file and sent as a FILE message. The loader deletes the temp file once it has written
 * it, which is how this run learns the file is done. State moves only after every file is.
 */
export async function extractFileCopyResource({
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
  stagingBudgetBytes = COPY_STAGING_BUDGET_BYTES,
  pollMs = DEFAULT_POLL_MS,
  pingMs = DEFAULT_PING_MS,
  nowMs = Date.now,
}: FileCopyOptions): Promise<FileCopyResult> {
  const sourceType = getFileStorageSourceType(integration);
  if (sourceType === undefined || sourceType === 'vercel_blob') {
    throw new ExtractorConfigError(
      `Resource "${resource.name}" copies files, which needs an s3, gcs, sftp or local integration.`
    );
  }
  const timeBased = sourceType === 's3' || sourceType === 'gcs';
  const key = streamKey(integrationName, resource.name);
  const lookbackMs =
    (resource.replication.cursor.lookback_seconds ?? COPY_DEFAULT_LOOKBACK_SECONDS) * 1000;
  const readAll = fullRefresh === true;
  const connection = (integration as { connection?: Record<string, unknown> | undefined })
    .connection;
  // A copy starts over when any part of where it reads from changes.
  const scope = JSON.stringify([
    sourceType,
    ...['endpoint', 'bucket', 'host', 'port', 'base_directory'].map((name) =>
      String(connection?.[name] ?? '')
    ),
    resource.source.path,
  ]);
  const tracker = timeBased
    ? watermarkTracker(readAll ? undefined : state.streams[key], lookbackMs, scope, nowMs)
    : bookmarkTracker(readAll ? undefined : state.streams[key], scope);
  const maxFiles = Math.min(resource.limits?.max_files_per_run ?? 10_000, limit ?? Infinity);
  const maxFileSize = resource.limits?.max_file_size_bytes ?? 5_368_709_120;
  const maxDownloads = sourceType === 'sftp' ? 1 : MAX_DOWNLOADS;
  const folder = fixedFolder(resource.source.path);
  // Each download and each SFTP read listens to the signal.
  if (signal) setMaxListeners(0, signal);

  const client = await createFileStorageClient(integration);
  let tempDir: string | undefined;
  let removeAtExit: (() => void) | undefined;
  try {
    // List everything: a client's `maxFiles` counts files from the start of the listing,
    // including ones an earlier run already copied.
    let listed = 0;
    let candidates: ListedFile[] = [];
    for await (const file of client.list({ path: resource.source.path, signal })) {
      signal?.throwIfAborted();
      listed += 1;
      if (file.path.endsWith('/')) {
        // A folder placeholder, such as the empty object the S3 console makes for a folder.
        await logger.warn(`Skipping ${printable(file.uri)}: it is a folder, not a file`);
        continue;
      }
      if (!tracker.wants(file)) continue;
      candidates.push(file);
      // Keep memory bounded on a long backlog: only the oldest `maxFiles` can be taken.
      if (candidates.length >= 2 * maxFiles) {
        candidates = oldestFirst(candidates).slice(0, maxFiles);
      }
    }
    const selected = oldestFirst(candidates).slice(0, maxFiles);

    for (const file of selected) {
      if (!file.path.startsWith(folder)) {
        throw new ExtractorDataError(
          `${printable(file.uri)} is not under "${folder}", the folder ${resource.source.path} ` +
            'starts in, so a copy cannot name it.'
        );
      }
      if (file.size !== undefined && file.size > maxFileSize) {
        throw new ExtractorDataError(
          `${printable(file.uri)} is ${file.size} bytes, over max_file_size_bytes ` +
            `(${maxFileSize}). Raise limits.max_file_size_bytes, or move the file out of the ` +
            'copied folder.'
        );
      }
    }

    const created = await mkdtemp(path.join(os.tmpdir(), 'dogsled-copy-'));
    tempDir = created;
    // A reader that fails can end this process on an unhandled write error, before the `finally`
    // below runs. Removing the folder at exit keeps the copied files from piling up in tmp.
    removeAtExit = () => {
      try {
        rmSync(created, { recursive: true, force: true });
      } catch {
        // Nothing more can be done as the process ends.
      }
    };
    process.once('exit', removeAtExit);
    const staged = new Map<string, number>(); // temp file -> bytes, until the loader deletes it
    let downloading = 0; // bytes reserved for downloads in flight
    const active = new Set<Promise<void>>();
    let failure: { error: unknown } | undefined;
    let filesCopied = 0;
    let bytesCopied = 0;
    let sequence = 0;

    let lastProgress = Date.now();
    let stallTold = false;
    const dropDeleted = async (): Promise<void> => {
      for (const tempFile of [...staged.keys()]) {
        if (!(await exists(tempFile))) {
          staged.delete(tempFile);
          lastProgress = Date.now();
        }
      }
      if (!stallTold && staged.size > 0 && Date.now() - lastProgress > STALL_NOTICE_MS) {
        stallTold = true;
        await logger.warn(
          `Waiting for the loader to write ${staged.size} file(s). A copy needs a loader reading ` +
            'this output; if none is, stop the run and use "dogsled pipeline".'
        );
      }
    };
    // A run that only waits writes nothing, so it would not notice that its reader has gone.
    let lastPing = Date.now();
    const keepAlive = async (): Promise<void> => {
      if (Date.now() - lastPing < pingMs) return;
      lastPing = Date.now();
      await emitter.ping();
    };
    const heldBytes = (): number => downloading + [...staged.values()].reduce((a, b) => a + b, 0);

    const admit = async (bytes: number): Promise<void> => {
      for (;;) {
        signal?.throwIfAborted();
        await dropDeleted();
        if (failure !== undefined || (active.size === 0 && staged.size === 0)) return;
        if (active.size < maxDownloads && heldBytes() + bytes <= stagingBudgetBytes) return;
        await Promise.race([...active, sleep(pollMs, undefined, { signal })]);
        await keepAlive();
      }
    };

    const copyOne = async (file: ListedFile): Promise<void> => {
      // The name is only for this run: the loader gets the key from the message, and a key can be
      // longer than a file name may be.
      const target = path.join(created, String((sequence += 1)));
      const downloaded = await client.download(file, target, { signal, asStored: true });
      const bytes = (await stat(downloaded.path)).size;
      if (bytes > maxFileSize) {
        throw new ExtractorDataError(
          `${printable(file.uri)} is ${bytes} bytes, over max_file_size_bytes (${maxFileSize}). ` +
            'Raise limits.max_file_size_bytes, or move the file out of the copied folder.'
        );
      }
      staged.set(downloaded.path, bytes);
      lastProgress = Date.now();
      await emitter.emitFile(
        resource.name,
        pathToFileURL(downloaded.path).href,
        file.path.slice(folder.length),
        bytes
      );
      filesCopied += 1;
      bytesCopied += bytes;
    };

    for (const file of selected) {
      const bytes = file.size ?? 0;
      await admit(bytes);
      if (failure !== undefined) break;
      downloading += bytes;
      const task: Promise<void> = copyOne(file)
        .catch((error: unknown) => {
          failure ??= { error };
        })
        .finally(() => {
          downloading -= bytes;
          active.delete(task);
        });
      active.add(task);
    }
    await Promise.all(active);

    // The loader reads these files from this process's temp folder, so state must wait until
    // it has written and deleted every one. A failed run waits too, so that the loader does not
    // find its files gone and die with the files it was still writing. A loader that fails
    // ends the run before this.
    await dropDeleted();
    while (staged.size > 0) {
      await sleep(pollMs, undefined, { signal });
      await keepAlive();
      await dropDeleted();
    }
    if (failure !== undefined) throw failure.error;

    const bookmark: StreamBookmark = {
      last_run_at: new Date().toISOString(),
      record_count: 0,
      ...tracker.next(selected),
    };
    if (advanceState && limit == null) {
      state.streams[key] = bookmark;
      await stateStore.save(state);
    }
    // The saved state is the record. A STATE line that carried the whole of it could pass the
    // protocol's line limit on a large folder, after the state was already saved.
    await emitter.emitState(resource.name, {
      last_run_at: bookmark.last_run_at,
      record_count: 0,
    });
    await logger.metric(resource.name, {
      files_listed: listed,
      files_skipped: listed - filesCopied,
      files_processed: filesCopied,
      bytes_downloaded: bytesCopied,
      records_emitted: 0,
    } as Parameters<ControlLogger['metric']>[1]);

    return { filesCopied, bytesCopied };
  } finally {
    if (removeAtExit) process.removeListener('exit', removeAtExit);
    try {
      await client.close();
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  }
}
