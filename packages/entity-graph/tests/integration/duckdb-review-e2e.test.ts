/**
 * DuckDB end-to-end agent-review test (in-process warehouse).
 *
 * Executes the full Phase T1 flow against a real DuckDB instance:
 * `runResolveProject` (threshold routing fills `__review_queue`) →
 * `reviewResolveProject` (judge adjudicates the gray zone, decisions written
 * through the `applyReviewDecisions` gate) → `clusterResolveProject` (applied
 * merges fold into the entity clusters) — the plan's definition of done, in
 * one pass, without touching `resolve run`'s default behavior.
 *
 * Skipped when `@duckdb/node-api` cannot be imported, mirroring
 * `duckdb-resolve-e2e.test.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveRunner,
  type IntegrationFile,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyReviewDecisions,
  clusterResolveProject,
  reviewResolveProject,
  runResolveProject,
} from '../../src/api/index.js';
import type { AgentDecisionBundleV1 } from '../../src/compiler/agent/types.js';
import type { LlmClient, PairDecision } from '../../src/compiler/identity/types.js';
import {
  writeAsymmetricFixture,
  INTEGRATION_HANDLE,
  RESOLUTION_TARGET_SCHEMA,
} from './asymmetric-fixture.js';

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

function duckdbIntegration(dbPath: string): IntegrationFile {
  return {
    spec_version: '1',
    type: 'integration',
    name: INTEGRATION_HANDLE,
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: dbPath },
  };
}

async function queryRows(
  runner: SqlRunnerModule,
  sql: string
): Promise<Array<Record<string, unknown>>> {
  if (!runner.query) {
    throw new Error('DuckDB runner does not expose query()');
  }
  return runner.query(sql);
}

async function scalarCount(runner: SqlRunnerModule, sql: string): Promise<number> {
  const rows = await queryRows(runner, sql);
  const first = rows[0];
  if (!first) {
    throw new Error(`query returned no rows: ${sql}`);
  }
  return Number(Object.values(first)[0]);
}

/**
 * Resolution spec tuned so the seeded data produces exactly
 * {@link REVIEW_BAND_PAIR_COUNT} review-band pairs: the prefix blocking key
 * groups a1 "acme corp", a3 "acme corporation", and b1 "acme corp"; the
 * exact-name pair (a1, b1) scores 1.0 and auto-merges, while (a1, a3) and
 * (a3, b1) land at jaro_winkler ≈ 0.93, inside [0.5, 0.98).
 */
function reviewResolutionYml(options: { agentPolicy?: string[] } = {}): string {
  return [
    `spec_version: '0.2'`,
    'type: resolution',
    'name: account_resolution',
    'description: Resolve account entities with an agent review band.',
    'inputs:',
    '  - ref: lake.accounts_a',
    '    role: internal',
    '    id_fields: [account_id]',
    '  - ref: lake.accounts_b',
    '    role: internal',
    '    id_fields: [pylon_id]',
    'standardize:',
    '  - field: name',
    '    transforms: [lowercase, trim]',
    'blocking:',
    '  rules:',
    '    - name: by_prefix',
    "      key: 'LEFT(standardized_name, 4)'",
    'scoring:',
    '  method: weighted_features',
    '  features:',
    '    - field: standardized_name',
    '      algorithm: jaro_winkler',
    '      weight: 1.0',
    'thresholds:',
    '  auto_merge: 0.98',
    '  review: 0.5',
    '  auto_reject: 0.3',
    ...(options.agentPolicy ?? []),
    'outputs:',
    '  target_schema: entity_graph',
    '',
  ].join('\n');
}

/** Known review-queue size for the seeded fixture — pin, don't derive. */
const REVIEW_BAND_PAIR_COUNT = 2;

const ENABLED_AGENT_POLICY = [
  'agent_policy:',
  '  enabled: true',
  '  auto_apply_threshold: 0.75',
  '  context_fields: [name]',
];

const REVIEWER_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'reviewers'
);
const ECHO_FIXTURE = join(REVIEWER_FIXTURES_DIR, 'echo-decisions.mjs');
const HANG_FIXTURE = join(REVIEWER_FIXTURES_DIR, 'hang.mjs');

/** agent_policy block with a command-transport external reviewer. */
function commandReviewerPolicy(command: string, timeoutS?: number): string[] {
  return [
    ...ENABLED_AGENT_POLICY,
    '  reviewer:',
    '    kind: command',
    `    command: '${command}'`,
    ...(timeoutS !== undefined ? [`    timeout_s: ${timeoutS}`] : []),
  ];
}

/** ENABLED_AGENT_POLICY plus an explicit `judge:` tier line (+ optional extra lines). */
function judgeTierPolicy(tier: 'model' | 'agent', extra: string[] = []): string[] {
  return [...ENABLED_AGENT_POLICY, `  judge: ${tier}`, ...extra];
}

function stubJudge(decide: (pairId: string, index: number) => PairDecision): LlmClient {
  return {
    reviewPairs: async (pairs) => pairs.map((pair, index) => decide(pair.pairId, index)),
  };
}

describe.skipIf(!DUCKDB_AVAILABLE)('entity-graph DuckDB review e2e', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eg-review-e2e-'));
    dbPath = join(dir, 'resolve.duckdb');
    await writeAsymmetricFixture(dir, { duckdbDbPath: dbPath });
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      reviewResolutionYml({ agentPolicy: ENABLED_AGENT_POLICY })
    );

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      await runner.run(`CREATE SCHEMA IF NOT EXISTS ${RESOLUTION_TARGET_SCHEMA}`);
      await runner.run(
        `CREATE TABLE main.accounts_a (account_id VARCHAR, name VARCHAR, slug VARCHAR)`
      );
      await runner.run(
        `INSERT INTO main.accounts_a VALUES
          ('a1', 'Acme Corp', 'acme'),
          ('a2', 'Globex', 'globex'),
          ('a3', 'Acme Corporation', 'acme-corp')`
      );
      await runner.run(
        `CREATE TABLE main.accounts_b (pylon_id VARCHAR, name VARCHAR, domain VARCHAR)`
      );
      await runner.run(
        `INSERT INTO main.accounts_b VALUES
          ('b1', 'acme corp', 'acme.com'),
          ('b2', 'Initech', 'initech.io')`
      );
    } finally {
      await runner.close?.();
    }

    const run = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
    });
    expect(run.failure).toBeUndefined();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reviews the gray zone, applies gated decisions, and cluster folds the merges', async () => {
    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      llmClient: stubJudge((pairId) => ({
        pairId,
        decision: 'merge',
        confidence: 0.95,
        reasoning: 'stub: same organization',
      })),
    });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.failure).toBeUndefined();
    expect(result.skipped_reason).toBeUndefined();
    expect(result.executed).toBe(true);
    expect(result.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.applied_count).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.proposed_count).toBe(0);
    expect(result.deferred_count).toBe(0);
    expect(result.metrics.pairsReviewed).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.metrics.pairsMerged).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.decision_batch_id).toBeTruthy();
    // bundle is a dryRun-only field.
    expect(result.bundle).toBeUndefined();

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisions = await queryRows(
        runner,
        `SELECT pair_id, decision, status, decision_source
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      expect(decisions).toHaveLength(REVIEW_BAND_PAIR_COUNT);
      expect(decisions.every((row) => row.decision === 'merge')).toBe(true);
      expect(decisions.every((row) => row.status === 'applied')).toBe(true);
      expect(decisions.every((row) => row.decision_source === 'agent_auto')).toBe(true);
    } finally {
      await runner.close?.();
    }

    // Same pass: cluster folds the applied merges into one entity.
    const cluster = await clusterResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
    });
    expect(cluster.failure).toBeUndefined();

    const verifyRunner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const rows = await queryRows(
        verifyRunner,
        `SELECT DISTINCT entity_id
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__clusters
         WHERE record_id IN (
           SELECT record_id FROM ${RESOLUTION_TARGET_SCHEMA}.account__standardized
           WHERE standardized_name IN ('acme corp', 'acme corporation')
         )`
      );
      // a1 ("Acme Corp"), a3 ("Acme Corporation"), b1 ("acme corp") all
      // collapse into a single entity once the reviewed merges apply.
      expect(rows).toHaveLength(1);
    } finally {
      await verifyRunner.close?.();
    }

    // Re-running the review finds nothing left to judge.
    const rerun = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      llmClient: stubJudge((pairId) => ({
        pairId,
        decision: 'merge',
        confidence: 0.95,
        reasoning: 'stub',
      })),
    });
    expect(rerun[0]!.skipped_reason).toBe('queue_empty');
  });

  it('gates below-threshold and defer decisions into proposed/deferred and writes not_match edges', async () => {
    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      llmClient: stubJudge((pairId, index) => {
        if (index === 0) {
          return { pairId, decision: 'not_match', confidence: 0.9, reasoning: 'stub: different' };
        }
        if (index === 1) {
          return { pairId, decision: 'merge', confidence: 0.6, reasoning: 'stub: unsure merge' };
        }
        return { pairId, decision: 'defer', confidence: 0.2, reasoning: 'stub: cannot tell' };
      }),
    });

    const result = results[0]!;
    expect(result.failure).toBeUndefined();
    expect(result.executed).toBe(true);
    // Two review-band pairs: index 0 → not_match@0.9 (applied), index 1 →
    // merge@0.6 (below the 0.75 gate → proposed). Pinned, not derived.
    expect(result.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.applied_count).toBe(1);
    expect(result.proposed_count).toBe(1);
    expect(result.deferred_count).toBe(0);

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const edgeCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__not_match_edges`
      );
      expect(edgeCount).toBe(1);
    } finally {
      await runner.close?.();
    }
  });

  it('applies a mixed applied/proposed/deferred bundle without dropping the pending rows', async () => {
    // Regression: generateApplySql splits one apply into two
    // sequential INSERTs — actionable, then pending — that share
    // defaultBatchId + defaultContentHash. With the content hash set (the
    // production path always sets it), the pending statement's proposed/
    // deferred rows all matched the actionable statement's just-inserted rows
    // on (batch_id, content_hash) and were silently filtered to nothing. The
    // hash-branch idempotency check must correlate on pair_id too.
    const bundle: AgentDecisionBundleV1 = {
      version: 'entity_graph_decision_bundle.v1',
      entity: 'account',
      mode: 'apply',
      decision_source: 'agent',
      threshold_bands: ['review'],
      decisions: [
        // confidence ≥ 0.75 → applied (actionable, first INSERT)
        { pair_id: 'mix-applied', decision: 'merge', confidence: 0.95, reason: 'high conf' },
        // merge below the gate → proposed (pending, second INSERT)
        { pair_id: 'mix-proposed', decision: 'merge', confidence: 0.5, reason: 'low conf' },
        // agent deferred → deferred (pending, second INSERT)
        { pair_id: 'mix-deferred', decision: 'defer', confidence: 0.2, reason: 'unsure' },
      ],
    };

    const applied = await applyReviewDecisions({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      bundle,
    });
    expect(applied.failure).toBeUndefined();
    expect(applied.applied_count).toBe(1);
    expect(applied.proposed_count).toBe(1);
    expect(applied.deferred_count).toBe(1);

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const rows = await queryRows(
        runner,
        `SELECT status, COUNT(*) AS c
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions
         WHERE pair_id IN ('mix-applied', 'mix-proposed', 'mix-deferred')
         GROUP BY status`
      );
      const byStatus = Object.fromEntries(rows.map((row) => [String(row.status), Number(row.c)]));
      // Before the fix: { applied: 1 } — proposed + deferred were dropped.
      expect(byStatus).toEqual({ applied: 1, proposed: 1, deferred: 1 });
    } finally {
      await runner.close?.();
    }

    // Re-applying the identical bundle inserts nothing: the same
    // (pair_id, batch_id, content_hash) correlation keeps it idempotent.
    const rerun = await applyReviewDecisions({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      bundle,
    });
    expect(rerun.failure).toBeUndefined();

    const verifyRunner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const total = await scalarCount(
        verifyRunner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions
         WHERE pair_id IN ('mix-applied', 'mix-proposed', 'mix-deferred')`
      );
      expect(total).toBe(3);
    } finally {
      await verifyRunner.close?.();
    }
  });

  it('dry run returns the bundle and writes nothing', async () => {
    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      dryRun: true,
      llmClient: stubJudge((pairId) => ({
        pairId,
        decision: 'merge',
        confidence: 0.95,
        reasoning: 'stub',
      })),
    });

    const result = results[0]!;
    expect(result.executed).toBe(false);
    expect(result.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.bundle).toBeDefined();
    expect(result.bundle!.decision_source).toBe('agent_auto');
    expect(result.bundle!.decisions).toHaveLength(REVIEW_BAND_PAIR_COUNT);
    expect(result.applied_count).toBe(REVIEW_BAND_PAIR_COUNT);

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisionCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      expect(decisionCount).toBe(0);
    } finally {
      await runner.close?.();
    }
  });

  it('honors maxPairsPerRun as a fetch cap', async () => {
    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      maxPairsPerRun: 1,
      llmClient: stubJudge((pairId) => ({
        pairId,
        decision: 'merge',
        confidence: 0.95,
        reasoning: 'stub',
      })),
    });
    expect(results[0]!.pairs_fetched).toBe(1);
  });

  it('skips when agent_policy is absent unless a judge is injected', async () => {
    await writeFile(join(dir, 'entity-graph', 'account_resolution.yml'), reviewResolutionYml());

    const skipped = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
    });
    expect(skipped[0]!).toMatchObject({
      executed: false,
      skipped_reason: 'agent_policy_disabled',
    });

    const injected = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      llmClient: stubJudge((pairId) => ({
        pairId,
        decision: 'defer',
        confidence: 0,
        reasoning: 'stub',
      })),
    });
    expect(injected[0]!.executed).toBe(true);
    expect(injected[0]!.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(injected[0]!.deferred_count).toBe(REVIEW_BAND_PAIR_COUNT);
  });

  it('reports no_judge_configured when the policy enables review but no judge exists', async () => {
    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
    });
    expect(results[0]!).toMatchObject({
      executed: false,
      skipped_reason: 'no_judge_configured',
    });
    expect(results[0]!.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
  });

  it('applies a spec-configured command reviewer through the gate with decision_source agent', async () => {
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      reviewResolutionYml({
        agentPolicy: commandReviewerPolicy(`node "${ECHO_FIXTURE}" merge 0.95`),
      })
    );

    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
    });

    const result = results[0]!;
    expect(result.failure).toBeUndefined();
    expect(result.executed).toBe(true);
    expect(result.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.applied_count).toBe(REVIEW_BAND_PAIR_COUNT);

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisions = await queryRows(
        runner,
        `SELECT pair_id, decision, status, decision_source
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      expect(decisions).toHaveLength(REVIEW_BAND_PAIR_COUNT);
      expect(decisions.every((row) => row.decision === 'merge')).toBe(true);
      // External reviewer decisions land as 'agent', not 'agent_auto'
      // (external reviewer contract).
      expect(decisions.every((row) => row.decision_source === 'agent')).toBe(true);
    } finally {
      await runner.close?.();
    }
  });

  it('lets reviewerOverride win over the spec reviewer', async () => {
    // The spec's reviewer would merge; the host-injected override says
    // not_match. The written decisions prove the override drove the review.
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      reviewResolutionYml({
        agentPolicy: commandReviewerPolicy(`node "${ECHO_FIXTURE}" merge 0.95`),
      })
    );

    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      reviewerOverride: {
        kind: 'command',
        command: `node "${ECHO_FIXTURE}" not_match 0.9`,
      },
    });

    const result = results[0]!;
    expect(result.failure).toBeUndefined();
    expect(result.applied_count).toBe(REVIEW_BAND_PAIR_COUNT);

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisions = await queryRows(
        runner,
        `SELECT decision, decision_source
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      expect(decisions).toHaveLength(REVIEW_BAND_PAIR_COUNT);
      expect(decisions.every((row) => row.decision === 'not_match')).toBe(true);
      expect(decisions.every((row) => row.decision_source === 'agent')).toBe(true);
    } finally {
      await runner.close?.();
    }
  });

  it('leaves the queue intact and the run green when the reviewer hangs past timeout_s', async () => {
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      reviewResolutionYml({
        agentPolicy: commandReviewerPolicy(`node "${HANG_FIXTURE}"`, 1),
      })
    );

    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
    });

    const result = results[0]!;
    // Fail-soft: no failure, no decisions, a timeout warning — exit 0 at the CLI.
    expect(result.failure).toBeUndefined();
    expect(result.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.applied_count).toBe(0);
    expect(result.proposed_count).toBe(0);
    expect(result.deferred_count).toBe(0);
    expect(result.warnings.some((w) => /timed out/.test(w))).toBe(true);

    // Nothing was written; the pairs are still queued for the next attempt.
    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisionCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      expect(decisionCount).toBe(0);
    } finally {
      await runner.close?.();
    }

    // A healthy reviewer on the next attempt recovers the retained queue.
    const rerun = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      reviewerOverride: {
        kind: 'command',
        command: `node "${ECHO_FIXTURE}" merge 0.95`,
      },
    });
    expect(rerun[0]!.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(rerun[0]!.applied_count).toBe(REVIEW_BAND_PAIR_COUNT);
    // Generous vitest timeout: slow CI runners spawn the shell + node slowly;
    // the reviewer's own timeout_s (1s here) is what's under test.
  }, 30_000);

  // --- agent_policy.judge tier selector (external reviewer contract) ------------
  // Scenario "judge absent (model runs)" is the suite's first test: the
  // beforeEach spec omits `judge`, and the injected llmClient serves the model
  // lane (decision_source 'agent_auto'). The tests below cover the new branches.

  it("judge: 'model' lets a host-injected llmClient win over the pin (escape hatch)", async () => {
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      reviewResolutionYml({ agentPolicy: judgeTierPolicy('model') })
    );

    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      llmClient: stubJudge((pairId) => ({
        pairId,
        decision: 'merge',
        confidence: 0.95,
        reasoning: 'stub: same organization',
      })),
    });

    const result = results[0]!;
    expect(result.failure).toBeUndefined();
    expect(result.executed).toBe(true);
    expect(result.applied_count).toBe(REVIEW_BAND_PAIR_COUNT);

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisions = await queryRows(
        runner,
        `SELECT decision_source
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      // The llmClient escape hatch lands as the model source, not 'agent'.
      expect(decisions.every((row) => row.decision_source === 'agent_auto')).toBe(true);
    } finally {
      await runner.close?.();
    }
  });

  it("judge: 'model' ignores a reviewerOverride and the spec reviewer, warning about both", async () => {
    // The spec's command reviewer would merge and the host override would
    // not_match — under judge: model both are ignored, the model lane is pinned,
    // and with no platform model configured the phase skips (no external run).
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      reviewResolutionYml({
        agentPolicy: [
          ...commandReviewerPolicy(`node "${ECHO_FIXTURE}" merge 0.95`),
          '  judge: model',
        ],
      })
    );

    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      reviewerOverride: {
        kind: 'command',
        command: `node "${ECHO_FIXTURE}" not_match 0.9`,
      },
    });

    const result = results[0]!;
    expect(result.failure).toBeUndefined();
    // Model lane pinned, no model available → skip; neither reviewer ran.
    expect(result.skipped_reason).toBe('no_judge_configured');
    expect(result.applied_count).toBe(0);
    expect(result.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.warnings.some((w) => /reviewer override was ignored/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /agent_policy\.reviewer was ignored/.test(w))).toBe(true);

    // Nothing written — no external reviewer drove the review, queue intact.
    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisionCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      expect(decisionCount).toBe(0);
    } finally {
      await runner.close?.();
    }
  });

  it("judge: 'agent' runs the external reviewer supplied via reviewerOverride", async () => {
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      reviewResolutionYml({ agentPolicy: judgeTierPolicy('agent') })
    );

    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      reviewerOverride: {
        kind: 'command',
        command: `node "${ECHO_FIXTURE}" merge 0.95`,
      },
    });

    const result = results[0]!;
    expect(result.failure).toBeUndefined();
    expect(result.executed).toBe(true);
    expect(result.applied_count).toBe(REVIEW_BAND_PAIR_COUNT);

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisions = await queryRows(
        runner,
        `SELECT decision, decision_source
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      expect(decisions).toHaveLength(REVIEW_BAND_PAIR_COUNT);
      expect(decisions.every((row) => row.decision === 'merge')).toBe(true);
      expect(decisions.every((row) => row.decision_source === 'agent')).toBe(true);
    } finally {
      await runner.close?.();
    }
  });

  it("judge: 'agent' with no reviewer skips as no_judge_configured, queue intact, run green", async () => {
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      reviewResolutionYml({ agentPolicy: judgeTierPolicy('agent') })
    );

    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
    });

    const result = results[0]!;
    // Fail-soft: no fallback to the model judge, no failure, a named warning.
    expect(result.failure).toBeUndefined();
    expect(result.skipped_reason).toBe('no_judge_configured');
    expect(result.applied_count).toBe(0);
    expect(result.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(result.warnings.some((w) => /requires an external reviewer transport/.test(w))).toBe(
      true
    );

    // Nothing written — the queue is retained for a later attempt.
    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisionCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      expect(decisionCount).toBe(0);
    } finally {
      await runner.close?.();
    }

    // A host override on the next attempt recovers the retained queue.
    const rerun = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      reviewerOverride: {
        kind: 'command',
        command: `node "${ECHO_FIXTURE}" merge 0.95`,
      },
    });
    expect(rerun[0]!.pairs_fetched).toBe(REVIEW_BAND_PAIR_COUNT);
    expect(rerun[0]!.applied_count).toBe(REVIEW_BAND_PAIR_COUNT);
  });

  it('captures a throwing judge as failure without failing the run, leaving the queue intact', async () => {
    const results = await reviewResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      llmClient: {
        reviewPairs: async () => {
          throw new Error('judge exploded');
        },
      },
    });

    const result = results[0]!;
    expect(result.executed).toBe(false);
    expect(result.failure).toBeDefined();
    expect(result.failure!.failedStatements![0]!.name).toBe('agent_review:judge');
    expect(result.warnings.some((w) => /judge exploded/.test(w))).toBe(true);

    // Nothing was written — the queue is untouched for the next attempt.
    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisionCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions`
      );
      expect(decisionCount).toBe(0);
    } finally {
      await runner.close?.();
    }
  });
});
