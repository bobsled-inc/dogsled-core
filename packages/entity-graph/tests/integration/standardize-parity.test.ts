import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveRunner, type IntegrationFile } from '@bobsled-inc/connections';
import { materializeMatchKeySecretPlaceholders } from '@bobsled-inc/model-spec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateStandardizeSql } from '../../src/compiler/identity/codegen-standardize.js';
import { compileResolutionRun } from '../../src/compiler/identity/codegen.js';
import { generateMaskedGoldenViewSql } from '../../src/compiler/identity/codegen-governance.js';
import { generateMaterializeDdl } from '../../src/compiler/identity/materializer.js';
import { applyStandardizeTransforms } from '../../src/runtime/services/standardize.js';

import type { ResolvedResolutionSpec } from '../../src/compiler/identity/types.js';

const requireFromHere = createRequire(import.meta.url);

function duckdbAvailable(): boolean {
  try {
    const connectionsEntry = requireFromHere.resolve('@bobsled-inc/connections');
    requireFromHere.resolve('@duckdb/node-api', { paths: [dirname(connectionsEntry)] });
    return true;
  } catch {
    return false;
  }
}

const DUCKDB_AVAILABLE = duckdbAvailable();

const RECORD = {
  id: 'r1',
  lowercase_field: 'MiXeD',
  uppercase_field: 'mixed',
  trim_field: '  padded  ',
  collapse_whitespace_field: 'a   b\tc',
  nullif_empty_field: '   ',
  normalize_email_field: ' User@Example.COM ',
  normalize_email_uid2_field: ' First.Last+promo@googlemail.com ',
  normalize_email_uid2_plain_field: ' First.Last+promo@example.com ',
  extract_email_domain_field: 'user+tag@Example.COM',
  strip_email_subaddress_field: 'user+tag@example.com',
  strip_accents_field: 'Crème Brûlée Æsir',
  strip_legal_suffixes_field: 'Acme, Inc.',
  strip_trading_as_field: 'Acme d/b/a Other Name',
  normalize_company_field: ' Acme   LLC ',
  strip_www_field: 'https://www.Example.com/path',
  strip_protocol_field: 'http://www.Example.com',
  extract_domain_field: 'https://www.example.com/path?q=1',
  digits_only_field: '+1 (555) 123-4567',
  strip_country_code_field: '15551234567',
  strip_phone_extension_field: '555-1234 ext. 99',
  normalize_phone_field: '+1 (555) 123-4567 x88',
  normalize_state_field: 'California',
  expand_street_abbreviations_field: '123 North Main Street Apartment 4',
  normalize_street_field: '123 north main street, apartment 4',
  normalize_postal_field: '12345-6789',
  remove_punctuation_field: 'A.c-m,e!',
  fingerprint_field: 'Beta alpha beta!',
  parse_number_field: '$1,234.50',
  sha256_field: 'hash me',
  hmac_sha256_field: 'hash me too',
} satisfies Record<string, unknown>;

const SPEC: ResolvedResolutionSpec = {
  name: 'customer_resolution',
  entity: 'customer',
  description: 'Standardize parity fixture.',
  inputs: [
    {
      ref: 'main.standardize_input',
      fqTableName: 'main.standardize_input',
      alias: 's0',
      idFields: ['id'],
      sourceColumns: Object.keys(RECORD),
    },
  ],
  standardize: [
    { field: 'lowercase_field', transforms: ['lowercase'] },
    { field: 'uppercase_field', transforms: ['uppercase'] },
    { field: 'trim_field', transforms: ['trim'] },
    { field: 'collapse_whitespace_field', transforms: ['collapse_whitespace'] },
    { field: 'nullif_empty_field', transforms: ['nullif_empty'] },
    { field: 'normalize_email_field', transforms: ['normalize_email'] },
    { field: 'normalize_email_uid2_field', transforms: ['normalize_email_uid2'] },
    { field: 'normalize_email_uid2_plain_field', transforms: ['normalize_email_uid2'] },
    { field: 'extract_email_domain_field', transforms: ['extract_email_domain'] },
    { field: 'strip_email_subaddress_field', transforms: ['strip_email_subaddress'] },
    { field: 'strip_accents_field', transforms: ['strip_accents'] },
    { field: 'strip_legal_suffixes_field', transforms: ['strip_legal_suffixes'] },
    { field: 'strip_trading_as_field', transforms: ['strip_trading_as'] },
    { field: 'normalize_company_field', transforms: ['normalize_company'] },
    { field: 'strip_www_field', transforms: ['strip_www'] },
    { field: 'strip_protocol_field', transforms: ['strip_protocol'] },
    { field: 'extract_domain_field', transforms: ['extract_domain'] },
    { field: 'digits_only_field', transforms: ['digits_only'] },
    { field: 'strip_country_code_field', transforms: ['strip_country_code'] },
    { field: 'strip_phone_extension_field', transforms: ['strip_phone_extension'] },
    { field: 'normalize_phone_field', transforms: ['normalize_phone'] },
    { field: 'normalize_state_field', transforms: ['normalize_state'] },
    { field: 'expand_street_abbreviations_field', transforms: ['expand_street_abbreviations'] },
    { field: 'normalize_street_field', transforms: ['normalize_street'] },
    { field: 'normalize_postal_field', transforms: ['normalize_postal'] },
    { field: 'remove_punctuation_field', transforms: ['remove_punctuation'] },
    { field: 'fingerprint_field', transforms: ['fingerprint'] },
    { field: 'parse_number_field', transforms: ['parse_number'] },
    { field: 'sha256_field', transforms: ['sha256'] },
    { field: 'hmac_sha256_field', transforms: ['hmac_sha256'] },
  ],
  blocking: { rules: [{ name: 'id', key: 'standardized_lowercase_field' }] },
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

function sqlString(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function readCaseInsensitive(row: Record<string, unknown>, field: string): unknown {
  const found = Object.entries(row).find(([key]) => key.toLowerCase() === field.toLowerCase());
  return found?.[1];
}

describe.skipIf(!DUCKDB_AVAILABLE)('standardize TS/SQL parity', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eg-standardize-parity-'));
    dbPath = join(dir, 'parity.duckdb');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('matches DuckDB SQL output for the full zero-arg transform catalog', async () => {
    vi.stubEnv('DOGSLED_MATCH_KEY_SECRET', 'parity-secret');
    const integration: IntegrationFile = {
      spec_version: '1',
      type: 'integration',
      name: 'main',
      source_type: 'duckdb',
      connection: { schema: 'main' },
      auth: { type: 'file', path: dbPath },
    };
    const runner = await resolveRunner(integration);
    try {
      await runner.run('CREATE SCHEMA IF NOT EXISTS entity_graph');
      await runner.run(
        `CREATE TABLE main.standardize_input (${Object.keys(RECORD)
          .map((field) => `${field} VARCHAR`)
          .join(', ')})`
      );
      await runner.run(
        `INSERT INTO main.standardize_input VALUES (${Object.values(RECORD).map(sqlString).join(', ')})`
      );
      for (const ddl of generateMaterializeDdl(SPEC.entity, 'duckdb', 'entity_graph')) {
        await runner.run(ddl.sql);
      }
      await runner.run(
        materializeMatchKeySecretPlaceholders(
          generateStandardizeSql(SPEC, 'duckdb', 'entity_graph').sql,
          'duckdb'
        )
      );
      const rows = await runner.query!('SELECT * FROM entity_graph.customer__standardized');
      const sqlRow = rows[0]!;
      const tsRow = applyStandardizeTransforms(RECORD, SPEC);
      for (const [field, expected] of Object.entries(tsRow)) {
        const actual = readCaseInsensitive(sqlRow, field);
        if (typeof expected === 'number') {
          expect(Number(actual), field).toBeCloseTo(expected, 6);
        } else {
          expect(actual ?? null, field).toBe(expected);
        }
      }
      expect(tsRow.standardized_normalize_email_uid2_field).toBe('firstlast@gmail.com');
      expect(tsRow.standardized_normalize_email_uid2_plain_field).toBe(
        'first.last+promo@example.com'
      );
    } finally {
      await runner.close?.();
      vi.unstubAllEnvs();
    }
  });

  it('matches two records through normalize_email_uid2 plus hmac_sha256', async () => {
    vi.stubEnv('DOGSLED_MATCH_KEY_SECRET', 'roundtrip-secret');
    const integration: IntegrationFile = {
      spec_version: '1',
      type: 'integration',
      name: 'main',
      source_type: 'duckdb',
      connection: { schema: 'main' },
      auth: { type: 'file', path: dbPath },
    };
    const runner = await resolveRunner(integration);
    try {
      await runner.run('CREATE SCHEMA IF NOT EXISTS entity_graph');
      await runner.run('CREATE TABLE main.src_a (id VARCHAR, email VARCHAR)');
      await runner.run('CREATE TABLE main.src_b (id VARCHAR, email VARCHAR)');
      await runner.run("INSERT INTO main.src_a VALUES ('a1', 'First.Last+promo@gmail.com')");
      await runner.run("INSERT INTO main.src_b VALUES ('b1', 'firstlast@googlemail.com')");

      const spec: ResolvedResolutionSpec = {
        name: 'person_resolution',
        entity: 'person',
        description: 'Privacy match key round trip.',
        inputs: [
          {
            ref: 'main.src_a',
            fqTableName: 'main.src_a',
            alias: 's0',
            idFields: ['id'],
            sourceColumns: ['id', 'email'],
          },
          {
            ref: 'main.src_b',
            fqTableName: 'main.src_b',
            alias: 's1',
            idFields: ['id'],
            sourceColumns: ['id', 'email'],
          },
        ],
        standardize: [{ field: 'email', transforms: ['normalize_email_uid2', 'hmac_sha256'] }],
        blocking: { rules: [{ name: 'email_key', key: 'standardized_email' }] },
        deterministicRules: [
          {
            name: 'email_key',
            conditions: [{ field: 'standardized_email', operator: 'exact', bothNotNull: true }],
            action: 'auto_merge',
            confidence: 1,
          },
        ],
        thresholds: { autoMerge: 0.95, review: 0.6, autoReject: 0.4 },
        entityIdPolicy: {
          strategy: 'stable',
          newId: 'component_id',
          merge: 'oldest_entity_id',
          split: 'preserve_anchor',
        },
        targetSchema: 'entity_graph',
      };

      const compiled = compileResolutionRun(spec, 'duckdb', 'entity_graph');
      for (const stmt of compiled.statements) {
        await runner.run(materializeMatchKeySecretPlaceholders(stmt.sql, 'duckdb'));
      }
      const rows = await runner.query!(
        "SELECT match_type, composite_score FROM entity_graph.person__pair_scores WHERE rule_name = 'email_key'"
      );
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.match_type).toLowerCase()).toBe('deterministic');
      expect(Number(rows[0]?.composite_score)).toBe(1);
    } finally {
      await runner.close?.();
      vi.unstubAllEnvs();
    }
  });

  it('executes masked golden view SQL on DuckDB', async () => {
    const integration: IntegrationFile = {
      spec_version: '1',
      type: 'integration',
      name: 'main',
      source_type: 'duckdb',
      connection: { schema: 'main' },
      auth: { type: 'file', path: dbPath },
    };
    const runner = await resolveRunner(integration);
    try {
      await runner.run('CREATE SCHEMA IF NOT EXISTS entity_graph');
      await runner.run(
        [
          'CREATE TABLE entity_graph.person__golden (',
          'entity_id VARCHAR, full_name VARCHAR, email VARCHAR, crm_id VARCHAR, has_crm BOOLEAN,',
          'cluster_size INTEGER, trust_score DOUBLE, trust_band VARCHAR)',
        ].join(' ')
      );
      await runner.run(
        "INSERT INTO entity_graph.person__golden VALUES ('ent_1', 'Ada Lovelace', 'ada@example.com', 'c1', true, 1, 1.0, 'trusted')"
      );
      const spec: ResolvedResolutionSpec = {
        name: 'person_resolution',
        entity: 'person',
        description: 'Governed person golden view.',
        inputs: [
          {
            ref: 'main.crm',
            fqTableName: 'main.crm',
            alias: 's0',
            idFields: ['id'],
            sourceColumns: ['id', 'email', 'full_name'],
          },
        ],
        standardize: [
          { field: 'full_name', transforms: ['trim'] },
          { field: 'email', transforms: ['normalize_email'] },
        ],
        deterministicRules: [
          {
            name: 'email',
            conditions: [{ field: 'standardized_email', operator: 'exact', bothNotNull: true }],
            action: 'auto_merge',
            confidence: 1,
          },
        ],
        thresholds: { autoMerge: 0.95, review: 0.6, autoReject: 0.4 },
        entityIdPolicy: {
          strategy: 'stable',
          newId: 'component_id',
          merge: 'oldest_entity_id',
          split: 'preserve_anchor',
        },
        profile: {
          attributes: [
            { field: 'full_name', alias: 'full_name' },
            { field: 'email', alias: 'email' },
          ],
          quality: {
            freshnessWindows: [],
            sourceDiversityCap: 1,
            trustWeights: { identity: 0.4, freshness: 0.25, diversity: 0.2, coverage: 0.15 },
            trustTierThresholds: { trusted: 0.8, monitor: 0.6, review: 0.4 },
          },
          activations: [],
          piiControls: {
            attributes: [
              { field: 'email', masking: 'hash', classification: 'email' },
              { field: 'full_name', masking: 'partial', classification: 'person_name' },
            ],
          },
        },
        targetSchema: 'entity_graph',
      };
      const masked = generateMaskedGoldenViewSql(spec, 'duckdb', 'entity_graph');
      expect(masked).toBeDefined();
      await runner.run(masked!.sql);
      const rows = await runner.query!(
        'SELECT full_name, email FROM entity_graph.person__golden_masked'
      );
      expect(String(rows[0]?.full_name)).toBe('Ad***ce');
      expect(String(rows[0]?.email)).not.toBe('ada@example.com');
      expect(String(rows[0]?.email)).toHaveLength(64);
    } finally {
      await runner.close?.();
    }
  });
});
