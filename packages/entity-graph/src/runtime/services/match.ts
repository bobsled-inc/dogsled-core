import { createHash } from 'node:crypto';

import { buildFqName, quoteIdentifier, type SupportedDialect } from '@bobsled-inc/model-spec';
import { CommandError, type AuditPayload } from '@bobsled-inc/protocol';

import {
  insertRows,
  requireQuery,
  readString,
  sqlValue,
  type QueryableRunner,
} from '../../api/extract-project-utils.js';
import { generateAuditInsertSql, generateAuditLogDdl } from '../../compiler/audit/codegen.js';
import { generateMaterializeDdl } from '../../compiler/identity/materializer.js';
import { outputTableName } from '../../compiler/output-tables/index.js';
import { assertSafeIdentifier } from '../candidate-retrieval/sql-utils.js';
import { isMissingTableError } from '../sql-errors.js';
import { applyStandardizeTransforms, type StandardizedFields } from './standardize.js';

import type {
  DeterministicRule,
  ResolvedInput,
  ResolvedResolutionSpec,
} from '../../compiler/identity/types.js';

export type MatchMode = 'lookup' | 'assign' | 'stage';
export type MatchBand = 'auto_merge' | 'review' | 'miss';

export interface MatchContext {
  runner: QueryableRunner;
  schema: string;
  dialect: SupportedDialect;
  spec: ResolvedResolutionSpec;
}

export interface PreparedMatchRecord {
  source_ref: string;
  source_pk_json: string;
  source_entity_id: string;
  record_id: string;
  idempotency_key: string;
  content_hash: string;
  record: Record<string, unknown>;
  standardized: StandardizedFields;
}

export interface MatchLookupResult {
  entity_id: string;
  matched_rule?: string;
  score?: number;
  band: MatchBand;
  record_id?: string;
}

export interface MatchMutationResult {
  status: 'assigned' | 'already_assigned' | 'pending_review' | 'staged';
  entity_id?: string;
  record_id: string;
  idempotency_key: string;
  band?: MatchBand;
  matched_rule?: string;
}

function hash(kind: 'md5' | 'sha256', value: string): string {
  return createHash(kind).update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function table(context: MatchContext, suffix: string): string {
  assertSafeIdentifier(context.spec.entity, 'entity');
  return buildFqName(context.schema, outputTableName(context.spec.entity, suffix), context.dialect);
}

const auditSurfaceEnsured = new WeakSet<object>();
const matchInboxEnsured = new WeakMap<object, Set<string>>();

function pickInput(spec: ResolvedResolutionSpec, record: Record<string, unknown>): ResolvedInput {
  const explicit = record['source_ref'] ?? record['_source_ref'];
  if (typeof explicit === 'string') {
    const found = spec.inputs.find((input) => input.ref === explicit);
    if (!found) {
      throw new CommandError(`Unknown source_ref '${explicit}' for entity ${spec.entity}.`, 2);
    }
    return found;
  }
  const matching = spec.inputs.find((input) =>
    (input.idFields ?? []).every((field) => record[field] !== undefined)
  );
  if (matching) return matching;
  const fallback = spec.inputs[0];
  if (!fallback) {
    throw new CommandError(`Resolution ${spec.name} must define at least one input for match.`, 2);
  }
  return fallback;
}

function sourcePkJson(idFields: readonly string[], record: Record<string, unknown>): string {
  return `{${idFields
    .map((field) => {
      const value = record[field];
      return `${JSON.stringify(field)}:${value === null || value === undefined ? 'null' : JSON.stringify(String(value))}`;
    })
    .join(',')}}`;
}

function sourceEntityId(idFields: readonly string[], record: Record<string, unknown>): string {
  if (idFields.length === 1) {
    const value = record[idFields[0]!];
    return value === null || value === undefined ? '' : String(value);
  }
  return idFields
    .map(
      (field) =>
        `${field}=${record[field] === null || record[field] === undefined ? '<null>' : String(record[field])}`
    )
    .join('|');
}

function assertMatchPrimaryKeyValues(
  sourceRef: string,
  idFields: readonly string[],
  record: Record<string, unknown>
): void {
  for (const field of idFields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      throw new CommandError(
        `Match record for ${sourceRef} is missing primary-key field "${field}".`,
        2
      );
    }
    const value = record[field];
    if (
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      (typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new CommandError(
        `Match record for ${sourceRef} has an invalid primary-key field "${field}"; primary keys must be a non-null string, number, or boolean.`,
        2
      );
    }
  }
}

export function prepareMatchRecord(
  spec: ResolvedResolutionSpec,
  record: Record<string, unknown>
): PreparedMatchRecord {
  const input = pickInput(spec, record);
  const idFields = input.idFields ?? [];
  if (idFields.length === 0) {
    throw new CommandError(`Resolution input ${input.ref} must define id_fields for match.`, 2);
  }
  const sourceRef = input.ref;
  assertMatchPrimaryKeyValues(sourceRef, idFields, record);
  const pkJson = sourcePkJson(idFields, record);
  const recordId = hash('md5', `${sourceRef}|${pkJson}`);
  const contentHash = hash('sha256', stableStringify(record));
  return {
    source_ref: sourceRef,
    source_pk_json: pkJson,
    source_entity_id: sourceEntityId(idFields, record),
    record_id: recordId,
    idempotency_key: hash('sha256', `${sourceRef}|${pkJson}`),
    content_hash: contentHash,
    record,
    standardized: applyStandardizeTransforms(record, spec),
  };
}

function deterministicColumn(spec: ResolvedResolutionSpec, field: string): string {
  if (field.startsWith('standardized_')) return field;
  if (spec.standardize.some((std) => std.field === field)) return `standardized_${field}`;
  return field;
}

function deterministicValue(
  prepared: PreparedMatchRecord,
  spec: ResolvedResolutionSpec,
  field: string
): unknown {
  const column = deterministicColumn(spec, field);
  // Standardized fields compare standardized-to-standardized, exactly like the
  // batch SQL. Falling back to the raw record value when the transform chain
  // nulled the field would compare a raw value against a standardized column.
  if (Object.prototype.hasOwnProperty.call(prepared.standardized, column)) {
    return prepared.standardized[column];
  }
  return prepared.record[field];
}

async function runAudit(
  context: MatchContext,
  payload: AuditPayload,
  subjectId: string,
  discriminator: string
): Promise<void> {
  // CREATE-IF-NOT-EXISTS DDL once per runner, not once per record — batch mode
  // otherwise issues O(records) DDL statements before any real work.
  if (!auditSurfaceEnsured.has(context.runner)) {
    for (const ddl of generateAuditLogDdl(context.dialect)) {
      await context.runner.run(ddl.sql);
    }
    auditSurfaceEnsured.add(context.runner);
  }
  await context.runner.run(
    generateAuditInsertSql({
      name: 'audit_match_assign',
      dialect: context.dialect,
      category: 'mutation',
      subjectType: 'source_record',
      subjectId,
      payload,
      eventIdDiscriminator: discriminator,
    }).sql
  );
}

async function ensureMatchInbox(context: MatchContext): Promise<void> {
  const key = `${context.dialect}\0${context.schema}\0${context.spec.entity}`;
  const ensured = matchInboxEnsured.get(context.runner);
  if (ensured?.has(key)) return;
  const ddl = generateMaterializeDdl(context.spec.entity, context.dialect, context.schema).find(
    (statement) => statement.name === 'ddl_match_inbox'
  );
  if (ddl) await context.runner.run(ddl.sql);
  const nextEnsured = ensured ?? new Set<string>();
  nextEnsured.add(key);
  matchInboxEnsured.set(context.runner, nextEnsured);
}

/**
 * Upsert the record into `__match_inbox`, the durable ledger for API-ingested
 * records: full resolve runs rebuild `__standardized`/`__crosswalks` from
 * warehouse sources only, and the incremental drain re-ingests any inbox row
 * whose record is missing from `__standardized` — so both staged and assigned
 * records survive rebuilds.
 */
async function upsertInboxRow(
  context: MatchContext,
  prepared: PreparedMatchRecord,
  status: 'pending' | 'assigned'
): Promise<void> {
  await ensureMatchInbox(context);
  await context.runner.run(
    `DELETE FROM ${table(context, '__match_inbox')} WHERE ${quoteIdentifier('idempotency_key', context.dialect)} = ${sqlValue(prepared.idempotency_key, context.dialect)}`
  );
  await insertRows(
    context.runner,
    table(context, '__match_inbox'),
    [
      'idempotency_key',
      'record_id',
      'source_ref',
      'source_pk_json',
      'source_entity_id',
      'record_json',
      'standardized_json',
      'status',
      'received_at',
      'drained_run_id',
      'drained_at',
      'content_hash',
    ],
    [
      {
        idempotency_key: prepared.idempotency_key,
        record_id: prepared.record_id,
        source_ref: prepared.source_ref,
        source_pk_json: prepared.source_pk_json,
        source_entity_id: prepared.source_entity_id,
        record_json: stableStringify(prepared.record),
        standardized_json: stableStringify(prepared.standardized),
        status,
        received_at: new Date().toISOString(),
        drained_run_id: null,
        drained_at: null,
        content_hash: prepared.content_hash,
      },
    ],
    context.dialect
  );
}

async function inboxContentHash(
  context: MatchContext,
  idempotencyKey: string
): Promise<string | undefined> {
  const query = context.runner.query;
  if (!query) return undefined;
  try {
    const rows = await query(
      [
        `SELECT ${quoteIdentifier('content_hash', context.dialect)}`,
        `FROM ${table(context, '__match_inbox')}`,
        `WHERE ${quoteIdentifier('idempotency_key', context.dialect)} = ${sqlValue(idempotencyKey, context.dialect)}`,
        `LIMIT 1`,
      ].join('\n')
    );
    return readString(rows[0] ?? {}, 'content_hash');
  } catch (error) {
    if (isMissingTableError(error)) return undefined;
    throw error;
  }
}

export async function lookupMatch(
  context: MatchContext,
  record: Record<string, unknown>
): Promise<MatchLookupResult | null> {
  const query = requireQuery(context.runner, 'entity match lookup');
  const prepared = prepareMatchRecord(context.spec, record);
  const stdTable = table(context, '__standardized');
  const crosswalksTable = table(context, '__crosswalks');
  const recordId = quoteIdentifier('record_id', context.dialect);

  for (const rule of context.spec.deterministicRules) {
    // Mirror the batch deterministic SQL exactly: it compiles each condition to
    // `a.col = b.col`, which under three-valued logic can NEVER match when the
    // value is NULL — regardless of both_not_null. Emitting `IS NULL` here
    // would auto-merge a null-valued record into an arbitrary null-valued
    // entity, a merge the warehouse pipeline would never produce. Empty string
    // stays an equality probe ('' = '' IS true in the batch SQL).
    const predicates = rule.conditions.flatMap((condition) => {
      const value = deterministicValue(prepared, context.spec, condition.field);
      if (value === null || value === undefined) return [];
      return [
        `std.${quoteIdentifier(deterministicColumn(context.spec, condition.field), context.dialect)} = ${sqlValue(value, context.dialect)}`,
      ];
    });
    if (predicates.length !== rule.conditions.length) continue;
    try {
      const rows = await query(
        [
          `SELECT cw.${quoteIdentifier('entity_id', context.dialect)} AS ${quoteIdentifier('entity_id', context.dialect)},`,
          `       std.${recordId} AS ${quoteIdentifier('record_id', context.dialect)}`,
          `FROM ${stdTable} std`,
          `JOIN ${crosswalksTable} cw ON cw.${recordId} = std.${recordId}`,
          `WHERE ${predicates.join(' AND ')}`,
          `ORDER BY cw.${quoteIdentifier('matched_at', context.dialect)} DESC`,
          `LIMIT 1`,
        ].join('\n')
      );
      const entityId = readString(rows[0] ?? {}, 'entity_id');
      if (entityId) {
        return {
          entity_id: entityId,
          matched_rule: rule.name,
          score: rule.confidence,
          band: rule.action === 'flag_for_review' ? 'review' : 'auto_merge',
          record_id: readString(rows[0] ?? {}, 'record_id'),
        };
      }
    } catch (error) {
      if (isMissingTableError(error)) return null;
      throw error;
    }
  }
  return null;
}

async function existingAssignment(
  context: MatchContext,
  recordIdValue: string
): Promise<string | undefined> {
  const query = requireQuery(context.runner, 'entity match assign');
  try {
    const rows = await query(
      [
        `SELECT ${quoteIdentifier('entity_id', context.dialect)}`,
        `FROM ${table(context, '__crosswalks')}`,
        `WHERE ${quoteIdentifier('record_id', context.dialect)} = ${sqlValue(recordIdValue, context.dialect)}`,
        `LIMIT 1`,
      ].join('\n')
    );
    return readString(rows[0] ?? {}, 'entity_id');
  } catch (error) {
    if (isMissingTableError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function upsertStandardized(
  context: MatchContext,
  prepared: PreparedMatchRecord
): Promise<void> {
  const stdTable = table(context, '__standardized');
  await context.runner.run(
    `DELETE FROM ${stdTable} WHERE ${quoteIdentifier('record_id', context.dialect)} = ${sqlValue(prepared.record_id, context.dialect)}`
  );
  const columns = [
    'record_id',
    'source_ref',
    'source_pk_json',
    '_source_system',
    '_source_entity_id',
    '_standardized_at',
    ...Object.keys(prepared.standardized),
  ];
  await insertRows(
    context.runner,
    stdTable,
    columns,
    [
      {
        record_id: prepared.record_id,
        source_ref: prepared.source_ref,
        source_pk_json: prepared.source_pk_json,
        _source_system: prepared.source_ref,
        _source_entity_id: prepared.source_entity_id,
        _standardized_at: new Date().toISOString(),
        ...prepared.standardized,
      },
    ],
    context.dialect
  );
}

async function attachEntity(
  context: MatchContext,
  prepared: PreparedMatchRecord,
  entityId: string,
  reason: string
): Promise<void> {
  const clusterId = entityId;
  const rows = {
    record_id: prepared.record_id,
    source_ref: prepared.source_ref,
    source_pk_json: prepared.source_pk_json,
    source_system: prepared.source_ref,
    source_entity_id: prepared.source_entity_id,
    entity_id: entityId,
    cluster_id: clusterId,
    component_id: clusterId,
    confidence_score: 1,
  };
  await context.runner.run(
    `DELETE FROM ${table(context, '__clusters')} WHERE ${quoteIdentifier('record_id', context.dialect)} = ${sqlValue(prepared.record_id, context.dialect)}`
  );
  await insertRows(
    context.runner,
    table(context, '__clusters'),
    [
      'entity_id',
      'cluster_id',
      'component_id',
      'record_id',
      'source_ref',
      'source_pk_json',
      'source_entity_id',
      'source_system',
      'confidence_score',
      'clustered_at',
    ],
    [{ ...rows, clustered_at: new Date().toISOString() }],
    context.dialect
  );
  await context.runner.run(
    `DELETE FROM ${table(context, '__crosswalks')} WHERE ${quoteIdentifier('record_id', context.dialect)} = ${sqlValue(prepared.record_id, context.dialect)}`
  );
  await insertRows(
    context.runner,
    table(context, '__crosswalks'),
    [
      'record_id',
      'source_ref',
      'source_pk_json',
      'source_system',
      'source_entity_id',
      'entity_id',
      'cluster_id',
      'component_id',
      'confidence_score',
      'matched_at',
    ],
    [{ ...rows, matched_at: new Date().toISOString() }],
    context.dialect
  );
  await insertRows(
    context.runner,
    table(context, '__entity_id_events'),
    [
      'event_id',
      'event_type',
      'entity_id',
      'previous_entity_id',
      'record_id',
      'component_id',
      'source_ref',
      'source_pk_json',
      'source_system',
      'source_entity_id',
      'reason',
      'created_at',
    ],
    [
      {
        event_id: hash('md5', `${prepared.record_id}|${entityId}|${reason}`),
        event_type: reason === 'new_entity' ? 'assign' : 'merge',
        entity_id: entityId,
        previous_entity_id: null,
        record_id: prepared.record_id,
        component_id: clusterId,
        source_ref: prepared.source_ref,
        source_pk_json: prepared.source_pk_json,
        source_system: prepared.source_ref,
        source_entity_id: prepared.source_entity_id,
        reason,
        created_at: new Date().toISOString(),
      },
    ],
    context.dialect
  );
}

async function enqueueReview(
  context: MatchContext,
  prepared: PreparedMatchRecord,
  hit: MatchLookupResult,
  rule: DeterministicRule | undefined
): Promise<void> {
  const otherRecordId = hit.record_id ?? hit.entity_id;
  const [a, b] = [prepared.record_id, otherRecordId].sort();
  const pairId = hash('md5', `${a}||${b}`);
  await context.runner.run(
    `DELETE FROM ${table(context, '__review_queue')} WHERE ${quoteIdentifier('pair_id', context.dialect)} = ${sqlValue(pairId, context.dialect)}`
  );
  await insertRows(
    context.runner,
    table(context, '__review_queue'),
    [
      'pair_id',
      'record_a_id',
      'record_b_id',
      'source_a',
      'source_b',
      'composite_score',
      'threshold_band',
      'blocking_rules',
      'field_diffs',
      'recommended_action',
      'semantic_score',
      'semantic_decision',
      'rule_name',
    ],
    [
      {
        pair_id: pairId,
        record_a_id: a,
        record_b_id: b,
        source_a: prepared.source_ref,
        source_b: 'matched_entity',
        composite_score: rule?.confidence ?? hit.score ?? 0,
        threshold_band: 'deterministic_review',
        blocking_rules: JSON.stringify([hit.matched_rule ?? 'match_lookup']),
        field_diffs: JSON.stringify(prepared.standardized),
        recommended_action: 'merge',
        semantic_score: null,
        semantic_decision: null,
        rule_name: hit.matched_rule ?? null,
      },
    ],
    context.dialect
  );
}

export async function stageMatch(
  context: MatchContext,
  record: Record<string, unknown>
): Promise<MatchMutationResult> {
  const prepared = prepareMatchRecord(context.spec, record);
  await upsertInboxRow(context, prepared, 'pending');
  await runAudit(
    context,
    {
      kind: 'match_assign',
      entity: context.spec.entity,
      mode: 'stage',
      idempotency_key: prepared.idempotency_key,
      record_id: prepared.record_id,
      source_ref: prepared.source_ref,
      outcome: 'staged',
    },
    prepared.record_id,
    prepared.idempotency_key
  );
  return {
    status: 'staged',
    record_id: prepared.record_id,
    idempotency_key: prepared.idempotency_key,
  };
}

export async function assignMatch(
  context: MatchContext,
  record: Record<string, unknown>
): Promise<MatchMutationResult> {
  const prepared = prepareMatchRecord(context.spec, record);
  const existing = await existingAssignment(context, prepared.record_id);
  if (existing) {
    // Same identity, same content → pure no-op. Changed content must not be
    // silently dropped: refresh the standardized row and the inbox ledger so
    // the next resolve run rescores the updated values (entity id unchanged).
    const storedContentHash = await inboxContentHash(context, prepared.idempotency_key);
    if (storedContentHash !== prepared.content_hash) {
      await upsertStandardized(context, prepared);
      await upsertInboxRow(context, prepared, 'assigned');
    }
    return {
      status: 'already_assigned',
      entity_id: existing,
      record_id: prepared.record_id,
      idempotency_key: prepared.idempotency_key,
      band: 'auto_merge',
    };
  }
  const hit = await lookupMatch(context, record);
  await upsertStandardized(context, prepared);
  if (hit?.band === 'review') {
    const rule = context.spec.deterministicRules.find(
      (candidate) => candidate.name === hit.matched_rule
    );
    // Pending-review records flow through the normal pipeline on the next
    // incremental run; the inbox row keeps them durable across full rebuilds.
    await upsertInboxRow(context, prepared, 'pending');
    await enqueueReview(context, prepared, hit, rule);
    await runAudit(
      context,
      {
        kind: 'match_assign',
        entity: context.spec.entity,
        mode: 'assign',
        idempotency_key: prepared.idempotency_key,
        record_id: prepared.record_id,
        source_ref: prepared.source_ref,
        outcome: 'pending_review',
        matched_entity_id: hit.entity_id,
      },
      prepared.record_id,
      prepared.idempotency_key
    );
    return {
      status: 'pending_review',
      entity_id: hit.entity_id,
      record_id: prepared.record_id,
      idempotency_key: prepared.idempotency_key,
      band: 'review',
      matched_rule: hit.matched_rule,
    };
  }
  const entityId = hit?.entity_id ?? prepared.record_id;
  await attachEntity(context, prepared, entityId, hit ? 'match_assign' : 'new_entity');
  await upsertInboxRow(context, prepared, 'assigned');
  await runAudit(
    context,
    {
      kind: 'match_assign',
      entity: context.spec.entity,
      mode: 'assign',
      idempotency_key: prepared.idempotency_key,
      record_id: prepared.record_id,
      source_ref: prepared.source_ref,
      outcome: 'assigned',
      matched_entity_id: entityId,
    },
    prepared.record_id,
    prepared.idempotency_key
  );
  return {
    status: 'assigned',
    entity_id: entityId,
    record_id: prepared.record_id,
    idempotency_key: prepared.idempotency_key,
    band: hit?.band ?? 'miss',
    matched_rule: hit?.matched_rule,
  };
}
