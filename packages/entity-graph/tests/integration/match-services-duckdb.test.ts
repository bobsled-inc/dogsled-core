import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveRunner, type IntegrationFile } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  generateInsertMatchInboxDeltaSql,
  generateMarkMatchInboxDrainedSql,
} from '../../src/compiler/identity/codegen-match-inbox.js';
import { assignMatch, lookupMatch, stageMatch } from '../../src/runtime/services/match.js';

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

const SPEC: ResolvedResolutionSpec = {
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
  deterministicRules: [
    {
      name: 'exact_name',
      conditions: [{ field: 'name', operator: 'exact', bothNotNull: true }],
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

const REVIEW_SPEC: ResolvedResolutionSpec = {
  ...SPEC,
  deterministicRules: [{ ...SPEC.deterministicRules[0]!, action: 'flag_for_review' }],
};

async function scalarCount(
  runner: { query?: (sql: string) => Promise<Record<string, unknown>[]> },
  sql: string
) {
  const rows = await runner.query!(sql);
  return Number(Object.values(rows[0] ?? { c: 0 })[0]);
}

describe.skipIf(!DUCKDB_AVAILABLE)('match runtime services on DuckDB', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eg-match-services-'));
    dbPath = join(dir, 'match.duckdb');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('looks up, assigns idempotently, queues review, stages idempotently, and drains inbox rows', async () => {
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
      await runner.run(`CREATE TABLE entity_graph.company__standardized (
        record_id VARCHAR,
        source_ref VARCHAR,
        source_pk_json VARCHAR,
        _source_system VARCHAR,
        _source_entity_id VARCHAR,
        _standardized_at TIMESTAMP,
        standardized_name VARCHAR
      )`);
      await runner.run(`CREATE TABLE entity_graph.company__crosswalks (
        record_id VARCHAR,
        source_ref VARCHAR,
        source_pk_json VARCHAR,
        source_system VARCHAR,
        source_entity_id VARCHAR,
        entity_id VARCHAR,
        cluster_id VARCHAR,
        component_id VARCHAR,
        confidence_score DOUBLE,
        matched_at TIMESTAMP
      )`);
      await runner.run(`CREATE TABLE entity_graph.company__clusters (
        entity_id VARCHAR,
        cluster_id VARCHAR,
        component_id VARCHAR,
        record_id VARCHAR,
        source_ref VARCHAR,
        source_pk_json VARCHAR,
        source_entity_id VARCHAR,
        source_system VARCHAR,
        confidence_score DOUBLE,
        clustered_at TIMESTAMP
      )`);
      await runner.run(`CREATE TABLE entity_graph.company__entity_id_events (
        event_id VARCHAR,
        event_type VARCHAR,
        entity_id VARCHAR,
        previous_entity_id VARCHAR,
        record_id VARCHAR,
        component_id VARCHAR,
        source_ref VARCHAR,
        source_pk_json VARCHAR,
        source_system VARCHAR,
        source_entity_id VARCHAR,
        reason VARCHAR,
        created_at TIMESTAMP
      )`);
      await runner.run(`CREATE TABLE entity_graph.company__review_queue (
        pair_id VARCHAR,
        record_a_id VARCHAR,
        record_b_id VARCHAR,
        source_a VARCHAR,
        source_b VARCHAR,
        composite_score DOUBLE,
        threshold_band VARCHAR,
        blocking_rules VARCHAR,
        field_diffs VARCHAR,
        recommended_action VARCHAR,
        semantic_score DOUBLE,
        semantic_decision VARCHAR,
        rule_name VARCHAR
      )`);
      await runner.run(`INSERT INTO entity_graph.company__standardized VALUES
        ('seed-record', 'crm.accounts', '{"account_id":"seed"}', 'crm.accounts', 'seed', CURRENT_TIMESTAMP, 'acme')`);
      await runner.run(`INSERT INTO entity_graph.company__crosswalks VALUES
        ('seed-record', 'crm.accounts', '{"account_id":"seed"}', 'crm.accounts', 'seed', 'entity-acme', 'entity-acme', 'entity-acme', 1.0, CURRENT_TIMESTAMP)`);

      const context = { runner, schema: 'entity_graph', dialect: 'duckdb' as const, spec: SPEC };
      const lookup = await lookupMatch(context, { account_id: 'new-1', name: 'Acme LLC' });
      expect(lookup?.entity_id).toBe('entity-acme');
      expect(lookup?.band).toBe('auto_merge');

      const assigned = await assignMatch(context, { account_id: 'new-1', name: 'Acme LLC' });
      expect(assigned.status).toBe('assigned');
      expect(assigned.entity_id).toBe('entity-acme');
      const assignedAgain = await assignMatch(context, { account_id: 'new-1', name: 'Acme LLC' });
      expect(assignedAgain.status).toBe('already_assigned');
      expect(
        await scalarCount(runner, 'SELECT COUNT(*) AS c FROM entity_graph.company__crosswalks')
      ).toBe(2);
      expect(
        await scalarCount(runner, 'SELECT COUNT(*) AS c FROM entity_graph.audit_log')
      ).toBeGreaterThan(0);

      const reviewContext = { ...context, spec: REVIEW_SPEC };
      const pending = await assignMatch(reviewContext, {
        account_id: 'review-1',
        name: 'Acme LLC',
      });
      expect(pending.status).toBe('pending_review');
      expect(
        await scalarCount(runner, 'SELECT COUNT(*) AS c FROM entity_graph.company__review_queue')
      ).toBe(1);

      await stageMatch(context, { account_id: 'stage-1', name: 'Globex LLC' });
      await stageMatch(context, { account_id: 'stage-1', name: 'Globex LLC' });
      // Duplicate stage calls upsert, never enqueue twice.
      expect(
        await scalarCount(
          runner,
          `SELECT COUNT(*) AS c FROM entity_graph.company__match_inbox WHERE source_entity_id = 'stage-1'`
        )
      ).toBe(1);
      // assign/review records are mirrored into the inbox as the durable ledger:
      // new-1 (assigned), review-1 (pending review), stage-1 (staged).
      expect(
        await scalarCount(runner, 'SELECT COUNT(*) AS c FROM entity_graph.company__match_inbox')
      ).toBe(3);
      expect(
        await scalarCount(
          runner,
          `SELECT COUNT(*) AS c FROM entity_graph.company__match_inbox WHERE source_entity_id = 'new-1' AND status = 'assigned'`
        )
      ).toBe(1);

      await runner.run(`CREATE TABLE entity_graph.company__standardized_delta (
        record_id VARCHAR,
        source_ref VARCHAR,
        source_pk_json VARCHAR,
        _source_system VARCHAR,
        _source_entity_id VARCHAR,
        _standardized_at TIMESTAMP,
        standardized_name VARCHAR
      )`);
      await runner.run(generateInsertMatchInboxDeltaSql(SPEC, 'duckdb', 'entity_graph').sql);
      // Pending rows drain (stage-1 + review-1); the assigned new-1 row does
      // not (its record already exists in __standardized).
      expect(
        await scalarCount(
          runner,
          'SELECT COUNT(*) AS c FROM entity_graph.company__standardized_delta'
        )
      ).toBe(2);
      // Draining is idempotent within a run: a second insert adds nothing.
      await runner.run(generateInsertMatchInboxDeltaSql(SPEC, 'duckdb', 'entity_graph').sql);
      expect(
        await scalarCount(
          runner,
          'SELECT COUNT(*) AS c FROM entity_graph.company__standardized_delta'
        )
      ).toBe(2);
      await runner.run(
        generateMarkMatchInboxDrainedSql(SPEC, 'duckdb', 'entity_graph', 'run-test').sql
      );
      expect(
        await scalarCount(
          runner,
          "SELECT COUNT(*) AS c FROM entity_graph.company__match_inbox WHERE status = 'drained'"
        )
      ).toBe(2);
      // A row staged AFTER the delta snapshot must stay pending — the drain is
      // scoped to record_ids the run actually ingested.
      await stageMatch(context, { account_id: 'late-stage', name: 'Late Corp' });
      await runner.run(
        generateMarkMatchInboxDrainedSql(SPEC, 'duckdb', 'entity_graph', 'run-test-2').sql
      );
      expect(
        await scalarCount(
          runner,
          `SELECT COUNT(*) AS c FROM entity_graph.company__match_inbox WHERE source_entity_id = 'late-stage' AND status = 'pending'`
        )
      ).toBe(1);
      // Full-rebuild recovery: wipe __standardized (a full run rebuilds it from
      // warehouse sources only) — drained inbox rows whose records vanished
      // re-qualify for the next drain instead of being lost forever.
      await runner.run(`DELETE FROM entity_graph.company__standardized`);
      await runner.run(`DELETE FROM entity_graph.company__standardized_delta`);
      await runner.run(generateInsertMatchInboxDeltaSql(SPEC, 'duckdb', 'entity_graph').sql);
      expect(
        await scalarCount(
          runner,
          'SELECT COUNT(*) AS c FROM entity_graph.company__standardized_delta'
        )
      ).toBe(4);

      // Batch parity for NULLs: the pipeline compiles rules to `a.col = b.col`,
      // which never matches on NULL — so a null-valued record must MISS, never
      // match rows that also have NULL in that column (regardless of
      // both_not_null). Kept last so the seed rows don't perturb counts above.
      await runner.run(`INSERT INTO entity_graph.company__standardized VALUES
        ('null-name-record', 'crm.accounts', '{"account_id":"nullseed"}', 'crm.accounts', 'nullseed', CURRENT_TIMESTAMP, NULL)`);
      await runner.run(`INSERT INTO entity_graph.company__crosswalks VALUES
        ('null-name-record', 'crm.accounts', '{"account_id":"nullseed"}', 'crm.accounts', 'nullseed', 'entity-null', 'entity-null', 'entity-null', 1.0, CURRENT_TIMESTAMP)`);
      const nullableRuleContext = {
        ...context,
        spec: {
          ...SPEC,
          deterministicRules: [
            {
              ...SPEC.deterministicRules[0]!,
              conditions: [{ field: 'name', operator: 'exact', bothNotNull: false }],
            },
          ],
        },
      };
      expect(
        await lookupMatch(nullableRuleContext, { account_id: 'null-input', name: null })
      ).toBeNull();
    } finally {
      await runner.close?.();
    }
  });
});
