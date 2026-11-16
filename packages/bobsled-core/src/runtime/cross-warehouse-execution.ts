import * as path from 'node:path';

import { runCancellable, throwIfCancelled, type SqlRunnerModule } from '@bobsled-inc/connections';
import { createDuckDbWriter } from '@bobsled-inc/loader';
import { CommandError, type BatchEncoding, type SchemaColumn } from '@bobsled-inc/protocol';

export function resolveStagingFormat(): 'jsonl' | 'parquet' {
  const raw = process.env['BOBSLED_CORE_XWH_STAGING_FORMAT'];
  if (raw === 'parquet') return 'parquet';
  if (raw === 'jsonl' || raw === undefined || raw === '') return 'jsonl';
  throw new CommandError(
    `BOBSLED_CORE_XWH_STAGING_FORMAT must be 'jsonl' or 'parquet'; got '${raw}'.`,
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

export function encodingFor(format: 'jsonl' | 'parquet'): BatchEncoding {
  return format === 'parquet' ? { format: 'parquet' } : { format: 'jsonl' };
}

export function resolveSourceTimeoutMs(): number | null {
  const raw = process.env['BOBSLED_CORE_XWH_SOURCE_TIMEOUT_S'];
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
    `Source ${ref} exceeded BOBSLED_CORE_XWH_SOURCE_TIMEOUT_S (${Math.round(timeoutMs / 1000)}s).`,
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
