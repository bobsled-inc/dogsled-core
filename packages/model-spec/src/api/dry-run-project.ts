/**
 * `dryRunProject` — Layer 3 orchestrator for `dogsled model dry-run`.
 *
 * Compiles a set of draft models with `inlineDeps`, wraps each compiled SELECT
 * with a sandbox-safe envelope (parse / limit0 / sample), and executes against
 * the integration's resolved runner. Designed for agents that draft multiple
 * interdependent models at once and need warehouse-level validation before
 * deploying.
 *
 * Three exported surfaces:
 *   - `dryRunProject(cwd, opts)`        — Layer 3, file-backed (used by CLI).
 *   - `dryRunInMemory(opts)`            — file-less variant for hosts whose
 *                                          drafts live outside the filesystem
 *                                          (e.g. a host application).
 *   - `wrapDryRunSql(sql, mode, ...)`   — pure helper that wraps a compiled
 *                                          SELECT with the chosen mode's
 *                                          envelope. Re-exposed for hosts
 *                                          that already have a runner of
 *                                          their own and only need the
 *                                          envelope logic.
 *
 * Semantics caveat: inlining a stateful upstream materialization (incremental,
 * snapshot, dynamic_table) drops its MERGE / SCD-2 / incremental_filter
 * semantics — the upstream collapses to a one-shot SELECT. The dry-run
 * validates SQL shape, not parity with `dogsled model run`.
 */

import {
  interpolateSecrets,
  resolveRunner,
  type CustomRunnerRegistry,
  type SecretResolver,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';

import {
  buildModelRegistry,
  compileAll,
  type CompileResult,
  type SourceEntryRegistry,
  type SourceRegistry,
  type SupportedDialect,
} from '../compiler/index.js';
import { buildSecretResolver } from '../integrations.js';
import { CommandError } from '../errors.js';

import {
  compileInMemory,
  type CompileInMemoryOptions,
  type InMemoryModel,
} from './compile-in-memory.js';
import { loadProject, selectIntegrationContexts, type LoadedProject } from './load-project.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dry-run envelope mode.
 *
 *   - `parse` — Validate syntax + reference resolution only. Uses the runner's
 *     native dry-run (BigQuery `dryRun: true`) when available; otherwise falls
 *     back to a `LIMIT 0` envelope which the warehouse still has to plan.
 *   - `limit0` — Wrap the SELECT in `SELECT * FROM (<sql>) WHERE 1 = 0`. The
 *     warehouse executes the plan but returns zero rows. Universal across
 *     every supported dialect. Default.
 *   - `sample` — Wrap with `SELECT * FROM (<sql>) LIMIT <rowLimit>`. Actually
 *     scans some data — useful for spot checks. Costs real compute on the
 *     warehouse.
 */
export type DryRunMode = 'parse' | 'limit0' | 'sample';

export interface DryRunModelResult {
  modelName: string;
  status: 'ok' | 'failed';
  /** Warehouse error message if `status === 'failed'`. */
  error?: string;
  /**
   * The SQL we sent to the warehouse. For `parse` mode using the runner's
   * native dryRun() hook this is the bare compiled SELECT; otherwise it's the
   * wrapped envelope. Returned so agents can echo it back when surfacing errors.
   */
  sql: string;
}

export interface DryRunProjectIntegrationResult {
  handle: string;
  dialect: SupportedDialect;
  results: DryRunModelResult[];
  /** Per-integration failure (runner dispatch / overall). */
  error?: string;
}

export interface DryRunProjectResult {
  ok: boolean;
  byIntegration: DryRunProjectIntegrationResult[];
  warnings: string[];
  /** Integrations declared but with no referencing model. */
  skipped: Array<{ handle: string; message: string }>;
}

export interface DryRunProjectOptions {
  /** Narrow to a single integration handle. Omit for fan-out across all referenced integrations. */
  integration?: string;
  /**
   * Models to inline as CTEs. The agent's draft set: models that don't yet
   * exist in the warehouse and must be expanded into the compiled SQL.
   * Defaults to every model in the integration when omitted.
   */
  drafts?: string[];
  /**
   * Models to actually dry-run against the warehouse. Defaults to `drafts`.
   * Useful when the agent has 10 drafts but only cares to verify a few leaf
   * models (their upstreams still get inlined when they appear in `drafts`).
   */
  targets?: string[];
  /** Dry-run envelope mode. Defaults to `limit0`. */
  mode?: DryRunMode;
  /** Row limit for `sample` mode. Defaults to 10. */
  rowLimit?: number;
  /** Path to a flat YAML map overlaying env-var values. Ignored when `secretResolver` is provided. */
  secrets?: string;
  secretResolver?: SecretResolver;
  customRunners?: CustomRunnerRegistry;
  /** Pre-loaded project to reuse. */
  project?: LoadedProject;
}

export interface DryRunInMemoryOptions extends Omit<
  CompileInMemoryOptions,
  'selectOnly' | 'inlineDeps'
> {
  /**
   * Models to inline as CTEs. Defaults to every model passed in `models`.
   * Sources are never inlined.
   */
  drafts?: string[];
  /** Models to dry-run. Defaults to `drafts` (i.e. every model). */
  targets?: string[];
  /** Dry-run envelope mode. Defaults to `limit0`. */
  mode?: DryRunMode;
  /** Row limit for `sample` mode. Defaults to 10. */
  rowLimit?: number;
  /**
   * Caller-provided runner module. The host application injects its existing
   * warehouse connection here so the dry-run doesn't rebuild credentials
   * or re-import drivers.
   */
  runner: SqlRunnerModule;
  /**
   * Source entry registry keyed by `connection.name`. Required by BigQuery
   * union models that use `include_all_columns: true`. Build one from parsed
   * `SourceSpec`s via `buildInMemorySourceEntryRegistry`.
   */
  entryRegistry?: SourceEntryRegistry;
}

export interface DryRunInMemoryResult {
  ok: boolean;
  results: DryRunModelResult[];
}

// ---------------------------------------------------------------------------
// Envelope wrapper (pure)
// ---------------------------------------------------------------------------

/**
 * Wrap a compiled SELECT with the chosen dry-run envelope. Pure function —
 * exported so hosts that already manage their own runner can use the same
 * envelope semantics that `dryRunProject` does.
 */
export function wrapDryRunSql(
  selectSql: string,
  mode: DryRunMode = 'limit0',
  rowLimit = 10
): string {
  const inner = selectSql.trim().replace(/;\s*$/, '');
  switch (mode) {
    case 'parse':
    case 'limit0':
      return `SELECT * FROM (\n${inner}\n) AS __bms_dry_run WHERE 1 = 0`;
    case 'sample':
      return `SELECT * FROM (\n${inner}\n) AS __bms_dry_run LIMIT ${Math.max(0, Math.floor(rowLimit))}`;
  }
}

// ---------------------------------------------------------------------------
// Shared execution helper
// ---------------------------------------------------------------------------

function lowerSet(input: Iterable<string>): Set<string> {
  return new Set([...input].map((s) => s.toLowerCase()));
}

function bucketCompileResults(
  results: CompileResult[],
  targetSet: Set<string>
): { selectByName: Map<string, string>; failures: DryRunModelResult[] } {
  const selectByName = new Map<string, string>();
  const failures: DryRunModelResult[] = [];
  for (const r of results) {
    if (r.ok) {
      selectByName.set(r.modelName.toLowerCase(), r.sql);
      continue;
    }
    const lower = r.modelName?.toLowerCase();
    if (lower && targetSet.has(lower)) {
      failures.push({
        modelName: r.modelName ?? 'unknown',
        status: 'failed',
        error: r.error,
        sql: '',
      });
    }
  }
  return { selectByName, failures };
}

async function executeDryRunBatch(
  runnerModule: SqlRunnerModule,
  selectByName: Map<string, string>,
  targets: string[],
  mode: DryRunMode,
  rowLimit: number
): Promise<DryRunModelResult[]> {
  const out: DryRunModelResult[] = [];
  for (const name of targets) {
    const selectSql = selectByName.get(name);
    if (!selectSql) continue;
    const useNativeDryRun = mode === 'parse' && typeof runnerModule.dryRun === 'function';
    const sqlForExecution = useNativeDryRun ? selectSql : wrapDryRunSql(selectSql, mode, rowLimit);
    try {
      if (useNativeDryRun) {
        await runnerModule.dryRun!(selectSql);
      } else {
        await runnerModule.run(sqlForExecution);
      }
      out.push({ modelName: name, status: 'ok', sql: sqlForExecution });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.push({ modelName: name, status: 'failed', error: message, sql: sqlForExecution });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// `dryRunInMemory` — file-less variant
// ---------------------------------------------------------------------------

/**
 * Dry-run a working set of in-memory drafts against a caller-provided runner.
 *
 * Intended for host applications that hold an open warehouse
 * runner and want to validate drafts before persisting them.
 */
export async function dryRunInMemory(opts: DryRunInMemoryOptions): Promise<DryRunInMemoryResult> {
  const {
    models,
    sources,
    dialect,
    targetSchema,
    targetDatabase,
    strict,
    drafts,
    targets,
    mode = 'limit0',
    rowLimit = 10,
    runner,
    entryRegistry,
  } = opts;

  if (models.length === 0) {
    return { ok: true, results: [] };
  }

  const allModelNames = models.map((m) => m.name.toLowerCase());
  const draftSet = drafts ? lowerSet(drafts) : new Set(allModelNames);
  const targetList = (targets ?? drafts ?? models.map((m) => m.name)).map((s) => s.toLowerCase());
  const targetSet = lowerSet(targetList);

  // Validate that every requested name is known.
  const known = new Set(allModelNames);
  for (const name of [...draftSet, ...targetSet]) {
    if (!known.has(name)) {
      throw new CommandError(`dry-run: model "${name}" is not in the provided model set.`, 2);
    }
  }

  const compileResult = compileInMemory({
    models,
    sources,
    dialect,
    targetSchema,
    targetDatabase,
    selectOnly: true,
    strict,
    inlineDeps: draftSet,
    entryRegistry,
  });

  const { selectByName, failures } = bucketCompileResults(compileResult.results, targetSet);

  if (selectByName.size === 0) {
    return { ok: failures.length === 0, results: failures };
  }

  const executed = await executeDryRunBatch(runner, selectByName, [...targetList], mode, rowLimit);

  const results = [...failures, ...executed];
  return {
    ok: results.every((r) => r.status === 'ok'),
    results,
  };
}

// ---------------------------------------------------------------------------
// `dryRunProject` — file-backed orchestrator
// ---------------------------------------------------------------------------

export async function dryRunProject(
  cwd: string,
  opts: DryRunProjectOptions = {}
): Promise<DryRunProjectResult> {
  const project = opts.project ?? (await loadProject(cwd));
  const mode: DryRunMode = opts.mode ?? 'limit0';
  const rowLimit = opts.rowLimit ?? 10;

  const skipped: DryRunProjectResult['skipped'] = [];
  const perIntegration = selectIntegrationContexts(project, {
    integration: opts.integration,
    onSkipped: (reason) => skipped.push(reason),
  });

  if (perIntegration.length === 0) {
    return {
      ok: true,
      byIntegration: [],
      warnings: [...project.warnings],
      skipped,
    };
  }

  const secretResolver =
    opts.secretResolver ?? (await buildSecretResolver(project.cwd, opts.secrets));

  const byIntegration: DryRunProjectIntegrationResult[] = [];
  let ok = true;

  for (const ictx of perIntegration) {
    const {
      dialect,
      targetSchema,
      targetDatabase,
      targetWarehouse,
      modelReg,
      orderedNodes,
      registry,
      entryRegistry,
      integration,
    } = ictx;

    const allNames = orderedNodes.map((n) => n.name.toLowerCase());
    const draftSet = opts.drafts ? lowerSet(opts.drafts) : new Set(allNames);
    const targetList = (opts.targets ?? opts.drafts ?? orderedNodes.map((n) => n.name)).map((s) =>
      s.toLowerCase()
    );
    const targetSet = lowerSet(targetList);

    const known = new Set(allNames);
    for (const name of [...draftSet, ...targetSet]) {
      if (!known.has(name)) {
        throw new CommandError(
          `[${integration.handle}] dry-run: model "${name}" is not a known model in this integration.`,
          2
        );
      }
    }

    const compileResults = compileAll(orderedNodes, registry, modelReg, {
      dialect,
      targetSchema,
      targetDatabase,
      defaultDynamicTableWarehouse: targetWarehouse,
      entryRegistry,
      selectOnly: true,
      inlineDeps: draftSet,
    });

    const { selectByName, failures } = bucketCompileResults(compileResults, targetSet);

    if (failures.length > 0) ok = false;

    if (selectByName.size === 0) {
      byIntegration.push({
        handle: integration.handle,
        dialect,
        results: failures,
        error:
          failures.length > 0
            ? `${failures.length} model(s) failed to compile for dry-run.`
            : undefined,
      });
      continue;
    }

    let runnerModule: SqlRunnerModule;
    try {
      const interpolated = await interpolateSecrets(integration.integration, secretResolver);
      runnerModule = await resolveRunner(interpolated, {
        secretResolver,
        customRunners: opts.customRunners,
      });
    } catch (err) {
      ok = false;
      const message = err instanceof Error ? err.message : String(err);
      byIntegration.push({
        handle: integration.handle,
        dialect,
        results: failures,
        error: `runner dispatch failed: ${message}`,
      });
      continue;
    }

    let executed: DryRunModelResult[] = [];
    try {
      executed = await executeDryRunBatch(
        runnerModule,
        selectByName,
        [...targetList],
        mode,
        rowLimit
      );
    } finally {
      if (typeof runnerModule.close === 'function') {
        try {
          await runnerModule.close();
        } catch {
          /* swallow close errors — primary dry-run results take precedence */
        }
      }
    }

    const results = [...failures, ...executed];
    const failedCount = results.filter((r) => r.status === 'failed').length;
    if (failedCount > 0) ok = false;

    byIntegration.push({
      handle: integration.handle,
      dialect,
      results,
      error: failedCount > 0 ? `${failedCount} model(s) failed dry-run.` : undefined,
    });
  }

  return {
    ok,
    byIntegration,
    warnings: [...project.warnings],
    skipped,
  };
}

// Re-export the model+model-registry primitives so a host that wants to roll
// its own dry-run loop (e.g. with custom envelope SQL) can do so without
// re-importing from the package root.
export { buildModelRegistry, compileAll, type InMemoryModel, type SourceRegistry };
