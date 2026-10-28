import {
  buildFqName,
  createOrReplaceTableAs,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import { outputTableName } from '../output-tables/index.js';
import {
  isEntityProfileTopLevelField,
  resolveEffectiveProfileConfig,
  resolveStandardizedColumnName,
} from './profile-config.js';
import { buildJsonObjectExpr } from './sql.js';

function buildSourcePrecedenceExpr(
  sourceExpr: string,
  sourcePrecedence: string[] | undefined,
  dialect: SupportedDialect
): string | null {
  if (!sourcePrecedence || sourcePrecedence.length === 0) {
    return null;
  }

  const cases = sourcePrecedence.map(
    (source, index) => `    WHEN ${sourceExpr} = ${quoteLiteral(source, dialect)} THEN ${index}`
  );
  return [`CASE`, ...cases, `    ELSE ${sourcePrecedence.length}`, `  END`].join('\n');
}

function buildFreshnessAgeSecondsExpr(timestampExpr: string, dialect: SupportedDialect): string {
  switch (dialect) {
    case 'duckdb':
    case 'postgres':
    case 'pgvector':
    case 'redshift':
      return `CAST(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ${timestampExpr})) AS INTEGER)`;
    case 'snowflake':
      return `CAST(EXTRACT(epoch_second FROM CURRENT_TIMESTAMP) - EXTRACT(epoch_second FROM ${timestampExpr}) AS INTEGER)`;
    case 'mysql':
      return `CAST(TIMESTAMPDIFF(SECOND, ${timestampExpr}, CURRENT_TIMESTAMP) AS INTEGER)`;
    case 'bigquery':
      return `TIMESTAMP_DIFF(CURRENT_TIMESTAMP, ${timestampExpr}, SECOND)`;
    case 'databricks':
      return `CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP) - UNIX_TIMESTAMP(${timestampExpr}) AS INTEGER)`;
    case 'clickhouse':
      return `dateDiff('second', ${timestampExpr}, CURRENT_TIMESTAMP)`;
    default: {
      const exhaustive: never = dialect;
      throw new Error(`Unsupported dialect: ${exhaustive}`);
    }
  }
}

export function generateEntityProfileSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const profile = resolveEffectiveProfileConfig(spec);

  for (const attribute of profile.attributes) {
    if (isEntityProfileTopLevelField(attribute.alias)) {
      throw new Error(
        `Profile attribute alias "${attribute.alias}" is reserved and cannot be used as a profile attribute name.`
      );
    }
  }
  const entity = spec.entity;
  const profileTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_profile'),
    dialect
  );
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
  const clustersTable = buildFqName(targetSchema, outputTableName(entity, '__clusters'), dialect);

  const entityId = quoteIdentifier('entity_id', dialect);
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);
  const standardizedAt = quoteIdentifier('_standardized_at', dialect);
  const confidence = quoteIdentifier('confidence', dialect);

  const displayColumn = profile.displayName
    ? resolveStandardizedColumnName(spec, profile.displayName.field)
    : undefined;
  const displayExpr = displayColumn ? `s.${quoteIdentifier(displayColumn, dialect)}` : null;
  const precedenceExpr =
    displayExpr == null
      ? null
      : buildSourcePrecedenceExpr(
          `s.${quoteIdentifier('_source_system', dialect)}`,
          profile.displayName?.sourcePrecedence,
          dialect
        );

  const attributeSelections = profile.attributes.map((attribute) => {
    const sourceColumn = resolveStandardizedColumnName(spec, attribute.field);
    return `MAX(s.${quoteIdentifier(sourceColumn, dialect)}) AS ${quoteIdentifier(attribute.alias, dialect)}`;
  });
  const profileAttrsExpr = buildJsonObjectExpr(
    profile.attributes.map((attribute) => [
      attribute.alias,
      `pb.${quoteIdentifier(attribute.alias, dialect)}`,
    ]),
    dialect
  );

  const ctes: string[] = [];
  if (displayExpr != null) {
    ctes.push(
      [
        `display_name_ranked AS (`,
        `  SELECT`,
        `    cw.${entityId},`,
        `    cw.${clusterId},`,
        `    ${displayExpr} AS ${quoteIdentifier('display_name', dialect)},`,
        `    ROW_NUMBER() OVER (`,
        `      PARTITION BY cw.${entityId}`,
        `      ORDER BY`,
        `        CASE WHEN ${displayExpr} IS NULL THEN 1 ELSE 0 END,`,
        ...(precedenceExpr != null ? [`        ${precedenceExpr},`] : []),
        `        s.${standardizedAt} DESC`,
        `    ) AS ${quoteIdentifier('rn', dialect)}`,
        `  FROM ${crosswalksTable} cw`,
        `  JOIN ${standardizedTable} s`,
        `    ON cw.${recordId} = s.${recordId}`,
        `   AND cw.${sourceRef} = s.${sourceRef}`,
        `),`,
      ].join('\n')
    );
  }

  const expectedProfileFieldCount = profile.attributes.length + (displayExpr == null ? 0 : 1);
  const coverageExpressions = [
    ...(displayExpr == null
      ? []
      : [`CASE WHEN dr.${quoteIdentifier('display_name', dialect)} IS NOT NULL THEN 1 ELSE 0 END`]),
    ...profile.attributes.map(
      (attribute) =>
        `CASE WHEN pb.${quoteIdentifier(attribute.alias, dialect)} IS NOT NULL THEN 1 ELSE 0 END`
    ),
  ];
  const profileCoverageExpr =
    expectedProfileFieldCount === 0
      ? `1.0`
      : `(${coverageExpressions.join(' + ')}) / ${expectedProfileFieldCount}.0`;

  ctes.push(
    [
      (() => {
        const profileBaseColumns = [
          `cw.${entityId}`,
          `cw.${clusterId}`,
          `COUNT(DISTINCT cw.${sourceSystem}) AS ${quoteIdentifier('source_diversity', dialect)}`,
          `MAX(s.${standardizedAt}) AS ${quoteIdentifier('last_seen_at', dialect)}`,
          ...attributeSelections,
        ];

        return [
          `profile_base AS (`,
          `  SELECT`,
          ...profileBaseColumns.map((column, index) =>
            index === profileBaseColumns.length - 1 ? `    ${column}` : `    ${column},`
          ),
          `  FROM ${crosswalksTable} cw`,
          `  JOIN ${standardizedTable} s`,
          `    ON cw.${recordId} = s.${recordId}`,
          `   AND cw.${sourceRef} = s.${sourceRef}`,
          `  GROUP BY cw.${entityId}, cw.${clusterId}`,
          `),`,
        ].join('\n');
      })(),
      `cluster_confidence AS (`,
      `  SELECT`,
      `    ${entityId},`,
      `    ${clusterId},`,
      `    MAX(${quoteIdentifier('confidence_score', dialect)}) AS ${confidence}`,
      `  FROM ${clustersTable}`,
      `  GROUP BY ${entityId}, ${clusterId}`,
      `)`,
    ].join('\n')
  );

  const sql = [
    createOrReplaceTableAs(profileTable, dialect),
    `WITH ${ctes.join('\n')}`,
    `SELECT`,
    `  ${quoteLiteral(entity, dialect)} AS ${quoteIdentifier('entity_type', dialect)},`,
    `  pb.${entityId},`,
    `  pb.${clusterId},`,
    displayExpr != null
      ? `  dr.${quoteIdentifier('display_name', dialect)} AS ${quoteIdentifier('canonical_name', dialect)},`
      : `  NULL AS ${quoteIdentifier('canonical_name', dialect)},`,
    displayExpr != null
      ? `  dr.${quoteIdentifier('display_name', dialect)} AS ${quoteIdentifier('display_name', dialect)},`
      : `  NULL AS ${quoteIdentifier('display_name', dialect)},`,
    `  ${profileAttrsExpr} AS ${quoteIdentifier('profile_attrs', dialect)},`,
    `  cc.${confidence},`,
    `  ${buildFreshnessAgeSecondsExpr(`pb.${quoteIdentifier('last_seen_at', dialect)}`, dialect)} AS ${quoteIdentifier('freshness_age_seconds', dialect)},`,
    `  pb.${quoteIdentifier('source_diversity', dialect)},`,
    `${profileCoverageExpr} AS ${quoteIdentifier('profile_coverage', dialect)},`,
    `  pb.${quoteIdentifier('last_seen_at', dialect)},`,
    `  '__entity_profile_run__' AS ${quoteIdentifier('lineage_run_id', dialect)},`,
    `  1 AS ${quoteIdentifier('version', dialect)},`,
    `FROM profile_base pb`,
    `JOIN cluster_confidence cc ON pb.${entityId} = cc.${entityId}`,
    ...(displayExpr != null
      ? [
          `LEFT JOIN display_name_ranked dr`,
          `  ON pb.${entityId} = dr.${entityId}`,
          ` AND dr.${quoteIdentifier('rn', dialect)} = 1`,
        ]
      : []),
  ].join('\n');

  return {
    name: 'entity_profile',
    sql,
    tableCreated: outputTableName(entity, '__entity_profile'),
  };
}
