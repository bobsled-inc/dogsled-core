import type {
  EntityFindRequest,
  EntityFindResult,
  DogsledEntityExecutor,
} from '../generated/dogsled-sdk/index.js';

interface ExampleRow {
  readonly [column: string]: unknown;
}

interface ExampleFilter {
  readonly [key: string]: unknown;
}

export interface QueryRunner {
  query(sql: string, params?: unknown[]): Promise<ExampleRow[]>;
}

const FILTER_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_LIMIT = 500;

function assertFilterKey(key: string): string {
  if (!FILTER_KEY_PATTERN.test(key)) {
    throw new Error(`Unsafe entity filter key: ${key}`);
  }
  return key;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`Entity find limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return limit;
}

function buildWhere(filter: ExampleFilter): { sql: string; params: unknown[] } {
  const entries = Object.entries(filter).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return { sql: '', params: [] };
  return {
    sql: entries.map(([key]) => `${assertFilterKey(key)} = ?`).join(' AND '),
    params: entries.map(([, value]) => value),
  };
}

function mapProfile(row: ExampleRow): ExampleRow {
  return {
    ...row,
    _quality: {
      confidence: Number(row['confidence'] ?? 1),
      freshness_age_seconds: Number(row['freshness_age_seconds'] ?? 0),
      source_diversity: Number(row['source_diversity'] ?? 1),
      profile_coverage: Number(row['profile_coverage'] ?? 1),
    },
  };
}

export function createExampleExecutor(runner: QueryRunner): DogsledEntityExecutor {
  return {
    async find<TProfile, TFilter extends object, TDocument = unknown>(
      request: EntityFindRequest<TFilter>
    ): Promise<Array<EntityFindResult<TProfile, TDocument>>> {
      const filter = buildWhere(request.filter as ExampleFilter);
      const limit = normalizeLimit(request.limit);
      const limitSql = limit === undefined ? '' : ' LIMIT ?';
      const where = filter.sql ? `AND ${filter.sql}` : '';
      const rows = await runner.query(
        `SELECT * FROM entity_graph.__entity_profile WHERE entity_type = ? ${where}${limitSql}`,
        limit === undefined
          ? [request.entity, ...filter.params]
          : [request.entity, ...filter.params, limit]
      );
      return rows.map((row) => ({
        profile: mapProfile(row) as TProfile,
        documents: [] as TDocument[],
        relationships: Object.fromEntries(request.includes.relationships.map((name) => [name, []])),
      }));
    },
  };
}
