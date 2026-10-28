import { buildFqName, quoteIdentifier, type SupportedDialect } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

import {
  requireQuery,
  readField,
  readNumber,
  readString,
  sqlValue,
  type QueryableRunner,
} from '../../api/extract-project-utils.js';
import { outputTableName } from '../../compiler/output-tables/index.js';
import { castToString } from '../../compiler/identity/sql.js';
import { resolveEffectiveProfileConfig } from '../../compiler/identity/profile-config.js';
import type { ResolvedResolutionSpec } from '../../compiler/identity/types.js';
import { assertSafeIdentifier } from '../candidate-retrieval/sql-utils.js';
import { isMissingTableError } from '../sql-errors.js';
import { decodeCursor, encodeCursor, pageLimit } from './cursor.js';

export interface EntityReadContext {
  runner: QueryableRunner;
  schema: string;
  dialect: SupportedDialect;
}

export interface EntityRecord {
  entity_type: string;
  entity_id: string;
  profile: Record<string, unknown>;
  quality: Record<string, unknown>;
  crosswalks: Array<Record<string, unknown>>;
}

export interface ListEntitiesResult {
  entities: EntityRecord[];
  next_cursor?: string;
  has_more: boolean;
  total_count?: number;
}

export interface EntityRelationshipResult {
  relationships: Array<Record<string, unknown>>;
  next_cursor?: string;
  has_more: boolean;
}

export interface EntitySearchConfig {
  profileTableDisplayName: boolean;
  goldenFields: string[];
}

function entityTable(
  context: Pick<EntityReadContext, 'schema' | 'dialect'>,
  entity: string,
  suffix: string
): string {
  assertSafeIdentifier(entity, 'entity');
  return buildFqName(context.schema, outputTableName(entity, suffix), context.dialect);
}

function relationshipTable(context: Pick<EntityReadContext, 'schema' | 'dialect'>): string {
  return buildFqName(context.schema, '__entity_relationship', context.dialect);
}

function entityProfileTable(
  context: Pick<EntityReadContext, 'schema' | 'dialect'>,
  entity: string
): string {
  assertSafeIdentifier(entity, 'entity');
  return buildFqName(context.schema, outputTableName(entity, '__entity_profile'), context.dialect);
}

function rowObject(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function specSearchConfig(spec: ResolvedResolutionSpec): EntitySearchConfig {
  const profile = resolveEffectiveProfileConfig(spec);
  return {
    profileTableDisplayName: profile.displayName != null,
    goldenFields: unique(profile.attributes.map((attribute) => attribute.alias)),
  };
}

function lowerLikePredicate(expression: string, search: string, dialect: SupportedDialect): string {
  return `LOWER(${castToString(expression, dialect)}) LIKE LOWER(${sqlValue(search, dialect)})`;
}

function searchPredicate(
  context: Pick<EntityReadContext, 'schema' | 'dialect'>,
  entity: string,
  config: EntitySearchConfig | undefined,
  search: string
): string | undefined {
  const predicates: string[] = [];
  for (const field of config?.goldenFields ?? []) {
    assertSafeIdentifier(field, 'entity search field');
    predicates.push(
      lowerLikePredicate(`g.${quoteIdentifier(field, context.dialect)}`, search, context.dialect)
    );
  }
  if (config?.profileTableDisplayName) {
    const profileTable = entityProfileTable(context, entity);
    const entityId = quoteIdentifier('entity_id', context.dialect);
    predicates.push(
      [
        `EXISTS (`,
        `  SELECT 1 FROM ${profileTable} ep`,
        `  WHERE ep.${entityId} = g.${entityId}`,
        `    AND ${lowerLikePredicate(
          `ep.${quoteIdentifier('display_name', context.dialect)}`,
          search,
          context.dialect
        )}`,
        `)`,
      ].join('\n')
    );
  }
  return predicates.length > 0 ? `(${predicates.join(' OR ')})` : undefined;
}

async function readCrosswalks(
  context: EntityReadContext,
  entity: string,
  entityId: string
): Promise<Array<Record<string, unknown>>> {
  const query = requireQuery(context.runner, 'entity get');
  const table = entityTable(context, entity, '__crosswalks');
  return (
    await query(
      [
        `SELECT *`,
        `FROM ${table}`,
        `WHERE ${quoteIdentifier('entity_id', context.dialect)} = ${sqlValue(entityId, context.dialect)}`,
        `ORDER BY ${quoteIdentifier('source_ref', context.dialect)}, ${quoteIdentifier('source_entity_id', context.dialect)}`,
      ].join('\n')
    )
  ).map(rowObject);
}

async function readQuality(
  context: EntityReadContext,
  entity: string,
  entityId: string
): Promise<Record<string, unknown>> {
  const query = requireQuery(context.runner, 'entity get');
  const table = entityTable(context, entity, '__entity_quality');
  try {
    const rows = await query(
      [
        `SELECT *`,
        `FROM ${table}`,
        `WHERE ${quoteIdentifier('entity_id', context.dialect)} = ${sqlValue(entityId, context.dialect)}`,
        `LIMIT 1`,
      ].join('\n')
    );
    return rows[0] ? rowObject(rows[0]) : {};
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    return {};
  }
}

export async function getEntity(
  context: EntityReadContext,
  input: { entity: string; entityId: string }
): Promise<EntityRecord | null> {
  const query = requireQuery(context.runner, 'entity get');
  const table = entityTable(context, input.entity, '__golden');
  const rows = await query(
    [
      `SELECT *`,
      `FROM ${table}`,
      `WHERE ${quoteIdentifier('entity_id', context.dialect)} = ${sqlValue(input.entityId, context.dialect)}`,
      `LIMIT 1`,
    ].join('\n')
  );
  const golden = rows[0];
  if (!golden) return null;
  const entityId = readString(golden, 'entity_id') ?? input.entityId;
  return {
    entity_type: input.entity,
    entity_id: entityId,
    profile: rowObject(golden),
    quality: await readQuality(context, input.entity, entityId),
    crosswalks: await readCrosswalks(context, input.entity, entityId),
  };
}

export async function listEntities(
  context: EntityReadContext,
  input: {
    entity: string;
    filters?: Record<string, unknown>;
    query?: string;
    search?: EntitySearchConfig;
    limit?: number;
    cursor?: string;
  }
): Promise<ListEntitiesResult> {
  const query = requireQuery(context.runner, 'entity list');
  const table = entityTable(context, input.entity, '__golden');
  const limit = pageLimit(input.limit);
  const { offset } = decodeCursor(input.cursor);
  const predicates: string[] = [];

  for (const [field, value] of Object.entries(input.filters ?? {})) {
    assertSafeIdentifier(field, 'entity filter field');
    predicates.push(
      `g.${quoteIdentifier(field, context.dialect)} = ${sqlValue(value, context.dialect)}`
    );
  }
  if (input.query && input.query.trim().length > 0) {
    const search = `%${input.query.trim()}%`;
    const predicate = searchPredicate(context, input.entity, input.search, search);
    if (predicate) predicates.push(predicate);
  }

  const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
  const rows = await query(
    [
      `SELECT g.*`,
      `FROM ${table} g`,
      where,
      `ORDER BY g.${quoteIdentifier('entity_id', context.dialect)}`,
      `LIMIT ${limit + 1} OFFSET ${offset}`,
    ]
      .filter((line) => line.length > 0)
      .join('\n')
  );
  const page = rows.slice(0, limit);
  const entities = await Promise.all(
    page.map(async (row) => {
      const entityId = readString(row, 'entity_id');
      if (!entityId) {
        throw new CommandError(`${input.entity}__golden row is missing entity_id.`, 1);
      }
      return {
        entity_type: input.entity,
        entity_id: entityId,
        profile: rowObject(row),
        quality: {
          trust_score: readNumber(row, 'trust_score'),
          trust_band: readField(row, 'trust_band'),
        },
        crosswalks: [],
      };
    })
  );
  let totalCount: number | undefined;
  try {
    const countRows = await query(
      [
        `SELECT COUNT(*) AS ${quoteIdentifier('row_count', context.dialect)}`,
        `FROM ${table} g`,
        where,
      ]
        .filter((line) => line.length > 0)
        .join('\n')
    );
    const count = Number(readField(countRows[0] ?? {}, 'row_count'));
    if (Number.isFinite(count)) totalCount = count;
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    totalCount = undefined;
  }
  const hasMore = rows.length > limit;
  return {
    entities,
    has_more: hasMore,
    ...(hasMore ? { next_cursor: encodeCursor({ offset: offset + limit }) } : {}),
    ...(totalCount !== undefined ? { total_count: totalCount } : {}),
  };
}

export async function getRelationships(
  context: EntityReadContext,
  input: { entity: string; entityId: string; relation?: string; limit?: number; cursor?: string }
): Promise<EntityRelationshipResult> {
  assertSafeIdentifier(input.entity, 'entity');
  const query = requireQuery(context.runner, 'entity relationships');
  const table = relationshipTable(context);
  const limit = pageLimit(input.limit);
  const { offset } = decodeCursor(input.cursor);
  const predicates = [
    `(${quoteIdentifier('left_entity_id', context.dialect)} = ${sqlValue(input.entityId, context.dialect)} OR ${quoteIdentifier('right_entity_id', context.dialect)} = ${sqlValue(input.entityId, context.dialect)})`,
  ];
  if (input.relation) {
    predicates.push(
      `${quoteIdentifier('relation_type', context.dialect)} = ${sqlValue(input.relation, context.dialect)}`
    );
  }
  const rows = await query(
    [
      `SELECT *`,
      `FROM ${table}`,
      `WHERE ${predicates.join(' AND ')}`,
      `ORDER BY ${quoteIdentifier('confidence', context.dialect)} DESC, ${quoteIdentifier('relationship_id', context.dialect)}`,
      `LIMIT ${limit + 1} OFFSET ${offset}`,
    ].join('\n')
  );
  const hasMore = rows.length > limit;
  return {
    relationships: rows.slice(0, limit).map(rowObject),
    has_more: hasMore,
    ...(hasMore ? { next_cursor: encodeCursor({ offset: offset + limit }) } : {}),
  };
}

export async function getRelationshipsForEntities(
  context: EntityReadContext,
  input: {
    entity: string;
    entityIds: readonly string[];
    relation?: string;
    limitPerEntity?: number;
  }
): Promise<Map<string, Array<Record<string, unknown>>>> {
  assertSafeIdentifier(input.entity, 'entity');
  const result = new Map<string, Array<Record<string, unknown>>>(
    input.entityIds.map((entityId) => [entityId, []])
  );
  if (input.entityIds.length === 0) return result;

  const query = requireQuery(context.runner, 'entity relationships');
  const table = relationshipTable(context);
  const limitPerEntity = pageLimit(input.limitPerEntity, 100);
  const entityIds = unique(input.entityIds);
  for (const entityId of entityIds) {
    const leftEntityId = quoteIdentifier('left_entity_id', context.dialect);
    const rightEntityId = quoteIdentifier('right_entity_id', context.dialect);
    const predicates = [
      `(${leftEntityId} = ${sqlValue(entityId, context.dialect)} OR ${rightEntityId} = ${sqlValue(entityId, context.dialect)})`,
    ];
    if (input.relation) {
      predicates.push(
        `${quoteIdentifier('relation_type', context.dialect)} = ${sqlValue(input.relation, context.dialect)}`
      );
    }
    const rows = await query(
      [
        `SELECT *`,
        `FROM ${table}`,
        `WHERE ${predicates.join(' AND ')}`,
        `ORDER BY ${quoteIdentifier('confidence', context.dialect)} DESC, ${quoteIdentifier('relationship_id', context.dialect)}`,
        `LIMIT ${limitPerEntity}`,
      ].join('\n')
    );
    result.set(entityId, rows.map(rowObject));
  }
  return result;
}
