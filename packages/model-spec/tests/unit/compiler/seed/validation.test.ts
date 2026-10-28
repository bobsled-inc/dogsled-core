import * as path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { generateSeedSql } from '../../../../src/compiler/seed/codegen.js';
import { parseSeedSpec } from '../../../../src/compiler/seed/parser.js';
import { readCsv } from '../../../../src/compiler/seed/csv-reader.js';
import { validateSeedData } from '../../../../src/compiler/seed/validation.js';

const FIXTURE = path.resolve(
  import.meta.dirname,
  '../../../fixtures/specs/seeds/legal_suffixes.yml'
);

describe('validateSeedData', () => {
  let parsed: ReturnType<typeof parseSeedSpec>;
  let expectedColumns: string[];

  beforeAll(() => {
    parsed = parseSeedSpec(FIXTURE);
    expectedColumns = parsed.spec.schema.columns.map((column) => column.name);
  });

  it('flags blank required values', () => {
    const csv = readCsv('suffix,normalized_form\nLLC,\n', {
      delimiter: ',',
      expectedColumns,
    });

    const validation = validateSeedData(parsed, csv);
    expect(validation.issues.some((issue) => issue.code === 'required')).toBe(true);
  });

  it('flags duplicate unique keys', () => {
    const csv = readCsv('suffix,normalized_form\nLLC,llc\nLLC,llc\n', {
      delimiter: ',',
      expectedColumns,
    });

    const validation = validateSeedData(parsed, csv);
    expect(validation.issues.some((issue) => issue.code === 'unique')).toBe(true);
  });

  it('flags missing required headers once instead of per row', () => {
    const csv = readCsv('suffix\nLLC\n', {
      delimiter: ',',
      expectedColumns: ['suffix'],
    });

    const validation = validateSeedData(parsed, csv);
    expect(validation.issues.filter((issue) => issue.code === 'missing_header')).toHaveLength(1);
  });

  it('deduplicates missing_header issues when a column is both required and unique', () => {
    const csv = readCsv('normalized_form\nllc\n', {
      delimiter: ',',
      expectedColumns: ['normalized_form'],
    });

    const validation = validateSeedData(parsed, csv);
    expect(validation.issues.filter((issue) => issue.code === 'missing_header')).toHaveLength(1);
    expect(validation.issues[0]?.message).toContain('Missing column "suffix"');
  });

  it('flags invalid type values', () => {
    const typedParsed: typeof parsed = {
      ...parsed,
      spec: {
        ...parsed.spec,
        schema: {
          ...parsed.spec.schema,
          columns: parsed.spec.schema.columns.map((column) =>
            column.name === 'normalized_form' ? { ...column, type: 'INTEGER' } : column
          ),
        },
      },
    };
    const csv = readCsv('suffix,normalized_form\nLLC,not-a-number\n', {
      delimiter: ',',
      expectedColumns,
    });

    const validation = validateSeedData(typedParsed, csv);
    expect(validation.issues.some((issue) => issue.code === 'type')).toBe(true);
  });
});

describe('generateSeedSql', () => {
  it('uses NOT EXISTS semantics for on_conflict: skip', () => {
    const parsed = parseSeedSpec(FIXTURE);
    const csv = readCsv('suffix,normalized_form\nLLC,llc\n', {
      delimiter: ',',
      expectedColumns: parsed.spec.schema.columns.map((column) => column.name),
    });
    const sql = generateSeedSql(
      {
        ...parsed,
        spec: {
          ...parsed.spec,
          materialization: {
            ...parsed.spec.materialization,
            on_conflict: 'skip',
          },
        },
      },
      csv,
      'snowflake',
      'MODEL_SPEC_SEEDS'
    );

    expect(sql).toContain('WHERE NOT EXISTS');
  });

  describe('clickhouse', () => {
    const clickHouseSql = (onConflict: 'replace' | 'skip'): string => {
      const parsed = parseSeedSpec(FIXTURE);
      const csv = readCsv('suffix,normalized_form\nLLC,llc\n', {
        delimiter: ',',
        expectedColumns: parsed.spec.schema.columns.map((column) => column.name),
      });
      return generateSeedSql(
        {
          ...parsed,
          spec: {
            ...parsed.spec,
            materialization: { ...parsed.spec.materialization, on_conflict: onConflict },
          },
        },
        csv,
        'clickhouse',
        'bms_seeds'
      );
    };

    // ClickHouse has no default engine and MergeTree needs a sorting key, so a
    // seed table without both is rejected at CREATE time.
    it('declares an engine and sorting key when replacing', () => {
      expect(clickHouseSql('replace')).toContain('ENGINE = MergeTree() ORDER BY tuple()');
    });

    it('declares an engine and sorting key when skipping', () => {
      expect(clickHouseSql('skip')).toContain('ENGINE = MergeTree() ORDER BY tuple()');
    });

    // Seeds emit a bare NULL for an empty CSV cell, which a non-Nullable
    // ClickHouse column rejects outright.
    it('makes scalar columns Nullable', () => {
      expect(clickHouseSql('replace')).toContain('Nullable(String)');
    });

    it('does not emit types ClickHouse has no column for', () => {
      const sql = clickHouseSql('replace');
      expect(sql).not.toContain('VARCHAR(4096)');
      expect(sql).not.toContain('DOUBLE PRECISION');
    });
  });
});
