import { describe, expect, it } from 'vitest';

import { detectAnomalies } from '../../../src/profiler/inferences/anomaly.js';
import { inferForeignKeyCandidates } from '../../../src/profiler/inferences/fk.js';
import { inferFormat } from '../../../src/profiler/inferences/format.js';
import { inferSemanticRole } from '../../../src/profiler/inferences/semantic.js';
import { inferType } from '../../../src/profiler/inferences/types.js';
import {
  buildProfileReport,
  filterProfileReport,
  profileTable,
} from '../../../src/profiler/profile.js';
import { suggestCleaningForColumn } from '../../../src/profiler/proposals/cleaning.js';

const ROWS = [
  {
    customer_id: 'c_001',
    company_id: 'co_1',
    email: 'FOUNDER@Acme.com.example.com ',
    website: 'https://www.Acme.com',
    company_name: 'Acme Inc.',
    state: 'California',
    created_at: '2026-04-01T10:00:00Z',
    amount_total: '10.50',
  },
  {
    customer_id: 'c_002',
    company_id: 'co_1',
    email: 'ops@example.com',
    website: 'www.example.com',
    company_name: 'Example LLC',
    state: 'CA',
    created_at: '2026-04-02T10:00:00Z',
    amount_total: '20.75',
  },
  {
    customer_id: 'c_003',
    company_id: 'co_2',
    email: 'bad-email',
    website: 'https://www.Test.co',
    company_name: 'Test Corporation',
    state: 'New York',
    created_at: 'not-a-date',
    amount_total: 'nope',
  },
];

describe('buildProfileReport', () => {
  it('emits confidence-scored column inferences with evidence', () => {
    const report = buildProfileReport({
      table: 'raw.customers',
      rowCount: ROWS.length,
      rows: ROWS,
      columns: [
        { name: 'customer_id', dataType: 'VARCHAR' },
        { name: 'company_id', dataType: 'VARCHAR' },
        { name: 'email', dataType: 'VARCHAR' },
        { name: 'website', dataType: 'VARCHAR' },
        { name: 'company_name', dataType: 'VARCHAR' },
        { name: 'state', dataType: 'VARCHAR' },
        { name: 'created_at', dataType: 'VARCHAR' },
        { name: 'amount_total', dataType: 'VARCHAR' },
      ],
      foreignKeyTargets: [{ table: 'companies', column: 'id', values: ['co_1', 'co_2'] }],
    });

    expect(report.table).toBe('raw.customers');
    expect(report.rowCount).toBe(ROWS.length);
    expect(report.columns.every((column) => column.typeInference?.confidence != null)).toBe(true);
    expect(report.columns.every((column) => column.typeInference?.evidence.sampleSize === 3)).toBe(
      true
    );

    const email = report.columns.find((column) => column.name === 'email');
    expect(email?.formatInference?.kind).toBe('email');
    expect(email?.semanticRoleInference?.kind).toBe('email');

    expect(report.pkCandidates?.[0]).toMatchObject({
      columns: ['customer_id'],
      recommendation: 'primary_key',
    });
    expect(report.fkCandidates?.[0]).toMatchObject({
      from: 'company_id',
      toTable: 'companies',
      toColumn: 'id',
      hitRate: 1,
    });
    expect(report.cleaningSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: 'company_name',
          transforms: ['normalize_company'],
        }),
        expect.objectContaining({
          column: 'website',
          transforms: ['strip_protocol', 'strip_www', 'lowercase'],
        }),
      ])
    );
  });

  it('filters nested confidence-scored output without changing scan totals', () => {
    const report = buildProfileReport({
      table: 'raw.customers',
      rowCount: ROWS.length,
      rows: ROWS,
    });

    const filtered = filterProfileReport(report, 0.9);

    expect(filtered.rowCount).toBe(report.rowCount);
    expect(filtered.sampleSize).toBe(report.sampleSize);
    expect(filtered.pkCandidates.every((candidate) => candidate.confidence >= 0.9)).toBe(true);
    expect(filtered.cleaningSuggestions.every((suggestion) => suggestion.confidence >= 0.9)).toBe(
      true
    );
    expect(
      filtered.columns
        .flatMap((column) => [
          column.typeInference,
          column.formatInference,
          column.semanticRoleInference,
        ])
        .filter(Boolean)
        .every((inference) => inference.confidence >= 0.9)
    ).toBe(true);
  });
});

describe('profileTable', () => {
  it('rejects fractional numeric row counts', async () => {
    const query = async () => [{ row_count: 3.14 }];

    await expect(
      profileTable(query, { table: 'raw.customers', dialect: 'duckdb', sampleSize: 1 })
    ).rejects.toThrow('Row count must be a safe non-negative integer.');
  });

  it('rejects unsafe numeric row counts', async () => {
    const query = async () => [{ row_count: Number.MAX_SAFE_INTEGER + 1 }];

    await expect(
      profileTable(query, { table: 'raw.customers', dialect: 'duckdb', sampleSize: 1 })
    ).rejects.toThrow('Row count must be a safe non-negative integer.');
  });

  it('rejects unsafe string row counts', async () => {
    const query = async () => [{ row_count: '9007199254740992' }];

    await expect(
      profileTable(query, { table: 'raw.customers', dialect: 'duckdb', sampleSize: 1 })
    ).rejects.toThrow('Row count out of safe range.');
  });
});

describe('suggestCleaningForColumn', () => {
  it('skips low-impact transforms and includes changed-row evidence', () => {
    expect(
      suggestCleaningForColumn({
        column: 'email',
        values: ['a@example.com', 'b@example.com', 'c@example.com'],
      })
    ).toEqual([
      expect.objectContaining({
        transforms: ['extract_email_domain'],
      }),
    ]);

    const suggestions = suggestCleaningForColumn({
      column: 'email',
      values: ['A@EXAMPLE.COM ', 'b@example.com', 'C@EXAMPLE.COM'],
    });

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: 'email',
          transforms: ['normalize_email'],
          evidence: expect.objectContaining({ changedRowRate: expect.any(Number) }),
        }),
      ])
    );
  });

  it('recognizes the complete US state set for state normalization', () => {
    const suggestions = suggestCleaningForColumn({
      column: 'billing_state',
      values: ['Wyoming', 'WY', 'District of Columbia'],
    });

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: 'billing_state',
          transforms: ['normalize_state'],
        }),
      ])
    );
  });

  it('generates model_expr for transforms with SQL implementations', () => {
    const emailSuggestions = suggestCleaningForColumn({
      column: 'email',
      values: ['A@EXAMPLE.COM ', 'B@EXAMPLE.COM', 'C@EXAMPLE.COM'],
    });
    const email = emailSuggestions.find((s) => s.transforms.includes('normalize_email'));
    expect(email?.model_expr).toBe('normalize_email(email)');

    const trimSuggestions = suggestCleaningForColumn({
      column: 'name',
      values: [' Acme ', ' Corp ', ' Test '],
    });
    const trim = trimSuggestions.find((s) => s.transforms.includes('trim'));
    expect(trim?.model_expr).toBe('trim(name)');
  });

  it('generates model_expr for company name cleaning chain', () => {
    const suggestions = suggestCleaningForColumn({
      column: 'company_name',
      values: ['Acme  Inc.', 'Example LLC', 'Test  Corp'],
    });
    const companySuggestion = suggestions.find((s) => s.transforms.includes('normalize_company'));
    expect(companySuggestion?.model_expr).toBe('normalize_company(company_name)');
  });

  it('generates model_expr for phone with strip_country_code', () => {
    const suggestions = suggestCleaningForColumn({
      column: 'phone',
      values: [
        '1-800-555-1212',
        '1 (415) 555-0100',
        '1-650-555-0199',
        '1-212-555-0123',
        '1-310-555-0456',
        '+1-408-555-0789',
        '1.212.555.0100',
        '1.310.555.0200',
        '1.408.555.0300',
        '1.650.555.0400',
      ],
    });
    const phoneSuggestion = suggestions.find((s) => s.transforms.includes('normalize_phone'));
    expect(phoneSuggestion?.model_expr).toBe('normalize_phone(phone)');
  });

  it('generates model_expr for state normalization', () => {
    const stateSuggestions = suggestCleaningForColumn({
      column: 'billing_state',
      values: ['Wyoming', 'WY', 'District of Columbia'],
    });
    const normalize = stateSuggestions.find((s) => s.transforms.includes('normalize_state'));
    expect(normalize?.model_expr).toBe('normalize_state(billing_state)');
  });

  it('quotes column names with spaces in model_expr', () => {
    const suggestions = suggestCleaningForColumn({
      column: 'Company Name',
      values: ['Acme  Inc.', 'Example LLC', 'Test  Corp'],
    });
    const companySuggestion = suggestions.find((s) => s.transforms.includes('normalize_company'));
    expect(companySuggestion?.model_expr).toContain('"Company Name"');
  });
});

describe('profiler inference helpers', () => {
  it('counts repeated row-level format matches before assigning mixed format', () => {
    const inference = inferFormat([
      'a@example.com',
      'a@example.com',
      'b@example.com',
      'https://example.com',
      'https://example.com',
    ]);

    expect(inference).toMatchObject({
      kind: 'mixed',
      evidence: expect.objectContaining({
        matches: 5,
        mismatches: 0,
      }),
    });
  });

  it('normalizes camelCase foreign key names before scoring candidates', () => {
    const candidates = inferForeignKeyCandidates(
      [{ userId: 'u1' }, { userId: 'u2' }],
      ['userId'],
      [{ table: 'users', column: 'id', values: ['u1', 'u2'] }]
    );

    expect(candidates?.[0]).toMatchObject({
      from: 'userId',
      toTable: 'users',
      toColumn: 'id',
      hitRate: 1,
    });
  });

  it('keeps evenly split supported formats classified as mixed', () => {
    const inference = inferFormat([
      'a@example.com',
      'b@example.com',
      '+15550100',
      '+15550101',
      'https://example.com/a',
      'https://example.com/b',
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
    ]);

    expect(inference).toMatchObject({
      kind: 'mixed',
      evidence: expect.objectContaining({
        matches: 8,
        mismatches: 0,
      }),
    });
  });

  it('scores plural foreign key table names without mangling common suffixes', () => {
    const candidates = inferForeignKeyCandidates(
      [{ companyId: 'co1' }, { companyId: 'co2' }],
      ['companyId'],
      [{ table: 'companies', column: 'id', values: ['co1', 'co2'] }]
    );

    expect(candidates?.[0]).toMatchObject({
      from: 'companyId',
      toTable: 'companies',
      toColumn: 'id',
      hitRate: 1,
    });
  });

  it('does not emit target-backed foreign keys when target key samples are empty', () => {
    const candidates = inferForeignKeyCandidates(
      [{ companyId: 'co1' }, { companyId: 'co2' }],
      ['companyId'],
      [{ table: 'companies', column: 'id', values: [null, undefined, ''] }]
    );

    expect(candidates).toEqual([]);
  });

  it('treats mixed integers and decimals as one numeric column', () => {
    const inference = inferType([1, 2, 3.5]);

    expect(inference.kind).toBe('number');
    expect(inference.evidence).toMatchObject({
      matches: 3,
      mismatches: 0,
    });
  });

  it('ignores non-letter strings when checking inconsistent casing', () => {
    const anomalies = detectAnomalies({
      values: ['123', '456', '789'],
      typeInference: {
        kind: 'string',
        confidence: 0.9,
        evidence: {},
      },
    });

    expect(anomalies.some((anomaly) => anomaly.type === 'inconsistent_casing')).toBe(false);
  });

  it('only flags parseable subfields for valid JSON strings', () => {
    const invalidPayloads = detectAnomalies({
      values: ['{foo}', '[1,]', 'plain'],
      typeInference: {
        kind: 'string',
        confidence: 0.9,
        evidence: {},
      },
    });
    expect(invalidPayloads.some((anomaly) => anomaly.type === 'parseable_subfields')).toBe(false);

    const validPayloads = detectAnomalies({
      values: ['{"foo":1}', '[1,2]', 'plain'],
      typeInference: {
        kind: 'string',
        confidence: 0.9,
        evidence: {},
      },
    });
    expect(validPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'parseable_subfields',
          evidence: expect.objectContaining({ parseableCount: 2 }),
        }),
      ])
    );
  });

  it('lowers id-name semantic confidence when distinctness is weak', () => {
    const inference = inferSemanticRole({
      columnName: 'status_id',
      typeKind: 'string',
      formatKind: null,
      distinctRate: 0.2,
    });

    expect(inference.kind).toBe('identifier');
    expect(inference.confidence).toBeLessThan(0.8);
  });
});
