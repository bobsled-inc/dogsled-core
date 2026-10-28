/**
 * `testProject` — Layer 3 orchestrator for `dogsled model test`.
 *
 * Generates test SQL from each model's test definitions; does not execute.
 * Returns per-integration groups of `{ modelName, testName, sql }` so hosts
 * can pipe the SQL to any runner they choose.
 */

import {
  generateTestSql,
  parseTransformSpecFromParsed,
  type SupportedDialect,
} from '../compiler/index.js';
import { CommandError } from '../errors.js';

import { loadProject, selectIntegrationContexts, type LoadedProject } from './load-project.js';

export interface TestProjectOptions {
  integration?: string;
  models?: string[];
  project?: LoadedProject;
}

export interface TestSqlEntry {
  modelName: string;
  testName: string;
  sql: string;
}

export interface TestProjectIntegrationResult {
  handle: string;
  dialect: SupportedDialect;
  tests: TestSqlEntry[];
}

export interface TestProjectResult {
  byIntegration: TestProjectIntegrationResult[];
  warnings: string[];
  skipped: Array<{ handle: string; message: string }>;
}

export async function testProject(
  cwd: string,
  opts: TestProjectOptions = {}
): Promise<TestProjectResult> {
  const project = opts.project ?? (await loadProject(cwd));

  const skipped: TestProjectResult['skipped'] = [];
  const perIntegration = selectIntegrationContexts(project, {
    integration: opts.integration,
    models: opts.models,
    onSkipped: (reason) => skipped.push(reason),
  });

  const byIntegration: TestProjectIntegrationResult[] = [];

  for (const ictx of perIntegration) {
    const { dialect, targetSchema, modelReg, orderedNodes, registry, integration } = ictx;
    const tests: TestSqlEntry[] = [];

    for (const node of orderedNodes) {
      const parseResult = parseTransformSpecFromParsed(node.parsedSpec, registry, modelReg);
      if (!parseResult.ok) {
        throw new CommandError(`${node.name}: ${parseResult.error}`);
      }
      const { spec } = parseResult;
      const emitted = generateTestSql(
        spec.name,
        targetSchema,
        spec.tests ?? [],
        spec.columns,
        dialect
      );
      for (const t of emitted) {
        tests.push({ modelName: t.modelName, testName: t.testName, sql: t.sql });
      }
    }

    byIntegration.push({
      handle: integration.handle,
      dialect,
      tests,
    });
  }

  return {
    byIntegration,
    warnings: [...project.warnings],
    skipped,
  };
}
