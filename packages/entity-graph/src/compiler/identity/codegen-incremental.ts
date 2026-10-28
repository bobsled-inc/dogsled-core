import { buildFqName, quoteIdentifier } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { outputTableName } from '../output-tables/index.js';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';

function deletePairSurfaceForDeltaSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  suffix: '__review_queue' | '__pair_scores' | '__candidate_pairs'
): SqlStatement {
  const table = buildFqName(targetSchema, outputTableName(spec.entity, suffix), dialect);
  const delta = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__standardized_delta'),
    dialect
  );
  const recordId = quoteIdentifier('record_id', dialect);
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  return {
    name: `delete_delta_${suffix.replace(/^__/, '')}`,
    sql: [
      `DELETE FROM ${table}`,
      `WHERE ${recordAId} IN (SELECT ${recordId} FROM ${delta})`,
      `   OR ${recordBId} IN (SELECT ${recordId} FROM ${delta})`,
    ].join('\n'),
    tableCreated: outputTableName(spec.entity, suffix),
  };
}

export function generateIncrementalDerivedPurgeSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement[] {
  return [
    deletePairSurfaceForDeltaSql(spec, dialect, targetSchema, '__review_queue'),
    deletePairSurfaceForDeltaSql(spec, dialect, targetSchema, '__pair_scores'),
    deletePairSurfaceForDeltaSql(spec, dialect, targetSchema, '__candidate_pairs'),
  ];
}
