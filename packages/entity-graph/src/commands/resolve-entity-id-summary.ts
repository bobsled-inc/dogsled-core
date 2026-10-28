import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { SqlQueryRunner } from '@bobsled-inc/model-spec';
import { loadRunnerModule } from '@bobsled-inc/model-spec/shared';
import { generateEntityIdSummaryQuery } from '../compiler/identity/codegen-entity-id.js';

export interface EntityIdSummaryJson {
  new_ids: number;
  reused_ids: number;
  merged_ids: number;
  split_ids: number;
  reactivated_ids: number;
  alias_count: number;
}

export function normalizeEntityIdSummary(rows: unknown[]): EntityIdSummaryJson | undefined {
  const first = rows[0];
  if (!first || typeof first !== 'object') {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(first).map(([key, value]) => [key.toLowerCase(), value])
  );
  const readCount = (key: keyof EntityIdSummaryJson): number => {
    const value = normalized[key];
    const count = Number(value);
    return Number.isFinite(count) ? count : 0;
  };
  return {
    new_ids: readCount('new_ids'),
    reused_ids: readCount('reused_ids'),
    merged_ids: readCount('merged_ids'),
    split_ids: readCount('split_ids'),
    reactivated_ids: readCount('reactivated_ids'),
    alias_count: readCount('alias_count'),
  };
}

export async function queryEntityIdSummary(
  entity: string,
  runnerPath: string,
  schema: string,
  dialect: SupportedDialect
): Promise<EntityIdSummaryJson | undefined> {
  const runner = await loadRunnerModule(runnerPath);
  if (runner.query == null) {
    return undefined;
  }
  return queryEntityIdSummaryWithRunner(entity, runner.query, schema, dialect);
}

export async function queryEntityIdSummaryWithRunner(
  entity: string,
  query: SqlQueryRunner,
  schema: string,
  dialect: SupportedDialect
): Promise<EntityIdSummaryJson | undefined> {
  const rows = await query(generateEntityIdSummaryQuery(entity, dialect, schema));
  return normalizeEntityIdSummary(rows);
}
