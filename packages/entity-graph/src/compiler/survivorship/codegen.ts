import { buildFqName, quoteIdentifier } from '@bobsled-inc/model-spec';
import { generateMaterializeDdl } from '../identity/materializer.js';
import { outputTableName } from '../output-tables/index.js';
import {
  buildGoldenRecordCtes,
  type GoldenAttributeRule,
} from '../identity/survivorship-ranking.js';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { SqlStatement } from '../identity/types.js';
import type {
  ResolvedSurvivorshipAttributeRule,
  ResolvedSurvivorshipSpec,
  SurvivorshipCompileResult,
} from './types.js';

/**
 * A survivorship spec's `attribute_rules` read the raw passthrough field from
 * `__standardized` and label the EAV row by that same field name (historical
 * behavior). Profile-synthesized golden rules differ — see `codegen-golden.ts`.
 */
export function toGoldenAttributeRule(
  rule: ResolvedSurvivorshipAttributeRule
): GoldenAttributeRule {
  return {
    attributeName: rule.attribute,
    sourceColumn: rule.attribute,
    strategy: rule.strategy,
    sourceOrder: rule.sourceOrder,
    timestampField: rule.timestampField,
    fallback: rule.fallback,
    valuePriority: rule.valuePriority,
    pinnedValue: rule.pinnedValue,
  };
}

/**
 * Compile a survivorship spec to the per-attribute decision audit
 * (`<entity>__survivorship_audit`).
 *
 * The wide `<entity>__golden` and the EAV `<entity>__golden_record` are emitted
 * by the cluster phase (`codegen-golden.ts`); when a survivorship spec is
 * present its `attribute_rules` are threaded into that builder so both golden
 * tables reflect the refined per-attribute strategy. This compiler now only
 * emits the survivorship audit trail (chosen value + source + strategy per
 * attribute). The legacy `__golden_history` table is not emitted (v1).
 */
export function compileSurvivorship(
  spec: ResolvedSurvivorshipSpec,
  dialect: SupportedDialect
): SurvivorshipCompileResult {
  const warnings: string[] = [];
  if (spec.attributeRules.length === 0) {
    throw new Error('Survivorship requires at least one resolved attribute rule');
  }
  if (spec.defaultRecencyMode) {
    warnings.push(
      'No attribute_rules defined; using default recency for standardized fields. Set default_timestamp_field if your sources do not have an updated_at column.'
    );
  }
  const statements: SqlStatement[] = [];
  const appendOnly = generateMaterializeDdl(
    spec.resolutionEntity,
    dialect,
    spec.targetSchema
  ).filter((statement) => statement.name === 'ddl_survivorship_audit');
  statements.push(...appendOnly);

  const auditTable = buildFqName(
    spec.targetSchema,
    outputTableName(spec.resolutionEntity, '__survivorship_audit'),
    dialect
  );
  const compiled = buildGoldenRecordCtes(
    spec.attributeRules.map(toGoldenAttributeRule),
    spec.resolutionEntity,
    spec.targetSchema,
    dialect
  );

  statements.push({
    name: 'survivorship_audit',
    sql: [
      compiled.ctes,
      `INSERT INTO ${auditTable} (`,
      `  ${quoteIdentifier('entity_id', dialect)},`,
      `  ${quoteIdentifier('cluster_id', dialect)},`,
      `  ${quoteIdentifier('attribute_name', dialect)},`,
      `  ${quoteIdentifier('chosen_value', dialect)},`,
      `  ${quoteIdentifier('source_system', dialect)},`,
      `  ${quoteIdentifier('strategy', dialect)},`,
      `  ${quoteIdentifier('decided_at', dialect)}`,
      `)`,
      `SELECT`,
      `  ${quoteIdentifier('entity_id', dialect)},`,
      `  ${quoteIdentifier('cluster_id', dialect)},`,
      `  ${quoteIdentifier('attribute_name', dialect)},`,
      `  ${quoteIdentifier('attribute_value', dialect)} AS ${quoteIdentifier('chosen_value', dialect)},`,
      `  ${quoteIdentifier('source_system', dialect)},`,
      `  ${quoteIdentifier('strategy', dialect)},`,
      `  CURRENT_TIMESTAMP AS ${quoteIdentifier('decided_at', dialect)}`,
      `FROM new_golden_record`,
    ].join('\n'),
  });

  return {
    ok: true,
    name: spec.name,
    entity: spec.resolutionEntity,
    schema: spec.targetSchema,
    statements,
    warnings,
  };
}
