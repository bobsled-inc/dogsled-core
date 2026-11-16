import os from 'node:os';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  buildEntityGraphHref,
  getEntityGraphEntityDefinition,
  getEntityGraphScenarioDefinition,
} from './entity-graph-scenarios';
import { getWorkspaceRoot } from './bobsled-cli';
import {
  escapeSqlLiteral,
  getEntityGraphRunnerPath,
  getEntityGraphWorkspaceRoot,
  readRunLog,
  specYamlPath,
  type EntityGraphRunLogEntry,
} from './entity-graph-workspace';
import type { EntityGraphEntityId, EntityGraphScenarioId } from './entity-graph-scenarios';

const ENTITY_GRAPH_WORKSPACE_REQUIRED_OUTPUT_SUFFIXES = [
  '__standardized',
  '__review_queue',
  '__review_decisions',
  '__clusters',
  '__entity_profile',
  '__entity_quality',
  '__golden_record',
  '__survivorship_audit',
] as const;
const DUCKDB_BUSY_PATTERNS = [
  /could not set lock/i,
  /database is locked/i,
  /database is busy/i,
  /conflicting lock is held/i,
  /resource temporarily unavailable/i,
] as const;

interface DuckDbRow {
  [column: string]: unknown;
}

export type EntityGraphWorkspaceQuery = <TRow extends DuckDbRow = DuckDbRow>(
  sql: string
) => Promise<TRow[]>;

export interface EntityGraphWorkspaceTableInfo {
  schema: string;
  name: string;
  rowCount?: number | null;
}

export interface EntityGraphWorkspaceHealth {
  scenario: EntityGraphScenarioId;
  entity: EntityGraphEntityId;
  specExists: boolean;
  runnerExists: boolean;
  outputTables: Array<{ name: string; exists: boolean }>;
  expectedOutputsReady: boolean;
}

export interface EntityGraphWorkspaceInventorySpec {
  name: string;
  type: 'resolution' | 'survivorship';
  entity: EntityGraphEntityId;
  path: string;
  href: string;
}

export interface EntityGraphWorkspaceInventorySeedFile {
  name: string;
  path: string;
  kind: 'seed_spec' | 'seed_data';
  /** When set, opens the seed's underlying table in the data preview with autorun SQL. */
  previewHref: string | null;
}

export interface EntityGraphWorkspaceInventoryEntity {
  entity: EntityGraphEntityId;
  label: string;
  outputTables: EntityGraphWorkspaceTableInfo[];
  links: {
    design: string;
    queue: string;
    clusters: string;
    dataPreview: string | null;
  };
}

export interface EntityGraphWorkspaceInventory {
  scenario: EntityGraphScenarioId;
  label: string;
  workspaceRoot: string;
  dbPath: string | null;
  specs: EntityGraphWorkspaceInventorySpec[];
  seedFiles: EntityGraphWorkspaceInventorySeedFile[];
  sourceTables: EntityGraphWorkspaceTableInfo[];
  entities: EntityGraphWorkspaceInventoryEntity[];
}

export function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteSqlText(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

function normalizeQueryRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] =
        typeof value === 'bigint' &&
        value <= BigInt(Number.MAX_SAFE_INTEGER) &&
        value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(value)
          : typeof value === 'bigint'
            ? value.toString()
            : value;
    }
    return normalized;
  });
}

async function getEntityGraphDatabasePath(
  scenario?: EntityGraphScenarioId
): Promise<string | null> {
  const workspaceRoot = getEntityGraphWorkspaceRoot(scenario);
  if (!existsSync(workspaceRoot)) {
    return null;
  }

  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  const databaseFile = entries
    .filter((entry) => entry.isFile() && /\.(db|duckdb)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))[0];

  return databaseFile ? path.join(workspaceRoot, databaseFile) : null;
}

async function createSnapshotDbCopy(
  dbPath: string
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'entity_graph-workspace-'));
  const snapshotPath = path.join(tempDir, path.basename(dbPath));
  await fs.copyFile(dbPath, snapshotPath);
  // Copy WAL alongside the DB so the snapshot reflects all committed transactions
  // that haven't been checkpointed yet.
  try {
    await fs.copyFile(`${dbPath}.wal`, `${snapshotPath}.wal`);
  } catch {
    // No WAL present or already checkpointed — snapshot is complete without it.
  }
  return {
    path: snapshotPath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function runQueryAgainstDb<T>(
  dbPath: string,
  fn: (query: EntityGraphWorkspaceQuery) => Promise<T>
): Promise<T> {
  const instance = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
  try {
    const connection = await instance.connect();
    try {
      return await fn(async <TRow extends DuckDbRow>(sql: string) => {
        const reader = await connection.runAndReadAll(sql);
        return normalizeQueryRows(reader.getRowObjectsJS() as DuckDbRow[]) as TRow[];
      });
    } finally {
      connection.disconnectSync();
    }
  } finally {
    instance.closeSync();
  }
}

export async function withEntityGraphWorkspaceQuery<T>(
  scenario: EntityGraphScenarioId | undefined,
  fn: (query: EntityGraphWorkspaceQuery) => Promise<T>
): Promise<T> {
  const dbPath = await getEntityGraphDatabasePath(scenario);
  if (!dbPath) {
    throw new Error(
      `Entity Graph database not found under ${getEntityGraphWorkspaceRoot(scenario)}`
    );
  }

  let cleanupSnapshot: (() => Promise<void>) | null = null;
  let resolvedDbPath = dbPath;

  try {
    try {
      return await runQueryAgainstDb(resolvedDbPath, fn);
    } catch (error) {
      if (!isDuckDbBusyError(error)) {
        throw error;
      }

      const snapshot = await createSnapshotDbCopy(dbPath);
      cleanupSnapshot = snapshot.cleanup;
      resolvedDbPath = snapshot.path;

      return await runQueryAgainstDb(resolvedDbPath, fn);
    }
  } finally {
    await cleanupSnapshot?.();
  }
}

async function listFilesRecursive(root: string, prefix = ''): Promise<string[]> {
  const dir = path.join(root, prefix);
  if (!existsSync(dir)) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursive(root, relativePath);
      }
      return [relativePath];
    })
  );

  return files.flat().sort((left, right) => left.localeCompare(right));
}

export function isDuckDbBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return DUCKDB_BUSY_PATTERNS.some((pattern) => pattern.test(message));
}

export async function listEntityGraphWorkspaceTables(
  scenario?: EntityGraphScenarioId,
  query?: EntityGraphWorkspaceQuery
): Promise<EntityGraphWorkspaceTableInfo[]> {
  const loadTables = async (runQuery: EntityGraphWorkspaceQuery) => {
    const rows = await runQuery<{ table_schema: string; table_name: string }>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY table_schema, table_name
    `);

    return rows.map((row) => ({
      schema: row.table_schema,
      name: row.table_name,
    }));
  };

  return query ? loadTables(query) : withEntityGraphWorkspaceQuery(scenario, loadTables);
}

export async function countEntityGraphWorkspaceTables(
  tables: EntityGraphWorkspaceTableInfo[],
  scenario?: EntityGraphScenarioId,
  query?: EntityGraphWorkspaceQuery
): Promise<EntityGraphWorkspaceTableInfo[]> {
  if (tables.length === 0) {
    return [];
  }

  const sql = tables
    .map(
      (table) => `
        SELECT
          ${quoteSqlText(table.schema)} AS table_schema,
          ${quoteSqlText(table.name)} AS table_name,
          COUNT(*) AS row_count
        FROM ${quoteSqlIdentifier(table.schema)}.${quoteSqlIdentifier(table.name)}
      `
    )
    .join('\nUNION ALL\n');

  const loadCounts = async (runQuery: EntityGraphWorkspaceQuery) => {
    const counts = await runQuery<{ table_schema: string; table_name: string; row_count: number }>(
      sql
    );
    const countMap = new Map(
      counts.map((row) => [`${row.table_schema}.${row.table_name}`, row.row_count] as const)
    );

    return tables.map((table) => ({
      ...table,
      rowCount: countMap.get(`${table.schema}.${table.name}`) ?? null,
    }));
  };

  return query ? loadCounts(query) : withEntityGraphWorkspaceQuery(scenario, loadCounts);
}

export async function getEntityGraphWorkspaceHealth(
  scenario: EntityGraphScenarioId,
  entity: EntityGraphEntityId
): Promise<EntityGraphWorkspaceHealth> {
  const entityDefinition = getEntityGraphEntityDefinition(entity);
  const runnerExists = existsSync(getEntityGraphRunnerPath(scenario));
  const dbExists = (await getEntityGraphDatabasePath(scenario)) !== null;
  const specExists = existsSync(specYamlPath(entityDefinition.defaultResolutionSpec, scenario));
  const expectedNames = ENTITY_GRAPH_WORKSPACE_REQUIRED_OUTPUT_SUFFIXES.map(
    (suffix) => `${entity}${suffix}`
  );

  if (!runnerExists || !dbExists) {
    return {
      scenario,
      entity,
      specExists,
      runnerExists,
      outputTables: expectedNames.map((name) => ({ name, exists: false })),
      expectedOutputsReady: false,
    };
  }

  return withEntityGraphWorkspaceQuery(scenario, async (query) => {
    const schema = getEntityGraphScenarioDefinition(scenario).schema;
    const tableSet = new Set(
      (await listEntityGraphWorkspaceTables(scenario, query))
        .filter((table) => table.schema === schema)
        .map((table) => table.name)
    );
    const outputTables = expectedNames.map((name) => ({
      name,
      exists: tableSet.has(name),
    }));

    return {
      scenario,
      entity,
      specExists,
      runnerExists,
      outputTables,
      expectedOutputsReady: outputTables.every((table) => table.exists),
    };
  });
}

export async function getLatestEntityGraphRunEntry(
  entity: EntityGraphEntityId,
  scenario: EntityGraphScenarioId
): Promise<EntityGraphRunLogEntry | null> {
  const runs = await readRunLog(25, scenario);
  return runs.find((run) => run.entity === entity) ?? null;
}

/**
 * Run a read-only SQL query against the Entity Graph workspace database.
 * Opens a per-request READ_ONLY connection and closes it immediately after use.
 * Falls back to a snapshot copy if the DB is busy with a write lock.
 */
export async function readEntityGraphSql<T = Record<string, unknown>>(
  sql: string,
  scenario?: EntityGraphScenarioId
): Promise<T[]> {
  const rows = await withEntityGraphWorkspaceQuery(scenario, (query) => query(sql));
  return rows as T[];
}

export async function getRelativeEntityGraphDatabasePath(
  scenario?: EntityGraphScenarioId
): Promise<string | null> {
  const dbPath = await getEntityGraphDatabasePath(scenario);
  if (!dbPath) {
    return null;
  }

  return path.relative(getWorkspaceRoot(), dbPath);
}

export async function getEntityGraphWorkspaceInventory(
  scenario: EntityGraphScenarioId
): Promise<EntityGraphWorkspaceInventory> {
  const scenarioDefinition = getEntityGraphScenarioDefinition(scenario);
  const dbPath = await getRelativeEntityGraphDatabasePath(scenario);
  const hasRunner = existsSync(getEntityGraphRunnerPath(scenario));
  const { sourceTables, entities } =
    hasRunner && dbPath
      ? await withEntityGraphWorkspaceQuery(scenario, async (query) => {
          const tables = await listEntityGraphWorkspaceTables(scenario, query);
          const sourceSchemas = new Set(['raw']);
          const sourceTablesResult = await countEntityGraphWorkspaceTables(
            tables.filter((table) => sourceSchemas.has(table.schema)),
            scenario,
            query
          );
          const entitiesResult = await Promise.all(
            scenarioDefinition.supportedEntities.map(async (entityId) => {
              const entityDefinition = getEntityGraphEntityDefinition(entityId);
              const outputTables = await countEntityGraphWorkspaceTables(
                tables.filter(
                  (table) =>
                    table.schema === scenarioDefinition.schema &&
                    table.name.startsWith(`${entityId}__`)
                ),
                scenario,
                query
              );
              return {
                entity: entityId,
                label: entityDefinition.label,
                outputTables,
                links: {
                  design: buildEntityGraphHref('/entity-graph/design', {
                    scenario,
                    entity: entityId,
                  }),
                  queue: buildEntityGraphHref('/entity-graph/resolve', {
                    scenario,
                    entity: entityId,
                    params: { tab: 'queue' },
                  }),
                  clusters: buildEntityGraphHref('/entity-graph/resolve', {
                    scenario,
                    entity: entityId,
                    params: { tab: 'clusters' },
                  }),
                  dataPreview: dbPath ? `/data?db=${encodeURIComponent(dbPath)}` : null,
                },
              };
            })
          );

          return {
            sourceTables: sourceTablesResult,
            entities: entitiesResult,
          };
        })
      : { sourceTables: [], entities: [] };

  const specs = scenarioDefinition.supportedEntities.flatMap((entityId) => {
    const entityDefinition = getEntityGraphEntityDefinition(entityId);
    return [
      {
        name: entityDefinition.defaultResolutionSpec,
        type: 'resolution' as const,
        entity: entityId,
        path: path.relative(
          getWorkspaceRoot(),
          specYamlPath(entityDefinition.defaultResolutionSpec, scenario)
        ),
        href: buildEntityGraphHref('/entity-graph/design', { scenario, entity: entityId }),
      },
      {
        name: entityDefinition.defaultSurvivorshipSpec,
        type: 'survivorship' as const,
        entity: entityId,
        path: path.relative(
          getWorkspaceRoot(),
          specYamlPath(entityDefinition.defaultSurvivorshipSpec, scenario)
        ),
        href: buildEntityGraphHref('/entity-graph/resolve', {
          scenario,
          entity: entityId,
          params: { tab: 'clusters' },
        }),
      },
    ];
  });

  const seedFiles = (await listFilesRecursive(getEntityGraphWorkspaceRoot(scenario), 'seeds')).map(
    (file) => {
      const isData = file.startsWith(path.join('seeds', 'data'));
      const basename = path.basename(file);
      return {
        name: basename,
        path: path.join(scenarioDefinition.workspaceDir, file),
        kind: isData ? ('seed_data' as const) : ('seed_spec' as const),
        previewHref: null,
      };
    }
  );

  return {
    scenario,
    label: scenarioDefinition.label,
    workspaceRoot: scenarioDefinition.workspaceDir,
    dbPath,
    specs,
    seedFiles,
    sourceTables,
    entities,
  };
}
