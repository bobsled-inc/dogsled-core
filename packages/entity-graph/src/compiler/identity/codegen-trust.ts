import {
  buildFqName,
  createOrReplaceTableAs,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import { outputTableName } from '../output-tables/index.js';
import { resolveEffectiveProfileConfig } from './profile-config.js';
import { jsonExtractString, timestampMinusDays } from './sql.js';
import {
  buildFreshnessScoreExpr,
  buildTrustBandExpr,
  buildTrustScoreExpr,
} from './trust-scoring.js';

export function generateTrustScoringSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const profile = resolveEffectiveProfileConfig(spec);
  const qualityTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_quality'),
    dialect
  );
  const profileTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_profile'),
    dialect
  );
  const clustersTable = buildFqName(targetSchema, outputTableName(entity, '__clusters'), dialect);
  const crosswalksTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__crosswalks'),
    dialect
  );
  const standardizedTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__standardized'),
    dialect
  );

  const entityId = quoteIdentifier('entity_id', dialect);
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);
  const profileAttrs = quoteIdentifier('profile_attrs', dialect);
  const displayName = quoteIdentifier('display_name', dialect);

  const expectedFieldCount = profile.attributes.length + (profile.displayName ? 1 : 0);
  const populatedExpressions = [
    ...(profile.displayName ? [`CASE WHEN ep.${displayName} IS NOT NULL THEN 1 ELSE 0 END`] : []),
    ...profile.attributes.map(
      (attribute) =>
        `CASE WHEN ${jsonExtractString(`ep.${profileAttrs}`, attribute.alias, dialect)} IS NOT NULL THEN 1 ELSE 0 END`
    ),
  ];
  const coverageExpr =
    expectedFieldCount === 0
      ? `1.0`
      : `(${populatedExpressions.join(' + ')}) / ${expectedFieldCount}.0`;
  const freshnessExpr = buildFreshnessScoreExpr(
    `MAX(s.${quoteIdentifier('_standardized_at', dialect)})`,
    profile.quality.freshnessWindows,
    dialect,
    timestampMinusDays
  );
  const trustExpr = buildTrustScoreExpr(profile.quality.trustWeights, {
    identity: `ids.${quoteIdentifier('identity_confidence', dialect)}`,
    freshness: `fs.${quoteIdentifier('freshness_score', dialect)}`,
    diversity: `ds.${quoteIdentifier('source_diversity_score', dialect)}`,
    coverage: `cs.${quoteIdentifier('profile_attribute_coverage', dialect)}`,
  });
  const trustTierExpr = buildTrustBandExpr(profile.quality.trustTierThresholds, trustExpr, dialect);

  const sql = [
    createOrReplaceTableAs(qualityTable, dialect),
    `WITH cluster_summary AS (`,
    `  SELECT`,
    `    ${entityId},`,
    `    ${clusterId},`,
    `    AVG(${confidenceScore}) AS ${quoteIdentifier('avg_confidence', dialect)},`,
    `    COUNT(*) AS ${quoteIdentifier('cluster_size', dialect)}`,
    `  FROM ${clustersTable}`,
    `  GROUP BY ${entityId}, ${clusterId}`,
    `),`,
    `identity_scores AS (`,
    `  SELECT`,
    `    ${entityId},`,
    `    ${clusterId},`,
    `    CASE`,
    `      WHEN ${quoteIdentifier('cluster_size', dialect)} = 1 THEN 1.0`,
    `      WHEN ${quoteIdentifier('cluster_size', dialect)} <= 3 THEN ${quoteIdentifier('avg_confidence', dialect)}`,
    `      ELSE GREATEST(${quoteIdentifier('avg_confidence', dialect)} - 0.02 * (${quoteIdentifier('cluster_size', dialect)} - 3), 0.0)`,
    `    END AS ${quoteIdentifier('identity_confidence', dialect)}`,
    `  FROM cluster_summary`,
    `),`,
    `freshness_scores AS (`,
    `  SELECT`,
    `    cw.${entityId},`,
    `    cw.${clusterId},`,
    `    ${freshnessExpr} AS ${quoteIdentifier('freshness_score', dialect)}`,
    `  FROM ${crosswalksTable} cw`,
    `  JOIN ${standardizedTable} s`,
    `    ON cw.${recordId} = s.${recordId}`,
    `   AND cw.${sourceRef} = s.${sourceRef}`,
    `  GROUP BY cw.${entityId}, cw.${clusterId}`,
    `),`,
    `diversity_scores AS (`,
    `  SELECT`,
    `    ${entityId},`,
    `    ${clusterId},`,
    `    LEAST(COUNT(DISTINCT ${sourceSystem}) / ${profile.quality.sourceDiversityCap}.0, 1.0) AS ${quoteIdentifier('source_diversity_score', dialect)}`,
    `  FROM ${crosswalksTable}`,
    `  GROUP BY ${entityId}, ${clusterId}`,
    `),`,
    `coverage_scores AS (`,
    `  SELECT`,
    `    ep.${entityId},`,
    `    ep.${clusterId},`,
    `    ${coverageExpr} AS ${quoteIdentifier('profile_attribute_coverage', dialect)}`,
    `  FROM ${profileTable} ep`,
    `)`,
    `SELECT`,
    `  ${quoteLiteral(entity, dialect)} AS ${quoteIdentifier('entity_type', dialect)},`,
    `  ep.${entityId},`,
    `  ep.${clusterId},`,
    `  ids.${quoteIdentifier('identity_confidence', dialect)},`,
    `  fs.${quoteIdentifier('freshness_score', dialect)},`,
    `  ds.${quoteIdentifier('source_diversity_score', dialect)},`,
    `  cs.${quoteIdentifier('profile_attribute_coverage', dialect)},`,
    `  ${trustExpr} AS ${quoteIdentifier('entity_trust_score', dialect)},`,
    `  ${trustTierExpr} AS ${quoteIdentifier('trust_tier', dialect)},`,
    `  CURRENT_TIMESTAMP AS ${quoteIdentifier('scored_at', dialect)}`,
    `FROM ${profileTable} ep`,
    `JOIN identity_scores ids ON ep.${entityId} = ids.${entityId}`,
    `JOIN freshness_scores fs ON ep.${entityId} = fs.${entityId}`,
    `JOIN diversity_scores ds ON ep.${entityId} = ds.${entityId}`,
    `JOIN coverage_scores cs ON ep.${entityId} = cs.${entityId}`,
  ].join('\n');

  return {
    name: 'entity_quality',
    sql,
    tableCreated: outputTableName(entity, '__entity_quality'),
  };
}
