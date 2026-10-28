import {
  formatEntityGraphTableName,
  isEntityGraphWorkspaceReady,
  readEntityGraphSql,
  type EntityGraphTableSuffix,
} from './entity-graph-workspace';
import {
  formatEntityGraphValue,
  getEntityGraphEntityDefinition,
  resolveEntityGraphScenarioEntity,
  type EntityGraphBusinessInsightCard,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from './entity-graph-scenarios';

interface BaseInsightRow {
  profile_count?: unknown;
  cluster_count?: unknown;
  open_review_count?: unknown;
}

interface DefaultCompanyInsightRow extends BaseInsightRow {}

function tableName(
  entityId: EntityGraphEntityId,
  suffix: EntityGraphTableSuffix,
  scenarioId: EntityGraphScenarioId
): string {
  return formatEntityGraphTableName(entityId, suffix, scenarioId);
}

function buildOpenReviewCountSelect(
  entityId: EntityGraphEntityId,
  scenarioId: EntityGraphScenarioId
): string {
  return `(
    WITH latest_decisions AS (
      SELECT pair_id, decision, status
      FROM (
        SELECT
          pair_id,
          decision,
          status,
          ROW_NUMBER() OVER (PARTITION BY pair_id ORDER BY decided_at DESC, applied_at DESC) AS rn
        FROM ${tableName(entityId, '__review_decisions', scenarioId)}
      ) ranked
      WHERE rn = 1
    )
    SELECT COUNT(*)
    FROM ${tableName(entityId, '__review_queue', scenarioId)} rq
    LEFT JOIN latest_decisions ld ON rq.pair_id = ld.pair_id
    WHERE ld.pair_id IS NULL
      OR ld.decision IN ('defer', 'escalate')
      OR ld.status IN ('proposed', 'deferred', 'escalated')
  ) AS open_review_count`;
}

function buildDefaultCompanyInsightsSql(scenarioId: EntityGraphScenarioId): string {
  return `
    SELECT
      (SELECT COUNT(*) FROM ${tableName('company', '__standardized', scenarioId)}) AS profile_count,
      (SELECT COUNT(*) FROM ${tableName('company', '__entity_profile', scenarioId)}) AS cluster_count,
      ${buildOpenReviewCountSelect('company', scenarioId)}
  `;
}

async function readSingleRow<T extends object>(
  sql: string,
  scenarioId: EntityGraphScenarioId
): Promise<T | null> {
  const rows = await readEntityGraphSql<T>(sql, scenarioId);
  return rows[0] ?? null;
}

function buildDefaultCompanyInsights(
  row: DefaultCompanyInsightRow | null
): EntityGraphBusinessInsightCard[] {
  if (!row) return [];
  return [
    {
      label: 'Source profiles',
      value: formatEntityGraphValue(row.profile_count, 'number') ?? '0',
      context: 'Profiles standardized into the company workspace',
    },
    {
      label: 'Mastered companies',
      value: formatEntityGraphValue(row.cluster_count, 'number') ?? '0',
      context: 'Clusters currently materialized in DuckDB',
    },
    {
      label: 'Open review pairs',
      value: formatEntityGraphValue(row.open_review_count, 'number') ?? '0',
      context: 'Pairs still waiting on a human or agent decision',
    },
  ];
}

export async function getEntityGraphInsightCards(
  scenarioValue?: string | null,
  entityValue?: string | null
): Promise<EntityGraphBusinessInsightCard[]> {
  const { scenarioId, entityId } = resolveEntityGraphScenarioEntity(scenarioValue, entityValue);
  return getEntityGraphInsightCardsByIds(scenarioId, entityId);
}

export async function getEntityGraphInsightCardsByIds(
  scenarioId: EntityGraphScenarioId,
  entityId: EntityGraphEntityId
): Promise<EntityGraphBusinessInsightCard[]> {
  if (!isEntityGraphWorkspaceReady(scenarioId)) {
    return [];
  }

  switch (`${scenarioId}:${entityId}`) {
    case 'default:company': {
      const row = await readSingleRow<DefaultCompanyInsightRow>(
        buildDefaultCompanyInsightsSql(scenarioId),
        scenarioId
      );
      return buildDefaultCompanyInsights(row);
    }
  }

  const entity = getEntityGraphEntityDefinition(entityId);
  return [
    {
      label: entity.label,
      value: 'Entity Graph',
      context: entity.description,
    },
  ];
}
