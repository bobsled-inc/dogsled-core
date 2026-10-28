import type { ModelExecutionResult, SupportedDialect } from '@bobsled-inc/model-spec';
import type { SqlRunnerModule } from '@bobsled-inc/connections';

import {
  generateAuditLogDdl,
  generateSemanticTriageSkippedAuditSql,
} from '../compiler/audit/codegen.js';
import { runSemanticTriageEmbeddingPrep } from '../compiler/identity/embeddings/run.js';
import { SEMANTIC_TRIAGE_START_STATEMENT } from '../compiler/identity/codegen-semantic-triage.js';
import type { ResolvedResolutionSpec, SqlStatement } from '../compiler/identity/types.js';
import {
  executeEntityGraphPlan,
  type EntityGraphExecutionCallbacks,
} from '../runtime/execution.js';

export async function runSemanticTriageForResolution(
  spec: ResolvedResolutionSpec,
  runner: SqlRunnerModule,
  result: { preamble?: string; statements: SqlStatement[] },
  dialect: SupportedDialect,
  targetSchema: string,
  suppressProgressOutput: boolean,
  callbacks?: EntityGraphExecutionCallbacks
): Promise<{ executionResults: ModelExecutionResult[]; warnings: string[] }> {
  const semanticStart = result.statements.findIndex(
    (statement) => statement.name === SEMANTIC_TRIAGE_START_STATEMENT
  );
  if (semanticStart < 0) {
    return {
      executionResults: await executeEntityGraphPlan(
        spec.entity,
        runner,
        { ...result, dialect },
        suppressProgressOutput,
        callbacks
      ),
      warnings: [],
    };
  }

  const prefix = {
    preamble: result.preamble,
    statements: result.statements.slice(0, semanticStart),
  };
  const suffix = {
    statements: result.statements.slice(semanticStart),
  };
  const prefixResults = await executeEntityGraphPlan(
    spec.entity,
    runner,
    { ...prefix, dialect },
    suppressProgressOutput,
    callbacks
  );
  const prefixFailed = prefixResults.some((row) => row.status === 'failed');
  if (prefixFailed) {
    const skipped = suffix.statements.map(
      (statement): ModelExecutionResult => ({
        modelName: `${spec.entity}:${statement.name}`,
        status: 'skipped',
        error: 'Skipped: upstream semantic triage prerequisite failed',
      })
    );
    return { executionResults: [...prefixResults, ...skipped], warnings: [] };
  }

  const prep = await runSemanticTriageEmbeddingPrep({
    spec,
    targetSchema,
    dialect,
    run: runner.run,
    query: runner.query,
  });
  const warnings: string[] = [];
  const auditResults: ModelExecutionResult[] = [];
  if (prep) {
    const embeddedCount = prep.cacheInsertCount ?? 'an unknown number of';
    const summary = prep.skipped
      ? `${spec.entity}: semantic triage skipped (${prep.reason}).`
      : `${spec.entity}: semantic triage embedded ${embeddedCount} missing input(s); estimated embedding cost $${prep.estimatedEmbeddingCostUsd.toFixed(6)}.`;
    warnings.push(summary);
    if (prep.skipped) {
      const auditStatement = generateSemanticTriageSkippedAuditSql({
        entityName: spec.entity,
        dialect,
        estimatedEmbeddingCostUsd: prep.estimatedEmbeddingCostUsd,
        maxEmbeddingCostUsd: spec.agentPolicy?.maxEmbeddingCostUsd,
        candidateCount: prep.semanticCandidateCount,
        reason: prep.reason ?? 'semantic triage skipped',
      });
      auditResults.push(
        ...(await executeEntityGraphPlan(
          spec.entity,
          runner,
          { statements: [...generateAuditLogDdl(dialect), auditStatement], dialect },
          suppressProgressOutput,
          callbacks
        ))
      );
    }
  }

  const suffixResults = await executeEntityGraphPlan(
    spec.entity,
    runner,
    { ...suffix, dialect },
    suppressProgressOutput,
    callbacks
  );
  return { executionResults: [...prefixResults, ...auditResults, ...suffixResults], warnings };
}
