/**
 * Run state tracking for incremental materializations and trust tiers.
 *
 * Persists model run metadata to `.bobsled/model-spec/run-state.json` for
 * first-run detection, change tracking, and trust tier management.
 */

import * as crypto from 'node:crypto';

import { canonicalize } from 'json-canonicalize';

import { CommandError } from '../errors.js';

export { loadState, saveState, updateLocalState } from './state-file.js';
import { bucketColumnType } from './parser.js';

import type { SourceEntryColumnType } from './parser.js';

// ---------------------------------------------------------------------------
// Types & validation
// ---------------------------------------------------------------------------

export const STATE_SCHEMA_VERSION = 1;

export interface ModelRunState {
  lastRunAt: string;
  materialization: string;
  specChecksum: string;
  selectSignature?: string;
  columns?: SelectStateColumn[];
  publishedSnapshotId?: string;
  publishedAt?: string;
  /**
   * Snapshot of the model's incremental strategy at last successful run
   * (`merge` | `delete_insert` | `append`). Omitted for non-incremental models
   * and for state written by Bobsled Core versions prior to drift-detection.
   */
  strategy?: string;
  /**
   * Normalized unique-key column list (lowercased, order preserved). Compared
   * positionally — reordering is treated as a change because some downstream
   * MERGE behaviors are key-order-sensitive at the SQL planner level.
   */
  uniqueKey?: string[];
  /**
   * Whitespace-normalized incremental filter (trimmed, internal whitespace
   * collapsed to a single space). Lets cosmetic edits (reformatting, adding
   * line breaks) round-trip without forcing a recreate.
   */
  incrementalFilter?: string;
  /** `fail` | `full_refresh`. Stored to detect flips between policies. */
  onSchemaChange?: string;
  /** Resolved target schema as Bobsled Core materialized to on the last run. */
  targetSchema?: string;
  /** Resolved target database (optional in single-database integrations). */
  targetDatabase?: string;
  /**
   * Fully-qualified destination name from the last successful run. When the
   * current run's resolved fqName differs, the planner DROPs *this* name
   * before creating at the new destination.
   */
  priorFqName?: string;
  /**
   * Forward-compatibility: unknown fields written by a newer Bobsled Core version
   * are preserved on round-trip. Indexer is `unknown` to avoid implying we
   * understand the shape.
   */
  [extra: string]: unknown;
}

export interface RunState {
  models: Record<string, ModelRunState>;
  /** Forward-compat: unknown root-level metadata round-trips losslessly. */
  [extra: string]: unknown;
}

export interface SelectColumnInput {
  name: string;
  type?: string | null | undefined;
  primary_key?: boolean;
  not_null?: boolean;
}

export interface SelectStateColumn {
  name: string;
  type: SourceEntryColumnType;
  primary_key: boolean;
  not_null: boolean;
  /** Forward-compat: unknown per-column fields round-trip losslessly. */
  [extra: string]: unknown;
}

export interface SelectSignatureResult {
  signature: string;
  columns: SelectStateColumn[];
}

export interface SelectColumnDiff {
  added: SelectStateColumn[];
  removed: SelectStateColumn[];
  changed: Array<{ before: SelectStateColumn; after: SelectStateColumn }>;
  hasChanges: boolean;
}

/** Key shape for per-integration run state: `<handle>.<model_name>`. */
export function stateKey(handle: string, modelName: string): string {
  return `${handle}.${modelName.toLowerCase()}`;
}

export function isFirstRun(state: RunState, modelName: string, handle?: string): boolean {
  if (handle !== undefined) {
    const key = stateKey(handle, modelName);
    return !Object.prototype.hasOwnProperty.call(state.models, key);
  }
  const key = modelName.toLowerCase();
  return !Object.keys(state.models).some((k) => k.toLowerCase() === key);
}

export function computeChecksum(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Normalize a unique-key spec for run-state storage.
 *
 * Returns `undefined` for "not configured" so that comparing two states where
 * neither side specified a unique key reads as "no change," not as
 * `[] !== undefined`. Column names are lowercased so case-only edits
 * (`customer_id` vs `Customer_ID`) don't spuriously force a recreate — every
 * supported dialect either folds case (Snowflake, Postgres, BigQuery) or
 * compares case-insensitively at the identifier level for these keys.
 *
 * Order is preserved: MERGE ON clauses are emitted in the listed order, and
 * some warehouses' query planners build indexes/clustering keys positionally,
 * so re-ordering the list is treated as a meaningful change downstream.
 */
export function normalizeUniqueKeyForState(
  key: string | string[] | null | undefined
): string[] | undefined {
  if (key === null || key === undefined) return undefined;
  const list = Array.isArray(key) ? key : [key];
  if (list.length === 0) return undefined;
  return list.map((k) => k.toLowerCase());
}

/**
 * Whitespace-normalize an incremental_filter expression for state comparison.
 *
 * The string is trimmed and any run of internal whitespace (spaces, tabs,
 * newlines) is collapsed to a single space. Two filters that differ only in
 * formatting compare equal; two filters that differ semantically still
 * compare unequal. We deliberately do **not** parse the SQL — full AST
 * normalization would be brittle and expensive, and the user is best served
 * by a predictable "reformat is fine, anything else recreates" rule.
 */
export function normalizeIncrementalFilterForState(
  filter: string | null | undefined
): string | undefined {
  if (filter === null || filter === undefined) return undefined;
  const collapsed = filter.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? undefined : collapsed;
}

export function normalizeSelectColumns(columns: SelectColumnInput[]): SelectStateColumn[] {
  return columns
    .map((column) => ({
      name: column.name,
      type: bucketColumnType(column.type ?? 'string'),
      primary_key: Boolean(column.primary_key),
      not_null: Boolean(column.not_null),
    }))
    .sort(compareSelectColumns);
}

export function computeSelectState(columns: SelectColumnInput[]): SelectSignatureResult {
  if (columns.length === 0) {
    throw new CommandError('Cannot compute select signature without columns.', 2);
  }

  const payload = normalizeSelectColumns(columns);
  const canonicalPayload = canonicalize(payload);
  if (canonicalPayload === undefined) {
    throw new CommandError('Cannot compute select signature for non-canonical column payload.', 2);
  }
  const hash = crypto.createHash('sha256').update(canonicalPayload).digest('hex').slice(0, 16);
  return { signature: `v${STATE_SCHEMA_VERSION}:${hash}`, columns: payload };
}

export function diffSelectColumns(
  previous: SelectStateColumn[] | undefined,
  next: SelectStateColumn[] | undefined
): SelectColumnDiff {
  const previousByName = indexColumns(previous ?? []);
  const nextByName = indexColumns(next ?? []);
  const added: SelectStateColumn[] = [];
  const removed: SelectStateColumn[] = [];
  const changed: Array<{ before: SelectStateColumn; after: SelectStateColumn }> = [];

  for (const [key, after] of nextByName) {
    const before = previousByName.get(key);
    if (!before) {
      added.push(after);
      continue;
    }
    if (
      before.name !== after.name ||
      before.type !== after.type ||
      Boolean(before.primary_key) !== Boolean(after.primary_key) ||
      Boolean(before.not_null) !== Boolean(after.not_null)
    ) {
      changed.push({ before, after });
    }
  }

  for (const [key, before] of previousByName) {
    if (!nextByName.has(key)) {
      removed.push(before);
    }
  }

  added.sort(compareSelectColumns);
  removed.sort(compareSelectColumns);
  changed.sort((a, b) => compareSelectColumns(a.before, b.before));

  return {
    added,
    removed,
    changed,
    hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
  };
}

function compareSelectColumns(a: SelectStateColumn, b: SelectStateColumn): number {
  const lower = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  if (lower !== 0) return lower;
  return a.name.localeCompare(b.name);
}

function indexColumns(columns: SelectStateColumn[]): Map<string, SelectStateColumn> {
  const indexed = new Map<string, SelectStateColumn>();
  for (const column of columns) {
    indexed.set(column.name.toLowerCase(), column);
  }
  return indexed;
}
