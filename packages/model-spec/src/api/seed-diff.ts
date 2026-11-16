/**
 * `diffSeeds` — Layer 3 for `bobsled model seed diff`: compare warehouse state
 * with the local seed CSVs. Values are compared in canonical form per column
 * type (see `compiler/seed/compare.ts`).
 */

import {
  buildFqName,
  getCanonicalDialect,
  quoteIdentifier,
  type SqlQueryRunner,
  type SupportedDialect,
} from '../compiler/index.js';
import { canonicalSeedValue, warehouseValueText } from '../compiler/seed/compare.js';
import { buildSeedKey } from '../compiler/seed/key.js';
import { classifySeedType, type SeedTypeFamily } from '../compiler/seed/types.js';
import { getSeedUniqueColumns } from '../compiler/seed/validation.js';
import { CommandError } from '../errors.js';
import { readSeedCsv, resolveSeedEnv } from './seed-env.js';

// ---------------------------------------------------------------------------
// diffSeeds
// ---------------------------------------------------------------------------

export interface SeedDiffEntry {
  key: string;
  csv: Record<string, string>;
  warehouse?: Record<string, string>;
}

export interface SeedDiffResultEntry {
  name: string;
  schema: string;
  uniqueColumns: string[];
  addCount: number;
  updateCount: number;
  deleteCount: number;
  adds: SeedDiffEntry[];
  updates: Array<SeedDiffEntry & { warehouse: Record<string, string> }>;
  deletes: Array<SeedDiffEntry & { warehouse: Record<string, string> }>;
}

export interface DiffSeedsOptions {
  dialect?: SupportedDialect;
  schema?: string;
  /** Optional seed folder override, relative to the project root. */
  seedsDir?: string;
  /** Required — seed diff cannot run without a warehouse query runner. */
  query: SqlQueryRunner;
}

export interface DiffSeedsResult {
  dialect: SupportedDialect;
  schema: string;
  seeds: SeedDiffResultEntry[];
  /** True when at least one seed has non-zero add/update/delete counts. */
  hasDrift: boolean;
}

function normalizeWarehouseRow(
  row: Record<string, unknown>,
  expectedColumns: string[]
): Record<string, string> {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  const normalized: Record<string, string> = {};
  for (const column of expectedColumns) {
    normalized[column] = warehouseValueText(lower.get(column.toLowerCase()));
  }
  return normalized;
}

/**
 * Select integer and exact columns as text, so a driver that converts numbers
 * to JavaScript doubles cannot round values above 2^53 or past 15 digits.
 */
function projectColumn(
  column: string,
  family: SeedTypeFamily | undefined,
  dialect: SupportedDialect
): string {
  const quoted = quoteIdentifier(column, dialect);
  if (family !== 'integer' && family !== 'exact') return quoted;
  return `CAST(${quoted} AS ${TEXT_TYPE[getCanonicalDialect(dialect)]}) AS ${quoted}`;
}

const TEXT_TYPE: Record<ReturnType<typeof getCanonicalDialect>, string> = {
  bigquery: 'STRING',
  snowflake: 'VARCHAR',
  postgres: 'TEXT',
  duckdb: 'VARCHAR',
  mysql: 'CHAR',
  databricks: 'STRING',
  clickhouse: 'String',
};

/** Canonical form of a row for keys and comparison (see `seed/compare.ts`). */
function canonicalRow(
  row: Record<string, string>,
  families: Map<string, SeedTypeFamily | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      canonicalSeedValue(value, families.get(column)),
    ])
  );
}

function rowsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
  columns: string[]
): boolean {
  return columns.every((column) => (left[column] ?? '') === (right[column] ?? ''));
}

export async function diffSeeds(cwd: string, opts: DiffSeedsOptions): Promise<DiffSeedsResult> {
  if (opts.dialect == null) {
    throw new CommandError(
      'seed diff requires --dialect. Top-level dialect in model-spec.yml is no longer supported; pass --dialect <dialect> on the command line.',
      2
    );
  }
  const env = resolveSeedEnv(cwd, opts);

  const seeds: SeedDiffResultEntry[] = [];

  for (const [name, parsed] of env.specs) {
    const { csvData, expectedColumns } = readSeedCsv(parsed);
    const schema = parsed.spec.materialization.target_schema ?? env.schema;
    const tableName = buildFqName(schema, parsed.name, env.dialect);
    const families = new Map(
      parsed.spec.schema.columns.map((column) => [
        column.name,
        classifySeedType(column.type)?.family,
      ])
    );
    const columnProjection = expectedColumns
      .map((column) => projectColumn(column, families.get(column), env.dialect))
      .join(', ');
    const warehouseRows = await opts.query(`SELECT ${columnProjection} FROM ${tableName}`);

    const csvRows = csvData.rows.map((row) => {
      const normalized: Record<string, string> = {};
      expectedColumns.forEach((column, index) => {
        normalized[column] = row[index] ?? '';
      });
      return normalized;
    });

    const uniqueColumns = getSeedUniqueColumns(parsed);
    if (uniqueColumns.length === 0) {
      throw new CommandError(
        `Seed ${name} must define unique_columns or primary_key columns for seed diff.`,
        2
      );
    }

    const csvByKey = new Map(
      csvRows.map((row) => [buildSeedKey(canonicalRow(row, families), uniqueColumns), row])
    );
    const warehouseByKey = new Map<string, Record<string, string>>();
    for (const row of warehouseRows) {
      const normalized = normalizeWarehouseRow(row, expectedColumns);
      const key = buildSeedKey(canonicalRow(normalized, families), uniqueColumns);
      if (warehouseByKey.has(key)) {
        throw new CommandError(
          `Seed ${name} warehouse data contains duplicate unique key ${key}.`,
          3
        );
      }
      warehouseByKey.set(key, normalized);
    }

    const adds: SeedDiffEntry[] = [];
    const updates: Array<SeedDiffEntry & { warehouse: Record<string, string> }> = [];
    const deletes: Array<SeedDiffEntry & { warehouse: Record<string, string> }> = [];

    for (const [key, row] of csvByKey) {
      const warehouseRow = warehouseByKey.get(key);
      if (!warehouseRow) {
        adds.push({ key, csv: row });
        continue;
      }
      if (
        !rowsEqual(
          canonicalRow(row, families),
          canonicalRow(warehouseRow, families),
          expectedColumns
        )
      ) {
        updates.push({ key, csv: row, warehouse: warehouseRow });
      }
    }

    for (const [key, row] of warehouseByKey) {
      if (!csvByKey.has(key)) {
        deletes.push({ key, csv: {}, warehouse: row });
      }
    }

    seeds.push({
      name,
      schema,
      uniqueColumns,
      addCount: adds.length,
      updateCount: updates.length,
      deleteCount: deletes.length,
      adds,
      updates,
      deletes,
    });
  }

  const hasDrift = seeds.some((s) => s.addCount + s.updateCount + s.deleteCount > 0);

  return {
    dialect: env.dialect,
    schema: env.schema,
    seeds,
    hasDrift,
  };
}
