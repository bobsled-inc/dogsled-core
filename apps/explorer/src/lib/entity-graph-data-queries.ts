import {
  getEntityGraphScenarioDefinition,
  resolveEntityGraphScenarioEntity,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from './entity-graph-scenarios';

export interface EntityGraphDataQuickQuery {
  label: string;
  sql: string;
}

export function buildEntityGraphDataQuickQueries(
  scenarioId: EntityGraphScenarioId,
  entityId?: EntityGraphEntityId
): EntityGraphDataQuickQuery[] {
  const { scenario, entityId: resolvedEntityId } = resolveEntityGraphScenarioEntity(
    scenarioId,
    entityId ?? null
  );
  const entity = resolvedEntityId;
  const tablePrefix = `${scenario.schema}.${entity}`;

  return [
    {
      label: 'Entity profiles',
      sql: `SELECT * FROM ${tablePrefix}__entity_profile LIMIT 100`,
    },
    {
      label: 'Review queue',
      sql: `SELECT * FROM ${tablePrefix}__review_queue LIMIT 100`,
    },
    {
      label: 'Clusters',
      sql: `SELECT * FROM ${tablePrefix}__clusters LIMIT 100`,
    },
  ];
}

export function isEntityGraphDataQuickQuery(
  sql: string,
  scenarioId: EntityGraphScenarioId,
  entityId?: EntityGraphEntityId
): boolean {
  const normalizedSql = normalizeEntityGraphDataQuerySql(sql, scenarioId, entityId);
  return buildEntityGraphDataQuickQueries(scenarioId, entityId).some(
    (query) => normalizeEntityGraphDataQuerySql(query.sql, scenarioId, entityId) === normalizedSql
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceTableIdentifier(sql: string, from: string, to: string): string {
  return sql.replace(new RegExp(`(?<![\\w"])${escapeRegExp(from)}(?![\\w"])`, 'g'), to);
}

export function normalizeEntityGraphDataQuerySql(
  sql: string,
  scenarioId: EntityGraphScenarioId,
  entityId?: EntityGraphEntityId
): string {
  const scenario = getEntityGraphScenarioDefinition(scenarioId);
  const entities =
    entityId === undefined
      ? scenario.supportedEntities
      : [resolveEntityGraphScenarioEntity(scenarioId, entityId).entityId];
  let normalized = sql;

  for (const entity of entities) {
    normalized = replaceTableIdentifier(
      normalized,
      `${scenario.schema}.${entity}__entity_profiles`,
      `${scenario.schema}.${entity}__entity_profile`
    );
    normalized = replaceTableIdentifier(
      normalized,
      `"${scenario.schema}"."${entity}__entity_profiles"`,
      `"${scenario.schema}"."${entity}__entity_profile"`
    );
  }

  return normalized;
}
