/**
 * Live BigQuery end-to-end resolution test (opt-in, env-gated).
 *
 * Skipped unless EG_BQ_TEST_PROJECT and EG_BQ_TEST_DATASET are set (plus ADC
 * credentials available). Never runs in normal `pnpm test:unit` / CI — it
 * costs real BigQuery compute. Run manually:
 *
 *   EG_BQ_TEST_PROJECT=my-project EG_BQ_TEST_DATASET=eg_test \
 *     pnpm --filter @bobsled-inc/entity-graph exec vitest run \
 *     tests/integration/bigquery-live-e2e.test.ts
 *
 * Pins the two BigQuery dialect regressions end-to-end on a real warehouse:
 *  - cluster: the components statement executes as a multi-statement script
 *    (DECLARE/WHILE loop) — recursive-CTE UNION is rejected by BigQuery.
 *  - review-apply: INSERT/DELETE statements with in-query CTE chains and
 *    typed NULL/TIMESTAMP literals.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveRunner,
  type IntegrationFile,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyReviewDecisions, runResolveProject } from '../../src/api/index.js';
import type { AgentDecisionBundleV1 } from '../../src/compiler/agent/types.js';

const PROJECT = process.env.EG_BQ_TEST_PROJECT;
const DATASET = process.env.EG_BQ_TEST_DATASET;
const LOCATION = process.env.EG_BQ_TEST_LOCATION;
const ENABLED = Boolean(PROJECT && DATASET);

const ENTITY = 'eg_dryrun_account';
const SOURCE_A = 'eg_dryrun_accounts_a';
const SOURCE_B = 'eg_dryrun_accounts_b';

function integration(): IntegrationFile {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'lake',
    source_type: 'bigquery',
    connection: {
      project_id: PROJECT!,
      ...(LOCATION ? { location: LOCATION } : {}),
    },
    auth: { type: 'adc' },
  } as IntegrationFile;
}

async function writeBigQueryFixture(dir: string): Promise<void> {
  await mkdir(join(dir, 'sources'), { recursive: true });
  await mkdir(join(dir, 'entity-graph'), { recursive: true });
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(
    join(dir, 'model-spec.yml'),
    ['entity_graph_dir: entity-graph', 'integrations_dir: integrations', ''].join('\n'),
    'utf8'
  );
  await writeFile(
    join(dir, 'integrations', 'lake.yml'),
    [
      `spec_version: '1'`,
      'type: integration',
      'name: lake',
      'source_type: bigquery',
      'connection:',
      `  project_id: ${PROJECT}`,
      ...(LOCATION ? [`  location: ${LOCATION}`] : []),
      'auth:',
      '  type: adc',
      '',
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    join(dir, 'sources', `${SOURCE_A}.yml`),
    [
      `spec_version: '0.2'`,
      `name: ${SOURCE_A}`,
      'type: source',
      'source_type: warehouse_table',
      'connection: lake',
      `table: ${DATASET}.${SOURCE_A}`,
      'schema:',
      '  columns:',
      '    - { name: account_id, type: STRING }',
      '    - { name: name, type: STRING }',
      '',
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    join(dir, 'sources', `${SOURCE_B}.yml`),
    [
      `spec_version: '0.2'`,
      `name: ${SOURCE_B}`,
      'type: source',
      'source_type: warehouse_table',
      'connection: lake',
      `table: ${DATASET}.${SOURCE_B}`,
      'schema:',
      '  columns:',
      '    - { name: pylon_id, type: STRING }',
      '    - { name: name, type: STRING }',
      '',
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    join(dir, 'entity-graph', `${ENTITY}_resolution.yml`),
    [
      `spec_version: '0.2'`,
      'type: resolution',
      `name: ${ENTITY}_resolution`,
      'description: Live BigQuery dialect regression fixture.',
      'inputs:',
      `  - ref: lake.${SOURCE_A}`,
      '    role: internal',
      '    id_fields: [account_id]',
      `  - ref: lake.${SOURCE_B}`,
      '    role: provider',
      '    id_fields: [pylon_id]',
      'standardize:',
      '  - field: name',
      '    transforms: [lowercase, collapse_whitespace]',
      'blocking:',
      '  rules:',
      '    - name: name_prefix',
      '      key: standardized_name',
      'scoring:',
      '  method: weighted_features',
      '  features:',
      '    - field: standardized_name',
      '      algorithm: jaro_winkler',
      '      weight: 1.0',
      'thresholds:',
      '  auto_merge: 0.95',
      '  review: 0.5',
      '  auto_reject: 0.3',
      '',
    ].join('\n'),
    'utf8'
  );
}

describe.skipIf(!ENABLED)('entity-graph live BigQuery e2e (env-gated)', () => {
  let dir: string;
  let runner: SqlRunnerModule;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eg-bq-live-'));
    await writeBigQueryFixture(dir);
    runner = await resolveRunner(integration());
    await runner.run(
      `CREATE OR REPLACE TABLE \`${DATASET}\`.\`${SOURCE_A}\` (account_id STRING, name STRING)`
    );
    await runner.run(
      `INSERT INTO \`${DATASET}\`.\`${SOURCE_A}\` VALUES
        ('a1', 'Acme Corp'), ('a2', 'Globex'), ('a3', 'Acme Corporation')`
    );
    await runner.run(
      `CREATE OR REPLACE TABLE \`${DATASET}\`.\`${SOURCE_B}\` (pylon_id STRING, name STRING)`
    );
    await runner.run(
      `INSERT INTO \`${DATASET}\`.\`${SOURCE_B}\` VALUES ('b1', 'acme corp'), ('b2', 'Initech')`
    );
  }, 120_000);

  afterAll(async () => {
    if (!runner) return;
    try {
      const drops = [
        SOURCE_A,
        SOURCE_B,
        `${ENTITY}__standardized`,
        `${ENTITY}__blocking_keys`,
        `${ENTITY}__candidate_pairs`,
        `${ENTITY}__pair_scores`,
        `${ENTITY}__review_queue`,
        `${ENTITY}__review_decisions`,
        `${ENTITY}__not_match_edges`,
        `${ENTITY}__components`,
        `${ENTITY}__clusters`,
        `${ENTITY}__crosswalk`,
      ];
      for (const table of drops) {
        await runner.run(`DROP TABLE IF EXISTS \`${DATASET}\`.\`${table}\``).catch(() => {});
      }
    } finally {
      await runner.close?.();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('runs resolve end-to-end, including the script-loop components statement', async () => {
    const result = await runResolveProject({
      cwd: dir,
      integration: 'lake',
      schema: DATASET!,
      quiet: true,
    });
    expect(
      result.failure,
      JSON.stringify(result.failure?.failedStatements?.map((s) => ({ ...s, sql: '<omitted>' })))
    ).toBeUndefined();
    const entity = result.entities[0];
    expect(entity?.executed).toBe(true);
    expect(entity?.statements.every((stmt) => stmt.status === 'success')).toBe(true);
  }, 600_000);

  it('applies review decisions through the rewritten DML shapes', async () => {
    if (!runner.query) throw new Error('BigQuery runner does not expose query()');
    const rows = await runner.query<{ pair_id: string }>(
      `SELECT pair_id FROM \`${DATASET}\`.\`${ENTITY}__pair_scores\` LIMIT 1`
    );
    const pairId = rows[0]?.pair_id;
    expect(pairId).toBeTruthy();

    const bundle: AgentDecisionBundleV1 = {
      version: 'entity_graph_decision_bundle.v1',
      entity: ENTITY,
      mode: 'apply',
      decision_source: 'agent',
      threshold_bands: ['review'],
      decisions: [
        { pair_id: pairId!, decision: 'not_match', confidence: 0.95, reason: 'distinct orgs' },
      ],
    };
    const applied = await applyReviewDecisions({
      cwd: dir,
      integration: 'lake',
      schema: DATASET!,
      quiet: true,
      bundle,
    });
    expect(
      applied.failure,
      JSON.stringify(applied.failure?.failedStatements?.map((s) => ({ ...s, sql: '<omitted>' })))
    ).toBeUndefined();
    expect(applied.statements.every((stmt) => stmt.status === 'success')).toBe(true);
  }, 600_000);
});
