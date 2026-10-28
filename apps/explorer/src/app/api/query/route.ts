import { NextResponse } from 'next/server';
import { spawnDogsledCommand, collectOutput, getWorkspaceRoot } from '@/lib/dogsled-cli';
import { parseLoaderQueryTable } from '@/lib/loader-query-parser';
import { resolveSafePathWithinRoot } from '@/lib/path-safety';

const MAX_ROWS_RETURNED = 1_000;
const QUERY_TIMEOUT_MS = 60_000;
const QUERY_OUTPUT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const {
    dbPath = './explorer.duckdb',
    dbKey,
    sql,
  } = body as {
    dbPath?: unknown;
    dbKey?: unknown;
    sql?: unknown;
  };

  if (typeof sql !== 'string' || !sql) {
    return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  }
  if (sql.length > 10_000) {
    return NextResponse.json({ error: 'sql too long (max 10,000 chars)' }, { status: 400 });
  }

  if (dbKey !== undefined) {
    return NextResponse.json({ error: 'Invalid dbKey' }, { status: 400 });
  }
  if (typeof dbPath !== 'string' || !dbPath || dbPath.includes('\0')) {
    return NextResponse.json({ error: 'Invalid dbPath' }, { status: 400 });
  }
  let resolved: string;
  try {
    resolved = resolveSafePathWithinRoot(getWorkspaceRoot(), dbPath);
  } catch {
    return NextResponse.json(
      { error: 'dbPath must be within the project directory' },
      { status: 400 }
    );
  }

  try {
    const child = spawnDogsledCommand('load', ['query', '--db-path', resolved, sql]);
    const { stdout, stderr, code } = await collectOutput(child, {
      timeoutMs: QUERY_TIMEOUT_MS,
      maxBytes: QUERY_OUTPUT_MAX_BYTES,
    });

    if (code !== 0) {
      return NextResponse.json(
        { error: stderr || `Process exited with code ${code}`, code },
        { status: 500 }
      );
    }

    const parsedRows = parseLoaderQueryTable(stdout);
    if (parsedRows === null) {
      return NextResponse.json({ raw: stdout, count: 0 });
    }

    const totalCount = parsedRows.length;
    const truncated = totalCount > MAX_ROWS_RETURNED;
    const rows = parsedRows.slice(0, MAX_ROWS_RETURNED);

    return NextResponse.json({
      rows,
      count: rows.length,
      totalCount,
      truncated,
      maxRows: MAX_ROWS_RETURNED,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
