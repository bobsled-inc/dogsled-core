import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelExecutionResult, SqlRunnerModule } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from '../../../src/compiler/identity/types.js';

const mocks = vi.hoisted(() => ({
  executeEntityGraphPlan: vi.fn(),
  runSemanticTriageEmbeddingPrep: vi.fn(),
}));

vi.mock('../../../src/runtime/execution.js', () => ({
  executeEntityGraphPlan: mocks.executeEntityGraphPlan,
}));

vi.mock('../../../src/compiler/identity/embeddings/run.js', () => ({
  runSemanticTriageEmbeddingPrep: mocks.runSemanticTriageEmbeddingPrep,
}));

const { runSemanticTriageForResolution } =
  await import('../../../src/commands/resolve-semantic-triage.js');

const spec = {
  name: 'company_resolution',
  entity: 'company',
  semanticTriage: {
    provider: 'openai_text_embedding_3_small',
    fields: ['company_name'],
    promoteToMergeThreshold: 0.94,
    promoteToRejectThreshold: 0.55,
  },
  agentPolicy: { maxEmbeddingCostUsd: 0.25 },
} as unknown as ResolvedResolutionSpec;

const runner = { run: vi.fn(), query: vi.fn() } as unknown as SqlRunnerModule;

const statement = (name: string): SqlStatement => ({ name, sql: `-- ${name}` });

function resultFor(name: string, status: ModelExecutionResult['status'] = 'success') {
  return { modelName: `company:${name}`, status };
}

describe('runSemanticTriageForResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeEntityGraphPlan.mockImplementation(
      async (_entity: string, _runner: SqlRunnerModule, plan: { statements: SqlStatement[] }) =>
        plan.statements.map((item) => resultFor(item.name))
    );
  });

  it('delegates directly when no semantic statements are present', async () => {
    const result = { statements: [statement('candidate_pairs')] };

    const response = await runSemanticTriageForResolution(
      spec,
      runner,
      result,
      'duckdb',
      'main',
      true
    );

    expect(response.warnings).toEqual([]);
    expect(mocks.runSemanticTriageEmbeddingPrep).not.toHaveBeenCalled();
    expect(mocks.executeEntityGraphPlan).toHaveBeenCalledTimes(1);
    expect(response.executionResults).toEqual([resultFor('candidate_pairs')]);
  });

  it('skips suffix statements when prefix execution fails', async () => {
    mocks.executeEntityGraphPlan.mockResolvedValueOnce([resultFor('candidate_pairs', 'failed')]);

    const response = await runSemanticTriageForResolution(
      spec,
      runner,
      { statements: [statement('candidate_pairs'), statement('semantic_pair_scores')] },
      'duckdb',
      'main',
      true
    );

    expect(mocks.runSemanticTriageEmbeddingPrep).not.toHaveBeenCalled();
    expect(response.executionResults).toEqual([
      resultFor('candidate_pairs', 'failed'),
      {
        modelName: 'company:semantic_pair_scores',
        status: 'skipped',
        error: 'Skipped: upstream semantic triage prerequisite failed',
      },
    ]);
  });

  it('runs prep before suffix and reports cache insert counts', async () => {
    mocks.runSemanticTriageEmbeddingPrep.mockResolvedValue({
      skipped: false,
      semanticCandidateCount: 3,
      missingInputCount: 2,
      estimatedEmbeddingTokens: 20,
      estimatedEmbeddingCostUsd: 0.000001,
      cacheInsertCount: 2,
    });

    const response = await runSemanticTriageForResolution(
      spec,
      runner,
      { statements: [statement('candidate_pairs'), statement('semantic_pair_scores')] },
      'duckdb',
      'main',
      true
    );

    expect(mocks.runSemanticTriageEmbeddingPrep).toHaveBeenCalledTimes(1);
    expect(response.warnings).toEqual([
      'company: semantic triage embedded 2 missing input(s); estimated embedding cost $0.000001.',
    ]);
    expect(response.executionResults.map((item) => item.modelName)).toEqual([
      'company:candidate_pairs',
      'company:semantic_pair_scores',
    ]);
  });

  it('writes skipped audit through planned DDL and insert statements', async () => {
    mocks.runSemanticTriageEmbeddingPrep.mockResolvedValue({
      skipped: true,
      reason: 'cost cap exceeded',
      semanticCandidateCount: 7,
      missingInputCount: 4,
      estimatedEmbeddingTokens: 100,
      estimatedEmbeddingCostUsd: 0.5,
      cacheInsertCount: 0,
    });

    await runSemanticTriageForResolution(
      spec,
      runner,
      { statements: [statement('candidate_pairs'), statement('semantic_pair_scores')] },
      'duckdb',
      'main',
      true
    );

    const auditCall = mocks.executeEntityGraphPlan.mock.calls.find((call) => {
      const plan = call[2] as { statements: SqlStatement[] };
      return plan.statements.some((item) => item.name === 'audit_semantic_triage_skipped');
    });
    expect(auditCall).toBeDefined();
    const auditPlan = auditCall?.[2] as { statements: SqlStatement[] };
    expect(auditPlan.statements.map((item) => item.name)).toEqual([
      'ddl_entity_graph_schema',
      'ddl_audit_log',
      'audit_semantic_triage_skipped',
    ]);
    expect(auditPlan.statements.at(-1)?.sql).toContain('"candidate_count":7');
  });
});
