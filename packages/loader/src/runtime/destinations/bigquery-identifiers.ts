import { assertBacktickIdentifier } from '@bobsled-inc/protocol';
/** BigQuery uses backticks for identifier quoting. Backticks cannot be escaped. */
export function quoteBqIdentifier(identifier: string): string {
  if (identifier.includes('`')) {
    throw new Error(`Invalid BigQuery identifier "${identifier}": backticks are not allowed`);
  }
  assertBacktickIdentifier(identifier, 'BigQuery identifier');
  return `\`${identifier}\``;
}
