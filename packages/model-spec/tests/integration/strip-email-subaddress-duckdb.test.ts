import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  resolveRunner,
  type IntegrationFile,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';

import { emitExpr, parseExprField } from '../../src/compiler/expr/index.js';

/**
 * End-to-end RE2 proof for `strip_email_subaddress`.
 *
 * DuckDB is the local engine and is backed by the RE2 regex engine, so
 * executing the emitted cleaning SQL against it proves the pattern is RE2-safe.
 * The pre-fix pattern `\+[^@]*(?=@)` throws `Cannot parse regular expression:
 * invalid perl operator: (?=` here; the fixed pattern `\+[^@]*` runs cleanly.
 *
 * Skips when `@duckdb/node-api` is not installed — the always-on codegen RE2
 * guard in `tests/unit/compiler/expr/functions-cleaning.test.ts` still covers
 * the regression in that case.
 */
const duckdbAvailable = await (async () => {
  try {
    await import('@duckdb/node-api');
    return true;
  } catch {
    return false;
  }
})();

const CLEANED_EMAIL = emitExpr(parseExprField('strip_email_subaddress(email)'), 'duckdb');

const memoryIntegration: IntegrationFile = {
  spec_version: '1',
  type: 'integration',
  name: 'duckdb',
  source_type: 'duckdb',
  connection: { schema: 'main' },
  auth: { type: 'memory' },
};

describe.skipIf(!duckdbAvailable)('strip_email_subaddress — DuckDB execution (RE2)', () => {
  let runner: SqlRunnerModule;

  beforeAll(async () => {
    runner = await resolveRunner(memoryIntegration);
  });

  afterAll(async () => {
    await runner?.close?.();
  });

  it('strips plus-addressing end-to-end on DuckDB without RE2 errors', async () => {
    const query = runner.query;
    if (!query) throw new Error('DuckDB runner does not expose query()');

    const rows = await query(
      `SELECT email AS input, ${CLEANED_EMAIL} AS cleaned
       FROM (VALUES ('user+test@example.com'), ('user@example.com'), (CAST(NULL AS VARCHAR)), (''))
       AS t(email)`
    );

    const byInput = new Map(rows.map((row) => [row.input ?? null, row.cleaned ?? null]));

    // Plus-addressing removed.
    expect(byInput.get('user+test@example.com')).toBe('user@example.com');
    // Already-clean address is unchanged.
    expect(byInput.get('user@example.com')).toBe('user@example.com');
    // NULL stays NULL.
    expect(byInput.get(null)).toBe(null);
    // Empty string stays empty.
    expect(byInput.get('')).toBe('');
  });
});
