import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { DatabaseDestination } from '@bobsled-inc/loader';
import { queryResource as defaultQueryResource } from '@bobsled-inc/extractor';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';

import type { ResolvedDestination } from './destination-resolver.js';
import {
  DuckDBMetadataStore,
  type MetadataFinishRefreshArgs,
  type MetadataLeaseArgs,
} from './metadata-store.js';
import { materializeSource, type Receipt } from './materializer.js';
import type { ApiResourceEntry } from './load-specs.js';
import type { SourceMaterializerFeatureFlags } from './feature-flags.js';

/**
 * Hydrate a single `api_resource` source into `destination` using `runner`.
 *
 * Extracted verbatim from the per-source block that lived inline in
 * `runQueryCommand` so both the flat `bobsled query` path and the new model
 * orchestrator share one wiring of `materializeSource`: metadata store,
 * refresh leases, table-existence probe, and (for transient live sources)
 * the metadata-less fast path.
 *
 * Behavior-preserving: callers supply the same `destination`, `database`
 * (`DatabaseDestination`), `runner`, `tempDir`, filter hash, and feature
 * flags they would have passed inline. The function does not close `database`
 * or `runner` — that stays the caller's responsibility.
 */
export interface MaterializeOneSourceArgs {
  entry: ApiResourceEntry;
  destination: ResolvedDestination;
  /** The loader destination already created for this resolved destination. */
  database: DatabaseDestination;
  runner: SqlRunnerModule;
  nowIso: string;
  tempDir: string;
  currentFilterHash: string;
  /**
   * When true, the destination is a run-scoped transient live table: skip the
   * metadata store entirely, treat the table as always-missing, and write the
   * fetched rows into the temp table with no persisted metadata.
   */
  isTransientLive: boolean;
  /** The caller already ensured the metadata table in this destination's schema. */
  metadataTableEnsured?: boolean;
  /** Optional partial-materialization limit forwarded to `materializeSource`. */
  queryLimit?: number;
  /** Canonical (non-limit) table name when partial materialization renamed the table. */
  canonicalTable?: string;
  queryResourceImpl?: typeof defaultQueryResource;
  integrationSpecLoader?: typeof loadQueryableResourceSpecs;
  featureFlags?: Partial<SourceMaterializerFeatureFlags>;
  secrets?: Record<string, string | undefined>;
  /**
   * Probe physical-table existence when no metadata store is in play. Mirrors
   * the inline `physicalTableExists(runner, destination)` fallback; injected so
   * this module stays free of the lazy-query-engine's SQL helpers.
   */
  physicalTableExists: (args: { schema: string; table: string }) => Promise<boolean>;
  destinationIdentity: (destination: ResolvedDestination) => string;
}

export async function materializeOneSource(args: MaterializeOneSourceArgs): Promise<Receipt> {
  const { entry, destination, database, runner, isTransientLive } = args;

  // BigQuery jobs run independently in the current runner, so BEGIN/COMMIT
  // based leases are not a real mutual-exclusion mechanism there.
  const metadataStore = isTransientLive
    ? undefined
    : new DuckDBMetadataStore({
        runner,
        dialect: destination.sqlRunnerKind,
        ...(args.metadataTableEnsured ? { ensuredSchemas: [destination.schema] } : {}),
      });
  const refreshLeaseCallbacks =
    metadataStore && destination.sqlRunnerKind !== 'bigquery'
      ? {
          beginRefresh: (leaseArgs: MetadataLeaseArgs) => metadataStore.beginRefresh(leaseArgs),
          finishRefresh: (leaseArgs: MetadataFinishRefreshArgs) =>
            metadataStore.finishRefresh(leaseArgs),
        }
      : {};

  return materializeSource({
    entry,
    nowIso: args.nowIso,
    tempRootDir: args.tempDir,
    target: destination.kind,
    schema: destination.schema,
    table: destination.table,
    ...(args.canonicalTable !== undefined ? { canonicalTable: args.canonicalTable } : {}),
    destination: database,
    destinationScopeKey: `${args.destinationIdentity(destination)}:${destination.fullyQualified}`,
    readRow: metadataStore ? (readArgs) => metadataStore.read(readArgs) : async () => undefined,
    tableExists: isTransientLive
      ? async () => false
      : metadataStore
        ? (tableArgs) => metadataStore.tableExists(tableArgs)
        : ({ schema, table }) => args.physicalTableExists({ schema, table }),
    upsertRow: metadataStore
      ? (writeArgs) => metadataStore.write(writeArgs)
      : async () => undefined,
    ...refreshLeaseCallbacks,
    currentFilterHash: args.currentFilterHash,
    ...(args.queryResourceImpl !== undefined ? { queryResourceImpl: args.queryResourceImpl } : {}),
    ...(args.integrationSpecLoader !== undefined
      ? { integrationSpecLoader: args.integrationSpecLoader }
      : {}),
    ...(args.featureFlags !== undefined ? { featureFlags: args.featureFlags } : {}),
    ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
    runner,
    dialect: destination.sqlRunnerKind,
    ...(args.queryLimit !== undefined ? { queryLimit: args.queryLimit } : {}),
  });
}
