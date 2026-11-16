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

const NORMALIZED_STREET = emitExpr(parseExprField('normalize_street(street)'), 'duckdb');
const NORMALIZED_POSTAL = emitExpr(parseExprField('normalize_postal(postal_code)'), 'duckdb');

const memoryIntegration: IntegrationFile = {
  spec_version: '1',
  type: 'integration',
  name: 'duckdb',
  source_type: 'duckdb',
  connection: { schema: 'main' },
  auth: { type: 'memory' },
};

describe.skipIf(!duckdbAvailable)('address cleaning — DuckDB execution', () => {
  let runner: SqlRunnerModule;

  beforeAll(async () => {
    runner = await resolveRunner(memoryIntegration);
  });

  afterAll(async () => {
    await runner?.close?.();
  });

  it('normalizes street suffixes, unit designators, directionals, and postal codes', async () => {
    const query = runner.query;
    if (!query) throw new Error('DuckDB runner does not expose query()');

    const rows = await query(
      `SELECT street, postal_code, ${NORMALIZED_STREET} AS normalized_street, ${NORMALIZED_POSTAL} AS normalized_postal
       FROM (VALUES
         ('123 Main St.', '12345-6789'),
         ('123 main street', '123456789'),
         ('55 North Lake Boulevard Suite 9', ' sw1a-1aa ')
       ) AS t(street, postal_code)`
    );

    expect(rows[0]?.normalized_street).toBe(rows[1]?.normalized_street);
    expect(rows[0]?.normalized_street).toBe('123 main ST');
    expect(rows[0]?.normalized_postal).toBe('12345');
    expect(rows[1]?.normalized_postal).toBe('12345');
    expect(rows[2]?.normalized_street).toBe('55 N LK BLVD STE 9');
    expect(rows[2]?.normalized_postal).toBe('SW1A1AA');
  });

  it('normalizes postal vocabulary without treating the toolkit name as a suffix', async () => {
    const query = runner.query;
    if (!query) throw new Error('DuckDB runner does not expose query()');

    const rows = await query(
      `SELECT ${NORMALIZED_STREET} AS normalized_street
       FROM (VALUES
         ('123 Example TRACK'),
         ('123 Example TRK'),
         ('123 Example BOBSLED')
       ) AS t(street)`
    );

    expect(rows.map((row) => row.normalized_street)).toEqual([
      '123 example TRAK',
      '123 example TRAK',
      '123 example bobsled',
    ]);
  });
});
