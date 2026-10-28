import { NextResponse } from 'next/server';
import { isEntityGraphTableSuffix } from '@/lib/learn-curriculum';
import {
  countEntityGraphWorkspaceTables,
  getRelativeEntityGraphDatabasePath,
  listEntityGraphWorkspaceTables,
  quoteSqlIdentifier,
  readEntityGraphSql,
} from '@/lib/entity-graph-workspace-inventory';
import {
  getEntityGraphScenarioDefinition,
  isEntityGraphEntityId,
  isEntityGraphScenarioId,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { logServerError } from '@/lib/server-logging';

export const dynamic = 'force-dynamic';

const MAX_SAMPLE_ROWS = 25;

function parseLimit(value: string | null): number {
  if (!value) {
    return 10;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return 10;
  }
  return Math.max(1, Math.min(parsed, MAX_SAMPLE_ROWS));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawScenario = url.searchParams.get('scenario') ?? 'default';
  const rawEntity = url.searchParams.get('entity') ?? 'company';
  const rawSuffix = url.searchParams.get('suffix');
  const limit = parseLimit(url.searchParams.get('limit'));

  if (!isEntityGraphScenarioId(rawScenario)) {
    return NextResponse.json(
      { error: `Unsupported scenario: ${rawScenario}`, code: 'invalid_request' },
      { status: 400 }
    );
  }
  const scenario: EntityGraphScenarioId = rawScenario;

  if (!isEntityGraphEntityId(rawEntity)) {
    return NextResponse.json(
      { error: `Unsupported entity: ${rawEntity}`, code: 'invalid_request' },
      { status: 400 }
    );
  }
  const entity: EntityGraphEntityId = rawEntity;

  if (!getEntityGraphScenarioDefinition(scenario).supportedEntities.includes(entity)) {
    return NextResponse.json(
      { error: `Entity ${entity} is not available in ${scenario}`, code: 'invalid_request' },
      { status: 400 }
    );
  }

  if (!isEntityGraphTableSuffix(rawSuffix)) {
    return NextResponse.json(
      { error: `Unsupported table suffix: ${String(rawSuffix)}`, code: 'invalid_request' },
      { status: 400 }
    );
  }

  const schema = getEntityGraphScenarioDefinition(scenario).schema;
  const tableName = `${entity}${rawSuffix}`;

  try {
    const dbPath = await getRelativeEntityGraphDatabasePath(scenario);
    if (!dbPath) {
      return NextResponse.json(
        {
          error: 'Entity Graph workspace database not found',
          code: 'workspace_missing',
          scenario,
        },
        { status: 404 }
      );
    }

    const tables = await listEntityGraphWorkspaceTables(scenario);
    const table = tables.find((entry) => entry.schema === schema && entry.name === tableName);
    if (!table) {
      return NextResponse.json({
        scenario,
        entity,
        suffix: rawSuffix,
        table: { schema, name: tableName, exists: false, rowCount: null },
        rows: [],
      });
    }

    const [counted] = await countEntityGraphWorkspaceTables([table], scenario);
    const rows = await readEntityGraphSql(
      `SELECT * FROM ${quoteSqlIdentifier(schema)}.${quoteSqlIdentifier(tableName)} LIMIT ${limit}`,
      scenario
    );

    return NextResponse.json({
      scenario,
      entity,
      suffix: rawSuffix,
      table: { ...table, exists: true, rowCount: counted?.rowCount ?? null },
      rows,
    });
  } catch (error) {
    logServerError('apps/explorer/api/learn/entity-graph-table:get', error, {
      scenario,
      entity,
      suffix: rawSuffix,
    });
    return NextResponse.json(
      {
        error: 'Failed to load Entity Graph table sample',
        code: 'table_sample_failed',
      },
      { status: 500 }
    );
  }
}
