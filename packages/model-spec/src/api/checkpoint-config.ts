import { resolve } from 'node:path';
import type { DuckDbIntegration, IntegrationFile } from '@bobsled-inc/connections';
import { readDefaultAgenticCursor } from '../agentic/default-state.js';
import { realDuckDbPath } from '../agentic/duckdb-file.js';
import {
  createDuckDbCheckpointStore,
  duckDbPublicationCursorReader,
} from '../agentic/duckdb-state.js';
import type { AgenticStateStore } from '../agentic/state.js';
import { resolveWarehouseCheckpointTarget } from '../agentic/warehouse-checkpoint-target.js';
import type { CheckpointStoreConfig } from '../config.js';
import { CommandError } from '../errors.js';
import type { LoadedProject } from './load-project.js';

export function checkpointIntegration(project: LoadedProject) {
  const config = project.config.checkpointStore;
  if (!config) return undefined;
  const integration = project.integrations.get(config.integration);
  if (!integration) {
    throw new CommandError('checkpoint_store references an unknown integration', 2);
  }
  const { source_type: sourceType } = integration.integration;
  if (config.retention_days !== undefined && sourceType !== 'duckdb') {
    throw new CommandError('checkpoint_store.retention_days requires a DuckDB integration', 2);
  }
  try {
    resolveWarehouseCheckpointTarget(integration.integration, config);
  } catch (cause) {
    throw new CommandError(cause instanceof Error ? cause.message : 'Invalid checkpoint target', 2);
  }
  return integration;
}

const sharedFile = (): CommandError =>
  new CommandError(
    'checkpoint_store must not use the DuckDB file that holds model output; give it a file of its own',
    2
  );

/**
 * A host reads a model's target outside the store's file guard, and overlapping instances of
 * one file in a process can drop its lock. So DuckDB state needs a file of its own. This sees
 * the configuration as written, so it also holds for a dry run, which resolves no secrets.
 */
export function assertCheckpointFile(
  checkpoint: IntegrationFile,
  targets: readonly IntegrationFile[]
): void {
  if (checkpoint.source_type !== 'duckdb') return;
  if (checkpoint.auth.type !== 'file' || checkpoint.auth.read_only) {
    throw new CommandError('A DuckDB checkpoint_store needs a writable, file-backed database', 2);
  }
  const file = resolve(checkpoint.auth.path);
  for (const target of targets) {
    if (
      target.source_type === 'duckdb' &&
      target.auth.type === 'file' &&
      resolve(target.auth.path) === file
    ) {
      throw sharedFile();
    }
  }
}

/**
 * The same rule on what the paths really name, once secrets are resolved: a secret, a symlink
 * or another spelling can lead to one file through paths that differ as written. Comparing
 * creates nothing, so a read-only target's directory stays as it is.
 */
export async function assertCheckpointFileResolved(
  checkpoint: IntegrationFile,
  targets: readonly IntegrationFile[]
): Promise<void> {
  if (checkpoint.source_type !== 'duckdb' || checkpoint.auth.type !== 'file') return;
  const file = await realDuckDbPath(checkpoint.auth.path);
  for (const target of targets) {
    if (target.source_type !== 'duckdb' || target.auth.type !== 'file') continue;
    if ((await realDuckDbPath(target.auth.path)) === file) throw sharedFile();
  }
}

/** Before this setting, a DuckDB target held the cursors and otherwise the default store did. */
export function configuredDuckDbStore(
  project: string,
  config: CheckpointStoreConfig,
  integration: DuckDbIntegration,
  target: IntegrationFile,
  signal?: AbortSignal
): AgenticStateStore {
  const fromTarget =
    target.source_type === 'duckdb' ? duckDbPublicationCursorReader(target, signal) : undefined;
  return createDuckDbCheckpointStore(integration, {
    schema: config.schema,
    ...(config.lease_seconds === undefined ? {} : { leaseMs: config.lease_seconds * 1000 }),
    ...(config.retention_days === undefined
      ? {}
      : { retentionMs: config.retention_days * 86_400_000 }),
    ...(signal ? { signal } : {}),
    legacyCursors: async (key) =>
      (await fromTarget?.(key)) ?? readDefaultAgenticCursor(project, key),
  });
}
