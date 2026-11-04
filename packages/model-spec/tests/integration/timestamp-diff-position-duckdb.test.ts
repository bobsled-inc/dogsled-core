import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  resolveRunner,
  type IntegrationFile,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';

import { emitExpr, parseExprField } from '../../src/compiler/expr/index.js';

const duckdbAvailable = await (async () => {
  try {
    await import('@duckdb/node-api');
    return true;
  } catch {
    return false;
  }
})();

const memoryIntegration: IntegrationFile = {
  spec_version: '1',
  type: 'integration',
  name: 'duckdb',
  source_type: 'duckdb',
  connection: { schema: 'main' },
  auth: { type: 'memory' },
};

describe.skipIf(!duckdbAvailable)('timestamp_diff and position — DuckDB execution', () => {
  let runner: SqlRunnerModule;

  beforeAll(async () => {
    runner = await resolveRunner(memoryIntegration);
  });

  afterAll(async () => {
    await runner?.close?.();
  });

  async function evaluate(expr: string): Promise<unknown> {
    if (!runner.query) throw new Error('DuckDB runner does not expose query()');
    const sql = emitExpr(parseExprField(expr), 'duckdb');
    const rows = await runner.query(`SELECT ${sql} AS result`);
    return rows[0]?.result;
  }

  it.each([
    ['microsecond', '1970-01-01 00:00:01', 1000000],
    ['millisecond', '1970-01-01 00:00:01', 1000],
    ['second', '1970-01-01 00:00:01', 1],
    ['minute', '1970-01-01 00:01:00', 1],
    ['hour', '1970-01-01 01:00:00', 1],
    ['day', '1970-01-02', 1],
    ['week', '1970-01-08', 1],
    ['month', '1970-02-01', 1],
    ['quarter', '1970-04-01', 1],
    ['year', '1971-01-01', 1],
  ] as const)('computes signed %s differences', async (unit, end, expected) => {
    const startTs = "CAST('1970-01-01' AS TIMESTAMP)";
    const endTs = `CAST('${end}' AS TIMESTAMP)`;
    expect(Number(await evaluate(`timestamp_diff('${unit}', ${startTs}, ${endTs})`))).toBe(
      expected
    );
    expect(Number(await evaluate(`timestamp_diff('${unit}', ${endTs}, ${startTs})`))).toBe(
      -expected
    );
  });

  it('preserves microseconds and cursor values beyond 32-bit integers', async () => {
    expect(
      Number(
        await evaluate(
          "timestamp_diff('microsecond', CAST('1970-01-01' AS TIMESTAMP), CAST('1970-01-02 00:00:00.000001' AS TIMESTAMP))"
        )
      )
    ).toBe(86400000001);
  });

  it('counts hour and month boundaries rather than complete elapsed units', async () => {
    expect(
      Number(
        await evaluate(
          "timestamp_diff('hour', CAST('1970-01-01 00:59:59' AS TIMESTAMP), CAST('1970-01-01 01:00:00' AS TIMESTAMP))"
        )
      )
    ).toBe(1);
    expect(
      Number(
        await evaluate(
          "timestamp_diff('month', CAST('1970-01-31' AS TIMESTAMP), CAST('1970-02-01' AS TIMESTAMP))"
        )
      )
    ).toBe(1);
  });

  it.each([
    ["position('an', 'banana')", 2n],
    ["position('ba', 'banana')", 1n],
    ["position('xy', 'banana')", 0n],
    ["position('fé', 'café')", 3n],
    ["position('an', NULL)", null],
    ["position(NULL, 'banana')", null],
  ] as const)('evaluates %s with canonical needle/haystack order', async (expr, expected) => {
    expect(await evaluate(expr)).toBe(expected);
  });

  it('propagates NULL timestamps', async () => {
    expect(
      await evaluate(
        "timestamp_diff('microsecond', CAST(NULL AS TIMESTAMP), CAST('1970-01-01' AS TIMESTAMP))"
      )
    ).toBe(null);
  });
});
