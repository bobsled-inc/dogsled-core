import { describe, expect, it, vi } from 'vitest';

import { prepareMatchRecord, stageMatch } from '../../../src/runtime/services/match.js';

import type { ResolvedResolutionSpec } from '../../../src/compiler/identity/types.js';

const COMPANY_SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Match service fixture.',
  inputs: [
    {
      ref: 'crm.accounts',
      fqTableName: 'main.accounts',
      alias: 's0',
      idFields: ['account_id'],
      sourceColumns: ['account_id', 'name'],
    },
  ],
  standardize: [{ field: 'name', transforms: ['normalize_company'] }],
  blocking: { rules: [{ name: 'name', key: 'standardized_name' }] },
  deterministicRules: [],
  thresholds: { autoMerge: 0.95, review: 0.6, autoReject: 0.4 },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
  targetSchema: 'entity_graph',
};

const PERSON_SPEC: ResolvedResolutionSpec = {
  ...COMPANY_SPEC,
  name: 'person_resolution',
  entity: 'person',
  inputs: [
    {
      ref: 'crm.people',
      fqTableName: 'main.people',
      alias: 's0',
      idFields: ['person_id'],
      sourceColumns: ['person_id', 'email'],
    },
  ],
  standardize: [{ field: 'email', transforms: ['lowercase', 'trim'] }],
  blocking: { rules: [{ name: 'email', key: 'standardized_email' }] },
};

describe('match runtime services', () => {
  it('rejects missing and non-scalar primary keys before hashing', () => {
    expect(() => prepareMatchRecord(COMPANY_SPEC, { name: 'Acme' })).toThrow(
      /missing primary-key field "account_id"/
    );
    expect(() =>
      prepareMatchRecord(COMPANY_SPEC, {
        source_ref: 'crm.accounts',
        account_id: { nested: 'bad' },
        name: 'Acme',
      })
    ).toThrow(/invalid primary-key field "account_id"/);
    expect(() =>
      prepareMatchRecord(COMPANY_SPEC, {
        source_ref: 'crm.accounts',
        account_id: Number.NaN,
        name: 'Acme',
      })
    ).toThrow(/invalid primary-key field "account_id"/);
  });

  it('ensures match inbox DDL separately for each entity on a shared runner', async () => {
    const runner = { run: vi.fn(async () => undefined) };

    await stageMatch(
      { runner, schema: 'entity_graph', dialect: 'duckdb', spec: COMPANY_SPEC },
      { account_id: 'company-1', name: 'Acme' }
    );
    await stageMatch(
      { runner, schema: 'entity_graph', dialect: 'duckdb', spec: PERSON_SPEC },
      { person_id: 'person-1', email: 'ada@example.com' }
    );

    const sql = runner.run.mock.calls.map(([statement]) => String(statement));
    expect(
      sql.some(
        (statement) =>
          statement.startsWith('CREATE TABLE IF NOT EXISTS') &&
          statement.includes('"entity_graph"."company__match_inbox"')
      )
    ).toBe(true);
    expect(
      sql.some(
        (statement) =>
          statement.startsWith('CREATE TABLE IF NOT EXISTS') &&
          statement.includes('"entity_graph"."person__match_inbox"')
      )
    ).toBe(true);
  });
});
