/**
 * Public API for the Model Spec model generator (SQL → Model Spec YAML).
 *
 * Currently scoped to Snowflake views. Sources must be supplied by the caller
 * — the generator does not infer source schemas from the SQL.
 *
 * Failure mode is strict: any unsupported construct (subquery in FROM,
 * correlated subquery, unrecognized function name in BobsledExpr terms) throws
 * a `ModelSpecGenerationError`. Callers can `try/catch` and surface the
 * `error.code` discriminant.
 */

import { createRequire } from 'node:module';

import { TransformSpecSchema, type TransformSpec } from '../compiler/schemas.js';

import { mapStatement } from './mapper.js';
import { preprocessJsonPaths } from './preprocess.js';
import {
  ModelSpecGenerationError,
  type ModelSpecGenerationOptions,
  type ModelSpecGenerationResult,
} from './types.js';

const requireCjs = createRequire(import.meta.url);
// node-sql-parser is a CJS module shipped via webpack that doesn't expose proper
// ESM named exports — pull it in through createRequire so default-import quirks
// don't bite us at runtime.
/* eslint-disable @typescript-eslint/no-explicit-any */
const { Parser } = requireCjs('node-sql-parser') as { Parser: new () => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

const DEFAULT_MODEL_NAME = 'generated_model';
const DEFAULT_DESCRIPTION = 'Generated from SQL';
const SUPPORTED_DIALECTS: ReadonlyArray<ModelSpecGenerationOptions['dialect']> = ['snowflake'];

export function generateModelSpecFromSql(
  sql: string,
  options: ModelSpecGenerationOptions
): ModelSpecGenerationResult {
  if (!SUPPORTED_DIALECTS.includes(options.dialect)) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_DIALECT',
      `SQL dialect \`${options.dialect}\` is not supported. ` +
        `Supported: ${SUPPORTED_DIALECTS.join(', ')}.`
    );
  }

  const modelName = options.modelName ?? DEFAULT_MODEL_NAME;
  const description = options.description ?? DEFAULT_DESCRIPTION;
  const cteNamePrefix = options.cteNamePrefix ?? `${modelName}__`;

  rejectUnsupportedSyntax(sql);

  const preprocessed = preprocessJsonPaths(sql);

  const parser = new Parser();
  let astRaw: unknown;
  try {
    astRaw = parser.astify(preprocessed.sql, { database: 'Snowflake' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ModelSpecGenerationError('PARSE_ERROR', `Failed to parse Snowflake SQL: ${msg}`);
  }

  const statements = Array.isArray(astRaw) ? astRaw : [astRaw];
  if (statements.length !== 1) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_STATEMENT',
      `Expected exactly one SQL statement; got ${statements.length}`
    );
  }
  const stmt = statements[0]!;

  const mapOpts: import('./mapper.js').MapStatementOptions = {
    modelName,
    description,
    cteNamePrefix,
    sources: options.sources,
    preprocessed,
  };
  if (options.defaultConnection !== undefined) {
    mapOpts.defaultConnection = options.defaultConnection;
  }
  const { drafts, warnings } = mapStatement(stmt, mapOpts);

  // Round-trip self-check: run each model through TransformSpecSchema so we
  // never return a YAML payload the compiler would reject.
  const models: TransformSpec[] = [];
  for (const draft of drafts) {
    const result = TransformSpecSchema.safeParse(draft);
    if (!result.success) {
      const issues = result.error.issues
        .map((iss) => `  - ${iss.path.join('.')}: ${iss.message}`)
        .join('\n');
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        `Generated model \`${draft.name}\` failed schema validation:\n${issues}`
      );
    }
    models.push(result.data);
  }

  return { models, warnings };
}

export type {
  ModelSpecGenerationOptions,
  ModelSpecGenerationResult,
  ModelSpecGenerationErrorCode,
  ModelSpecSqlDialect,
} from './types.js';
export { ModelSpecGenerationError } from './types.js';

/**
 * Reject Snowflake constructs the AST mapper would silently drop. Runs before
 * parsing because some of these (e.g. `NULLS FIRST/LAST`) aren't preserved in
 * the node-sql-parser AST and would otherwise be lost without the user
 * noticing.
 */
function rejectUnsupportedSyntax(sql: string): void {
  // Strip string literals and SQL comments (line + block) so the scan only
  // inspects executable SQL — otherwise a `-- NULLS LAST` comment or a
  // `'NULLS FIRST'` string literal would false-positive.
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\r\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  if (/\bNULLS\s+(FIRST|LAST)\b/i.test(stripped)) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      'NULLS FIRST / NULLS LAST in ORDER BY is not supported by the Model Spec generator — node-sql-parser drops the clause and the round-trip would silently change null ordering. Remove the clause or rewrite using an explicit `IS NULL` predicate.'
    );
  }
}
