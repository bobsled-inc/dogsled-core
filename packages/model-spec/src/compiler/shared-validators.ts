import { z } from 'zod';

export const identifierRegex = /^[a-zA-Z_]\w*$/;
export const identifierMsg = 'Must be a valid identifier (letters, digits, underscores)';
export const identifierSchema = z
  .string()
  .trim()
  .min(1, 'Identifier is required')
  .regex(identifierRegex, identifierMsg);

/**
 * Database names follow the identifier rule, plus single internal hyphens so
 * BigQuery project ids (for example `analytics-prod`) can be targeted. The
 * dialect check that limits hyphens to BigQuery runs when the integration is
 * known. Quotes, backticks, dots, semicolons, and whitespace stay rejected.
 */
export const databaseIdentifierRegex = /^[a-zA-Z_]\w*(?:-[a-zA-Z0-9_]+)*$/;
export const databaseIdentifierMsg =
  'Must be a valid identifier (letters, digits, underscores; hyphens only in BigQuery project ids)';

export const databaseIdentifierSchema = z
  .string()
  .min(1)
  .regex(databaseIdentifierRegex, databaseIdentifierMsg);

export function identifierSchemaWithRequiredMessage(message: string): typeof identifierSchema {
  return z.string().trim().min(1, message).regex(identifierRegex, identifierMsg);
}
