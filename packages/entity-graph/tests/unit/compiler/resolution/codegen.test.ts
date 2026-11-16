import { describe, expect, it, vi } from 'vitest';

import {
  compileResolutionCluster,
  compileResolutionProfile,
  compileResolutionRun,
} from '../../../../src/compiler/identity/codegen.js';
import { generateEntityIdSummaryQuery } from '../../../../src/compiler/identity/codegen-entity-id.js';
import { generateScoringSql } from '../../../../src/compiler/identity/codegen-scoring.js';
import { generateStandardizeSql } from '../../../../src/compiler/identity/codegen-standardize.js';
import { computeResolutionRunFingerprint } from '../../../../src/compiler/identity/fingerprint.js';
import { MATCH_KEY_SECRET_RUNTIME_TOKEN, quoteIdentifier } from '@bobsled-inc/model-spec';

import type {
  FellegiSunterLevel,
  ResolvedResolutionSpec,
} from '../../../../src/compiler/identity/types.js';

const SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Resolve companies.',
  inputs: [
    {
      ref: 'revops.salesforce_accounts',
      fqTableName: 'RAW.SALESFORCE_ACCOUNTS',
      alias: 's0',
      role: 'internal',
      trustTier: 'gold',
      idFields: ['salesforce_account_id'],
    },
  ],
  standardize: [
    {
      field: 'company_name',
      transforms: ['lowercase'],
    },
  ],
  blocking: {
    rules: [{ name: 'exact_name', key: 'standardized_company_name' }],
  },
  deterministicRules: [
    {
      name: 'exact_name',
      conditions: [{ field: 'company_name', operator: 'exact', bothNotNull: true }],
      action: 'auto_merge',
      confidence: 1,
    },
  ],
  thresholds: {
    autoMerge: 0.95,
    review: 0.6,
    autoReject: 0.6,
  },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
  targetSchema: 'ENTITY_GRAPH',
};

describe('compileResolutionRun', () => {
  it('creates append-only tables before stages that reference them', () => {
    const result = compileResolutionRun(SPEC, 'snowflake', 'PUBLIC');

    expect(result.statements[0]?.name).toBe('ddl_resolve_state');
    expect(result.statements[1]?.name).toBe('ddl_match_inbox');
    expect(result.statements[2]?.name).toBe('ddl_review_decisions');
    expect(result.statements.some((stmt) => stmt.name === 'blocking')).toBe(true);
  });

  it('uses the spec target schema override for generated SQL', () => {
    const result = compileResolutionRun(SPEC, 'snowflake', 'PUBLIC');

    expect(result.statements[0]?.sql).toContain('"ENTITY_GRAPH"."COMPANY__RESOLVE_STATE"');
    expect(
      result.statements.some((stmt) => stmt.sql.includes('"PUBLIC"."COMPANY__REVIEW_DECISIONS"'))
    ).toBe(false);
  });

  it('falls back to the command schema when spec.targetSchema is undefined', () => {
    const specWithoutOverride = { ...SPEC, targetSchema: undefined };
    const result = compileResolutionRun(specWithoutOverride, 'snowflake', 'PUBLIC');

    expect(result.statements[0]?.sql).toContain('"PUBLIC"."COMPANY__RESOLVE_STATE"');
  });

  it('routes review pairs into a literal review band', () => {
    const result = compileResolutionRun(SPEC, 'snowflake', 'PUBLIC');
    const thresholdStatement = result.statements.find(
      (statement) => statement.name === 'threshold_routing'
    );

    expect(thresholdStatement?.sql).toContain(`'review' AS "THRESHOLD_BAND"`);
    expect(thresholdStatement?.sql).not.toContain(`'agent_review'`);
    expect(thresholdStatement?.sql).not.toContain(`'human_review'`);
  });

  it('creates forgotten-record tombstones before standardization and anti-joins them', () => {
    const result = compileResolutionRun(SPEC, 'duckdb', 'PUBLIC');
    const forgottenDdl = result.statements.find(
      (statement) => statement.name === 'ddl_forgotten_records'
    );
    const standardize = result.statements.find((statement) => statement.name === 'standardize');

    expect(forgottenDdl?.sql).toContain('"entity_graph"."company__forgotten_records"');
    expect(standardize?.sql).toContain('LEFT JOIN "entity_graph"."company__forgotten_records"');
    expect(standardize?.sql).toContain('"forgotten"."tombstone_id" IS NULL');
    expect(
      result.statements.findIndex((statement) => statement.name === 'ddl_forgotten_records')
    ).toBeLessThan(result.statements.findIndex((statement) => statement.name === 'standardize'));
  });

  it('generates a full cross join and warning when blocking is omitted', () => {
    const result = compileResolutionRun({ ...SPEC, blocking: undefined }, 'snowflake', 'PUBLIC');
    const blockingStatement = result.statements.find((statement) => statement.name === 'blocking');

    expect(blockingStatement?.sql).toContain(
      'JOIN "ENTITY_GRAPH"."COMPANY__STANDARDIZED" b_std ON a_std."RECORD_ID" < b_std."RECORD_ID"'
    );
    expect(blockingStatement?.sql).toContain(`'[]' AS "BLOCKING_RULES"`);
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0] ?? '';
    expect(warning).toContain('blocking is disabled');
    expect(warning).toContain('Pair count warning threshold: 100000');
  });

  it('uses a JSON empty array expression for MySQL when blocking is omitted', () => {
    const result = compileResolutionRun({ ...SPEC, blocking: undefined }, 'mysql', 'ENTITY_GRAPH');
    const blockingStatement = result.statements.find((statement) => statement.name === 'blocking');

    expect(blockingStatement?.sql).toContain('a_std.`record_id` < b_std.`record_id`');
    expect(blockingStatement?.sql).toContain('JSON_ARRAY() AS `blocking_rules`');
  });

  it('skips semantic triage statements when semantic triage is absent', () => {
    const result = compileResolutionRun(SPEC, 'duckdb', 'PUBLIC');

    expect(result.statements.map((statement) => statement.name)).not.toContain(
      'semantic_pair_scores'
    );
  });

  it('runs DuckDB semantic triage after threshold routing', () => {
    const result = compileResolutionRun(
      {
        ...SPEC,
        semanticTriage: {
          provider: 'openai_text_embedding_3_small',
          fields: ['company_name'],
          promoteToMergeThreshold: 0.94,
          promoteToRejectThreshold: 0.55,
        },
      },
      'duckdb',
      'PUBLIC'
    );
    const names = result.statements.map((statement) => statement.name);

    const thresholdRoutingIndex = names.indexOf('threshold_routing');
    const semanticPairScoresIndex = names.indexOf('semantic_pair_scores');

    expect(thresholdRoutingIndex).toBeGreaterThanOrEqual(0);
    expect(semanticPairScoresIndex).toBeGreaterThanOrEqual(0);
    expect(thresholdRoutingIndex).toBeLessThan(semanticPairScoresIndex);
    expect(names).toEqual(
      expect.arrayContaining([
        'semantic_pair_scores',
        'semantic_review_queue',
        'semantic_not_match_edges',
        'audit_semantic_promotions',
      ])
    );
    const reviewQueue = result.statements.find(
      (statement) => statement.name === 'semantic_review_queue'
    );
    expect(reviewQueue?.sql).toContain('kept_for_review');
    expect(reviewQueue?.sql).toContain('semantic_score');
  });

  it('emits delta-scoped standardize, blocking, and scoring SQL for incremental runs', () => {
    const result = compileResolutionRun(SPEC, 'duckdb', 'PUBLIC', {
      incremental: {
        runId: 'run_1',
        specFingerprint: 'abc123',
        modeReason: 'resolve_state_matched',
        sources: [
          {
            sourceRef: 'revops.salesforce_accounts',
            fqTableName: 'RAW.SALESFORCE_ACCOUNTS',
            watermarkKind: 'loaded_at',
            watermarkColumn: 'loaded_at',
            previousWatermarkValue: '2026-01-01 00:00:00',
          },
        ],
      },
      state: {
        runId: 'run_1',
        specFingerprint: 'abc123',
        mode: 'incremental',
        modeReason: 'resolve_state_matched',
        sources: [
          {
            sourceRef: 'revops.salesforce_accounts',
            fqTableName: 'RAW.SALESFORCE_ACCOUNTS',
            watermarkKind: 'loaded_at',
            watermarkColumn: 'loaded_at',
          },
        ],
      },
    });
    const standardize = result.statements.find(
      (statement) => statement.name === 'standardize_delta'
    );
    const blocking = result.statements.find((statement) => statement.name === 'blocking_delta');
    const scoring = result.statements.find((statement) => statement.name === 'scoring_delta');

    expect(standardize?.sql).toContain('company__standardized_delta');
    expect(standardize?.sql).toContain('"src"."loaded_at" > CAST');
    expect(standardize?.sql).toContain('"src"."loaded_at" = CAST');
    expect(standardize?.sql).toContain('NOT EXISTS');
    expect(standardize?.sql).toContain('"entity_graph"."company__standardized"');
    expect(blocking?.sql).toContain('"entity_graph"."company__standardized_delta" a_std');
    expect(blocking?.sql).toContain('JOIN "entity_graph"."company__standardized" b_std');
    expect(blocking?.sql).not.toContain(
      'FROM "entity_graph"."company__standardized" a_std\nJOIN "entity_graph"."company__standardized" b_std'
    );
    expect(scoring?.sql).toContain('"entity_graph"."company__candidate_pairs_delta"');
    expect(scoring?.sql).toContain('WHERE existing."pair_id" = scored."pair_id"');
    expect(result.statements.map((statement) => statement.name)).toEqual(
      expect.arrayContaining([
        'delete_delta_review_queue',
        'delete_delta_pair_scores',
        'delete_delta_candidate_pairs',
        'insert_match_inbox_delta',
        'insert_standardized_delta',
        'insert_candidate_pairs_delta',
        'mark_match_inbox_drained',
        'audit_incremental_run',
        'delete_resolve_state',
        'insert_resolve_state',
      ])
    );
  });

  it('deduplicates no-rules incremental candidate pairs', () => {
    const result = compileResolutionRun({ ...SPEC, blocking: { rules: [] } }, 'duckdb', 'PUBLIC', {
      incremental: {
        runId: 'run_1',
        specFingerprint: 'abc123',
        modeReason: 'resolve_state_matched',
        sources: [
          {
            sourceRef: 'revops.salesforce_accounts',
            fqTableName: 'RAW.SALESFORCE_ACCOUNTS',
            watermarkKind: 'loaded_at',
            watermarkColumn: 'loaded_at',
            previousWatermarkValue: '2026-01-01 00:00:00',
          },
        ],
      },
      state: {
        runId: 'run_1',
        specFingerprint: 'abc123',
        mode: 'incremental',
        modeReason: 'resolve_state_matched',
        sources: [
          {
            sourceRef: 'revops.salesforce_accounts',
            fqTableName: 'RAW.SALESFORCE_ACCOUNTS',
            watermarkKind: 'loaded_at',
            watermarkColumn: 'loaded_at',
          },
        ],
      },
    });

    const blocking = result.statements.find((statement) => statement.name === 'blocking_delta');

    expect(blocking?.tableCreated).toBe('company__candidate_pairs_delta');
    expect(blocking?.sql).toContain('SELECT DISTINCT');
    expect(blocking?.sql).toContain('"entity_graph"."company__standardized_delta" a_std');
  });

  it('emits resolve-state DDL and delta pair SQL for Snowflake and BigQuery incremental runs', () => {
    const incrementalOptions = {
      incremental: {
        runId: 'run_1',
        specFingerprint: 'abc123',
        modeReason: 'resolve_state_matched',
        sources: [
          {
            sourceRef: 'revops.salesforce_accounts',
            fqTableName: 'RAW.SALESFORCE_ACCOUNTS',
            watermarkKind: 'loaded_at' as const,
            watermarkColumn: 'loaded_at',
            previousWatermarkValue: '2026-01-01 00:00:00',
          },
        ],
      },
      state: {
        runId: 'run_1',
        specFingerprint: 'abc123',
        mode: 'incremental' as const,
        modeReason: 'resolve_state_matched',
        sources: [
          {
            sourceRef: 'revops.salesforce_accounts',
            fqTableName: 'RAW.SALESFORCE_ACCOUNTS',
            watermarkKind: 'loaded_at' as const,
            watermarkColumn: 'loaded_at',
          },
        ],
      },
    };

    const snowflake = compileResolutionRun(SPEC, 'snowflake', 'PUBLIC', incrementalOptions);
    const snowflakeDdl = snowflake.statements.find(
      (statement) => statement.name === 'ddl_resolve_state'
    );
    const snowflakeBlocking = snowflake.statements.find(
      (statement) => statement.name === 'blocking_delta'
    );
    const snowflakeScoring = snowflake.statements.find(
      (statement) => statement.name === 'scoring_delta'
    );

    expect(snowflakeDdl?.sql).toContain('"ENTITY_GRAPH"."COMPANY__RESOLVE_STATE"');
    expect(snowflakeBlocking?.sql).toContain(
      'FROM "ENTITY_GRAPH"."COMPANY__STANDARDIZED_DELTA" a_std'
    );
    expect(snowflakeBlocking?.sql).toContain('JOIN "ENTITY_GRAPH"."COMPANY__STANDARDIZED" b_std');
    expect(snowflakeScoring?.sql).toContain(
      'FROM "ENTITY_GRAPH"."COMPANY__CANDIDATE_PAIRS_DELTA" cp'
    );

    const bigquery = compileResolutionRun(SPEC, 'bigquery', 'PUBLIC', incrementalOptions);
    const bigqueryDdl = bigquery.statements.find(
      (statement) => statement.name === 'ddl_resolve_state'
    );
    const bigqueryBlocking = bigquery.statements.find(
      (statement) => statement.name === 'blocking_delta'
    );
    const bigqueryScoring = bigquery.statements.find(
      (statement) => statement.name === 'scoring_delta'
    );

    expect(bigqueryDdl?.sql).toContain('`entity_graph`.`company__resolve_state`');
    expect(bigqueryBlocking?.sql).toContain(
      'FROM `entity_graph`.`company__standardized_delta` a_std'
    );
    expect(bigqueryBlocking?.sql).toContain('JOIN `entity_graph`.`company__standardized` b_std');
    expect(bigqueryScoring?.sql).toContain(
      'FROM `entity_graph`.`company__candidate_pairs_delta` cp'
    );
  });

  it('records the plan-time watermark literal instead of a live recompute (closes the state-write race)', () => {
    const withCaptured = {
      state: {
        runId: 'run_1',
        specFingerprint: 'abc123',
        mode: 'incremental' as const,
        modeReason: 'resolve_state_matched',
        sources: [
          {
            sourceRef: 'revops.salesforce_accounts',
            fqTableName: 'RAW.SALESFORCE_ACCOUNTS',
            watermarkKind: 'loaded_at' as const,
            watermarkColumn: 'loaded_at',
          },
        ],
        capturedWatermarkValues: new Map([['revops.salesforce_accounts', '2026-06-01 12:00:00']]),
      },
    };
    const compiled = compileResolutionRun(SPEC, 'duckdb', 'ENTITY_GRAPH', withCaptured);
    const insert = compiled.statements.find((s) => s.name === 'insert_resolve_state');
    // The recorded watermark is the pre-scan literal, NOT a live MAX(loaded_at)
    // subquery re-evaluated after the pipeline.
    expect(insert?.sql).toContain(`'2026-06-01 12:00:00' AS "watermark_value"`);
    expect(insert?.sql).not.toMatch(/MAX\("src"\."loaded_at"\)/i);

    // Without captured values (full-run fallback) the live subquery is retained.
    const live = compileResolutionRun(SPEC, 'duckdb', 'ENTITY_GRAPH', {
      state: { ...withCaptured.state, capturedWatermarkValues: undefined },
    });
    const liveInsert = live.statements.find((s) => s.name === 'insert_resolve_state');
    expect(liveInsert?.sql).toMatch(/MAX\("src"\."loaded_at"\)/i);
  });

  it('changes the run fingerprint when a cost-driving blocking rule changes', () => {
    const original = computeResolutionRunFingerprint(SPEC, 'duckdb', 'ENTITY_GRAPH');
    const changed = computeResolutionRunFingerprint(
      {
        ...SPEC,
        blocking: {
          rules: [{ name: 'exact_name_changed', key: 'LOWER(standardized_company_name)' }],
        },
      },
      'duckdb',
      'ENTITY_GRAPH'
    );

    expect(changed).not.toBe(original);
  });
});

describe('compileResolutionRun fuzzy UDF inlining', () => {
  const FUZZY_SPEC: ResolvedResolutionSpec = {
    ...SPEC,
    deterministicRules: [],
    scoring: {
      method: 'weighted_features',
      features: [
        { field: 'standardized_company_name', algorithm: 'jaro_winkler', weight: 0.7 },
        { field: 'standardized_company_name', algorithm: 'token_cosine', weight: 0.3 },
      ],
    },
  };

  it('inlines BigQuery fuzzy UDFs into the scoring statement and emits no preamble', () => {
    const result = compileResolutionRun(FUZZY_SPEC, 'bigquery', 'PUBLIC');

    expect(result.preamble).toBeUndefined();

    const scoring = result.statements.find((statement) => statement.name === 'scoring');
    expect(scoring?.sql).toContain('bms_jaro_winkler(');
    expect(scoring?.sql).toContain('bms_token_cosine(');
    expect(scoring?.sql.startsWith('CREATE TEMP FUNCTION bms_jaro_winkler')).toBe(true);
    expect(scoring?.sql).toContain('CREATE TEMP FUNCTION bms_token_cosine');
    // Must be the native SQL UDF — a LANGUAGE js UDF is untenably slow.
    expect(scoring?.sql).not.toContain('LANGUAGE js');

    // Statements that do not call the UDF must not be prefixed.
    const standardize = result.statements.find((statement) => statement.name === 'standardize');
    expect(standardize?.sql).not.toContain('CREATE TEMP FUNCTION bms_jaro_winkler');
    expect(standardize?.sql).not.toContain('CREATE TEMP FUNCTION bms_token_cosine');
  });

  it('emits no BigQuery fuzzy UDFs anywhere on duckdb', () => {
    const result = compileResolutionRun(FUZZY_SPEC, 'duckdb', 'PUBLIC');

    expect(result.preamble).toBeUndefined();
    for (const statement of result.statements) {
      expect(statement.sql).not.toContain('CREATE TEMP FUNCTION bms_jaro_winkler');
      expect(statement.sql).not.toContain('bms_jaro_winkler(');
      expect(statement.sql).not.toContain('CREATE TEMP FUNCTION bms_token_cosine');
      expect(statement.sql).not.toContain('bms_token_cosine(');
    }
  });

  it('keeps the standalone extension preamble on postgres and inlines no UDF', () => {
    const result = compileResolutionRun(FUZZY_SPEC, 'postgres', 'PUBLIC');

    expect(result.preamble).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    for (const statement of result.statements) {
      expect(statement.sql).not.toContain('CREATE TEMP FUNCTION bms_jaro_winkler');
    }
  });
});

describe('compileResolutionCluster', () => {
  it('uses the spec target schema override for clustering SQL', () => {
    const result = compileResolutionCluster(SPEC, 'snowflake', 'PUBLIC');
    const components = result.statements.find((statement) => statement.name === 'components');
    const stableClusters = result.statements.find(
      (statement) => statement.name === 'stable_clusters'
    );
    const crosswalk = result.statements.find((statement) => statement.name === 'crosswalk');

    expect(components?.sql).toContain('"ENTITY_GRAPH"."COMPANY__COMPONENTS"');
    expect(stableClusters?.sql).toContain('"ENTITY_GRAPH"."COMPANY__CLUSTERS"');
    expect(crosswalk?.sql).toContain('"ENTITY_GRAPH"."COMPANY__CROSSWALKS"');
    expect(
      result.statements.some((stmt) => stmt.sql.includes('"PUBLIC"."COMPANY__CLUSTERS"'))
    ).toBe(false);
    expect(
      result.statements.some((stmt) => stmt.sql.includes('"PUBLIC"."COMPANY__CROSSWALKS"'))
    ).toBe(false);
  });

  it('falls back to the command schema for clustering when spec.targetSchema is undefined', () => {
    const specWithoutOverride = { ...SPEC, targetSchema: undefined };
    const result = compileResolutionCluster(specWithoutOverride, 'snowflake', 'PUBLIC');
    const stableClusters = result.statements.find(
      (statement) => statement.name === 'stable_clusters'
    );
    const crosswalk = result.statements.find((statement) => statement.name === 'crosswalk');

    expect(stableClusters?.sql).toContain('"PUBLIC"."COMPANY__CLUSTERS"');
    expect(crosswalk?.sql).toContain('"PUBLIC"."COMPANY__CROSSWALKS"');
  });

  it('keeps non-applied decisions out of auto-merge edges', () => {
    const result = compileResolutionCluster(SPEC, 'snowflake', 'PUBLIC');
    const components = result.statements.find((statement) => statement.name === 'components');

    expect(components?.sql).toContain(`AND (ld."PAIR_ID" IS NULL OR ld."STATUS" = 'proposed')`);
    expect(components?.sql).toContain(`COALESCE(ld."STATUS", 'applied') = 'applied'`);
  });

  it('does not cap connected component recursion at 100 hops', () => {
    const result = compileResolutionCluster(SPEC, 'snowflake', 'PUBLIC');
    const components = result.statements.find((statement) => statement.name === 'components');

    expect(components?.sql).toContain('components(node_id, component_id)');
    expect(components?.sql).not.toContain('depth < 100');
  });

  it('uses review confidence when computing cluster confidence scores', () => {
    const result = compileResolutionCluster(SPEC, 'snowflake', 'PUBLIC');
    const components = result.statements.find((statement) => statement.name === 'components');

    expect(components?.sql).toContain('"CONFIDENCE"');
    expect(components?.sql).toContain('GREATEST(');
    expect(components?.sql).toContain('node_confidence');
  });

  it('uses semantic triage promotions and rejects in clustering when enabled', () => {
    const result = compileResolutionCluster(
      {
        ...SPEC,
        semanticTriage: {
          provider: 'openai_text_embedding_3_small',
          fields: ['company_name'],
          promoteToMergeThreshold: 0.94,
          promoteToRejectThreshold: 0.55,
        },
      },
      'duckdb',
      'PUBLIC'
    );
    const components = result.statements.find((statement) => statement.name === 'components');

    expect(components?.sql).toContain('Semantic triage promoted review-band pairs to merge');
    expect(components?.sql).toContain('> 0.55');
    expect(components?.sql).toContain('>= 0.94');
  });

  it('assigns stable entity IDs after connected components', () => {
    const result = compileResolutionCluster(SPEC, 'snowflake', 'PUBLIC');

    expect(result.statements.map((statement) => statement.name)).toEqual([
      'ddl_entity_id_events',
      'ddl_entity_id_record_map',
      'ddl_entity_id_current',
      'ddl_entity_id_aliases',
      'backfill_entity_id_events',
      'bootstrap_entity_id_record_map',
      'bootstrap_entity_id_aliases',
      'components',
      'assign_entity_ids',
      'refresh_entity_id_record_map',
      'refresh_entity_id_aliases',
      'refresh_entity_id_current',
      'stable_clusters',
      'crosswalk',
      'golden_record',
      'golden',
    ]);

    const stableClusters = result.statements.find(
      (statement) => statement.name === 'stable_clusters'
    );
    const assignment = result.statements.find(
      (statement) => statement.name === 'assign_entity_ids'
    );
    expect(stableClusters?.sql).toContain('"ENTITY_ID" AS "CLUSTER_ID"');
    expect(stableClusters?.sql).toContain('"COMPONENT_ID"');
    expect(assignment?.sql).toContain('"ENTITY_GRAPH"."COMPANY__ENTITY_ID_EVENTS"');
    expect(assignment?.sql).toContain("'new_record_existing_entity'");
  });

  it('summarizes one latest assignment reason per live entity', () => {
    const sql = generateEntityIdSummaryQuery('company', 'snowflake', 'ENTITY_GRAPH');

    expect(sql).toContain('WITH latest_entity_reason AS');
    expect(sql).toContain('PARTITION BY "ENTITY_ID"');
    expect(sql).toContain('ORDER BY "ASSIGNED_AT" DESC, "ASSIGNMENT_REASON" DESC');
    expect(sql).toContain('FROM latest_entity_reason');
    expect(sql).not.toContain('COUNT(DISTINCT CASE');
  });
});

describe('compileResolutionProfile', () => {
  it('builds entity profile and quality statements by default', () => {
    const result = compileResolutionProfile(SPEC, 'snowflake', 'PUBLIC');
    expect(result.statements.map((statement) => statement.name)).toEqual([
      'entity_profile',
      'entity_quality',
    ]);
  });

  it('supports activation projections when profile config is present', () => {
    const result = compileResolutionProfile(
      {
        ...SPEC,
        profile: {
          displayName: { field: 'company_name', sourcePrecedence: ['revops.salesforce_accounts'] },
          attributes: [{ field: 'company_name', alias: 'legal_name' }],
          quality: {
            freshnessWindows: [
              { days: 1, score: 1 },
              { days: 7, score: 0.8 },
            ],
            sourceDiversityCap: 3,
            trustWeights: {
              identity: 0.4,
              freshness: 0.25,
              diversity: 0.2,
              coverage: 0.15,
            },
          },
          activations: [
            {
              name: 'salesforce_sync',
              version: 'v1',
              trustGate: 0.8,
              fields: [{ field: 'display_name', target: 'account_name' }],
              identityMap: {
                sourceSystem: 'revops.salesforce_accounts',
                idAlias: 'salesforce_account_id',
              },
            },
          ],
        },
      },
      'snowflake',
      'PUBLIC'
    );

    expect(result.statements.map((statement) => statement.name)).toContain(
      'activation_salesforce_sync_v1'
    );
    const activationStatement = result.statements.find(
      (statement) => statement.name === 'activation_salesforce_sync_v1'
    );
    expect(activationStatement?.sql).toContain('SALESFORCE_SYNC__PROJECTION_V1');
    expect(activationStatement?.sql).toContain('"ENTITY_TRUST_SCORE"');
  });
});

describe('generateScoringSql', () => {
  it('quotes MySQL field score separators as SQL string literals', () => {
    const scoringSpec: ResolvedResolutionSpec = {
      ...SPEC,
      deterministicRules: [],
      scoring: {
        method: 'weighted_features',
        features: [
          { field: 'standardized_company_name', algorithm: 'exact', weight: 0.6 },
          { field: 'standardized_domain', algorithm: 'exact', weight: 0.4 },
        ],
      },
    };

    const statement = generateScoringSql(scoringSpec, 'mysql', 'PUBLIC');

    expect(statement.sql).toContain(", ',', CONCAT(");
  });

  it('builds Databricks field score JSON with CONCAT and STRING casts', () => {
    const scoringSpec: ResolvedResolutionSpec = {
      ...SPEC,
      deterministicRules: [],
      scoring: {
        method: 'weighted_features',
        features: [
          { field: 'standardized_company_name', algorithm: 'exact', weight: 0.6 },
          { field: 'standardized_domain', algorithm: 'exact', weight: 0.4 },
        ],
      },
    };

    const statement = generateScoringSql(scoringSpec, 'databricks', 'PUBLIC');

    expect(statement.sql).toContain("CONCAT('{',");
    expect(statement.sql).toContain(' AS STRING)');
  });
});

describe('generateScoringSql fellegi_sunter', () => {
  const fsSpec = (overrides: Partial<ResolvedResolutionSpec> = {}): ResolvedResolutionSpec => ({
    ...SPEC,
    deterministicRules: [],
    scoring: {
      method: 'fellegi_sunter',
      prior: 0.0001,
      comparisons: [
        {
          field: 'standardized_company_name',
          levels: [
            { op: 'exact', m: 0.85, u: 0.0001 },
            { op: 'else', m: 0.15, u: 0.9999 },
          ],
        },
        {
          field: 'standardized_domain',
          levels: [
            { op: 'exact', m: 0.7, u: 0.0005 },
            { op: 'else', m: 0.3, u: 0.9995 },
          ],
        },
      ],
    },
    ...overrides,
  });

  // Single-comparison FS spec (prior 0.0001) over `standardized_company_name`.
  const fsSpecWith = (levels: FellegiSunterLevel[]): ResolvedResolutionSpec => ({
    ...SPEC,
    deterministicRules: [],
    scoring: {
      method: 'fellegi_sunter',
      prior: 0.0001,
      comparisons: [{ field: 'standardized_company_name', levels }],
    },
  });

  it.each(['snowflake', 'bigquery', 'postgres', 'duckdb', 'databricks', 'mysql'] as const)(
    'emits a calibrated probability via EXP and match_type fellegi_sunter for %s',
    (dialect) => {
      const statement = generateScoringSql(fsSpec(), dialect, 'PUBLIC');

      expect(statement.tableCreated).toBe('company__pair_scores');
      // match_type literal + the sigmoid over summed log2 match weights.
      expect(statement.sql).toContain("'fellegi_sunter'");
      expect(statement.sql).toContain('1.0 / (1.0 + EXP(-(');
      expect(statement.sql).toContain('* 0.6931471805599453');
      // The sigmoid is clamped into the open interval (0,1) so a saturating sum
      // of strong evidence can't floor/ceil the composite to exactly 0.0/1.0 on
      // double-precision engines.
      expect(statement.sql).toContain('LEAST(0.999999999, GREATEST(0.000000001,');
      // Missing data on either side contributes no evidence — 0 bits, not a penalty.
      expect(statement.sql).toContain('IS NULL OR');
      expect(statement.sql).toContain('IS NULL THEN 0.0');
    }
  );

  it('inlines fuzzy level thresholds and match weights (DuckDB)', () => {
    const spec: ResolvedResolutionSpec = {
      ...SPEC,
      deterministicRules: [],
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'exact', m: 0.85, u: 0.0001 },
              { op: 'jaro_winkler', gte: 0.9, m: 0.1, u: 0.001 },
              { op: 'token_cosine', gte: 0.8, m: 0.03, u: 0.0005 },
              { op: 'else', m: 0.05, u: 0.9989 },
            ],
          },
        ],
      },
    };
    const statement = generateScoringSql(spec, 'duckdb', 'PUBLIC');
    const nameA = `a.${quoteIdentifier('standardized_company_name', 'duckdb')}`;
    const nameB = `b.${quoteIdentifier('standardized_company_name', 'duckdb')}`;

    // exact level → direct equality
    expect(statement.sql).toContain(`${nameA} = ${nameB}`);
    // jaro_winkler level → similarity expr gated by the gte threshold
    expect(statement.sql).toContain('>= 0.900000');
    // token_cosine level → DuckDB token-set SQL gated by its own threshold
    expect(statement.sql).toContain('string_split');
    expect(statement.sql).toContain('>= 0.800000');
    // an exact-name agreement inlines a strong positive match weight (~log2(8500))
    expect(statement.sql).toMatch(/THEN 13\.\d{6}/);
  });

  it('applies the deterministic exclusion when rules are present', () => {
    const statement = generateScoringSql(
      fsSpec({ deterministicRules: SPEC.deterministicRules }),
      'duckdb',
      'PUBLIC'
    );

    expect(statement.sql).toContain('WHERE NOT (');
  });

  it('inlines per-level log2(m/u) weights — including a negative else and the prior (DuckDB)', () => {
    const statement = generateScoringSql(
      fsSpecWith([
        { op: 'exact', m: 0.85, u: 0.0001 },
        { op: 'else', m: 0.05, u: 0.9989 },
      ]),
      'duckdb',
      'PUBLIC'
    );

    // Weights are log2(m/u), not similarities; computed the same way the codegen does.
    const priorBits = Math.log2(0.0001 / (1 - 0.0001)).toFixed(6); // negative prior log-odds
    const exactBits = Math.log2(0.85 / 0.0001).toFixed(6); // strong positive (~13.05)
    const elseBits = Math.log2(0.05 / 0.9989).toFixed(6); // negative (disagreement)
    expect(exactBits.startsWith('13.')).toBe(true);
    expect(elseBits.startsWith('-')).toBe(true);

    expect(statement.sql).toContain(`THEN ${exactBits}`);
    expect(statement.sql).toContain(`ELSE ${elseBits}`);
    // The prior leads the bit sum; the negative else composes without a doubled operator.
    expect(statement.sql).toContain(`EXP(-(${priorBits} + (`);
    expect(statement.sql).not.toContain('+ -');
  });

  it('emits a soundex level gated at the fixed 0.5 binary-match threshold (DuckDB)', () => {
    // soundex is a non-threshold op: the schema forbids `gte` on it, and
    // fuzzyScoreExpr('soundex') is binary (1.0 when the codes are equal, else
    // 0.0). The level therefore compiles to a FIXED `>= 0.5` gate — the
    // half-way constant that means "soundex codes match" — rather than a tunable
    // or defaulted threshold. Asserting the literal pins that intentional gate.
    const statement = generateScoringSql(
      fsSpecWith([
        { op: 'soundex', m: 0.6, u: 0.01 },
        { op: 'else', m: 0.4, u: 0.99 },
      ]),
      'duckdb',
      'PUBLIC'
    );

    expect(statement.sql).toContain('SOUNDEX(');
    expect(statement.sql).toContain('>= 0.5');
  });

  it.each(['mysql', 'redshift'] as const)(
    'compiles a soundex/exact fellegi_sunter spec for %s without a fuzzy-op throw',
    (dialect) => {
      const statement = generateScoringSql(
        fsSpecWith([
          { op: 'exact', m: 0.7, u: 0.001 },
          { op: 'soundex', m: 0.2, u: 0.05 },
          { op: 'else', m: 0.1, u: 0.949 },
        ]),
        dialect,
        'PUBLIC'
      );

      expect(statement.sql).toContain('SOUNDEX(');
      expect(statement.sql).toContain("'fellegi_sunter'");
    }
  );
});

describe('generateScoringSql scoring-field validation', () => {
  // A spec whose single input DECLARES its source columns, so the produced-column
  // universe is known and field existence is enforced (the base SPEC above uses
  // wildcard passthrough, which intentionally skips the check).
  const specWithColumns = (scoring: ResolvedResolutionSpec['scoring']): ResolvedResolutionSpec => ({
    ...SPEC,
    deterministicRules: [],
    inputs: [{ ...SPEC.inputs[0]!, sourceColumns: ['salesforce_account_id', 'company_name'] }],
    scoring,
  });

  it('rejects a fellegi_sunter comparison field the standardize stage does not produce', () => {
    expect(() =>
      generateScoringSql(
        specWithColumns({
          method: 'fellegi_sunter',
          prior: 0.0001,
          comparisons: [
            {
              field: 'standardized_naem', // typo — no `naem` standardize entry
              levels: [
                { op: 'exact', m: 0.85, u: 0.0001 },
                { op: 'else', m: 0.15, u: 0.9999 },
              ],
            },
          ],
        }),
        'duckdb',
        'PUBLIC'
      )
    ).toThrow(/scoring field "standardized_naem" is not produced/);
  });

  it('accepts a fellegi_sunter comparison over a produced standardized field', () => {
    expect(() =>
      generateScoringSql(
        specWithColumns({
          method: 'fellegi_sunter',
          prior: 0.0001,
          comparisons: [
            {
              field: 'standardized_company_name',
              levels: [
                { op: 'exact', m: 0.85, u: 0.0001 },
                { op: 'else', m: 0.15, u: 0.9999 },
              ],
            },
          ],
        }),
        'duckdb',
        'PUBLIC'
      )
    ).not.toThrow();
  });

  it('also validates weighted_features feature fields against produced columns', () => {
    expect(() =>
      generateScoringSql(
        specWithColumns({
          method: 'weighted_features',
          features: [{ field: 'standardized_nonexistent', algorithm: 'exact', weight: 1 }],
        }),
        'duckdb',
        'PUBLIC'
      )
    ).toThrow(/scoring field "standardized_nonexistent" is not produced/);
  });

  it('skips the check under wildcard passthrough (no declared source columns)', () => {
    // The base SPEC input declares no sourceColumns, so the produced universe is
    // unknown and field existence is intentionally not enforced.
    expect(() =>
      generateScoringSql(
        {
          ...SPEC,
          deterministicRules: [],
          scoring: {
            method: 'fellegi_sunter',
            prior: 0.0001,
            comparisons: [
              {
                field: 'standardized_anything',
                levels: [
                  { op: 'exact', m: 0.85, u: 0.0001 },
                  { op: 'else', m: 0.15, u: 0.9999 },
                ],
              },
            ],
          },
        },
        'duckdb',
        'PUBLIC'
      )
    ).not.toThrow();
  });
});

describe('generateStandardizeSql', () => {
  it.each(['snowflake', 'bigquery', 'postgres', 'duckdb', 'databricks', 'mysql'] as const)(
    'aliases the source table and uses the alias in standardize expressions for %s',
    (dialect) => {
      // SPEC has a single input with no sourceColumns. The old behaviour emitted
      // src.* for the raw passthrough; the fix drops passthrough in mixed mode
      // so branches are column-count-stable even when inputs differ in raw schema.
      const statement = generateStandardizeSql(SPEC, dialect, 'PUBLIC');
      const sourceAlias = quoteIdentifier('src', dialect);
      const companyName = quoteIdentifier('company_name', dialect);

      // FROM clause still uses the alias.
      expect(statement.sql).toContain(`FROM RAW.SALESFORCE_ACCOUNTS AS ${sourceAlias}`);
      // No wildcard — raw passthrough dropped to prevent branch count mismatch.
      expect(statement.sql).not.toContain(`${sourceAlias}.*`);
      expect(statement.sql).not.toContain('RAW.SALESFORCE_ACCOUNTS.*');
      // Standardize transform chain still uses the aliased column reference.
      expect(statement.sql).toContain(`LOWER(${sourceAlias}.${companyName})`);
    }
  );

  it('emits explicit columns when sourceColumns are known, excluding metadata collisions', () => {
    const specWithColumns: ResolvedResolutionSpec = {
      ...SPEC,
      inputs: [
        {
          ...SPEC.inputs[0]!,
          sourceColumns: ['salesforce_account_id', 'company_name', 'record_id', 'domain'],
        },
      ],
    };

    const statement = generateStandardizeSql(specWithColumns, 'duckdb', 'PUBLIC');
    const sourceAlias = quoteIdentifier('src', 'duckdb');

    // Should use explicit columns, not wildcard
    expect(statement.sql).not.toContain(`${sourceAlias}.*`);
    // Non-colliding columns should be present
    expect(statement.sql).toContain('"salesforce_account_id"');
    expect(statement.sql).toContain('"company_name"');
    expect(statement.sql).toContain('"domain"');
    // Colliding column 'record_id' must be excluded from src columns
    // (it is already emitted as a metadata column expression)
    expect(statement.sql).not.toContain(`${sourceAlias}."record_id"`);
  });

  it('excludes all known metadata column names from explicit source columns', () => {
    const metadataNames = [
      'record_id',
      'source_ref',
      'source_pk_json',
      '_source_system',
      '_source_entity_id',
      '_standardized_at',
      'standardized_company_name',
    ];
    const specWithColumns: ResolvedResolutionSpec = {
      ...SPEC,
      inputs: [
        {
          ...SPEC.inputs[0]!,
          sourceColumns: ['safe_col', 'company_name', ...metadataNames],
        },
      ],
    };

    const statement = generateStandardizeSql(specWithColumns, 'snowflake', 'PUBLIC');
    const sourceAlias = quoteIdentifier('src', 'snowflake');

    expect(statement.sql).toContain('"SAFE_COL"');
    for (const name of metadataNames) {
      const quotedName = quoteIdentifier(name, 'snowflake');
      expect(statement.sql).not.toContain(`${sourceAlias}.${quotedName} AS ${quotedName}`);
    }
  });

  // Spec where two inputs declare disjoint source columns and standardize
  // fields that are not shared across both inputs.
  const asymmetricSpec: ResolvedResolutionSpec = {
    ...SPEC,
    inputs: [
      {
        ...SPEC.inputs[0]!,
        ref: 'a',
        fqTableName: 'RAW.A',
        idFields: ['id_a'],
        sourceColumns: ['id_a', 'name', 'slug'],
      },
      {
        ...SPEC.inputs[0]!,
        ref: 'b',
        fqTableName: 'RAW.B',
        idFields: ['id_b'],
        sourceColumns: ['id_b', 'name', 'domain'],
      },
    ],
    standardize: [
      { field: 'name', transforms: ['lowercase'] },
      { field: 'slug', transforms: ['lowercase'] },
      { field: 'domain', transforms: ['lowercase'] },
    ],
    blocking: { rules: [{ name: 'exact_name', key: 'standardized_name' }] },
    deterministicRules: [
      {
        name: 'exact_name',
        conditions: [{ field: 'name', operator: 'exact', bothNotNull: true }],
        action: 'auto_merge',
        confidence: 1,
      },
    ],
  };

  it('NULL-pads standardize fields absent from a given input', () => {
    const statement = generateStandardizeSql(asymmetricSpec, 'duckdb', 'PUBLIC');
    const [branchA, branchB] = statement.sql.split('\nUNION ALL\n');

    // Input A has slug, lacks domain.
    expect(branchA).toContain('LOWER("src"."slug") AS "standardized_slug"');
    expect(branchA).toContain('CAST(NULL AS TEXT) AS "standardized_domain"');
    // Input B has domain, lacks slug.
    expect(branchB).toContain('LOWER("src"."domain") AS "standardized_domain"');
    expect(branchB).toContain('CAST(NULL AS TEXT) AS "standardized_slug"');
  });

  it('aligns passthrough columns across UNION ALL branches', () => {
    const statement = generateStandardizeSql(asymmetricSpec, 'duckdb', 'PUBLIC');
    const [branchA, branchB] = statement.sql.split('\nUNION ALL\n');

    const passthroughAliases = (branch: string): string[] => {
      const matches = [...branch.matchAll(/ AS ("[^"]+")/g)].map((m) => m[1]!);
      return matches;
    };

    expect(passthroughAliases(branchA!)).toEqual(passthroughAliases(branchB!));
    // Input A lacks 'domain' as a passthrough → NULL-padded with that alias.
    expect(branchA).toContain('CAST(NULL AS TEXT) AS "domain"');
  });

  it('throws when a standardize field is present in no input source columns', () => {
    const missingFieldSpec: ResolvedResolutionSpec = {
      ...asymmetricSpec,
      standardize: [
        { field: 'name', transforms: ['lowercase'] },
        { field: 'email', transforms: ['lowercase'] },
      ],
    };

    expect(() => generateStandardizeSql(missingFieldSpec, 'duckdb', 'PUBLIC')).toThrow(/"email"/);
  });

  it('uses catalog-backed address transforms in standardize expressions', () => {
    const addressSpec: ResolvedResolutionSpec = {
      ...SPEC,
      inputs: [
        {
          ...SPEC.inputs[0]!,
          sourceColumns: ['salesforce_account_id', 'street', 'postal_code'],
        },
      ],
      standardize: [
        { field: 'street', transforms: ['normalize_street'] },
        { field: 'postal_code', transforms: ['normalize_postal'] },
      ],
      blocking: { rules: [{ name: 'street_postal', key: 'standardized_street' }] },
    };

    const statement = generateStandardizeSql(addressSpec, 'duckdb', 'PUBLIC');
    expect(statement.sql).toContain('STREET');
    expect(statement.sql).toContain('regexp_matches(UPPER(TRIM("src"."postal_code"))');
    expect(statement.sql).toContain('AS "standardized_street"');
    expect(statement.sql).toContain('AS "standardized_postal_code"');
  });

  it.each([
    'snowflake',
    'bigquery',
    'postgres',
    'duckdb',
    'databricks',
    'mysql',
    'redshift',
  ] as const)('emits privacy hash transforms for %s', (dialect) => {
    vi.stubEnv('BOBSLED_CORE_MATCH_KEY_SECRET', 'unit-secret');
    try {
      const hashSpec: ResolvedResolutionSpec = {
        ...SPEC,
        inputs: [
          {
            ...SPEC.inputs[0]!,
            sourceColumns: ['salesforce_account_id', 'email', 'email_key'],
          },
        ],
        standardize: [
          { field: 'email', transforms: ['normalize_email_uid2', 'hmac_sha256'] },
          { field: 'email_key', transforms: [], preHashed: true },
        ],
        blocking: { rules: [{ name: 'email_key', key: 'standardized_email' }] },
      };
      const statement = generateStandardizeSql(hashSpec, dialect, 'PUBLIC');
      expect(statement.sql).not.toContain('unit-secret');
      expect(statement.sql).toContain(MATCH_KEY_SECRET_RUNTIME_TOKEN);
      expect(statement.sql).toMatch(/standardized_email/i);
      expect(statement.sql).toMatch(/standardized_email_key/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('omits raw passthrough and emits only bookkeeping+standardized when an input lacks sourceColumns', () => {
    // The old behaviour emitted `src.*` for the input without sourceColumns. When
    // inputs have different raw column counts (the live 19-vs-9 repro) the UNION
    // ALL branch counts mismatch → warehouse rejection. The fix drops raw passthrough
    // entirely in mixed mode so every branch has the same column count.
    const mixedSpec: ResolvedResolutionSpec = {
      ...asymmetricSpec,
      inputs: [
        {
          ...asymmetricSpec.inputs[0]!,
          ref: 'a',
          fqTableName: 'RAW.A',
          idFields: ['id_a'],
          sourceColumns: undefined,
        },
        asymmetricSpec.inputs[1]!,
      ],
    };

    const statement = generateStandardizeSql(mixedSpec, 'duckdb', 'PUBLIC');
    const branches = statement.sql.split('\nUNION ALL\n');
    const [branchA, branchB] = branches;

    // No wildcard — raw passthrough dropped to prevent branch count mismatch.
    expect(branchA).not.toContain('"src".*');
    // Both branches still emit the standardize transform chains.
    expect(branchA).toContain('LOWER("src"."slug") AS "standardized_slug"');
    expect(branchA).toContain('LOWER("src"."domain") AS "standardized_domain"');
    // Branch B (which HAS sourceColumns) also drops its raw passthrough in mixed
    // mode — no standalone "domain" or "id_b" passthrough column alias.
    expect(branchB).not.toContain('"src"."domain" AS "domain"');
    expect(branchB).not.toContain('"src"."id_b" AS "id_b"');
    // Branches have equal alias counts — the UNION ALL is valid.
    const countAliases = (s: string): number => (s.match(/ AS "/g) ?? []).length;
    expect(countAliases(branchA ?? '')).toBeGreaterThan(0);
    expect(countAliases(branchA ?? '')).toBe(countAliases(branchB ?? ''));
  });

  it('compiles an asymmetric resolution run end-to-end without throwing', () => {
    expect(() => compileResolutionRun(asymmetricSpec, 'duckdb', 'PUBLIC')).not.toThrow();
  });
});

describe('auto_merge: null (deterministic-only merging)', () => {
  const NULL_AUTO_MERGE_SPEC: ResolvedResolutionSpec = {
    ...SPEC,
    scoring: {
      method: 'weighted_features',
      features: [{ field: 'company_name', algorithm: 'jaro_winkler', weight: 1 }],
    },
    thresholds: { autoMerge: null, review: 0.6, autoReject: 0.4 },
  };

  it('gates merge edges on match_type instead of a score cutoff', () => {
    const result = compileResolutionCluster(NULL_AUTO_MERGE_SPEC, 'duckdb', 'PUBLIC');
    const components = result.statements.find((stmt) => stmt.name === 'components');
    expect(components).toBeDefined();
    expect(components?.sql).toContain(`WHERE ps."match_type" = 'deterministic'`);
    expect(components?.sql).not.toContain('>= null');
    expect(components?.sql).not.toContain('>= 0.95');
  });

  it('routes the unbounded review band to the queue, excluding deterministic pairs', () => {
    const result = compileResolutionRun(NULL_AUTO_MERGE_SPEC, 'duckdb', 'PUBLIC');
    const threshold = result.statements.find((stmt) => stmt.name === 'threshold_routing');
    expect(threshold).toBeDefined();
    expect(threshold?.sql).toContain(`"composite_score" >= 0.6`);
    expect(threshold?.sql).toContain(`"match_type" <> 'deterministic'`);
    expect(threshold?.sql).not.toContain('< null');
    // Midpoint heuristic falls back to (1 + review) / 2 = 0.8.
    expect(threshold?.sql).toContain('>= 0.8');
  });

  it('keeps the numeric cutoffs when auto_merge is set', () => {
    const result = compileResolutionRun(SPEC, 'duckdb', 'PUBLIC');
    const threshold = result.statements.find((stmt) => stmt.name === 'threshold_routing');
    expect(threshold?.sql).toContain('< 0.95');
    expect(threshold?.sql).not.toContain(`"match_type" <> 'deterministic'`);
  });

  it('warns when a deterministic rule confidence falls below review', () => {
    const spec: ResolvedResolutionSpec = {
      ...NULL_AUTO_MERGE_SPEC,
      deterministicRules: [
        {
          name: 'weak_rule',
          conditions: [{ field: 'company_name', operator: 'exact', bothNotNull: true }],
          action: 'auto_merge',
          confidence: 0.5,
        },
      ],
    };
    const result = compileResolutionRun(spec, 'duckdb', 'PUBLIC');
    expect(result.warnings.join('\n')).toContain('"weak_rule" (confidence 0.5)');

    const calibrated = compileResolutionRun(NULL_AUTO_MERGE_SPEC, 'duckdb', 'PUBLIC');
    expect(calibrated.warnings.join('\n')).not.toContain('deterministic rules always merge');
  });
});

describe('deterministic flag_for_review', () => {
  const FLAG_SPEC: ResolvedResolutionSpec = {
    ...SPEC,
    scoring: {
      method: 'weighted_features',
      features: [{ field: 'company_name', algorithm: 'jaro_winkler', weight: 1 }],
    },
    deterministicRules: [
      ...SPEC.deterministicRules,
      {
        name: 'same_name_no_domain',
        conditions: [{ field: 'company_name', operator: 'exact', bothNotNull: true }],
        action: 'flag_for_review',
        confidence: 0.85,
      },
    ],
  };

  it('scores flagged pairs with match_type deterministic_review', () => {
    const statement = generateScoringSql(FLAG_SPEC, 'duckdb', 'PUBLIC');
    expect(statement.sql).toContain(`'deterministic_review' AS "match_type"`);
    // The auto_merge rule keeps its plain deterministic match_type.
    expect(statement.sql).toContain(`'deterministic' AS "match_type"`);
  });

  it('routes flagged pairs to the queue regardless of score band', () => {
    const result = compileResolutionRun(FLAG_SPEC, 'duckdb', 'PUBLIC');
    const threshold = result.statements.find((stmt) => stmt.name === 'threshold_routing');
    expect(threshold?.sql).toContain(`OR "match_type" = 'deterministic_review'`);
    expect(threshold?.sql).toContain(
      `WHEN "match_type" = 'deterministic_review' THEN 'deterministic_review'`
    );
  });

  it('carries rule_name into the review queue', () => {
    const result = compileResolutionRun(FLAG_SPEC, 'duckdb', 'PUBLIC');
    const threshold = result.statements.find((stmt) => stmt.name === 'threshold_routing');
    expect(threshold?.sql).toContain(`"rule_name"`);
  });

  it('excludes flagged pairs from score-driven merge edges', () => {
    const result = compileResolutionCluster(FLAG_SPEC, 'duckdb', 'PUBLIC');
    const components = result.statements.find((stmt) => stmt.name === 'components');
    expect(components?.sql).toContain(`AND ps."match_type" <> 'deterministic_review'`);
  });

  it('keeps flagged pairs out of merge edges under auto_merge: null', () => {
    const spec: ResolvedResolutionSpec = {
      ...FLAG_SPEC,
      thresholds: { autoMerge: null, review: 0.6, autoReject: 0.4 },
    };
    const cluster = compileResolutionCluster(spec, 'duckdb', 'PUBLIC');
    const components = cluster.statements.find((stmt) => stmt.name === 'components');
    // Merge edges require the exact 'deterministic' match_type, which
    // 'deterministic_review' rows fail.
    expect(components?.sql).toContain(`WHERE ps."match_type" = 'deterministic'`);

    const run = compileResolutionRun(spec, 'duckdb', 'PUBLIC');
    const threshold = run.statements.find((stmt) => stmt.name === 'threshold_routing');
    expect(threshold?.sql).toContain(`OR "match_type" = 'deterministic_review'`);
  });

  it('emits unchanged routing SQL when no flag rules are present', () => {
    const run = compileResolutionRun(SPEC, 'duckdb', 'PUBLIC');
    const threshold = run.statements.find((stmt) => stmt.name === 'threshold_routing');
    expect(threshold?.sql).not.toContain('deterministic_review');

    const cluster = compileResolutionCluster(SPEC, 'duckdb', 'PUBLIC');
    const components = cluster.statements.find((stmt) => stmt.name === 'components');
    expect(components?.sql).not.toContain('deterministic_review');
  });

  it('does not warn about low-confidence flag rules under auto_merge: null', () => {
    const spec: ResolvedResolutionSpec = {
      ...FLAG_SPEC,
      thresholds: { autoMerge: null, review: 0.6, autoReject: 0.4 },
      deterministicRules: [
        ...SPEC.deterministicRules,
        {
          name: 'weak_flag',
          conditions: [{ field: 'company_name', operator: 'exact', bothNotNull: true }],
          action: 'flag_for_review',
          confidence: 0.3,
        },
      ],
    };
    const result = compileResolutionRun(spec, 'duckdb', 'PUBLIC');
    expect(result.warnings.join('\n')).not.toContain('weak_flag');
  });
});

describe('compileResolutionCluster on BigQuery', () => {
  const BARE_UNION = /\bUNION\b(?!\s+(ALL|DISTINCT))/;

  it('emits a procedural fixpoint script instead of a recursive CTE', () => {
    const result = compileResolutionCluster(SPEC, 'bigquery', 'PUBLIC');
    const components = result.statements.find((statement) => statement.name === 'components');

    expect(components?.sql.startsWith('BEGIN')).toBe(true);
    expect(components?.sql).toContain('LOOP');
    expect(components?.sql).toContain('END LOOP;');
    expect(components?.sql).toContain('CREATE OR REPLACE TEMP TABLE _eg_components');
    expect(components?.sql).toContain(
      'CREATE OR REPLACE TABLE `entity_graph`.`company__components`'
    );
    expect(components?.sql).not.toContain('WITH RECURSIVE');
  });

  it('keeps the recursive CTE on dialects that allow UNION in the recursive term', () => {
    const result = compileResolutionCluster(SPEC, 'duckdb', 'PUBLIC');
    const components = result.statements.find((statement) => statement.name === 'components');

    expect(components?.sql).toContain('WITH RECURSIVE');
    expect(components?.sql).not.toContain('BEGIN');
  });

  it('refuses to cluster on clickhouse, whose profile has no recursive CTE', () => {
    const cluster = () => compileResolutionCluster(SPEC, 'clickhouse', 'PUBLIC');

    // Must read as unimplemented rather than broken: name the dialect, the
    // construct, and point at BigQuery's dedicated strategy as the shape of a fix.
    expect(cluster).toThrow(/unsupported_feature:recursiveCte/i);
    expect(cluster).toThrow(/clickhouse/i);
    expect(cluster).toThrow(/connected-components clustering/i);
    expect(cluster).toThrow(/recursive CTE/i);
    expect(cluster).toThrow(/per-dialect clustering implementation/i);
  });

  it('never emits bare UNION in any cluster statement', () => {
    const result = compileResolutionCluster(SPEC, 'bigquery', 'PUBLIC');

    for (const statement of result.statements) {
      expect(statement.sql, `statement ${statement.name}`).not.toMatch(BARE_UNION);
    }
  });

  it('never emits bare UNION in any run statement (semantic triage included)', () => {
    const result = compileResolutionRun(
      {
        ...SPEC,
        semanticTriage: {
          provider: 'openai_text_embedding_3_small',
          fields: ['company_name'],
          promoteToMergeThreshold: 0.94,
          promoteToRejectThreshold: 0.55,
        },
      },
      'bigquery',
      'PUBLIC'
    );

    for (const statement of result.statements) {
      expect(statement.sql, `statement ${statement.name}`).not.toMatch(BARE_UNION);
    }
  });

  it('places the CTE clause after INSERT INTO for entity-id event statements', () => {
    // BigQuery rejects a leading WITH on INSERT statements; every dialect
    // accepts INSERT INTO ... (cols) WITH ... SELECT, so the portable form
    // is asserted for all dialects.
    for (const dialect of ['bigquery', 'duckdb', 'snowflake', 'postgres'] as const) {
      const result = compileResolutionCluster(SPEC, dialect, 'PUBLIC');
      for (const name of ['backfill_entity_id_events', 'assign_entity_ids']) {
        const statement = result.statements.find((stmt) => stmt.name === name);
        expect(statement?.sql.startsWith('INSERT INTO'), `${dialect} ${name}`).toBe(true);
      }
    }
  });

  it('types NULL columns in entity-id event candidates', () => {
    const result = compileResolutionCluster(SPEC, 'bigquery', 'PUBLIC');
    const backfill = result.statements.find(
      (statement) => statement.name === 'backfill_entity_id_events'
    );
    const assignment = result.statements.find(
      (statement) => statement.name === 'assign_entity_ids'
    );

    expect(backfill?.sql).toContain('CAST(NULL AS STRING) AS previous_entity_id');
    expect(backfill?.sql).toContain('CAST(NULL AS TIMESTAMP) AS prior_assigned_at');
    expect(assignment?.sql).toContain('CAST(NULL AS STRING) AS record_id');
    expect(assignment?.sql).not.toMatch(/(?<!\w)NULL AS source_ref/);
  });
});
