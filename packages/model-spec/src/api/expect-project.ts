import { getSourceEntry, parseTransformSpecFromParsed } from '../compiler/parser.js';
import { collectModelExpectations } from '../compiler/expect/parser.js';
import { generateExpectationSql } from '../compiler/expect/codegen.js';
import { getOrThrow } from '../compiler/dialect.js';

import { loadProject, selectIntegrationContexts, type LoadedProject } from './load-project.js';

import type { IntegrationCompileContext } from './integration-context.js';
import type { ExpectSqlStatement } from '../compiler/expect/codegen.js';
import type { SqlQueryRunner, SqlQueryRow } from '../compiler/index.js';

export interface ExpectProjectOptions {
  integration?: string;
  models?: string[];
  query?: SqlQueryRunner;
  project?: LoadedProject;
}

export interface ExpectRunEntry extends ExpectSqlStatement {
  handle: string;
  dialect: string;
  executed: boolean;
  status?: 'passed' | 'failed' | 'warned';
  violationCount?: number;
  error?: string;
}

export interface ExpectSkippedEntry {
  handle: string;
  message: string;
}

export interface ExpectProjectResult {
  ok: boolean;
  entries: ExpectRunEntry[];
  warnings: string[];
  skipped: ExpectSkippedEntry[];
}

export async function expectProject(
  cwd: string,
  opts: ExpectProjectOptions = {}
): Promise<ExpectProjectResult> {
  const project = opts.project ?? (await loadProject(cwd));
  const skipped: ExpectProjectResult['skipped'] = [];
  const perIntegration = selectIntegrationContexts(project, {
    integration: opts.integration,
    models: opts.models,
    onSkipped: (reason) => skipped.push(reason),
  });

  const entries: ExpectRunEntry[] = [];
  for (const ictx of perIntegration) {
    const statements = buildExpectationStatements(ictx);
    for (const statement of statements) {
      if (!opts.query) {
        entries.push({
          ...statement,
          handle: ictx.integration.handle,
          dialect: ictx.dialect,
          executed: false,
        });
        continue;
      }

      try {
        const rows = await opts.query(statement.sql);
        const violationCount = readViolationCount(rows);
        const status =
          violationCount === 0 ? 'passed' : statement.severity === 'warn' ? 'warned' : 'failed';
        entries.push({
          ...statement,
          handle: ictx.integration.handle,
          dialect: ictx.dialect,
          executed: true,
          status,
          violationCount,
        });
      } catch (err) {
        entries.push({
          ...statement,
          handle: ictx.integration.handle,
          dialect: ictx.dialect,
          executed: true,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    ok: entries.every((entry) => entry.status !== 'failed' && !entry.error),
    entries,
    warnings: [...project.warnings],
    skipped,
  };
}

function buildExpectationStatements(ictx: IntegrationCompileContext): ExpectSqlStatement[] {
  const statements: ExpectSqlStatement[] = [];
  const { dialect, entryRegistry, modelReg, orderedNodes, registry } = ictx;

  for (const node of orderedNodes) {
    const parseResult = parseTransformSpecFromParsed(node.parsedSpec, registry, modelReg);
    if (!parseResult.ok) {
      throw new Error(`${node.name}: ${parseResult.error}`);
    }
    if (!parseResult.spec.expect || parseResult.spec.expect.length === 0) continue;

    const tableName = getOrThrow(modelReg, node.name.toLowerCase(), 'modelReg expect table');
    const sourceEntry = getSourceEntry(
      entryRegistry,
      parseResult.spec.source.refKey ?? parseResult.spec.sourceRef
    );
    const inheritedColumns = parseResult.spec.includeAllColumns
      ? sourceEntry?.columns
          .map((column) => column.name)
          .filter(
            (name) =>
              !parseResult.spec.excludeColumns?.some(
                (excluded) => excluded.toLowerCase() === name.toLowerCase()
              )
          )
      : undefined;

    const parsed = collectModelExpectations(parseResult.spec, tableName, inheritedColumns);
    statements.push(
      ...generateExpectationSql({
        ...parsed,
        dialect,
      })
    );
  }

  return statements;
}

function readViolationCount(rows: SqlQueryRow[]): number {
  const first = rows[0];
  if (!first) {
    throw new Error('Expectation query returned no rows');
  }
  for (const [key, value] of Object.entries(first)) {
    if (key.toLowerCase() !== 'violation_count') continue;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  throw new Error('Expectation query did not return violation_count');
}
