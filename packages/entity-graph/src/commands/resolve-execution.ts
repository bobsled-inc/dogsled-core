import type { ModelExecutionResult } from '@bobsled-inc/model-spec';

export interface ResolveStatementJson {
  name: string;
  sql: string;
  table_created?: string;
  status?: ModelExecutionResult['status'];
  error?: string;
  rows_affected?: number;
}

export interface ResolvePreambleJson {
  sql: string;
  status?: ModelExecutionResult['status'];
  error?: string;
  rows_affected?: number;
}

export function toResolveStatementJson(
  statement: { name: string; sql: string; tableCreated?: string },
  execution?: ModelExecutionResult
): ResolveStatementJson {
  return {
    name: statement.name,
    sql: statement.sql,
    table_created: statement.tableCreated,
    status: execution?.status,
    error: execution?.error,
    rows_affected: execution?.rowsAffected,
  };
}

export function toResolvePreambleJson(
  sql: string,
  execution?: ModelExecutionResult
): ResolvePreambleJson {
  return {
    sql,
    status: execution?.status,
    error: execution?.error,
    rows_affected: execution?.rowsAffected,
  };
}
