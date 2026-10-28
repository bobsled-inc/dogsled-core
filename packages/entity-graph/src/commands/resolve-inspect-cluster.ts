import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type SqlQueryRow,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import { loadRunnerModule, out } from '@bobsled-inc/model-spec/shared';
import { CommandError } from '@bobsled-inc/protocol';
import { AUDIT_LOG_TABLE, ENTITY_GRAPH_SCHEMA } from '../compiler/audit/codegen.js';
import { outputTableName } from '../compiler/output-tables/index.js';
import { buildResolveContext } from './resolve-context.js';
import { normalizeQueryRow, toNullableNumber, toNullableString } from './resolve-query-utils.js';

interface ClusterMemberResult {
  entity_id: string | null;
  component_id: string | null;
  record_id: string | null;
  source_ref: string | null;
  source_system: string | null;
  source_entity_id: string | null;
  confidence_score: number | null;
}

interface ContributingDecisionResult {
  pair_id: string | null;
  record_a_id: string | null;
  record_b_id: string | null;
  source_a: string | null;
  source_b: string | null;
  decision: string | null;
  reviewer: string | null;
  reason: string | null;
  confidence: number | null;
  proposed_decision: string | null;
  proposed_confidence: number | null;
  decided_at: string | null;
  applied_at: string | null;
}

interface GoldenRecordAttribute {
  attribute_name: string | null;
  attribute_value: string | null;
}

interface AuditEventResult {
  event_id: string | null;
  category: string | null;
  subject_type: string | null;
  subject_id: string | null;
  payload: unknown;
  audit_reason: string | null;
  actor: string | null;
  actor_type: string | null;
  occurred_at: string | null;
}

interface SourceSystemDistributionEntry {
  source_system: string;
  count: number;
}

export interface InspectClusterResult {
  found: true;
  entity_id: string | null;
  cluster_id: string | null;
  cluster_size: number;
  source_system_distribution: SourceSystemDistributionEntry[];
  members: ClusterMemberResult[];
  crosswalks: ClusterMemberResult[];
  golden_record: GoldenRecordAttribute[];
  contributing_decisions: ContributingDecisionResult[];
  audit: AuditEventResult[];
}

export interface ResolveInspectClusterOptions {
  dialect?: string;
  schema?: string;
  runner?: string;
  json?: boolean;
  entity: string;
  clusterId?: string;
  entityId?: string;
}

function parseAuditPayload(value: unknown): unknown {
  if (value === null || value === undefined || value === '') {
    return {};
  }
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function selectCanonicalIdentityRow(
  rows: Array<Record<string, unknown>>
): Record<string, unknown> | undefined {
  return (
    rows.find((row) => row.section === 'members') ??
    rows.find((row) => row.section === 'crosswalks') ??
    rows.find((row) => row.section === 'golden_record') ??
    rows[0]
  );
}

export function transformInspectClusterResult(rows: SqlQueryRow[]): InspectClusterResult | null {
  if (rows.length === 0) {
    return null;
  }

  const normalizedRows = rows.map((row) => normalizeQueryRow(row));
  const identityRow = selectCanonicalIdentityRow(normalizedRows);
  const entityId = toNullableString(identityRow?.entity_id);
  const clusterId = toNullableString(identityRow?.cluster_id);
  const members = normalizedRows
    .filter((row) => row.section === 'members')
    .map((row) => ({
      entity_id: toNullableString(row.entity_id),
      component_id: toNullableString(row.component_id),
      record_id: toNullableString(row.record_id),
      source_ref: toNullableString(row.source_ref),
      source_system: toNullableString(row.source_system),
      source_entity_id: toNullableString(row.source_entity_id),
      confidence_score: toNullableNumber(row.confidence_score),
    }));
  const crosswalks = normalizedRows
    .filter((row) => row.section === 'crosswalks')
    .map((row) => ({
      entity_id: toNullableString(row.entity_id),
      component_id: toNullableString(row.component_id),
      record_id: toNullableString(row.record_id),
      source_ref: toNullableString(row.source_ref),
      source_system: toNullableString(row.source_system),
      source_entity_id: toNullableString(row.source_entity_id),
      confidence_score: toNullableNumber(row.confidence_score),
    }));
  const goldenRecord = normalizedRows
    .filter((row) => row.section === 'golden_record')
    .map((row) => ({
      attribute_name: toNullableString(row.attribute_name),
      attribute_value: toNullableString(row.attribute_value),
    }));
  const contributingDecisions = normalizedRows
    .filter((row) => row.section === 'contributing_decisions')
    .map((row) => ({
      pair_id: toNullableString(row.pair_id),
      record_a_id: toNullableString(row.record_a_id),
      record_b_id: toNullableString(row.record_b_id),
      source_a: toNullableString(row.source_a),
      source_b: toNullableString(row.source_b),
      decision: toNullableString(row.decision),
      reviewer: toNullableString(row.reviewer),
      reason: toNullableString(row.reason),
      confidence: toNullableNumber(row.confidence),
      proposed_decision: toNullableString(row.proposed_decision),
      proposed_confidence: toNullableNumber(row.proposed_confidence),
      decided_at: toNullableString(row.decided_at),
      applied_at: toNullableString(row.applied_at),
    }));
  const audit = normalizedRows
    .filter((row) => row.section === 'audit')
    .map((row) => ({
      event_id: toNullableString(row.event_id),
      category: toNullableString(row.category),
      subject_type: toNullableString(row.subject_type),
      subject_id: toNullableString(row.subject_id),
      payload: parseAuditPayload(row.payload),
      audit_reason: toNullableString(row.audit_reason ?? row.reason),
      actor: toNullableString(row.actor),
      actor_type: toNullableString(row.actor_type),
      occurred_at: toNullableString(row.occurred_at),
    }));
  const sourceSystemDistribution = Object.entries(
    members.reduce<Record<string, number>>((distribution, member) => {
      const sourceSystem = member.source_system;
      if (typeof sourceSystem === 'string' && sourceSystem.length > 0) {
        distribution[sourceSystem] = (distribution[sourceSystem] ?? 0) + 1;
      }
      return distribution;
    }, {})
  ).map(([source_system, count]) => ({ source_system, count }));

  return {
    found: true,
    entity_id: entityId,
    cluster_id: clusterId,
    cluster_size: members.length,
    source_system_distribution: sourceSystemDistribution,
    members,
    crosswalks,
    golden_record: goldenRecord,
    contributing_decisions: contributingDecisions,
    audit,
  };
}

function hasCurrentClusterEvidence(result: InspectClusterResult): boolean {
  return (
    result.members.length > 0 || result.crosswalks.length > 0 || result.golden_record.length > 0
  );
}

export function buildResolveInspectClusterQuery(
  entity: string,
  targetSchema: string,
  clusterId: string,
  dialect: SupportedDialect
): string {
  const clustersTable = buildFqName(targetSchema, outputTableName(entity, '__clusters'), dialect);
  const crosswalksTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__crosswalks'),
    dialect
  );
  const scoresTable = buildFqName(targetSchema, outputTableName(entity, '__pair_scores'), dialect);
  const decisionsTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__review_decisions'),
    dialect
  );
  const goldenTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__golden_record'),
    dialect
  );
  const aliasesTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_aliases'),
    dialect
  );
  const auditTable = buildFqName(ENTITY_GRAPH_SCHEMA, AUDIT_LOG_TABLE, dialect);
  const entityIdCol = quoteIdentifier('entity_id', dialect);
  const clusterIdCol = quoteIdentifier('cluster_id', dialect);
  const componentIdCol = quoteIdentifier('component_id', dialect);
  const pairIdCol = quoteIdentifier('pair_id', dialect);
  const decisionCol = quoteIdentifier('decision', dialect);
  const decidedAtCol = quoteIdentifier('decided_at', dialect);
  const appliedAtCol = quoteIdentifier('applied_at', dialect);
  const confidenceCol = quoteIdentifier('confidence', dialect);
  const proposedDecisionCol = quoteIdentifier('proposed_decision', dialect);
  const proposedConfidenceCol = quoteIdentifier('proposed_confidence', dialect);
  const recordIdCol = quoteIdentifier('record_id', dialect);
  const sourceRefCol = quoteIdentifier('source_ref', dialect);
  const sourceSystemCol = quoteIdentifier('source_system', dialect);
  const sourceEntityIdCol = quoteIdentifier('source_entity_id', dialect);
  const confidenceScoreCol = quoteIdentifier('confidence_score', dialect);
  const recordAIdCol = quoteIdentifier('record_a_id', dialect);
  const recordBIdCol = quoteIdentifier('record_b_id', dialect);
  const sectionCol = quoteIdentifier('section', dialect);
  const attributeNameCol = quoteIdentifier('attribute_name', dialect);
  const attributeValueCol = quoteIdentifier('attribute_value', dialect);
  const reviewerCol = quoteIdentifier('reviewer', dialect);
  const reasonCol = quoteIdentifier('reason', dialect);
  const eventIdCol = quoteIdentifier('event_id', dialect);
  const categoryCol = quoteIdentifier('category', dialect);
  const subjectTypeCol = quoteIdentifier('subject_type', dialect);
  const subjectIdCol = quoteIdentifier('subject_id', dialect);
  const payloadCol = quoteIdentifier('payload', dialect);
  const actorCol = quoteIdentifier('actor', dialect);
  const actorTypeCol = quoteIdentifier('actor_type', dialect);
  const occurredAtCol = quoteIdentifier('occurred_at', dialect);
  const auditNulls = [
    `  NULL AS ${eventIdCol},`,
    `  NULL AS ${categoryCol},`,
    `  NULL AS ${subjectTypeCol},`,
    `  NULL AS ${subjectIdCol},`,
    `  NULL AS ${payloadCol},`,
    `  NULL AS ${quoteIdentifier('audit_reason', dialect)},`,
    `  NULL AS ${actorCol},`,
    `  NULL AS ${actorTypeCol},`,
    `  NULL AS ${occurredAtCol}`,
  ];

  return [
    `WITH requested_entity AS (`,
    `  SELECT ${quoteLiteral(clusterId, dialect)} AS ${entityIdCol}`,
    `  UNION ALL`,
    `  SELECT ${entityIdCol}`,
    `  FROM ${aliasesTable}`,
    `  WHERE ${quoteIdentifier('alias_entity_id', dialect)} = ${quoteLiteral(clusterId, dialect)}`,
    `    AND ${quoteIdentifier('superseded_at', dialect)} IS NULL`,
    `),`,
    `cluster_members AS (`,
    `  SELECT * FROM ${clustersTable}`,
    `  WHERE ${entityIdCol} IN (SELECT ${entityIdCol} FROM requested_entity)`,
    `     OR ${clusterIdCol} = ${quoteLiteral(clusterId, dialect)}`,
    `),`,
    `cluster_crosswalks AS (`,
    `  SELECT * FROM ${crosswalksTable}`,
    `  WHERE ${entityIdCol} IN (SELECT ${entityIdCol} FROM requested_entity)`,
    `     OR ${clusterIdCol} = ${quoteLiteral(clusterId, dialect)}`,
    `),`,
    `cluster_golden AS (`,
    `  SELECT * FROM ${goldenTable}`,
    `  WHERE ${entityIdCol} IN (SELECT ${entityIdCol} FROM requested_entity)`,
    `     OR ${clusterIdCol} = ${quoteLiteral(clusterId, dialect)}`,
    `),`,
    `cluster_audit AS (`,
    `  SELECT * FROM ${auditTable}`,
    `  WHERE ${clusterIdCol} IN (SELECT ${entityIdCol} FROM requested_entity)`,
    `     OR ${clusterIdCol} = ${quoteLiteral(clusterId, dialect)}`,
    `     OR (${subjectTypeCol} = ${quoteLiteral('cluster', dialect)} AND ${subjectIdCol} = ${quoteLiteral(clusterId, dialect)})`,
    `),`,
    `cluster_pairs AS (`,
    `  SELECT ps.*`,
    `  FROM ${scoresTable} ps`,
    `  JOIN cluster_members a`,
    `    ON ps.${recordAIdCol} = a.${recordIdCol}`,
    `   AND ps.${quoteIdentifier('source_a', dialect)} = a.${sourceRefCol}`,
    `  JOIN cluster_members b`,
    `    ON ps.${recordBIdCol} = b.${recordIdCol}`,
    `   AND ps.${quoteIdentifier('source_b', dialect)} = b.${sourceRefCol}`,
    `),`,
    `latest_decisions AS (`,
    `  SELECT *`,
    `  FROM (`,
    `    SELECT`,
    `      ${pairIdCol},`,
    `      ${decisionCol},`,
    `      ${reviewerCol},`,
    `      ${reasonCol},`,
    `      ${confidenceCol},`,
    `      ${proposedDecisionCol},`,
    `      ${proposedConfidenceCol},`,
    `      ${decidedAtCol},`,
    `      ${appliedAtCol},`,
    `      ROW_NUMBER() OVER (PARTITION BY ${pairIdCol} ORDER BY ${decidedAtCol} DESC, ${appliedAtCol} DESC) AS ${quoteIdentifier('rn', dialect)}`,
    `    FROM ${decisionsTable}`,
    `  ) ranked`,
    `  WHERE ranked.${quoteIdentifier('rn', dialect)} = 1`,
    `),`,
    `cluster_decisions AS (`,
    `  SELECT`,
    `    cp.${pairIdCol},`,
    `    cp.${recordAIdCol},`,
    `    cp.${recordBIdCol},`,
    `    cp.${quoteIdentifier('source_a', dialect)},`,
    `    cp.${quoteIdentifier('source_b', dialect)},`,
    `    ld.${decisionCol},`,
    `    ld.${reviewerCol},`,
    `    ld.${reasonCol},`,
    `    ld.${confidenceCol},`,
    `    ld.${proposedDecisionCol},`,
    `    ld.${proposedConfidenceCol},`,
    `    ld.${decidedAtCol},`,
    `    ld.${appliedAtCol}`,
    `  FROM cluster_pairs cp`,
    `  JOIN latest_decisions ld ON cp.${pairIdCol} = ld.${pairIdCol}`,
    `)`,
    `SELECT`,
    `  ${quoteLiteral('members', dialect)} AS ${sectionCol},`,
    `  cm.${entityIdCol} AS ${entityIdCol},`,
    `  cm.${clusterIdCol} AS ${quoteIdentifier('cluster_id', dialect)},`,
    `  cm.${componentIdCol} AS ${componentIdCol},`,
    `  cm.${recordIdCol} AS ${recordIdCol},`,
    `  cm.${sourceRefCol} AS ${sourceRefCol},`,
    `  cm.${sourceSystemCol} AS ${sourceSystemCol},`,
    `  cm.${sourceEntityIdCol} AS ${sourceEntityIdCol},`,
    `  cm.${confidenceScoreCol} AS ${confidenceScoreCol},`,
    `  NULL AS ${attributeNameCol},`,
    `  NULL AS ${attributeValueCol},`,
    `  NULL AS ${pairIdCol},`,
    `  NULL AS ${recordAIdCol},`,
    `  NULL AS ${recordBIdCol},`,
    `  NULL AS ${quoteIdentifier('source_a', dialect)},`,
    `  NULL AS ${quoteIdentifier('source_b', dialect)},`,
    `  NULL AS ${decisionCol},`,
    `  NULL AS ${reviewerCol},`,
    `  NULL AS ${reasonCol},`,
    `  NULL AS ${confidenceCol},`,
    `  NULL AS ${proposedDecisionCol},`,
    `  NULL AS ${proposedConfidenceCol},`,
    `  NULL AS ${decidedAtCol},`,
    `  NULL AS ${appliedAtCol},`,
    ...auditNulls,
    `FROM cluster_members cm`,
    `UNION ALL`,
    `SELECT`,
    `  ${quoteLiteral('crosswalks', dialect)} AS ${sectionCol},`,
    `  cw.${entityIdCol} AS ${entityIdCol},`,
    `  cw.${clusterIdCol} AS ${quoteIdentifier('cluster_id', dialect)},`,
    `  cw.${componentIdCol} AS ${componentIdCol},`,
    `  cw.${recordIdCol} AS ${recordIdCol},`,
    `  cw.${sourceRefCol} AS ${sourceRefCol},`,
    `  cw.${sourceSystemCol} AS ${sourceSystemCol},`,
    `  cw.${sourceEntityIdCol} AS ${sourceEntityIdCol},`,
    `  cw.${confidenceScoreCol} AS ${confidenceScoreCol},`,
    `  NULL AS ${attributeNameCol},`,
    `  NULL AS ${attributeValueCol},`,
    `  NULL AS ${pairIdCol},`,
    `  NULL AS ${recordAIdCol},`,
    `  NULL AS ${recordBIdCol},`,
    `  NULL AS ${quoteIdentifier('source_a', dialect)},`,
    `  NULL AS ${quoteIdentifier('source_b', dialect)},`,
    `  NULL AS ${decisionCol},`,
    `  NULL AS ${reviewerCol},`,
    `  NULL AS ${reasonCol},`,
    `  NULL AS ${confidenceCol},`,
    `  NULL AS ${proposedDecisionCol},`,
    `  NULL AS ${proposedConfidenceCol},`,
    `  NULL AS ${decidedAtCol},`,
    `  NULL AS ${appliedAtCol},`,
    ...auditNulls,
    `FROM cluster_crosswalks cw`,
    `UNION ALL`,
    `SELECT`,
    `  ${quoteLiteral('golden_record', dialect)} AS ${sectionCol},`,
    `  gr.${entityIdCol} AS ${entityIdCol},`,
    `  gr.${clusterIdCol} AS ${quoteIdentifier('cluster_id', dialect)},`,
    `  NULL AS ${componentIdCol},`,
    `  NULL AS ${recordIdCol},`,
    `  NULL AS ${sourceRefCol},`,
    `  NULL AS ${sourceSystemCol},`,
    `  NULL AS ${sourceEntityIdCol},`,
    `  NULL AS ${confidenceScoreCol},`,
    `  gr.${attributeNameCol} AS ${attributeNameCol},`,
    `  gr.${attributeValueCol} AS ${attributeValueCol},`,
    `  NULL AS ${pairIdCol},`,
    `  NULL AS ${recordAIdCol},`,
    `  NULL AS ${recordBIdCol},`,
    `  NULL AS ${quoteIdentifier('source_a', dialect)},`,
    `  NULL AS ${quoteIdentifier('source_b', dialect)},`,
    `  NULL AS ${decisionCol},`,
    `  NULL AS ${reviewerCol},`,
    `  NULL AS ${reasonCol},`,
    `  NULL AS ${confidenceCol},`,
    `  NULL AS ${proposedDecisionCol},`,
    `  NULL AS ${proposedConfidenceCol},`,
    `  NULL AS ${decidedAtCol},`,
    `  NULL AS ${appliedAtCol},`,
    ...auditNulls,
    `FROM cluster_golden gr`,
    `UNION ALL`,
    `SELECT`,
    `  ${quoteLiteral('contributing_decisions', dialect)} AS ${sectionCol},`,
    `  ${quoteLiteral(clusterId, dialect)} AS ${entityIdCol},`,
    `  ${quoteLiteral(clusterId, dialect)} AS ${quoteIdentifier('cluster_id', dialect)},`,
    `  NULL AS ${componentIdCol},`,
    `  NULL AS ${recordIdCol},`,
    `  NULL AS ${sourceRefCol},`,
    `  NULL AS ${sourceSystemCol},`,
    `  NULL AS ${sourceEntityIdCol},`,
    `  NULL AS ${confidenceScoreCol},`,
    `  NULL AS ${attributeNameCol},`,
    `  NULL AS ${attributeValueCol},`,
    `  cd.${pairIdCol} AS ${pairIdCol},`,
    `  cd.${recordAIdCol} AS ${recordAIdCol},`,
    `  cd.${recordBIdCol} AS ${recordBIdCol},`,
    `  cd.${quoteIdentifier('source_a', dialect)} AS ${quoteIdentifier('source_a', dialect)},`,
    `  cd.${quoteIdentifier('source_b', dialect)} AS ${quoteIdentifier('source_b', dialect)},`,
    `  cd.${decisionCol} AS ${decisionCol},`,
    `  cd.${reviewerCol} AS ${reviewerCol},`,
    `  cd.${reasonCol} AS ${reasonCol},`,
    `  cd.${confidenceCol} AS ${confidenceCol},`,
    `  cd.${proposedDecisionCol} AS ${proposedDecisionCol},`,
    `  cd.${proposedConfidenceCol} AS ${proposedConfidenceCol},`,
    `  cd.${decidedAtCol} AS ${decidedAtCol},`,
    `  cd.${appliedAtCol} AS ${appliedAtCol},`,
    ...auditNulls,
    `FROM cluster_decisions cd`,
    `UNION ALL`,
    `SELECT`,
    `  ${quoteLiteral('audit', dialect)} AS ${sectionCol},`,
    `  ca.${clusterIdCol} AS ${entityIdCol},`,
    `  ca.${clusterIdCol} AS ${quoteIdentifier('cluster_id', dialect)},`,
    `  NULL AS ${componentIdCol},`,
    `  NULL AS ${recordIdCol},`,
    `  NULL AS ${sourceRefCol},`,
    `  NULL AS ${sourceSystemCol},`,
    `  NULL AS ${sourceEntityIdCol},`,
    `  NULL AS ${confidenceScoreCol},`,
    `  NULL AS ${attributeNameCol},`,
    `  NULL AS ${attributeValueCol},`,
    `  NULL AS ${pairIdCol},`,
    `  NULL AS ${recordAIdCol},`,
    `  NULL AS ${recordBIdCol},`,
    `  NULL AS ${quoteIdentifier('source_a', dialect)},`,
    `  NULL AS ${quoteIdentifier('source_b', dialect)},`,
    `  NULL AS ${decisionCol},`,
    `  NULL AS ${reviewerCol},`,
    `  ca.${reasonCol} AS ${reasonCol},`,
    `  NULL AS ${confidenceCol},`,
    `  NULL AS ${proposedDecisionCol},`,
    `  NULL AS ${proposedConfidenceCol},`,
    `  NULL AS ${decidedAtCol},`,
    `  NULL AS ${appliedAtCol},`,
    `  ca.${eventIdCol} AS ${eventIdCol},`,
    `  ca.${categoryCol} AS ${categoryCol},`,
    `  ca.${subjectTypeCol} AS ${subjectTypeCol},`,
    `  ca.${subjectIdCol} AS ${subjectIdCol},`,
    `  ca.${payloadCol} AS ${payloadCol},`,
    `  ca.${reasonCol} AS ${quoteIdentifier('audit_reason', dialect)},`,
    `  ca.${actorCol} AS ${actorCol},`,
    `  ca.${actorTypeCol} AS ${actorTypeCol},`,
    `  ca.${occurredAtCol} AS ${occurredAtCol}`,
    `FROM cluster_audit ca`,
  ].join('\n');
}

export async function inspectClusterHandler(
  options: ResolveInspectClusterOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  if (options.entityId && options.clusterId && options.entityId !== options.clusterId) {
    throw new CommandError(
      '--entity-id and --cluster-id conflict; provide one or pass matching values.',
      2
    );
  }
  const requestedEntityId = options.entityId ?? options.clusterId;
  if (!requestedEntityId) {
    throw new CommandError('Provide --entity-id or --cluster-id.', 2);
  }
  const { specs, dialect, targetSchema } = buildResolveContext(globalOptions, options, [
    options.entity,
  ]);
  const spec = specs[0];
  if (!spec) {
    throw new CommandError(`No resolution specs found matching: ${options.entity}`);
  }

  const schema = spec.targetSchema ?? targetSchema;
  const query = buildResolveInspectClusterQuery(spec.entity, schema, requestedEntityId, dialect);
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (options.runner && runner?.query == null) {
    throw new CommandError('Runner module does not implement query(sql).', 2);
  }

  if (runner?.query == null) {
    if (options.json) {
      out.json({
        command: 'resolve.inspect.cluster',
        entity: spec.entity,
        entity_id: requestedEntityId,
        cluster_id: requestedEntityId,
        dialect,
        schema,
        executed: false,
        found: null,
        query,
      });
      return;
    }
    out.text(`${query}\n`);
    return;
  }

  const rows = await runner.query(query);
  const transformed = transformInspectClusterResult(rows);
  if (transformed == null || !hasCurrentClusterEvidence(transformed)) {
    if (options.json) {
      out.json({
        command: 'resolve.inspect.cluster',
        entity: spec.entity,
        entity_id: requestedEntityId,
        cluster_id: requestedEntityId,
        dialect,
        schema,
        executed: true,
        found: false,
      });
      return;
    }
    throw new CommandError(`Entity ${requestedEntityId} was not found for ${spec.entity}.`, 2);
  }
  const result = {
    command: 'resolve.inspect.cluster',
    entity: spec.entity,
    dialect,
    schema,
    executed: true,
    ...transformed,
  };
  if (options.json) {
    out.json(result);
  } else {
    out.yaml(result);
  }
}
