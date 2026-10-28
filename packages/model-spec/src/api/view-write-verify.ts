import { assertBigQueryQuotedIdentifier } from '@bobsled-inc/protocol';
/**
 * Post-write verification that `view` materializations which reported success
 * actually exist in the warehouse catalog.
 *
 * Why this exists: the executor reports `MODEL_STATEMENT status:'success'`
 * whenever `run()` does not throw, and thin DDL runners return `{ rowCount: 0 }`
 * without reading the object back. A swallowed/transient runner error — or a
 * stale input SQL right after a deploy — is therefore indistinguishable from a
 * real `CREATE OR REPLACE VIEW`. This check reads each succeeded view back from
 * the catalog (BigQuery's dataset-qualified `INFORMATION_SCHEMA.VIEWS`, or the
 * generic `information_schema.views`) and turns a silent no-op into a loud
 * failure.
 *
 * The function is pure: it returns the failures it found. The caller flips the
 * matching execution-result entries to `failed` and sets `ok = false`. Shape
 * and call site mirror `preflightBigQueryPlan`.
 */

import { isCancellationError, throwIfCancelled } from '@bobsled-inc/connections';

import {
  caseName,
  getCanonicalDialect,
  quoteLiteral,
  type DagNode,
  type ModelExecutionResult,
  type SqlRunnerModule,
  type SupportedDialect,
} from '../compiler/index.js';

import type { IntegrationCompileContext } from './integration-context.js';

/** Minimal shape of a planned materialized model needed for verification. */
export interface VerifiableMaterializedModel {
  node: DagNode;
}

export interface VerifyViewsWrittenCallbacks {
  onWarn?: (msg: string) => void;
}

/**
 * Verify that every `view` model in `models` exists in the warehouse catalog.
 *
 * Pass only models whose execution reported success — already-failed models are
 * skipped at the call site so we never double-report them. Non-view models are
 * ignored here as a defensive second filter.
 */
export async function verifyViewsWritten(
  ictx: IntegrationCompileContext,
  models: VerifiableMaterializedModel[],
  runner: SqlRunnerModule,
  callbacks?: VerifyViewsWrittenCallbacks,
  signal?: AbortSignal
): Promise<ModelExecutionResult[]> {
  const viewModels = models.filter((m) => m.node.materialization === 'view');
  if (viewModels.length === 0) return [];

  // Built-in runners may omit `query()` (e.g. a write-only DDL runner). Without
  // a row-returning surface we cannot read the catalog, so skip with a note
  // rather than fail — verification is a backstop, not a hard gate.
  if (typeof runner.query !== 'function') {
    callbacks?.onWarn?.(
      `[${ictx.integration.handle}] Skipping view-write verification: the resolved runner ` +
        'does not expose query() to read INFORMATION_SCHEMA.'
    );
    return [];
  }
  const query = runner.query;

  const failures: ModelExecutionResult[] = [];
  for (const { node } of viewModels) {
    // Verification is a post-write backstop, but it still costs catalog reads —
    // stop issuing them once the caller has cancelled.
    throwIfCancelled(signal);
    const spec = node.parsedSpec;
    const effectiveSchema = spec.target_schema ?? ictx.targetSchema;
    const effectiveDatabase = spec.target_database ?? ictx.targetDatabase;

    const existsSql = buildViewExistsQuery(
      ictx.dialect,
      effectiveSchema,
      effectiveDatabase,
      node.name
    );
    if (existsSql === undefined) {
      callbacks?.onWarn?.(
        `[${ictx.integration.handle}] Skipping view-write verification for "${node.name}": ` +
          `dialect "${ictx.dialect}" has no catalog existence query.`
      );
      continue;
    }

    let exists: boolean;
    try {
      // Call with the original single argument when no signal is in play, so a
      // runner (or a test double) observes exactly the arity it always has.
      const rows = signal ? await query(existsSql, undefined, { signal }) : await query(existsSql);
      exists = rows.length > 0;
    } catch (err) {
      // Cancellation is not an inconclusive catalog read — propagate so the run
      // reports `cancelled` rather than silently skipping verification.
      if (isCancellationError(err, signal)) throw err;
      // The catalog read itself failed — we cannot confirm presence either way.
      // Do NOT convert a verification-read error into a false model failure;
      // the no-op we care about is "query succeeds and returns zero rows".
      callbacks?.onWarn?.(
        `[${ictx.integration.handle}] Could not verify view ${effectiveSchema}.${node.name} ` +
          `exists: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    if (!exists) {
      failures.push({
        modelName: node.name,
        status: 'failed',
        error:
          `View ${effectiveSchema}.${node.name} reported success but is absent from the ` +
          'warehouse catalog after the run. The CREATE OR REPLACE VIEW statement was a silent ' +
          'no-op (a swallowed/transient runner error, or stale input SQL right after a deploy). ' +
          'Re-run the model.',
        exitCode: 1,
      });
    }
  }

  return failures;
}

/**
 * Build a dialect-aware "does this view exist?" query against the warehouse
 * catalog. Returns `undefined` for dialects with no known catalog shape (the
 * caller skips those with a warning).
 *
 * Identifiers are matched in their dialect-folded form (`caseName`) because Model Spec
 * creates views via `quoteIdentifier`, which case-folds the stored object name
 * (UPPER on Snowflake, lower elsewhere).
 */
export function buildViewExistsQuery(
  dialect: SupportedDialect,
  schema: string,
  database: string | undefined,
  viewName: string
): string | undefined {
  const view = caseName(viewName, dialect);

  switch (getCanonicalDialect(dialect)) {
    case 'bigquery': {
      // INFORMATION_SCHEMA.VIEWS is dataset-scoped. The dataset comes from the
      // schema's last segment; the project from the database, or the schema's
      // leading segment when it is authored as `project.dataset`.
      const segments = splitIdentifierPath(schema);
      const dataset = segments[segments.length - 1] ?? schema;
      const project = database ?? (segments.length > 1 ? segments[0] : undefined);
      const path = project
        ? `${project}.${dataset}.INFORMATION_SCHEMA.VIEWS`
        : `${dataset}.INFORMATION_SCHEMA.VIEWS`;
      return (
        `SELECT table_name FROM \`${assertBigQueryQuotedIdentifier(path, 'BigQuery view path')}\` ` +
        `WHERE table_name = ${quoteLiteral(view, dialect)} LIMIT 1`
      );
    }

    case 'snowflake': {
      // INFORMATION_SCHEMA is database-scoped. Database from the explicit field
      // or the schema's leading segment when authored as `DATABASE.SCHEMA`.
      const segments = splitIdentifierPath(schema);
      const schemaName = caseName(segments[segments.length - 1] ?? schema, dialect);
      const catalog = database ?? (segments.length > 1 ? segments[0] : undefined);
      const from = catalog
        ? `${caseName(catalog, dialect)}.INFORMATION_SCHEMA.VIEWS`
        : 'INFORMATION_SCHEMA.VIEWS';
      return (
        `SELECT table_name FROM ${from} ` +
        `WHERE table_schema = ${quoteLiteral(schemaName, dialect)} ` +
        `AND table_name = ${quoteLiteral(view, dialect)} LIMIT 1`
      );
    }

    case 'databricks': {
      // Unity Catalog: <catalog>.information_schema.views.
      const segments = splitIdentifierPath(schema);
      const schemaName = caseName(segments[segments.length - 1] ?? schema, dialect);
      const catalog = database ?? (segments.length > 1 ? segments[0] : undefined);
      const from = catalog
        ? `${caseName(catalog, dialect)}.information_schema.views`
        : 'information_schema.views';
      return (
        `SELECT table_name FROM ${from} ` +
        `WHERE table_schema = ${quoteLiteral(schemaName, dialect)} ` +
        `AND table_name = ${quoteLiteral(view, dialect)} LIMIT 1`
      );
    }

    case 'mysql': {
      // MySQL has no schema separate from the database — the view lives in a
      // database and `table_schema` is that database name.
      const segments = splitIdentifierPath(schema);
      const dbName = caseName(database ?? segments[segments.length - 1] ?? schema, dialect);
      return (
        'SELECT table_name FROM information_schema.views ' +
        `WHERE table_schema = ${quoteLiteral(dbName, dialect)} ` +
        `AND table_name = ${quoteLiteral(view, dialect)} LIMIT 1`
      );
    }

    case 'postgres':
    case 'duckdb': {
      // Single-database engines: plain information_schema.views, scoped by the
      // schema's last segment.
      const segments = splitIdentifierPath(schema);
      const schemaName = caseName(segments[segments.length - 1] ?? schema, dialect);
      return (
        'SELECT table_name FROM information_schema.views ' +
        `WHERE table_schema = ${quoteLiteral(schemaName, dialect)} ` +
        `AND table_name = ${quoteLiteral(view, dialect)} LIMIT 1`
      );
    }

    default:
      return undefined;
  }
}

/** Split a dotted identifier path into trimmed, unquoted segments. */
function splitIdentifierPath(value: string): string[] {
  return value
    .split('.')
    .map((part) => part.trim().replace(/^["`]|["`]$/g, ''))
    .filter((part) => part.length > 0);
}
