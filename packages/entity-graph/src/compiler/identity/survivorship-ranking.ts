/**
 * Shared per-attribute survivorship ranking + chosen-value CTE builders.
 *
 * These produce the "one chosen value per entity per attribute" CTEs that drive
 * the EAV golden record (`<entity>__golden_record`). They are consumed by:
 *   - `codegen-golden.ts` — emits `__golden_record` (and pivots it into the wide
 *     `__golden`) on every resolve+cluster run, driven by `profile.attributes`; and
 *   - `survivorship/codegen.ts` — refines the same per-attribute choice with rich
 *     `attribute_rules` when a `<entity>_survivorship.yml` is co-located.
 *
 * The rule carries BOTH the standardized source column to read (`sourceColumn`)
 * and the attribute label to emit (`attributeName`); profile-synthesized rules
 * read `standardized_<field>` but label by the profile alias.
 */

import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { outputTableName } from '../output-tables/index.js';
import { castToString } from './sql.js';

export type SurvivorshipStrategy =
  | 'source_priority'
  | 'recency'
  | 'most_common'
  | 'most_complete'
  | 'value_priority'
  | 'pinned_value';

export interface GoldenAttributeRule {
  /** Attribute label emitted as `attribute_name` (EAV) / column alias (wide). */
  attributeName: string;
  /** Standardized column read from `__standardized` (e.g. `standardized_domain`). */
  sourceColumn: string;
  strategy: SurvivorshipStrategy;
  sourceOrder: string[];
  timestampField?: string;
  fallback?: string;
  valuePriority: string[];
  pinnedValue?: string;
}

/** ORDER BY fragment ranking a candidate by its source's position in `sourceOrder` (earlier wins). */
function buildSourcePriorityOrder(rule: GoldenAttributeRule, dialect: SupportedDialect): string {
  if (rule.sourceOrder.length === 0) {
    return '0';
  }

  const sourceSystem = `s.${quoteIdentifier('_source_system', dialect)}`;
  const cases = rule.sourceOrder
    .map((value, index) => `WHEN ${quoteLiteral(value, dialect)} THEN ${index}`)
    .join(' ');
  return `CASE ${sourceSystem} ${cases} ELSE ${rule.sourceOrder.length} END`;
}

/** ORDER BY fragment ranking a candidate value by its position in the rule's `valuePriority` list. */
function buildValuePriorityOrder(
  valueExpr: string,
  rule: GoldenAttributeRule,
  dialect: SupportedDialect
): string {
  if (rule.valuePriority.length === 0) {
    return '0';
  }

  const cases = rule.valuePriority
    .map((value, index) => `WHEN ${quoteLiteral(value, dialect)} THEN ${index}`)
    .join(' ');
  return `CASE ${valueExpr} ${cases} ELSE ${rule.valuePriority.length} END`;
}

/**
 * Full `ORDER BY` expression that picks the surviving value for one attribute,
 * per the rule's strategy (source_priority / recency / most_common / …); NULLs
 * always rank last, with `record_id` as the final deterministic tiebreaker.
 */
export function buildRankingExpression(
  rule: GoldenAttributeRule,
  valueExpr: string,
  dialect: SupportedDialect
): string {
  const sourcePriority = buildSourcePriorityOrder(rule, dialect);
  const recordId = `s.${quoteIdentifier('record_id', dialect)}`;
  const parts = [`CASE WHEN ${valueExpr} IS NULL THEN 1 ELSE 0 END`];

  switch (rule.strategy) {
    case 'source_priority':
      parts.push(sourcePriority);
      parts.push(`LENGTH(COALESCE(${valueExpr}, ${quoteLiteral('', dialect)})) DESC`);
      break;
    case 'recency':
      // `timestamp_field` is required for recency in the survivorship schema, and
      // profile-synthesized rules never use recency — so this guard normally
      // holds. If a hand-built rule omits it, ranking degrades to source priority
      // rather than erroring.
      if (rule.timestampField) {
        const timestampExpr = `s.${quoteIdentifier(rule.timestampField, dialect)}`;
        parts.push(`CASE WHEN ${timestampExpr} IS NULL THEN 1 ELSE 0 END`);
        parts.push(`${timestampExpr} DESC`);
      }
      parts.push(sourcePriority);
      break;
    case 'most_common':
      parts.push(
        `COUNT(*) OVER (PARTITION BY c.${quoteIdentifier('cluster_id', dialect)}, ${valueExpr}) DESC`
      );
      parts.push(sourcePriority);
      break;
    case 'most_complete':
      parts.push(`LENGTH(COALESCE(${valueExpr}, ${quoteLiteral('', dialect)})) DESC`);
      parts.push(sourcePriority);
      break;
    case 'value_priority':
      parts.push(buildValuePriorityOrder(valueExpr, rule, dialect));
      parts.push(sourcePriority);
      break;
    case 'pinned_value':
      return '0';
    default: {
      const exhaustive: never = rule.strategy;
      throw new Error(`Unhandled survivorship strategy: ${exhaustive}`);
    }
  }

  parts.push(`${recordId} ASC`);
  return parts.join(', ');
}

/**
 * Candidate + chosen CTEs that select exactly one surviving value per entity for
 * a single attribute rule (plus an optional fallback row when nothing survives).
 *
 * `clustersRelation` overrides the `__clusters` read (e.g. with a scoped CTE
 * name) so incremental review materialization can recompute survivorship for
 * only the touched entities; the default reads the full table.
 */
export function buildChosenRuleCtes(
  entity: string,
  targetSchema: string,
  rule: GoldenAttributeRule,
  index: number,
  dialect: SupportedDialect,
  clustersRelation?: string
): string[] {
  const clustersTable =
    clustersRelation ?? buildFqName(targetSchema, outputTableName(entity, '__clusters'), dialect);
  const standardizedTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__standardized'),
    dialect
  );
  const entityId = quoteIdentifier('entity_id', dialect);
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const attributeExpr = castToString(`s.${quoteIdentifier(rule.sourceColumn, dialect)}`, dialect);
  const sourceSystem = `s.${quoteIdentifier('_source_system', dialect)}`;
  const candidatesName = `rule_${index}_candidates`;
  const chosenName = `rule_${index}_chosen`;

  if (rule.strategy === 'pinned_value') {
    return [
      [
        `${chosenName} AS (`,
        `  SELECT DISTINCT`,
        `    c.${entityId},`,
        `    c.${clusterId},`,
        `    ${quoteLiteral(rule.attributeName, dialect)} AS ${quoteIdentifier('attribute_name', dialect)},`,
        `    ${quoteLiteral(rule.pinnedValue ?? rule.fallback ?? '', dialect)} AS ${quoteIdentifier('attribute_value', dialect)},`,
        `    NULL AS ${quoteIdentifier('source_system', dialect)},`,
        `    ${quoteLiteral(rule.strategy, dialect)} AS ${quoteIdentifier('strategy', dialect)}`,
        `  FROM ${clustersTable} c`,
        `)`,
      ].join('\n'),
    ];
  }

  const ranking = buildRankingExpression(rule, attributeExpr, dialect);
  const fallbackBranch = rule.fallback
    ? [
        `  UNION ALL`,
        `  SELECT`,
        `    clusters.${entityId},`,
        `    clusters.${clusterId},`,
        `    ${quoteLiteral(rule.attributeName, dialect)} AS ${quoteIdentifier('attribute_name', dialect)},`,
        `    ${quoteLiteral(rule.fallback, dialect)} AS ${quoteIdentifier('attribute_value', dialect)},`,
        `    NULL AS ${quoteIdentifier('source_system', dialect)},`,
        `    ${quoteLiteral(`${rule.strategy}:fallback`, dialect)} AS ${quoteIdentifier('strategy', dialect)}`,
        `  FROM (SELECT DISTINCT ${entityId}, ${clusterId} FROM ${clustersTable}) clusters`,
        `  WHERE NOT EXISTS (`,
        `    SELECT 1 FROM ${candidatesName} ranked WHERE ranked.${entityId} = clusters.${entityId} AND ranked.${clusterId} = clusters.${clusterId} AND ranked.${quoteIdentifier('rn', dialect)} = 1`,
        `  )`,
      ]
    : [];

  return [
    [
      `${candidatesName} AS (`,
      `  SELECT`,
      `    c.${entityId},`,
      `    c.${clusterId},`,
      `    ${quoteLiteral(rule.attributeName, dialect)} AS ${quoteIdentifier('attribute_name', dialect)},`,
      `    ${attributeExpr} AS ${quoteIdentifier('attribute_value', dialect)},`,
      `    ${sourceSystem} AS ${quoteIdentifier('source_system', dialect)},`,
      `    ${quoteLiteral(rule.strategy, dialect)} AS ${quoteIdentifier('strategy', dialect)},`,
      `    ROW_NUMBER() OVER (`,
      `      PARTITION BY c.${clusterId}`,
      `      ORDER BY ${ranking}`,
      `    ) AS ${quoteIdentifier('rn', dialect)}`,
      `  FROM ${clustersTable} c`,
      `  JOIN ${standardizedTable} s`,
      `    ON c.${quoteIdentifier('record_id', dialect)} = s.${quoteIdentifier('record_id', dialect)}`,
      `  WHERE ${attributeExpr} IS NOT NULL`,
      `)`,
    ].join('\n'),
    [
      `${chosenName} AS (`,
      `  SELECT`,
      `    ${entityId},`,
      `    ${clusterId},`,
      `    ${quoteIdentifier('attribute_name', dialect)},`,
      `    ${quoteIdentifier('attribute_value', dialect)},`,
      `    ${quoteIdentifier('source_system', dialect)},`,
      `    ${quoteIdentifier('strategy', dialect)}`,
      `  FROM ${candidatesName}`,
      `  WHERE ${quoteIdentifier('rn', dialect)} = 1`,
      ...fallbackBranch,
      `)`,
    ].join('\n'),
  ];
}

/**
 * Full WITH clause + SELECT that materializes the EAV golden record from a set
 * of resolved attribute rules. Callers prepend `createOrReplaceTableAs(...)`.
 */
export function buildGoldenRecordCtes(
  rules: GoldenAttributeRule[],
  entity: string,
  targetSchema: string,
  dialect: SupportedDialect
): { ctes: string; selectSql: string } {
  const ctes = rules.flatMap((rule, index) =>
    buildChosenRuleCtes(entity, targetSchema, rule, index, dialect)
  );
  const unions = rules
    .map((_rule, index) => `SELECT * FROM rule_${index}_chosen`)
    .join('\nUNION ALL\n');

  return {
    ctes: [`WITH`, ctes.join(',\n'), `, new_golden_record AS (`, unions, `)`].join('\n'),
    selectSql: [
      `SELECT`,
      `  ${quoteIdentifier('entity_id', dialect)},`,
      `  ${quoteIdentifier('cluster_id', dialect)},`,
      `  ${quoteIdentifier('attribute_name', dialect)},`,
      `  ${quoteIdentifier('attribute_value', dialect)},`,
      `  ${quoteIdentifier('source_system', dialect)},`,
      `  CURRENT_TIMESTAMP AS ${quoteIdentifier('updated_at', dialect)}`,
      `FROM new_golden_record`,
    ].join('\n'),
  };
}
