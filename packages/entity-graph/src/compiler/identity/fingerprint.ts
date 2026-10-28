import { createHash } from 'node:crypto';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { generateBlockingSql } from './codegen-blocking.js';
import { generateScoringSql } from './codegen-scoring.js';
import { generateStandardizeSql } from './codegen-standardize.js';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';

function canonicalSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export function fingerprintStatements(statements: readonly SqlStatement[]): string {
  const canonical = statements
    .map((statement) => `${statement.name}:${canonicalSql(statement.sql)}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function computeResolutionRunFingerprint(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  const effectiveSchema = spec.targetSchema ?? targetSchema;
  return fingerprintStatements([
    generateStandardizeSql(spec, dialect, effectiveSchema),
    generateBlockingSql(spec, dialect, effectiveSchema),
    generateScoringSql(spec, dialect, effectiveSchema),
  ]);
}
