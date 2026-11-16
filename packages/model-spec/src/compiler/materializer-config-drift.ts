/**
 * Materialization-config drift detection.
 *
 * Compares the prior successful run's persisted snapshot (in `ModelRunState`)
 * against the current invocation's resolved config and decides whether the
 * destination needs a DROP + rebuild. Composes with — runs *after* —
 * `planTransition` in `./materializer.ts`, which handles materialization-type
 * changes (e.g. `table` → `view`).
 *
 * Split out from `materializer.ts` because the file was sprawling and this
 * logic has no dependency on the DDL generation paths beyond the shared
 * `Decision` type and the `dropStatementForMaterialization` helper.
 */
import { dropStatementForMaterialization, type Decision } from './materializer.js';

import type { ModelRunState } from './state.js';

/**
 * Snapshot of the *current* run's resolved config, used by `planConfigDrift`
 * to diff against what was last persisted to run state.
 *
 * `fqName` here is the destination the current run would write to. When the
 * prior `priorFqName` differs (target_schema or target_database changed), the
 * planner DROPs the prior name — otherwise the old table sits orphaned.
 */
export interface CurrentRunConfigSnapshot {
  materialization: string;
  strategy?: string;
  uniqueKey?: string[];
  incrementalFilter?: string;
  onSchemaChange?: string;
  targetSchema: string;
  targetDatabase?: string;
  fqName: string;
}

/**
 * Detect materialization-config drift between the prior successful run's
 * persisted snapshot and the current invocation's resolved config.
 *
 * Triggers a `recreate` Decision when any of the load-bearing fields
 * (`strategy`, `uniqueKey`, `incrementalFilter`, `onSchemaChange`,
 * `targetSchema`, `targetDatabase`) changes. The DROP statement is emitted
 * against the **prior** fqName so a moved destination doesn't orphan its old
 * table.
 *
 * Returns `proceed` when:
 *   - `prior` is undefined (first run);
 *   - the relevant prior fields are undefined ("don't know" path — state
 *     written by older Bobsled Core versions that didn't track these fields).
 *     Spec §3 is explicit: don't force a destructive rebuild on upgrade.
 */
export function planConfigDrift(
  prior: ModelRunState | undefined,
  current: CurrentRunConfigSnapshot,
  modelName: string
): Decision {
  if (!prior) return { kind: 'proceed' };

  const changes = collectConfigChanges(prior, current);
  if (changes.length === 0) return { kind: 'proceed' };

  // Pick the destination to drop. Prefer the explicit prior fqName written
  // by drift-aware Bobsled Core versions; fall back to the current fqName when an
  // older state file didn't track it (this happens after upgrade with prior
  // state that *did* persist the changed field somehow — rare but defined).
  const dropTarget = prior.priorFqName ?? current.fqName;
  const priorMaterialization = prior.materialization;
  const dropDdl = dropStatementForMaterialization(priorMaterialization, dropTarget);

  // Inline the diagnostic comment with the DROP rather than emitting it as
  // its own entry — `executeSqlStatements` dispatches each preDdl entry as a
  // standalone runner call, and Snowflake (along with BigQuery, MySQL,
  // Databricks) rejects comment-only payloads with `Empty SQL statement`.
  // Every dialect parses a leading `-- ...\n` as part of the next statement,
  // so coupling them keeps the diagnostic visible in the SQL log without
  // turning it into a failing standalone call.
  return {
    kind: 'recreate',
    preDdl: [
      `-- model \`${modelName}\` config drift: ${changes.join(', ')}; rebuilding destination.\n${dropDdl}`,
    ],
    // Surface the diff as structured data so the caller can fire it on
    // `opts.onWarn` and push it onto `RunProjectResult.warnings` without
    // re-parsing the leading SQL comment. Same pattern the schema-drift
    // full-refresh path already uses for observability into destructive
    // recreates.
    changes,
  };
}

/**
 * Return a list of human-readable change descriptions between prior state
 * and the current run's resolved config. An empty list means no
 * recreate-worthy drift.
 *
 * Each comparison guards on `prior` field being defined — a missing prior
 * field means "older Bobsled Core version didn't track this," not "the value used
 * to be undefined." The latter is indistinguishable from the former in the
 * persisted JSON, and forcing a recreate on upgrade is the higher-blast-
 * radius wrong answer.
 */
function collectConfigChanges(prior: ModelRunState, current: CurrentRunConfigSnapshot): string[] {
  const changes: string[] = [];

  if (prior.strategy !== undefined && current.strategy !== undefined) {
    if (prior.strategy !== current.strategy) {
      changes.push(`strategy ${prior.strategy} -> ${current.strategy}`);
    }
  }

  if (prior.uniqueKey !== undefined && current.uniqueKey !== undefined) {
    if (!arraysEqual(prior.uniqueKey, current.uniqueKey)) {
      const before = prior.uniqueKey.join(',');
      const after = current.uniqueKey.join(',');
      changes.push(`unique_key [${before}] -> [${after}]`);
    }
  }

  if (prior.incrementalFilter !== undefined && current.incrementalFilter !== undefined) {
    if (prior.incrementalFilter !== current.incrementalFilter) {
      changes.push('incremental_filter changed');
    }
  } else if (
    (prior.incrementalFilter === undefined) !== (current.incrementalFilter === undefined) &&
    prior.strategy !== undefined
  ) {
    // Filter added or removed (the strategy guard above keeps this from
    // firing for state written by old Bobsled Core versions that didn't track
    // incrementalFilter at all — those have `prior.strategy === undefined`).
    changes.push(
      prior.incrementalFilter === undefined
        ? 'incremental_filter added'
        : 'incremental_filter removed'
    );
  }

  if (prior.onSchemaChange !== undefined && current.onSchemaChange !== undefined) {
    if (prior.onSchemaChange !== current.onSchemaChange) {
      changes.push(`on_schema_change ${prior.onSchemaChange} -> ${current.onSchemaChange}`);
    }
  }

  if (prior.targetSchema !== undefined) {
    if (prior.targetSchema !== current.targetSchema) {
      changes.push(`target_schema ${prior.targetSchema} -> ${current.targetSchema}`);
    }
  }

  // Gate on `prior.targetSchema` rather than `prior.targetDatabase` to
  // distinguish "older Bobsled Core version, no fields tracked" (both undefined,
  // no signal) from "drift-aware single-database prior" (targetSchema set,
  // targetDatabase legitimately absent). The latter is the case a stricter
  // `prior.targetDatabase !== undefined` guard would miss — gaining an
  // explicit target_database silently orphans the old destination.
  if (prior.targetSchema !== undefined && prior.targetDatabase !== current.targetDatabase) {
    changes.push(
      `target_database ${prior.targetDatabase ?? '(unset)'} -> ${current.targetDatabase ?? '(unset)'}`
    );
  }

  return changes;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
