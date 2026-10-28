import { join } from 'node:path';

import { computeIdempotencyKey } from '@bobsled-inc/extractor';
import {
  EnvSecretResolver,
  assertRunnerSupportsBindings,
  interpolateSecrets,
  loadIndexedIntegrations,
  resolveRunner,
} from '@bobsled-inc/connections';
import { findAction, getIntegrationsDir, loadActions } from '@bobsled-inc/integrations';
import { resolveProjectIndex, type ProjectIndex } from '@bobsled-inc/project-index';
import { CommandError } from '@bobsled-inc/protocol';
import { randomUUID } from 'node:crypto';

import { executeAction, type ActionResult } from '../lib/action-executor.js';
import {
  buildCursorQuery,
  isSyncSqlDialect,
  SYNC_SQL_DIALECTS,
  type SyncSqlDialect,
} from './cursor-query.js';
import { stableJson, syncNamespace } from './idempotency.js';
import {
  FileSyncStateStore,
  truncatePayloadSnapshot,
  type SyncCheckpoint,
  type SyncRunSummary,
  type SyncStateStore,
} from './state-store.js';

import type { Action } from '@bobsled-inc/integrations';
import type {
  IntegrationFile,
  SqlParamValue,
  SqlQueryRow,
  SqlRunnerModule,
} from '@bobsled-inc/connections';
import type { SyncSpec } from './spec.js';

export interface RunSyncOptions {
  spec: SyncSpec;
  projectRoot: string;
  /** Prebuilt index of `projectRoot`; the project is scanned when omitted. */
  index?: ProjectIndex;
  dryRun?: boolean;
  limit?: number;
  stateDir?: string;
  stateStore?: SyncStateStore;
  runner?: SqlRunnerModule;
  action?: Action;
  now?: () => Date;
}

function shortFieldName(field: string): string {
  return field.split('.').at(-1) ?? field;
}

function getRowField(row: SqlQueryRow, field: string): unknown {
  return row[field] ?? row[shortFieldName(field)];
}

function isDuckDbValue(value: unknown): value is { toString(): string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    /^DuckDB(Timestamp[A-Za-z]*|Date|Time[A-Za-z]*|Decimal|UUID|Interval)Value$/.test(
      value.constructor?.name ?? ''
    )
  );
}

export function getRowValue(row: SqlQueryRow, field: string): SqlParamValue {
  const value = getRowField(row, field);
  if (value === undefined) {
    throw new CommandError(`Cursor field "${field}" is missing from the query result row.`, 1);
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value instanceof Date
  ) {
    return value;
  }
  if (isDuckDbValue(value)) {
    // DuckDB returns TIMESTAMP, DATE and DECIMAL columns as value objects. Their
    // text form round-trips through a ? binding and the JSON checkpoint.
    return String(value);
  }
  throw new CommandError(`Cursor field "${field}" produced a non-scalar value.`, 1);
}

function buildEntityKey(spec: SyncSpec, row: SqlQueryRow): Record<string, unknown> {
  return Object.fromEntries(
    spec.target.entity_key.fields.map((field) => [field, getRowField(row, field)])
  );
}

function buildInputs(spec: SyncSpec, action: Action, row: SqlQueryRow): Record<string, unknown> {
  if (spec.target.input_mapping) {
    return Object.fromEntries(
      Object.entries(spec.target.input_mapping).map(([input, field]) => [
        input,
        getRowField(row, field),
      ])
    );
  }
  return Object.fromEntries(Object.keys(action.inputs).map((input) => [input, row[input]]));
}

export function resolveAction(
  spec: SyncSpec,
  projectRoot: string,
  injected?: Action,
  index?: ProjectIndex
): Action {
  if (injected) return injected;
  const actions = loadActions(getIntegrationsDir(), resolveProjectIndex(projectRoot, index));
  const result = findAction(actions, spec.target.action);
  if (result.kind === 'found') {
    return result.action;
  }
  if (result.kind === 'ambiguous') {
    throw new CommandError(
      `Action "${spec.target.action}" is ambiguous. Use one of: ${result.actions
        .map((action) => action.qualifiedName)
        .join(', ')}`,
      2
    );
  }
  throw new CommandError(`Action not found: ${spec.target.action}`, 2);
}

export function validateInputMapping(spec: SyncSpec, action: Action): void {
  if (!spec.target.input_mapping) return;
  const allowed = new Set(Object.keys(action.inputs));
  const unknown = Object.keys(spec.target.input_mapping).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new CommandError(
      `Sync "${spec.name}" maps unknown action inputs for ${action.qualifiedName}: ${unknown.join(', ')}`,
      2
    );
  }
}

/** The project integration a sync reads from, found by its declared name. */
export function resolveSyncIntegration(spec: SyncSpec, project: ProjectIndex): IntegrationFile {
  const found = loadIndexedIntegrations(project).get(spec.source.connection);
  if (!found) {
    throw new CommandError(
      `Integration "${spec.source.connection}" not found. Add an integration file with name: ${spec.source.connection}.`,
      2
    );
  }
  return found.integration;
}

async function resolveRunnerForSync(
  spec: SyncSpec,
  project: () => ProjectIndex,
  injected?: SqlRunnerModule
): Promise<{ runner: SqlRunnerModule; integration?: IntegrationFile; close: () => Promise<void> }> {
  if (injected) {
    assertRunnerSupportsBindings(injected, spec.source.connection);
    return { runner: injected, close: async () => undefined };
  }
  const loaded = resolveSyncIntegration(spec, project());
  const secretResolver = new EnvSecretResolver();
  const interpolated = await interpolateSecrets(loaded, secretResolver);
  const runner = await resolveRunner(interpolated, { secretResolver });
  assertRunnerSupportsBindings(runner, spec.source.connection);
  return {
    runner,
    integration: interpolated,
    close: async () => {
      await runner.close?.();
    },
  };
}

function makeInitialCheckpoint(spec: SyncSpec, runId: string): SyncCheckpoint {
  return {
    cursor_value: spec.source.cursor.initial_value satisfies SqlParamValue,
    tie_breaker_values: spec.source.cursor.tie_breaker_fields.map(() => null),
    updated_at: new Date().toISOString(),
    run_id: runId,
  };
}

export async function runSync(options: RunSyncOptions): Promise<SyncRunSummary> {
  const { spec, projectRoot, dryRun = false } = options;
  const now = options.now ?? (() => new Date());
  const runId = randomUUID().replaceAll('-', '');
  let index = options.index;
  const projectIndex = (): ProjectIndex => (index = resolveProjectIndex(projectRoot, index));
  const action = options.action ?? resolveAction(spec, projectRoot, undefined, projectIndex());
  validateInputMapping(spec, action);
  // An API action reads its integration from the project; resolve the index
  // once here instead of letting every execution scan the project.
  const actionIndex = action.transport === 'api' ? projectIndex() : index;

  const resolved = await resolveRunnerForSync(spec, projectIndex, options.runner);
  const { query: runQuery } = resolved.runner;
  if (!runQuery) throw new CommandError('Runner missing query method.', 1);
  const sourceType = resolved.integration?.source_type ?? 'duckdb';
  if (!isSyncSqlDialect(sourceType)) {
    throw new CommandError(
      `sync: source_type "${sourceType}" is not supported as a sync source. ` +
        `Supported sources are ${SYNC_SQL_DIALECTS.join(', ')}.`,
      2
    );
  }
  const dialect: SyncSqlDialect = sourceType;
  const store: SyncStateStore =
    options.stateStore ??
    new FileSyncStateStore(options.stateDir ?? join(projectRoot, '.dogsled', 'sync-state'));

  let lease = dryRun
    ? undefined
    : await store.acquireLease(spec.name, spec.options.lease_ttl_seconds);
  const startedAt = now().toISOString();
  const summary: SyncRunSummary = {
    run_id: runId,
    sync_name: spec.name,
    status: 'running',
    started_at: startedAt,
    dry_run: dryRun,
    counters: { processed: 0, succeeded: 0, failed: 0, skipped: 0 },
  };

  try {
    if (!dryRun) {
      await store.startRun(spec.name, runId, summary);
    }
    let checkpoint = (await store.loadCheckpoint(spec.name)) ?? makeInitialCheckpoint(spec, runId);
    let consecutiveFailures = 0;
    let remaining = options.limit ?? Number.POSITIVE_INFINITY;

    while (remaining > 0) {
      const pageLimit = Math.min(spec.options.page_size, remaining);
      const query = buildCursorQuery({
        spec,
        dialect,
        cursorValue: checkpoint.cursor_value,
        tieBreakerValues: checkpoint.tie_breaker_values,
        limit: pageLimit,
      });
      const rows = await runQuery(query.sql, query.params);
      if (rows.length === 0) break;

      for (const row of rows) {
        const entityKey = buildEntityKey(spec, row);
        const inputs = buildInputs(spec, action, row);
        // Audit-only key written to receipts; v1 does not deduplicate on restart.
        const idempotencyKey = computeIdempotencyKey({
          action: action.qualifiedName,
          targetRecordKey: stableJson(entityKey),
          projectionRef: spec.source.projection_ref,
          namespace: syncNamespace(spec.name),
        });

        // Pre-action idempotency claim: managed runtimes reserve the key before
        // the destination action runs so retries/concurrent invocations cannot
        // create duplicate external side effects. A throw here intentionally
        // fails the run before any side effect — safer than risking a duplicate.
        // Local/default stores omit the hook, leaving behavior unchanged.
        const claim =
          !dryRun && store.claimSyncActionIdempotencyKey
            ? await store.claimSyncActionIdempotencyKey(spec.name, runId, {
                idempotency_key: idempotencyKey,
                entity_key: entityKey,
                action: action.qualifiedName,
              })
            : undefined;

        let result: ActionResult;
        if (claim?.status === 'already_succeeded') {
          // The action already ran for this key; skip execution but still
          // record a receipt and advance the checkpoint like any processed row.
          result = {
            status: 'skipped',
            action: action.qualifiedName,
            transport: action.transport,
            target_record_id: claim.target_record_id,
            attempted_at: now().toISOString(),
            duration_ms: 0,
          };
        } else {
          result = await executeAction(action, inputs, { dryRun, projectRoot, index: actionIndex });
        }
        summary.counters.processed++;
        if (result.status === 'success') summary.counters.succeeded++;
        if (result.status === 'skipped') summary.counters.skipped++;
        if (result.status === 'failed') summary.counters.failed++;

        if (!dryRun) {
          await store.appendReceipt(spec.name, runId, {
            run_id: runId,
            sync_name: spec.name,
            entity_key: entityKey,
            idempotency_key: idempotencyKey,
            action: action.qualifiedName,
            status: result.status,
            target_record_id: result.target_record_id,
            attempted_at: result.attempted_at,
            duration_ms: result.duration_ms,
            error: result.error,
          });
          if (result.status === 'failed') {
            await store.appendDeadLetter(spec.name, runId, {
              run_id: runId,
              sync_name: spec.name,
              entity_key: entityKey,
              action: action.qualifiedName,
              error: result.error,
              payload_snapshot: truncatePayloadSnapshot({ row, inputs }),
              occurred_at: now().toISOString(),
            });
          }
        }

        const nextCheckpoint = {
          cursor_value: getRowValue(row, spec.source.cursor.field),
          tie_breaker_values: spec.source.cursor.tie_breaker_fields.map((field) =>
            getRowValue(row, field)
          ),
          idempotency_key: idempotencyKey,
          updated_at: now().toISOString(),
          run_id: runId,
        };

        if (result.status === 'failed') {
          consecutiveFailures++;
          if (spec.options.on_record_error === 'fail') {
            summary.status = 'aborted';
            summary.last_error = result.error?.message ?? 'Action failed';
            remaining = 0;
            break;
          }
          if (consecutiveFailures >= spec.options.consecutive_failure_threshold) {
            summary.status = 'aborted';
            summary.last_error = `Consecutive failure threshold ${spec.options.consecutive_failure_threshold} reached.`;
            remaining = 0;
            break;
          }
        } else {
          consecutiveFailures = 0;
        }

        checkpoint = nextCheckpoint;
        if (
          !dryRun &&
          summary.counters.processed % spec.options.checkpoint_interval_records === 0
        ) {
          await store.saveCheckpoint(spec.name, checkpoint);
        }
        remaining--;
      }

      if (summary.status === 'aborted' || rows.length < pageLimit) break;
    }

    if (!dryRun && summary.counters.processed > 0) {
      await store.saveCheckpoint(spec.name, checkpoint);
    }
    if (summary.status === 'running') {
      summary.status = 'completed';
    }
  } catch (error) {
    summary.status = 'failed';
    summary.last_error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    summary.ended_at = now().toISOString();
    if (!dryRun) {
      await store.finishRun(spec.name, runId, summary);
      if (lease) {
        await store.releaseLease(lease);
        lease = undefined;
      }
    }
    await resolved.close();
  }

  return summary;
}
