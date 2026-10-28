import { CommandError } from './definitions.js';

export function quoteWarehouseLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\x08/g, '\\b')
    .replace(/\f/g, '\\f');
  return `'${escaped}'`;
}

function isUnsafeBacktickCharacter(character: string): boolean {
  const code = character.codePointAt(0)!;
  return character === '\\' || code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
}

/**
 * Backtick-quoted identifiers in BigQuery and ClickHouse honor backslash
 * escapes, so doubling backticks alone cannot keep a value inside the quotes.
 * Reject backslashes and control characters before any backtick quoting.
 */
export function assertBacktickIdentifier(value: string, label = 'identifier'): string {
  if ([...value].some(isUnsafeBacktickCharacter)) {
    throw new CommandError(
      `Invalid ${label}: backslashes and control characters are not allowed in quoted identifiers.`,
      2
    );
  }
  return value;
}

/**
 * BigQuery quoted identifiers cannot escape a backtick by doubling, and they
 * honor backslash escapes. Reject both, plus control characters, for any value
 * placed inside BigQuery backticks.
 */
export function assertBigQueryQuotedIdentifier(
  value: string,
  label = 'BigQuery identifier'
): string {
  assertBacktickIdentifier(value, label);
  if (value.includes('`')) {
    throw new CommandError(`Invalid ${label}: backticks are not allowed.`, 2);
  }
  return value;
}

export function quoteWarehouseIdentifier(
  value: string,
  dialect: 'snowflake' | 'databricks'
): string {
  const delimiter = dialect === 'databricks' ? '`' : '"';
  if (dialect === 'databricks') assertBacktickIdentifier(value, 'Databricks identifier');
  return delimiter + value.replaceAll(delimiter, delimiter + delimiter) + delimiter;
}
