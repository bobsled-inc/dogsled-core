/**
 * Golden record codegen — emits, on every resolve+cluster run:
 *   - `<entity>__golden_record` (EAV: one row per entity × attribute), and
 *   - `<entity>__golden` (wide: one row per entity, named columns).
 *
 * Both are driven by `profile.attributes` + `inputs[]` precedence by default (no
 * survivorship spec required — this is the fix for the empty `__golden_record`
 * bug). A co-located `<entity>_survivorship.yml` refines the per-attribute rules
 * via `goldenRulesFor`. The wide table is a pivot of the EAV plus a per-source id
 * splay (from `__clusters`) and an inline trust score/band, so the two tables can
 * never drift.
 */

import {
  buildFqName,
  createOrReplaceTableAs,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import { outputTableName } from '../output-tables/index.js';
import { resolveEffectiveProfileConfig, resolveStandardizedColumnName } from './profile-config.js';
import { buildGoldenRecordCtes, type GoldenAttributeRule } from './survivorship-ranking.js';
import {
  buildFreshnessScoreExpr,
  buildTrustBandExpr,
  buildTrustScoreExpr,
} from './trust-scoring.js';
import { nullString, nullTimestamp, timestampMinusDays } from './sql.js';

/** Fixed (non-attribute) columns of the wide golden table. */
const RESERVED_GOLDEN_COLUMNS = ['entity_id', 'cluster_size', 'trust_score', 'trust_band'] as const;

/**
 * Short tail of a source ref, used to name `<tail>_id` / `has_<tail>` columns.
 * `revops.salesforce_accounts` → `salesforce_accounts`; sanitized to a SQL
 * identifier so it is safe to quote.
 */
export function sourceTail(ref: string): string {
  const lastDot = ref.lastIndexOf('.');
  const tail = lastDot >= 0 ? ref.slice(lastDot + 1) : ref;
  const sanitized = tail.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

/** Per-source column names derived from a resolution spec's inputs. */
interface SourceColumns {
  ref: string;
  tail: string;
  idColumn: string; // <tail>_id
  hasColumn: string; // has_<tail>
}

/**
 * Derive each input's `<tail>_id` / `has_<tail>` column names, rejecting two
 * inputs whose refs collapse to the same sanitized tail.
 */
function resolveSourceColumns(spec: ResolvedResolutionSpec): SourceColumns[] {
  const byTail = new Map<string, string>();
  return spec.inputs.map((input) => {
    const tail = sourceTail(input.ref);
    const existing = byTail.get(tail);
    if (existing && existing !== input.ref) {
      throw new Error(
        `Golden record: inputs "${existing}" and "${input.ref}" both map to source column prefix "${tail}". Disambiguate the input refs.`
      );
    }
    byTail.set(tail, input.ref);
    return { ref: input.ref, tail, idColumn: `${tail}_id`, hasColumn: `has_${tail}` };
  });
}

/**
 * Synthesize per-attribute survivorship rules from the resolution profile:
 * COALESCE through the `inputs[]` declaration order (gold source first), reading
 * the standardized column, labelled by the profile alias.
 */
export function synthesizeGoldenRules(spec: ResolvedResolutionSpec): GoldenAttributeRule[] {
  const profile = resolveEffectiveProfileConfig(spec);
  const sourceOrder = spec.inputs.map((input) => input.ref);
  return profile.attributes.map((attribute) => ({
    attributeName: attribute.alias,
    sourceColumn: resolveStandardizedColumnName(spec, attribute.field),
    strategy: 'source_priority',
    sourceOrder,
    valuePriority: [],
  }));
}

/** Resolve the golden attribute rules for a spec: refined rules win, else profile defaults. */
export function goldenRulesFor(
  spec: ResolvedResolutionSpec,
  refined?: GoldenAttributeRule[]
): GoldenAttributeRule[] {
  return refined && refined.length > 0 ? refined : synthesizeGoldenRules(spec);
}

/**
 * Reject profile attribute aliases that collide with a reserved golden column, a
 * per-source id/flag column, or another attribute alias.
 */
function assertNoColumnCollisions(rules: GoldenAttributeRule[], sources: SourceColumns[]): void {
  const reserved = new Set<string>([
    ...RESERVED_GOLDEN_COLUMNS,
    ...sources.flatMap((source) => [source.idColumn, source.hasColumn]),
  ]);
  const seen = new Set<string>();
  for (const rule of rules) {
    const alias = rule.attributeName;
    if (reserved.has(alias)) {
      throw new Error(
        `Golden record: profile attribute alias "${alias}" collides with a reserved golden column. Rename the attribute.`
      );
    }
    if (seen.has(alias)) {
      throw new Error(`Golden record: duplicate profile attribute alias "${alias}".`);
    }
    seen.add(alias);
  }
}

/**
 * EAV golden record (`<entity>__golden_record`). Emitted on every resolve+cluster
 * run from the resolved golden rules. With zero attributes the table is created
 * empty (correct schema, no rows) rather than throwing.
 */
export function generateGoldenRecordSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  refinedRules?: GoldenAttributeRule[]
): SqlStatement {
  const entity = spec.entity;
  const goldenRecordTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__golden_record'),
    dialect
  );
  const rules = goldenRulesFor(spec, refinedRules);
  assertNoColumnCollisions(rules, resolveSourceColumns(spec));

  if (rules.length === 0) {
    const clustersTable = buildFqName(targetSchema, outputTableName(entity, '__clusters'), dialect);
    const emptySelect = [
      `SELECT`,
      `  ${nullString(dialect)} AS ${quoteIdentifier('entity_id', dialect)},`,
      `  ${nullString(dialect)} AS ${quoteIdentifier('cluster_id', dialect)},`,
      `  ${nullString(dialect)} AS ${quoteIdentifier('attribute_name', dialect)},`,
      `  ${nullString(dialect)} AS ${quoteIdentifier('attribute_value', dialect)},`,
      `  ${nullString(dialect)} AS ${quoteIdentifier('source_system', dialect)},`,
      `  ${nullTimestamp(dialect)} AS ${quoteIdentifier('updated_at', dialect)}`,
      `FROM ${clustersTable}`,
      `WHERE 1 = 0`,
    ].join('\n');
    return {
      name: 'golden_record',
      sql: [createOrReplaceTableAs(goldenRecordTable, dialect), emptySelect].join('\n'),
      tableCreated: outputTableName(entity, '__golden_record'),
    };
  }

  const compiled = buildGoldenRecordCtes(rules, entity, targetSchema, dialect);
  return {
    name: 'golden_record',
    sql: [
      createOrReplaceTableAs(goldenRecordTable, dialect),
      compiled.ctes,
      compiled.selectSql,
    ].join('\n'),
    tableCreated: outputTableName(entity, '__golden_record'),
  };
}

/**
 * Relation overrides for {@link buildGoldenWideParts}. Incremental review
 * materialization points these at scoped CTEs so only the touched entities are
 * recomputed; the defaults read the full `__clusters` / `__golden_record`
 * tables.
 */
export interface GoldenWideRelations {
  clusters?: string;
  goldenRecord?: string;
}

/** Decomposed wide-golden query: CTE list, final SELECT, and column order. */
export interface GoldenWideParts {
  /** CTE definitions (with internal commas), joinable with `'\n'` after WITH. */
  ctes: string[];
  /** Final `SELECT ... FROM ... JOIN ...` (no WHERE clause). */
  selectSql: string;
  /** Output column names in SELECT order (for INSERT column lists). */
  columnNames: string[];
}

/**
 * Build the CTEs + SELECT that compute the wide golden record — one row per
 * entity_id with pivoted attributes, per-source splay, cluster size, and trust
 * score/band. Shared by the full rebuild ({@link generateGoldenWideSql}) and
 * the entity-scoped incremental refresh (`review-materialize.ts`).
 */
export function buildGoldenWideParts(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  refinedRules?: GoldenAttributeRule[],
  relations?: GoldenWideRelations
): GoldenWideParts {
  const entity = spec.entity;
  const profile = resolveEffectiveProfileConfig(spec);
  const rules = goldenRulesFor(spec, refinedRules);
  const sources = resolveSourceColumns(spec);
  assertNoColumnCollisions(rules, sources);

  const goldenRecordTable =
    relations?.goldenRecord ??
    buildFqName(targetSchema, outputTableName(entity, '__golden_record'), dialect);
  const clustersTable =
    relations?.clusters ??
    buildFqName(targetSchema, outputTableName(entity, '__clusters'), dialect);
  const standardizedTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__standardized'),
    dialect
  );

  const entityId = quoteIdentifier('entity_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourceEntityId = quoteIdentifier('source_entity_id', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);
  const attributeName = quoteIdentifier('attribute_name', dialect);
  const attributeValue = quoteIdentifier('attribute_value', dialect);
  const clusterSize = quoteIdentifier('cluster_size', dialect);
  const standardizedAt = quoteIdentifier('_standardized_at', dialect);

  // entity_agg: cluster size, confidence + diversity inputs, and per-source splay.
  const splaySelections = sources.flatMap((source) => [
    `    MAX(CASE WHEN ${sourceRef} = ${quoteLiteral(source.ref, dialect)} THEN ${sourceEntityId} END) AS ${quoteIdentifier(source.idColumn, dialect)}`,
    `    (MAX(CASE WHEN ${sourceRef} = ${quoteLiteral(source.ref, dialect)} THEN 1 ELSE 0 END) = 1) AS ${quoteIdentifier(source.hasColumn, dialect)}`,
  ]);
  const entityAggColumns = [
    `    ${entityId}`,
    `    COUNT(DISTINCT ${recordId}) AS ${clusterSize}`,
    `    AVG(${confidenceScore}) AS ${quoteIdentifier('avg_confidence', dialect)}`,
    `    COUNT(DISTINCT ${sourceSystem}) AS ${quoteIdentifier('source_count', dialect)}`,
    ...splaySelections,
  ];

  const identityConfidence = quoteIdentifier('identity_confidence', dialect);
  const freshnessScore = quoteIdentifier('freshness_score', dialect);
  const diversityScore = quoteIdentifier('source_diversity_score', dialect);

  const freshnessExpr = buildFreshnessScoreExpr(
    `MAX(s.${standardizedAt})`,
    profile.quality.freshnessWindows,
    dialect,
    timestampMinusDays
  );

  // Attribute pivot from the EAV golden record (only when attributes exist).
  const hasAttrs = rules.length > 0;
  const attrSelections = rules.map(
    (rule) =>
      `    MAX(CASE WHEN ${attributeName} = ${quoteLiteral(rule.attributeName, dialect)} THEN ${attributeValue} END) AS ${quoteIdentifier(rule.attributeName, dialect)}`
  );

  const coverageExpr = hasAttrs
    ? `(${rules
        .map(
          (rule) =>
            `CASE WHEN a.${quoteIdentifier(rule.attributeName, dialect)} IS NOT NULL THEN 1 ELSE 0 END`
        )
        .join(' + ')}) / ${rules.length}.0`
    : `1.0`;

  const trustScoreExpr = buildTrustScoreExpr(profile.quality.trustWeights, {
    identity: `ids.${identityConfidence}`,
    freshness: `fs.${freshnessScore}`,
    diversity: `ds.${diversityScore}`,
    coverage: coverageExpr,
  });
  const trustBandExpr = buildTrustBandExpr(
    profile.quality.trustTierThresholds,
    trustScoreExpr,
    dialect
  );

  const ctes = [
    [
      `entity_agg AS (`,
      `  SELECT`,
      entityAggColumns.join(',\n'),
      `  FROM ${clustersTable}`,
      `  GROUP BY ${entityId}`,
      `),`,
    ].join('\n'),
    [
      `identity_scores AS (`,
      `  SELECT`,
      `    ${entityId},`,
      `    CASE`,
      `      WHEN ${clusterSize} = 1 THEN 1.0`,
      `      WHEN ${clusterSize} <= 3 THEN ${quoteIdentifier('avg_confidence', dialect)}`,
      `      ELSE GREATEST(${quoteIdentifier('avg_confidence', dialect)} - 0.02 * (${clusterSize} - 3), 0.0)`,
      `    END AS ${identityConfidence}`,
      `  FROM entity_agg`,
      `),`,
    ].join('\n'),
    [
      `diversity_scores AS (`,
      `  SELECT`,
      `    ${entityId},`,
      `    LEAST(${quoteIdentifier('source_count', dialect)} / ${profile.quality.sourceDiversityCap}.0, 1.0) AS ${diversityScore}`,
      `  FROM entity_agg`,
      `),`,
    ].join('\n'),
    [
      `freshness_scores AS (`,
      `  SELECT`,
      `    c.${entityId},`,
      `    ${freshnessExpr} AS ${freshnessScore}`,
      `  FROM ${clustersTable} c`,
      `  JOIN ${standardizedTable} s`,
      `    ON c.${recordId} = s.${recordId}`,
      `   AND c.${sourceRef} = s.${sourceRef}`,
      `  GROUP BY c.${entityId}`,
      `)${hasAttrs ? ',' : ''}`,
    ].join('\n'),
    ...(hasAttrs
      ? [
          [
            `attrs AS (`,
            `  SELECT`,
            `    ${entityId},`,
            attrSelections.join(',\n'),
            `  FROM ${goldenRecordTable}`,
            `  GROUP BY ${entityId}`,
            `)`,
          ].join('\n'),
        ]
      : []),
  ];

  const selectColumns = [
    `  ea.${entityId}`,
    ...rules.map((rule) => `  a.${quoteIdentifier(rule.attributeName, dialect)}`),
    ...sources.flatMap((source) => [
      `  ea.${quoteIdentifier(source.idColumn, dialect)}`,
      `  ea.${quoteIdentifier(source.hasColumn, dialect)}`,
    ]),
    `  ea.${clusterSize}`,
    `  ${trustScoreExpr} AS ${quoteIdentifier('trust_score', dialect)}`,
    `  ${trustBandExpr} AS ${quoteIdentifier('trust_band', dialect)}`,
  ];

  const selectSql = [
    `SELECT`,
    selectColumns.join(',\n'),
    `FROM entity_agg ea`,
    `JOIN identity_scores ids ON ea.${entityId} = ids.${entityId}`,
    `JOIN freshness_scores fs ON ea.${entityId} = fs.${entityId}`,
    `JOIN diversity_scores ds ON ea.${entityId} = ds.${entityId}`,
    ...(hasAttrs ? [`LEFT JOIN attrs a ON ea.${entityId} = a.${entityId}`] : []),
  ].join('\n');

  const columnNames = [
    'entity_id',
    ...rules.map((rule) => rule.attributeName),
    ...sources.flatMap((source) => [source.idColumn, source.hasColumn]),
    'cluster_size',
    'trust_score',
    'trust_band',
  ];

  return { ctes, selectSql, columnNames };
}

/**
 * Wide golden record (`<entity>__golden`) — one row per entity_id: the pivoted
 * attribute columns, a per-source id splay + coverage flags, cluster size, and an
 * inline trust score/band. Reads the just-built `__golden_record` (attribute
 * pivot) plus `__clusters` / `__standardized` (splay + trust).
 */
export function generateGoldenWideSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  refinedRules?: GoldenAttributeRule[]
): SqlStatement {
  const entity = spec.entity;
  const goldenTable = buildFqName(targetSchema, outputTableName(entity, '__golden'), dialect);
  const parts = buildGoldenWideParts(spec, dialect, targetSchema, refinedRules);

  const sql = [
    createOrReplaceTableAs(goldenTable, dialect),
    `WITH ${parts.ctes.join('\n')}`,
    parts.selectSql,
  ].join('\n');

  return {
    name: 'golden',
    sql,
    tableCreated: outputTableName(entity, '__golden'),
  };
}
