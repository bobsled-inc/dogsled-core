/**
 * Source-ref resolution for the Model Spec generator.
 *
 * Given a set of user-provided `SourceSpec`s, build a lookup that maps a
 * Snowflake table reference (the `table` field on a parsed FROM clause —
 * either bare `T`, dotted `S.T`, or fully-qualified `D.S.T`) to its Model Spec ref
 * (`<connection>.<source_name>`).
 *
 * The lookup is case-insensitive: Snowflake uppercases unquoted identifiers,
 * but user YAMLs may declare `table: raw.raw_orders` in lower case. Both forms
 * resolve consistently.
 */

import type { SourceSpec } from '../compiler/schemas.js';

import { normalize, splitDotted } from './identifiers.js';
import { ModelSpecGenerationError } from './types.js';

interface SourceEntry {
  /** `<connection>.<name>` — the value used in `source: { ref: ... }`. */
  ref: string;
  /** Normalized table parts (1, 2, or 3 segments). */
  tableParts: string[];
  /** Source spec name (used for ambiguity error messages). */
  name: string;
  /** The `connection` field from the source spec — used for `defaultConnection` filtering. */
  connection: string;
}

export class SourceResolver {
  private readonly entries: SourceEntry[];
  private readonly defaultConnection: string | undefined;

  constructor(sources: readonly SourceSpec[], defaultConnection?: string) {
    this.defaultConnection = defaultConnection;
    this.entries = sources.map((s) => {
      // Only `warehouse_table` sources have a `table` field; api_resource sources
      // are not directly addressable from a SQL FROM clause and can be referenced
      // only by their `connection.name` form. The generator resolves both, but
      // api_resource sources only match by short name (no FQN comparison).
      if (s.source_type === 'warehouse_table') {
        return {
          ref: `${s.connection}.${s.name}`,
          tableParts: splitDotted(s.table),
          name: s.name,
          connection: s.connection,
        };
      }
      return {
        ref: `${s.connection}.${s.name}`,
        tableParts: [normalize(s.name)],
        name: s.name,
        connection: s.connection,
      };
    });
  }

  /**
   * Look up a source ref from a parsed FROM table reference.
   *
   * `db` is `node-sql-parser`'s qualifier (database for 3-part FQNs, schema for
   * 2-part), `table` is the table name itself. We match progressively from most
   * specific (3-part) to least specific (1-part). When multiple sources match
   * by table name alone, `defaultConnection` (if set) breaks the tie.
   */
  resolve(db: string | null | undefined, table: string): string {
    const normTable = normalize(table);
    const dbParts = db ? splitDotted(db) : [];
    const sqlParts = [...dbParts, normTable];

    const matches = this.entries.filter((e) => isSuffixMatch(e.tableParts, sqlParts));
    if (matches.length === 0) {
      throw new ModelSpecGenerationError(
        'UNRESOLVED_SOURCE',
        `No source spec matches table reference \`${db ? db + '.' : ''}${table}\`. ` +
          `Provide a SourceSpec whose \`table\` field ends with this identifier.`
      );
    }
    if (matches.length > 1) {
      // Multiple matches — try `defaultConnection` as a tie-breaker.
      if (this.defaultConnection) {
        const filtered = matches.filter((m) => m.connection === this.defaultConnection);
        if (filtered.length === 1) return filtered[0]!.ref;
      }
      throw new ModelSpecGenerationError(
        'AMBIGUOUS_SOURCE',
        `Table reference \`${db ? db + '.' : ''}${table}\` matches multiple sources: ` +
          matches.map((m) => m.ref).join(', ') +
          (this.defaultConnection
            ? `. Tried tie-breaking with --default-connection=\`${this.defaultConnection}\` but it did not narrow to a single match.`
            : '. Disambiguate by qualifying the SQL with database/schema or passing --default-connection.')
      );
    }
    return matches[0]!.ref;
  }
}

/**
 * True if `sqlParts` matches the right-hand suffix of `sourceParts`, or
 * `sourceParts` matches the right-hand suffix of `sqlParts`. This makes
 * `FROM users` resolve to a source whose table is `RAW.PUBLIC.USERS`, and
 * `FROM analytics.public.orders` resolve to a source whose table is just
 * `ORDERS` (declared without qualifier).
 */
function isSuffixMatch(sourceParts: readonly string[], sqlParts: readonly string[]): boolean {
  const longer = sourceParts.length >= sqlParts.length ? sourceParts : sqlParts;
  const shorter = sourceParts.length >= sqlParts.length ? sqlParts : sourceParts;
  for (let i = 1; i <= shorter.length; i++) {
    if (longer[longer.length - i] !== shorter[shorter.length - i]) return false;
  }
  return true;
}
