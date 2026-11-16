/**
 * Takes over warehouse tables that an earlier Core generation created, by
 * renaming them in place on first use (`__dogsled_cursors` once Core writes
 * `__bobsled_cursors`, and so on). Never drops a table: when the current name
 * exists already, the earlier table is left alone.
 */
import { caseName, quoteIdentifier } from '../compiler/dialect.js';
import type { PublicationDb } from './sql-publication-storage.js';
import type { PublicationDialect } from './sql-publication-dialect.js';

export interface LegacyTableTarget {
  catalog?: string | undefined;
  schema: string;
}

// Quoting folds case the same way (quoteIdentifier), so the catalog lists the folded name.
const folder = (dialect: PublicationDialect, _target: LegacyTableTarget) => (part: string) =>
  caseName(part, dialect);

async function tableExists(
  db: PublicationDb,
  dialect: PublicationDialect,
  target: LegacyTableTarget,
  name: string
): Promise<boolean> {
  const fold = folder(dialect, target);
  const q = (part: string) => quoteIdentifier(fold(part), dialect);
  const info =
    dialect === 'bigquery'
      ? `${[...(target.catalog ? [target.catalog] : []), target.schema].map(q).join('.')}.INFORMATION_SCHEMA`
      : target.catalog
        ? `${q(target.catalog)}.information_schema`
        : 'information_schema';
  const rows = await db.query(
    `SELECT table_name FROM ${info}.TABLES WHERE table_schema = ${db.p(1)} AND table_name = ${db.p(2)} LIMIT 1`,
    [fold(target.schema), fold(name)]
  );
  return rows.length > 0;
}

/**
 * For each `[current, earlier names]` pair: when `current` is missing and an
 * earlier table exists, rename that table to `current`. A rename that fails
 * while the earlier table still stands and the current one is missing throws,
 * so the caller never creates an empty current table beside saved state.
 */
/** Tables this process saw under their current name, so later calls skip the catalog. */
const settled = new Set<string>();

export async function adoptLegacyWarehouseTables(
  db: PublicationDb,
  dialect: PublicationDialect,
  target: LegacyTableTarget,
  pairs: readonly (readonly [string, readonly string[]])[]
): Promise<string[]> {
  const q = (part: string) => quoteIdentifier(folder(dialect, target)(part), dialect);
  const namespace = [...(target.catalog ? [target.catalog] : []), target.schema].map(q).join('.');
  const adopted: string[] = [];
  for (const [current, names] of pairs) {
    const earlier = names.filter((name) => name.toLowerCase() !== current.toLowerCase());
    const key = `${dialect}:${namespace}.${q(current)}`;
    if (!earlier.length || settled.has(key)) continue;
    if (await tableExists(db, dialect, target, current)) {
      settled.add(key);
      continue;
    }
    // Nothing to adopt when no earlier table exists: the caller creates the current one.
    let found = false;
    for (const name of earlier) {
      if (!(await tableExists(db, dialect, target, name))) continue;
      found = true;
      // Snowflake and Databricks resolve an unqualified new name outside the table's schema.
      const to =
        dialect === 'snowflake' || dialect === 'databricks'
          ? `${namespace}.${q(current)}`
          : q(current);
      try {
        await db.run(`ALTER TABLE ${namespace}.${q(name)} RENAME TO ${to}`);
      } catch (error) {
        if (!(await tableExists(db, dialect, target, current))) throw error;
      }
      adopted.push(name);
      settled.add(key);
      break;
    }
    if (!found) settled.add(key);
  }
  return adopted;
}
