import type { LoaderLogger } from '../logger.js';
import { LEGACY_LOADED_AT_COLUMNS, LEGACY_UNIQUE_INDEX_PREFIXES } from '../legacy-names.js';

/**
 * Taking over an earlier loaded-at column (for example `_dogsled_loaded_at`
 * once Core writes `_bobsled_loaded_at`), the first time a run sees a table:
 *
 * - only the current column: nothing to do;
 * - only an earlier column: rename it in place;
 * - both: keep loading into the current column and copy the earlier values
 *   into its empty rows once. The earlier column is never dropped.
 *
 * When a warehouse refuses the rename (for example a BigQuery table with a
 * search index or row access policy, or a Delta table without column
 * mapping), the earlier column stays, the current column is added by the
 * usual system-column step and the earlier values are copied into it, so the
 * data reads under the current name.
 */

export type LoadedAtTakeoverPlan =
  | { action: 'none' }
  | { action: 'rename'; from: string }
  | { action: 'fill'; from: string };

/** Earlier loaded-at names that differ from the column Core writes now. */
export function legacyLoadedAtColumns(current: string): string[] {
  return LEGACY_LOADED_AT_COLUMNS.filter((name) => name.toLowerCase() !== current.toLowerCase());
}

/** Decide the takeover from a table's existing column names (matched case-insensitively). */
export function planLoadedAtTakeover(
  existingNames: Iterable<string>,
  current: string
): LoadedAtTakeoverPlan {
  const byLower = new Map<string, string>();
  for (const name of existingNames) byLower.set(name.toLowerCase(), name);
  const legacy = legacyLoadedAtColumns(current)
    .map((name) => byLower.get(name.toLowerCase()))
    .find((name): name is string => name !== undefined);
  if (legacy === undefined) return { action: 'none' };
  return byLower.has(current.toLowerCase())
    ? { action: 'fill', from: legacy }
    : { action: 'rename', from: legacy };
}

export interface LoadedAtTakeoverOptions<T> {
  /** Qualified table name, for log lines only. */
  table: string;
  /** Existing columns keyed as the destination stores them; updated in place after a rename. */
  existing: Map<string, T>;
  /** The loaded-at column Core writes, spelled the way `existing` keys it. */
  current: string;
  rename(from: string, to: string): Promise<void>;
  /** Re-read the table's columns after a failed rename (another run may have renamed it). */
  reread(): Promise<Map<string, T>>;
  logger?: LoaderLogger | undefined;
}

export interface LoadedAtTakeoverResult {
  /** Earlier column whose values still need copying into the current column. */
  fillFrom?: string;
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Rename an earlier loaded-at column when the table has no current one. Run before schema checks. */
export async function takeOverLegacyLoadedAt<T>(
  options: LoadedAtTakeoverOptions<T>
): Promise<LoadedAtTakeoverResult> {
  const { existing, current, table, logger } = options;
  const plan = planLoadedAtTakeover(existing.keys(), current);
  if (plan.action === 'none') return {};
  if (plan.action === 'fill') return { fillFrom: plan.from };
  try {
    await options.rename(plan.from, current);
    const type = existing.get(plan.from) as T;
    existing.delete(plan.from);
    existing.set(current, type);
    logger?.info('loaded_at_column_taken_over', { table, from: plan.from, to: current });
    return {};
  } catch (error) {
    const fresh = await options.reread();
    existing.clear();
    for (const [name, type] of fresh) existing.set(name, type);
    const again = planLoadedAtTakeover(existing.keys(), current);
    if (again.action === 'none') return {};
    if (again.action === 'rename') {
      logger?.warn('loaded_at_column_rename_refused', {
        table,
        from: again.from,
        to: current,
        note: 'keeping the earlier column; the current column is added and filled from it',
        reason: reason(error),
      });
    }
    return { fillFrom: again.from };
  }
}

/** The note Core leaves on the earlier column once its values are copied, so it copies once. */
export function loadedAtFilledNote(current: string): string {
  return `Core copied this column into ${current}`;
}

/**
 * Metadata-only proof that the copy is done: a column comment where the warehouse has one,
 * else Core's own marker. Never a scan of the data.
 */
export interface LoadedAtFillMarker {
  done(from: string, note: string): Promise<boolean>;
  mark(from: string, note: string): Promise<void>;
}

/**
 * Copy earlier loaded-at values into empty current ones, once: the marker is read first and
 * written after the copy. A run that dies in between repeats the copy, which only touches rows
 * that are still empty. A failure is logged and retried on the next run instead of failing the
 * load.
 */
export async function fillLegacyLoadedAt(
  result: LoadedAtTakeoverResult,
  options: {
    table: string;
    current: string;
    fill(from: string, to: string): Promise<void>;
    marker: LoadedAtFillMarker;
    logger?: LoaderLogger | undefined;
  }
): Promise<void> {
  if (!result.fillFrom) return;
  const note = loadedAtFilledNote(options.current);
  try {
    if (await options.marker.done(result.fillFrom, note)) return;
    await options.fill(result.fillFrom, options.current);
    await options.marker.mark(result.fillFrom, note);
    options.logger?.info('loaded_at_column_filled', {
      table: options.table,
      from: result.fillFrom,
      to: options.current,
    });
  } catch (error) {
    options.logger?.warn('loaded_at_column_fill_failed', {
      table: options.table,
      from: result.fillFrom,
      to: options.current,
      reason: reason(error),
    });
  }
}

/** `UPDATE` statement shared by the SQL destinations. */
export function loadedAtFillSql(
  qualifiedTable: string,
  quote: (identifier: string) => string,
  from: string,
  to: string
): string {
  return `UPDATE ${qualifiedTable} SET ${quote(to)} = ${quote(from)} WHERE ${quote(to)} IS NULL AND ${quote(from)} IS NOT NULL`;
}

/**
 * Names an earlier Core release gave the unique merge index of `table`. When
 * one exists the destination keeps using it instead of adding a second index.
 */
export function legacyUniqueIndexNames(table: string, currentPrefix: string): string[] {
  return LEGACY_UNIQUE_INDEX_PREFIXES.filter(
    (prefix) => prefix.toLowerCase() !== currentPrefix.toLowerCase()
  ).map((prefix) => `${prefix}${table}`);
}

/**
 * The takeover for a SQL destination in one call: renames now (before schema
 * checks) and returns the step that copies earlier values, to run once the
 * current column exists.
 */
export async function takeOverLoadedAtSql<T>(options: {
  table: string;
  existing: Map<string, T>;
  current: string;
  quote(identifier: string): string;
  run(sql: string): Promise<unknown>;
  reread(): Promise<Map<string, T>>;
  marker: LoadedAtFillMarker;
  logger?: LoaderLogger | undefined;
}): Promise<() => Promise<void>> {
  const { table, current, quote, run, logger } = options;
  const result = await takeOverLegacyLoadedAt({
    table,
    existing: options.existing,
    current,
    rename: async (from, to) => {
      await run(`ALTER TABLE ${table} RENAME COLUMN ${quote(from)} TO ${quote(to)}`);
    },
    reread: options.reread,
    logger,
  });
  return () =>
    fillLegacyLoadedAt(result, {
      table,
      current,
      fill: async (from, to) => {
        await run(loadedAtFillSql(table, quote, from, to));
      },
      marker: options.marker,
      logger,
    });
}

/** SQL string literal with single quotes doubled (the note is Core's own text). */
export function noteLiteral(note: string): string {
  return `'${note.replaceAll("'", "''")}'`;
}
