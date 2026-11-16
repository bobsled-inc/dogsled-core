import { NextResponse } from 'next/server';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve as resolvePath } from 'path';
import { resolveSafePathWithinRoot } from '@/lib/path-safety';
import { getWorkspaceRoot } from '@/lib/bobsled-cli';

interface TestBody {
  type: string;
  config: Record<string, string>;
}

function isTestBody(value: unknown): value is TestBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TestBody>;
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.config === 'object' &&
    candidate.config !== null &&
    !Array.isArray(candidate.config) &&
    Object.values(candidate.config).every((v): v is string => typeof v === 'string')
  );
}

function safeWorkspacePath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes('\0')) return null;
  try {
    return resolveSafePathWithinRoot(getWorkspaceRoot(), rawPath);
  } catch {
    return null;
  }
}

// Credential key files legitimately live outside the workspace
// (e.g. ~/.config/gcloud/application_default_credentials.json).
// Reject null bytes, expand `~`, and return an absolute path without
// confining to the workspace root.
function safeCredentialPath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes('\0')) return null;
  const expanded = rawPath.startsWith('~')
    ? resolvePath(homedir(), rawPath.slice(1).replace(/^[/\\]/, ''))
    : rawPath;
  try {
    return resolvePath(expanded);
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body.' }, { status: 400 });
  }

  if (!isTestBody(body)) {
    return NextResponse.json({ ok: false, message: 'Missing type or config.' }, { status: 400 });
  }

  const { type, config } = body;

  try {
    if (type === 'duckdb') {
      const rawPath = config.path ?? '';
      if (!rawPath) {
        return NextResponse.json({ ok: false, message: 'No file path provided.' });
      }
      const resolved = safeWorkspacePath(rawPath);
      if (!resolved) {
        return NextResponse.json({ ok: false, message: 'Invalid file path.' });
      }
      if (!existsSync(resolved)) {
        return NextResponse.json({ ok: false, message: 'File not found at the provided path.' });
      }
      const { DuckDBInstance } = await import('@duckdb/node-api');
      const instance = await DuckDBInstance.create(resolved, { access_mode: 'READ_ONLY' });
      try {
        const connection = await instance.connect();
        try {
          await connection.runAndReadAll('SELECT 1');
        } finally {
          connection.disconnectSync();
        }
      } finally {
        instance.closeSync();
      }
      return NextResponse.json({ ok: true, message: 'DuckDB connection successful.' });
    }

    if (type === 'bigquery') {
      const rawKey = config.keyFilename ?? '';
      if (!rawKey) {
        return NextResponse.json({ ok: false, message: 'No service account key path provided.' });
      }
      const resolved = safeCredentialPath(rawKey);
      if (!resolved) {
        return NextResponse.json({ ok: false, message: 'Invalid key file path.' });
      }
      const { BigQuery } = await import('@google-cloud/bigquery');
      const bq = new BigQuery({ keyFilename: resolved, projectId: config.project || undefined });
      await bq.getDatasets({ maxResults: 1 });
      return NextResponse.json({ ok: true, message: 'BigQuery connection successful.' });
    }

    return NextResponse.json({
      ok: true,
      untested: true,
      message: `Saved. Automatic testing is not yet supported for ${type} — credentials will be validated on first use.`,
    });
  } catch (err) {
    console.error('[connections/test] Connection test failed:', err);
    return NextResponse.json({
      ok: false,
      message: 'Connection test failed. Check server logs for details.',
    });
  }
}
