import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { finished } from 'node:stream/promises';

import { runCancellable, throwIfCancelled, type SqlRunnerModule } from '@bobsled-inc/connections';
import { createDuckDbWriter } from '@bobsled-inc/loader';
import { CommandError, type BatchEncoding, type SchemaColumn } from '@bobsled-inc/protocol';

export function resolveStagingFormat(): 'jsonl' | 'parquet' {
  const raw = process.env['DOGSLED_XWH_STAGING_FORMAT'];
  if (raw === 'parquet') return 'parquet';
  if (raw === 'jsonl' || raw === undefined || raw === '') return 'jsonl';
  throw new CommandError(
    `DOGSLED_XWH_STAGING_FORMAT must be 'jsonl' or 'parquet'; got '${raw}'.`,
    2
  );
}

export async function convertJsonlChunksToParquet(
  jsonlFiles: string[],
  columns: SchemaColumn[],
  workDir: string,
  baseName: string,
  signal?: AbortSignal
): Promise<string[]> {
  throwIfCancelled(signal);
  if (jsonlFiles.length === 0) return [];
  return runCancellable(signal, async (register) => {
    const writer = await createDuckDbWriter();
    let closePromise: Promise<void> | undefined;
    const closeWriter = (): Promise<void> => {
      closePromise ??= writer.close();
      return closePromise;
    };
    register(closeWriter);
    const parquetFiles: string[] = [];
    try {
      for (let index = 0; index < jsonlFiles.length; index += 1) {
        throwIfCancelled(signal);
        const sourcePath = jsonlFiles[index]!;
        const outputPath = path.join(workDir, `${baseName}-${index}.parquet`);
        await writer.convertFile({
          sourcePath,
          outputPath,
          format: 'parquet',
          sourceEncoding: { format: 'jsonl' },
          columns,
        });
        parquetFiles.push(outputPath);
      }
      return parquetFiles;
    } finally {
      try {
        await closeWriter();
      } catch {
        // Conversion already settled; cleanup failure must not replace its outcome.
      }
    }
  });
}

/**
 * Join a stage's JSONL chunks into one file. Every load job counts toward
 * BigQuery's per-table limits (about five table updates every ten seconds and
 * 1,500 table operations a day), so a BigQuery stage loads with one job instead
 * of one job and one loaded-at UPDATE per 10,000-row chunk.
 */
async function joinJsonlChunks(
  jsonlFiles: string[],
  workDir: string,
  baseName: string,
  signal?: AbortSignal
): Promise<string[]> {
  if (jsonlFiles.length <= 1) return jsonlFiles;
  const outputPath = path.join(workDir, `${baseName}-stage.jsonl`);
  const output = createWriteStream(outputPath);
  // A write error surfaces through `once(output, 'drain')` or `finished(output)`.
  output.on('error', () => undefined);
  try {
    for (const file of jsonlFiles) {
      throwIfCancelled(signal);
      // Each chunk line already ends with a newline, so chunks join cleanly.
      for await (const data of createReadStream(file)) {
        if (!output.write(data)) await once(output, 'drain');
      }
    }
  } finally {
    output.end();
    await finished(output);
  }
  await Promise.all(jsonlFiles.map((file) => rm(file, { force: true })));
  return [outputPath];
}

/** The files to load for one stage: one file on BigQuery, Parquet when requested. */
export async function prepareStageFiles(
  jsonlFiles: string[],
  options: {
    oneFile: boolean;
    stagingFormat: 'jsonl' | 'parquet';
    columns: SchemaColumn[];
    workDir: string;
    baseName: string;
    signal?: AbortSignal;
  }
): Promise<string[]> {
  const chunks = options.oneFile
    ? await joinJsonlChunks(jsonlFiles, options.workDir, options.baseName, options.signal)
    : jsonlFiles;
  return options.stagingFormat === 'parquet'
    ? await convertJsonlChunksToParquet(
        chunks,
        options.columns,
        options.workDir,
        options.baseName,
        options.signal
      )
    : chunks;
}

export function encodingFor(format: 'jsonl' | 'parquet'): BatchEncoding {
  return format === 'parquet' ? { format: 'parquet' } : { format: 'jsonl' };
}

export function resolveSourceTimeoutMs(): number | null {
  const raw = process.env['DOGSLED_XWH_SOURCE_TIMEOUT_S'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

export function sourceTimeoutError(ref: string, timeoutMs: number): CommandError {
  return new CommandError(
    `Source ${ref} exceeded DOGSLED_XWH_SOURCE_TIMEOUT_S (${Math.round(timeoutMs / 1000)}s).`,
    1
  );
}

export async function withSourceDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number | null,
  timeoutMs: number | null,
  ref: string,
  signal?: AbortSignal
): Promise<T> {
  throwIfCancelled(signal);
  if (deadlineMs === null || timeoutMs === null) return operation;

  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    operation.catch(() => undefined);
    throw sourceTimeoutError(ref, timeoutMs);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(sourceTimeoutError(ref, timeoutMs)), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function runSql(
  runner: SqlRunnerModule,
  sql: string,
  signal?: AbortSignal
): ReturnType<SqlRunnerModule['run']> {
  return signal ? runner.run(sql, { signal }) : runner.run(sql);
}
