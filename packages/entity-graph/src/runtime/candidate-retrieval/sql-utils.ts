/**
 * Shared SQL utilities for entity-graph runtime.
 *
 * `assertSafeIdentifier` validates table/column identifiers against a strict
 * pattern before string-interpolating into a SQL template, preventing
 * injection through identifier slots that cannot be parameterised. Per
 */

import { quoteLiteral, type SupportedDialect } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

// Up to two optional dot prefixes so BigQuery 3-part names
// (`project.dataset.table`) pass through. Dialect-aware compiler helpers may
// quote every segment; quoted segments are still limited to the same simple
// identifier alphabet so arbitrary quoted SQL text cannot bypass the guard.
const IDENTIFIER_SEGMENT = '[a-zA-Z_][a-zA-Z0-9_]*';
const UNQUOTED_IDENTIFIER_PATTERN = new RegExp(
  `^${IDENTIFIER_SEGMENT}(\\.${IDENTIFIER_SEGMENT}){0,2}$`
);
const DOUBLE_QUOTED_IDENTIFIER_PATTERN = new RegExp(
  `^"${IDENTIFIER_SEGMENT}"(\\."${IDENTIFIER_SEGMENT}"){0,2}$`
);
const BACKTICK_IDENTIFIER_PATTERN = new RegExp(
  `^\`${IDENTIFIER_SEGMENT}\`(\\.\`${IDENTIFIER_SEGMENT}\`){0,2}$`
);

export function assertSafeIdentifier(identifier: string, context: string): string {
  if (
    !UNQUOTED_IDENTIFIER_PATTERN.test(identifier) &&
    !DOUBLE_QUOTED_IDENTIFIER_PATTERN.test(identifier) &&
    !BACKTICK_IDENTIFIER_PATTERN.test(identifier)
  ) {
    throw new CommandError(
      `Invalid SQL identifier '${identifier}' for ${context}. Allowed: ` +
        `[a-zA-Z_][a-zA-Z0-9_]* with up to two optional dot prefixes ` +
        `(e.g. table | schema.table | project.dataset.table).`,
      2
    );
  }
  return identifier;
}

const ENTITY_TYPE_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function buildEntityTypeFilterSql(
  entityTypes: readonly string[] | undefined,
  expression: string,
  dialect: SupportedDialect
): string {
  if (!entityTypes || entityTypes.length === 0) return '';
  const uniqueTypes = [...new Set(entityTypes)];
  for (const entityType of uniqueTypes) {
    if (!ENTITY_TYPE_PATTERN.test(entityType)) {
      throw new CommandError(`Invalid entity type '${entityType}' for candidate retrieval.`, 2);
    }
  }
  // Values are pre-validated to the identifier alphabet (no quotes possible), but
  // route through model-spec's dialect-aware quoteLiteral so the literal form
  // stays BigQuery-correct (\' rather than '' doubling) if that ever loosens.
  const values = uniqueTypes.map((entityType) => quoteLiteral(entityType, dialect)).join(', ');
  return `AND ${expression} IN (${values})`;
}
