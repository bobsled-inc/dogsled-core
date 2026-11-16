import { generateTestSql } from '../compiler/tests.js';
import { generateExpectationSql } from '../compiler/expect/codegen.js';
import { quoteIdentifier, buildFqName, type SupportedDialect } from '../compiler/dialect.js';
import type { AgenticPublicationContext } from './publication.js';

export const PUBLICATION_SCHEMA = '_bobsled_agentic_publication';
export const q = (value: string): string => quoteIdentifier(value, 'duckdb');
export const stageRef = (stage: string): string => `${q(PUBLICATION_SCHEMA)}.${q(stage)}`;

/** No raw SQL reaches the warehouse through final checks in the first adapter. */
export function validatePublicationChecks(context: AgenticPublicationContext): void {
  const model = context.resolved.model;
  const names = new Set(context.resolved.output_columns.map((column) => column.name));
  for (const test of model.tests ?? []) {
    if (test.type === 'custom' || test.sql !== undefined) {
      throw new Error('Agentic publication does not support custom SQL tests');
    }
    if (
      !test.column ||
      !names.has(test.column) ||
      (test.type === 'accepted_values' && !test.values?.length)
    ) {
      throw new Error('Agentic publication requires complete tests on output columns');
    }
  }
  for (const expectation of model.expect) {
    if (expectation.severity === 'warn') {
      throw new Error('Agentic publication does not support warning severity expectations');
    }
    if (expectation.kind === 'custom' || expectation.kind === 'expression') {
      throw new Error('Agentic publication does not support custom or expression expectations');
    }
    const columns =
      'column' in expectation
        ? [expectation.column]
        : 'columns' in expectation
          ? expectation.columns
          : [];
    if (expectation.kind !== 'schema_contains' && columns.some((column) => !names.has(column))) {
      throw new Error('Agentic publication expectations must reference output columns');
    }
  }
}
export function publicationCheckSql(
  context: AgenticPublicationContext,
  stage: string,
  dialect: SupportedDialect = 'duckdb',
  relation: string = stageRef(stage)
): string[] {
  validatePublicationChecks(context);
  const columns = context.resolved.output_columns;
  const model = context.resolved.model;
  // The shared generator deduplicates names within one call. Each authored rule
  // is a separate obligation, even when its column and test type are repeated.
  const tests = (model.tests ?? []).flatMap((test) =>
    generateTestSql(
      stage,
      PUBLICATION_SCHEMA,
      [{ ...test, column: quoteIdentifier(test.column!, dialect) }],
      [],
      dialect
    ).map(
      (generated) =>
        `SELECT COUNT(*) AS violation_count FROM (${generated.sql.replace(buildFqName(PUBLICATION_SCHEMA, stage, dialect), () => relation).replace(/;\s*$/, '')}) AS failures`
    )
  );
  const expectations = generateExpectationSql({
    modelName: model.name,
    tableName: relation,
    dialect,
    outputColumns: columns.map((column) => column.name),
    expectations: [
      { kind: 'primary_key', columns: model.grain },
      ...columns
        .filter((column) => !column.nullable)
        .map((column) => ({ kind: 'non_null' as const, column: column.name })),
      ...model.expect,
    ],
  });
  return [...tests, ...expectations.map((check) => check.sql)];
}
