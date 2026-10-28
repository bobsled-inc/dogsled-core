import { describe, expect, it } from 'vitest';

import {
  buildForgetRecordRequest,
  generateForgetSql,
} from '../../../../src/compiler/identity/codegen-forget.js';
import { findBareUnions } from '../../../integration/sql-invariants.js';

import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';
import type { SupportedDialect } from '@bobsled-inc/model-spec';

const SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Resolve companies.',
  inputs: [
    {
      ref: 'crm.accounts',
      fqTableName: '"raw"."accounts"',
      alias: 's0',
      role: 'internal',
      idFields: ['account_id'],
      sourceColumns: ['account_id', 'name', 'email'],
    },
  ],
  standardize: [{ field: 'name', transforms: ['lowercase', 'trim'] }],
  semanticTriage: {
    provider: 'openai_text_embedding_3_small',
    fields: ['name'],
    promoteToMergeThreshold: 0.92,
    promoteToRejectThreshold: 0.45,
  },
  blocking: { rules: [{ name: 'by_name', key: 'standardized_name' }] },
  deterministicRules: [],
  scoring: {
    method: 'weighted_features',
    features: [{ field: 'standardized_name', algorithm: 'exact', weight: 1 }],
  },
  thresholds: { autoMerge: 0.9, review: 0.6, autoReject: 0.3 },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
};

function request() {
  return buildForgetRecordRequest(
    SPEC,
    { sourceRef: 'crm.accounts', pk: { account_id: 'pii@example.com' } },
    'gdpr erasure'
  );
}

describe('buildForgetRecordRequest', () => {
  it('canonicalizes source PKs in id_field order and hashes tombstones', () => {
    const built = request();

    expect(built.sourcePkJson).toBe('{"account_id":"pii@example.com"}');
    expect(built.tombstoneId).toMatch(/^[a-f0-9]{32}$/);
    expect(built.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects requests for unknown sources and missing PK fields', () => {
    expect(() =>
      buildForgetRecordRequest(SPEC, { sourceRef: 'crm.contacts', pk: { account_id: 'a1' } })
    ).toThrow(/Unknown source_ref/);
    expect(() =>
      buildForgetRecordRequest(SPEC, { sourceRef: 'crm.accounts', pk: { id: 'a1' } })
    ).toThrow(/missing primary-key field/);
  });

  it('rejects non-scalar primary-key values that would stringify unstably', () => {
    expect(() =>
      buildForgetRecordRequest(SPEC, {
        sourceRef: 'crm.accounts',
        // A nested object would collapse to "[object Object]" in the tombstone key.
        pk: { account_id: { nested: 'x' } as unknown as string },
      })
    ).toThrow(/non-scalar primary-key field/);
  });
});

describe('generateForgetSql', () => {
  it.each([
    'snowflake',
    'bigquery',
    'postgres',
    'duckdb',
    'databricks',
    'mysql',
    'redshift',
  ] as const)('snapshots the forget plan for %s', (dialect: SupportedDialect) => {
    const statements = generateForgetSql({
      spec: SPEC,
      dialect,
      targetSchema:
        dialect === 'bigquery' || dialect === 'duckdb' ? 'entity_graph' : 'ENTITY_GRAPH',
      requests: [request()],
      reason: 'gdpr erasure',
    });

    expect(
      statements.map((statement) => ({
        name: statement.name,
        sql: statement.sql,
        ignore_error_patterns: statement.ignoreErrorPatterns,
      }))
    ).toMatchSnapshot();
  });

  it('orders data mutations before erasure audit and passes content_hash as discriminator', () => {
    const forgetRequest = request();
    const statements = generateForgetSql({
      spec: SPEC,
      dialect: 'snowflake',
      targetSchema: 'ENTITY_GRAPH',
      requests: [forgetRequest],
      reason: 'gdpr erasure',
    });

    expect(statements.at(-1)?.name).toContain('audit_erasure');
    expect(statements.at(-1)?.sql).toContain(forgetRequest.contentHash);
    expect(statements.at(-1)?.sql).not.toContain('pii@example.com');
    expect(
      statements.findIndex((statement) => statement.name === 'forget_purge_standardized')
    ).toBeLessThan(statements.findIndex((statement) => statement.name.startsWith('audit_erasure')));
  });

  it('purges crosswalks using a composite source key instead of a self-comparing subquery', () => {
    const statements = generateForgetSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      requests: [request()],
      reason: 'gdpr erasure',
    });

    const crosswalkPurge = statements.find(
      (statement) => statement.name === 'forget_purge_crosswalks'
    );
    // Composite key via concat: row-value `(a, b) IN (SELECT ...)` is invalid on
    // BigQuery, so the key is a single concatenated expression on both sides.
    expect(crosswalkPurge?.sql).toContain(`WHERE CONCAT("source_ref", '|', "source_pk_json") IN (`);
    expect(crosswalkPurge?.sql).toContain(
      `SELECT CONCAT("forgotten"."source_ref", '|', "forgotten"."source_pk_json")`
    );
    expect(crosswalkPurge?.sql).not.toContain(
      'WHERE "source_ref" = tr."source_ref"\n    AND "source_pk_json" = tr."source_pk_json"'
    );
  });

  it.each([
    'snowflake',
    'bigquery',
    'postgres',
    'duckdb',
    'databricks',
    'mysql',
    'redshift',
  ] as const)(
    'never leads a DML statement with WITH on %s (BigQuery/Snowflake reject it)',
    (dialect: SupportedDialect) => {
      const statements = generateForgetSql({
        spec: SPEC,
        dialect,
        targetSchema: 'entity_graph',
        requests: [request()],
        reason: 'gdpr erasure',
      });
      for (const statement of statements) {
        const firstKeyword = statement.sql.trimStart().split(/\s+/)[0]?.toUpperCase();
        expect(
          ['INSERT', 'DELETE', 'UPDATE'],
          `statement "${statement.name}" on ${dialect} must start with DML, got "${firstKeyword}"`
        ).toContain(firstKeyword);
        if (dialect === 'bigquery') {
          expect(
            findBareUnions(statement.sql),
            `bare UNION (BigQuery requires ALL/DISTINCT) in statement "${statement.name}"`
          ).toEqual([]);
        }
      }
    }
  );

  it('redacts review decisions and audit payloads before purging the pair and crosswalk surfaces they read', () => {
    const statements = generateForgetSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      requests: [request()],
      reason: 'gdpr erasure',
    });
    const names = statements.map((statement) => statement.name);
    const firstPurge = names.findIndex((name) => name.startsWith('forget_purge_'));
    expect(firstPurge).toBeGreaterThan(-1);
    expect(names.indexOf('forget_redact_review_decisions')).toBeLessThan(firstPurge);
    expect(names.indexOf('forget_redact_audit_payloads')).toBeLessThan(firstPurge);
    // Purges of derived surfaces run before the base surfaces they join against.
    expect(names.indexOf('forget_purge_document_mentions')).toBeLessThan(
      names.indexOf('forget_purge_crosswalks')
    );
    expect(names.indexOf('forget_purge_survivorship_audit')).toBeLessThan(
      names.indexOf('forget_purge_crosswalks')
    );
    expect(names.indexOf('forget_purge_embedding_cache')).toBeLessThan(
      names.indexOf('forget_purge_standardized')
    );
  });

  it('purges staged match-inbox rows so erasure covers stage-mode records', () => {
    const statements = generateForgetSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      requests: [request()],
      reason: 'gdpr erasure',
    });
    const inboxPurge = statements.find(
      (statement) => statement.name === 'forget_purge_match_inbox'
    );
    expect(inboxPurge?.sql).toContain('company__match_inbox');
    expect(inboxPurge?.sql).toContain('"record_id" IN (');
  });
});
