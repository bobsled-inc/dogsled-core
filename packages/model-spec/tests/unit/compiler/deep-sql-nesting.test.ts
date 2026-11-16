import { describe, expect, it } from 'vitest';

import { compileInMemory } from '../../../src/api/compile-in-memory.js';
import { TransformSpecSchema } from '../../../src/compiler/schemas.js';

const depth = 40;
const nested = Array.from({ length: depth }).reduce<string>(
  (expr) => `COALESCE(${expr}, 'none')`,
  't0.id'
);

describe('deeply nested SQL', () => {
  it.each(['snowflake', 'bigquery', 'postgres', 'duckdb'] as const)(
    `compiles an expression nested ${depth} levels deep on %s`,
    (dialect) => {
      const result = compileInMemory({
        models: [
          {
            name: 'deep_records',
            spec: TransformSpecSchema.parse({
              spec_version: '0.2',
              type: 'model',
              name: 'deep_records',
              description: 'Synthetic model with deeply nested SQL.',
              grain: 'id',
              source: { ref: 'example.records' },
              columns: [{ name: 'id', expr: nested, type: 'VARCHAR' }],
              materialization: { type: 'view' },
            }),
          },
        ],
        sources: new Map([['example.records', 'EXAMPLE_DB.RAW.RECORDS']]),
        dialect,
        targetDatabase: 'EXAMPLE_DB',
        targetSchema: 'OUTPUT',
        selectOnly: true,
      });
      expect(result.ok, JSON.stringify(result.results)).toBe(true);
    }
  );
});
