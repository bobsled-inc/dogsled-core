import { NextResponse } from 'next/server';
import { readEntityGraphSql } from '@/lib/entity-graph-workspace';
import { normalizeEntityGraphDataQuerySql } from '@/lib/entity-graph-data-queries';
import {
  isInvalidEntityGraphInputError,
  resolveEntityGraphScenarioEntity,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { getEntityGraphBusyActionableError } from '@/lib/entity-graph-workspace-state';
import { logServerError } from '@/lib/server-logging';

export const dynamic = 'force-dynamic';

const MAX_ROWS_RETURNED = 1_000;
const MAX_SQL_LENGTH = 10_000;
const FORBIDDEN_READONLY_SQL_RE =
  /\b(insert|update|delete|merge|alter|drop|create|truncate|copy|call|vacuum|attach|detach|returning)\b/i;

interface EntityGraphQueryRow {
  [column: string]: unknown;
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripSqlLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

function validateReadOnlySelect(sql: string): { ok: true } | { ok: false; message: string } {
  const withoutComments = stripSqlLiterals(stripSqlComments(sql)).trim();
  if (!withoutComments) return { ok: false, message: 'sql is required' };
  if (/;\s*\S/.test(withoutComments)) {
    return { ok: false, message: 'Multi-statement SQL is not allowed' };
  }
  if (!/^(select|with)\b/i.test(withoutComments)) {
    return { ok: false, message: 'Only SELECT queries are allowed' };
  }
  if (FORBIDDEN_READONLY_SQL_RE.test(withoutComments)) {
    return { ok: false, message: 'Only read-only SELECT queries are allowed' };
  }
  return { ok: true };
}

function isCountColumnName(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === 'count' ||
    normalized === 'count(*)' ||
    normalized === 'count_star()' ||
    normalized.startsWith('count_') ||
    normalized.endsWith('_count')
  );
}

function toJsonSafeValue(key: string, value: unknown): unknown {
  if (typeof value !== 'bigint') return value;
  if (
    isCountColumnName(key) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return value.toString();
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const {
    scenario: scenarioValue,
    entity: entityValue,
    sql,
  } = body as {
    scenario?: unknown;
    entity?: unknown;
    sql?: unknown;
  };

  if (typeof sql !== 'string' || !sql.trim()) {
    return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  }
  if (sql.length > MAX_SQL_LENGTH) {
    return NextResponse.json(
      { error: `sql too long (max ${MAX_SQL_LENGTH.toLocaleString()} chars)` },
      { status: 400 }
    );
  }

  let scenarioId: EntityGraphScenarioId = 'default';
  let entityId: EntityGraphEntityId = 'company';
  try {
    const resolved = resolveEntityGraphScenarioEntity(
      typeof scenarioValue === 'string' ? scenarioValue : null,
      typeof entityValue === 'string' ? entityValue : null
    );
    scenarioId = resolved.scenarioId;
    entityId = resolved.entityId;
  } catch (err) {
    if (isInvalidEntityGraphInputError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logServerError('entity-graph/query:resolve', err, {
      scenario: scenarioValue,
      entity: entityValue,
    });
    return NextResponse.json(
      { error: 'Failed to resolve Entity Graph selection' },
      { status: 500 }
    );
  }

  const trimmedSql = normalizeEntityGraphDataQuerySql(
    sql.replace(/;+\s*$/, '').trim(),
    scenarioId,
    entityId
  );
  const validation = validateReadOnlySelect(trimmedSql);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.message }, { status: 400 });
  }

  try {
    const cappedSql = `SELECT * FROM (${trimmedSql}) AS __entity_graph_query LIMIT ${MAX_ROWS_RETURNED + 1}`;
    const allRows = await readEntityGraphSql<EntityGraphQueryRow>(cappedSql, scenarioId);
    const truncated = allRows.length > MAX_ROWS_RETURNED;
    const rawRows = truncated ? allRows.slice(0, MAX_ROWS_RETURNED) : allRows;
    const rows = rawRows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, toJsonSafeValue(key, value)])
      )
    );

    return NextResponse.json({
      rows,
      count: rows.length,
      truncated,
      maxRows: MAX_ROWS_RETURNED,
    });
  } catch (error) {
    const busyError = getEntityGraphBusyActionableError(error);
    if (busyError) {
      return NextResponse.json(busyError.body, { status: busyError.status });
    }
    logServerError('entity-graph/query', error);
    return NextResponse.json({ error: 'Query execution failed' }, { status: 500 });
  }
}
