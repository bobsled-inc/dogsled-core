import type {
  ModelExecutionResult,
  SqlRunnerModule,
  SupportedDialect,
} from '@bobsled-inc/model-spec';
import {
  MATCH_KEY_SECRET_RUNTIME_TOKEN,
  executeSqlStatements,
  materializeMatchKeySecretPlaceholders,
} from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

import type { SqlStatement as ResolutionSqlStatement } from '../compiler/identity/types.js';

export interface EntityGraphExecutionPlan {
  preamble?: string;
  statements: ResolutionSqlStatement[];
  dialect?: SupportedDialect;
}

export interface EntityGraphExecutionCallbacks {
  onInfo?: (msg: string) => void;
  onError?: (msg: string) => void;
  onSuccess?: (msg: string) => void;
}

export function toEntityGraphExecutionStatements(
  entity: string,
  plan: EntityGraphExecutionPlan
): Array<{
  modelName: string;
  sql: string;
  deps?: string[];
  ignoreErrorPatterns?: string[];
}> {
  const orderedStatements = [
    ...(plan.preamble ? [{ name: 'preamble', sql: plan.preamble }] : []),
    ...plan.statements,
  ];
  return orderedStatements.map((stmt, index) => {
    const modelName = `${entity}:${stmt.name}`;
    const previousStatement = orderedStatements[index - 1];
    if (stmt.sql.includes(MATCH_KEY_SECRET_RUNTIME_TOKEN) && plan.dialect == null) {
      throw new CommandError(
        'Entity graph execution requires a dialect to materialize BOBSLED_CORE_MATCH_KEY_SECRET placeholders.',
        2
      );
    }
    return {
      modelName,
      sql:
        plan.dialect == null
          ? stmt.sql
          : materializeMatchKeySecretPlaceholders(stmt.sql, plan.dialect),
      deps: previousStatement ? [`${entity}:${previousStatement.name}`] : undefined,
      ignoreErrorPatterns: stmt.ignoreErrorPatterns,
    };
  });
}

export async function executeEntityGraphPlan(
  entity: string,
  runner: SqlRunnerModule,
  plan: EntityGraphExecutionPlan,
  suppressProgressOutput: boolean,
  callbacks?: EntityGraphExecutionCallbacks
): Promise<ModelExecutionResult[]> {
  return executeSqlStatements(toEntityGraphExecutionStatements(entity, plan), runner.run, {
    onInfo: suppressProgressOutput ? undefined : callbacks?.onInfo,
    onError: callbacks?.onError,
    onSuccess: suppressProgressOutput ? undefined : callbacks?.onSuccess,
  });
}
