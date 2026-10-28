import {
  buildFqName,
  createOrReplaceTableAs,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type {
  ResolvedActivationProjection,
  ResolvedResolutionSpec,
  SqlStatement,
} from './types.js';
import { resolveEffectiveProfileConfig, isEntityProfileTopLevelField } from './profile-config.js';
import { outputTableName } from '../output-tables/index.js';
import { jsonExtractString } from './sql.js';

function projectionTableName(entity: string, activation: ResolvedActivationProjection): string {
  return `${entity}__${activation.name}__projection_${activation.version}`;
}

function resolveProjectionFieldExpr(field: string, dialect: SupportedDialect): string {
  if (isEntityProfileTopLevelField(field)) {
    return `ep.${quoteIdentifier(field, dialect)}`;
  }
  return jsonExtractString(`ep.${quoteIdentifier('profile_attrs', dialect)}`, field, dialect);
}

export function generateActivationSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement[] {
  const profile = resolveEffectiveProfileConfig(spec);
  if (profile.activations.length === 0) {
    return [];
  }

  const entityProfileTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__entity_profile'),
    dialect
  );
  const entityQualityTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__entity_quality'),
    dialect
  );
  const crosswalksTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__crosswalks'),
    dialect
  );

  return profile.activations.map((activation) => {
    const targetTableName = projectionTableName(spec.entity, activation);
    const projectionTable = buildFqName(targetSchema, targetTableName, dialect);
    const entityId = quoteIdentifier('entity_id', dialect);
    const clusterId = quoteIdentifier('cluster_id', dialect);
    const selectColumns = [
      `  ep.${entityId}`,
      `  ep.${clusterId}`,
      ...activation.fields.map(
        (field) =>
          `  ${resolveProjectionFieldExpr(field.field, dialect)} AS ${quoteIdentifier(field.target, dialect)}`
      ),
      ...(activation.identityMap
        ? [
            `  id_map.${quoteIdentifier('source_entity_id', dialect)} AS ${quoteIdentifier(
              activation.identityMap.idAlias,
              dialect
            )}`,
          ]
        : []),
      `  eq.${quoteIdentifier('entity_trust_score', dialect)}`,
      `  eq.${quoteIdentifier('trust_tier', dialect)}`,
    ];

    const sql = [
      createOrReplaceTableAs(projectionTable, dialect),
      ...(activation.identityMap
        ? [
            `WITH identity_map_ranked AS (`,
            `  SELECT`,
            `    ${entityId},`,
            `    ${clusterId},`,
            `    ${quoteIdentifier('source_entity_id', dialect)},`,
            `    ROW_NUMBER() OVER (`,
            `      PARTITION BY ${entityId}`,
            `      ORDER BY ${quoteIdentifier('matched_at', dialect)} DESC`,
            `    ) AS ${quoteIdentifier('rn', dialect)}`,
            `  FROM ${crosswalksTable}`,
            `  WHERE ${quoteIdentifier('source_system', dialect)} = ${quoteLiteral(
              activation.identityMap.sourceSystem,
              dialect
            )}`,
            `),`,
            `identity_map AS (`,
            `  SELECT ${entityId}, ${clusterId}, ${quoteIdentifier('source_entity_id', dialect)}`,
            `  FROM identity_map_ranked`,
            `  WHERE ${quoteIdentifier('rn', dialect)} = 1`,
            `)`,
          ]
        : []),
      `SELECT`,
      ...selectColumns.map((column, index) =>
        index === selectColumns.length - 1 ? column : `${column},`
      ),
      `FROM ${entityProfileTable} ep`,
      `JOIN ${entityQualityTable} eq ON ep.${entityId} = eq.${entityId}`,
      ...(activation.identityMap
        ? [`LEFT JOIN identity_map id_map ON ep.${entityId} = id_map.${entityId}`]
        : []),
      `WHERE eq.${quoteIdentifier('entity_trust_score', dialect)} >= ${activation.trustGate}`,
    ].join('\n');

    return {
      name: `activation_${activation.name}_${activation.version}`,
      sql,
      tableCreated: targetTableName,
    };
  });
}
