/**
 * Data test SQL generation from transform spec test definitions.
 *
 * Each test generates a SQL query that returns rows that FAIL the test.
 * A passing test returns 0 rows.
 */

import { buildFqName, caseName, quoteLiteral } from './dialect.js';

import type { SupportedDialect } from './dialect.js';
import type { ResolvedColumn } from './parser.js';
import type { DataTest } from './schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestResult {
  modelName: string;
  testName: string;
  sql: string;
}

export type TestSpec = DataTest;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate test SQL statements from a model's test definitions.
 *
 * Returns one TestResult per test. Each SQL query returns rows that
 * FAIL the test — a passing test returns 0 rows.
 */
export function generateTestSql(
  modelName: string,
  targetSchema: string,
  tests: TestSpec[],
  columns: ResolvedColumn[],
  dialect: SupportedDialect
): TestResult[] {
  const fqName = buildFqName(targetSchema, modelName, dialect);
  const results: TestResult[] = [];
  const seen = new Set<string>();

  function pushResult(result: TestResult): void {
    if (seen.has(result.testName)) return;
    seen.add(result.testName);
    results.push(result);
  }

  // Auto-generate tests from column constraints (single pass)
  for (const col of columns) {
    if (col.primary_key) {
      const colName = caseName(col.name, dialect);
      pushResult(notNullTest(modelName, col.name, colName, fqName));
      pushResult(uniqueTest(modelName, col.name, colName, fqName));
    } else if (col.not_null) {
      const colName = caseName(col.name, dialect);
      pushResult(notNullTest(modelName, col.name, colName, fqName));
    }
  }

  // Process explicit tests
  for (const test of tests) {
    switch (test.type) {
      case 'not_null': {
        if (!test.column) continue;
        const colName = caseName(test.column, dialect);
        pushResult(notNullTest(modelName, test.column, colName, fqName));
        break;
      }
      case 'unique': {
        if (!test.column) continue;
        const colName = caseName(test.column, dialect);
        pushResult(uniqueTest(modelName, test.column, colName, fqName));
        break;
      }
      case 'accepted_values': {
        if (!test.column || !test.values || test.values.length === 0) continue;
        const colName = caseName(test.column, dialect);
        const valuesList = test.values.map((v) => quoteLiteral(v, dialect)).join(', ');
        pushResult({
          modelName,
          testName: `${test.column}_accepted_values`,
          sql: `SELECT * FROM ${fqName} WHERE ${colName} NOT IN (${valuesList});`,
        });
        break;
      }
      case 'custom': {
        if (!test.sql) continue;
        // Expand {name} template in custom test SQL
        const expandedSql = test.sql.replace(/\{name\}/g, fqName);
        const customIdx = results.filter((r) =>
          r.testName.startsWith(`${modelName}_custom`)
        ).length;
        results.push({
          modelName,
          testName: `${modelName}_custom_${customIdx + 1}`,
          sql: expandedSql.endsWith(';') ? expandedSql : `${expandedSql};`,
        });
        break;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function notNullTest(
  modelName: string,
  rawName: string,
  colName: string,
  fqName: string
): TestResult {
  return {
    modelName,
    testName: `${rawName}_not_null`,
    sql: `SELECT * FROM ${fqName} WHERE ${colName} IS NULL;`,
  };
}

function uniqueTest(
  modelName: string,
  rawName: string,
  colName: string,
  fqName: string
): TestResult {
  return {
    modelName,
    testName: `${rawName}_unique`,
    sql: `SELECT ${colName}, COUNT(*) AS __count FROM ${fqName} GROUP BY ${colName} HAVING COUNT(*) > 1;`,
  };
}
