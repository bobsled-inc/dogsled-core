import { randomUUID } from 'node:crypto';
import { throwIfCancelled, type SqlRunnerModule } from '@bobsled-inc/connections';
import { publicationCheckSql, stageRef } from './duckdb-checks.js';
import { ddl, dbFor, type Db } from './duckdb-publication-storage.js';
import type { AgenticPublicationContext } from './publication.js';

/** Bind every generated check to a typed empty relation, then discard the transaction. */
export async function preflightPublicationChecks(
  db: Db,
  runner: SqlRunnerModule,
  context: AgenticPublicationContext,
  signal?: AbortSignal
): Promise<void> {
  const stage = `preflight_${randomUUID().replaceAll('-', '')}`;
  await db.run('BEGIN TRANSACTION');
  try {
    const binding = await db.query('SELECT CAST(? AS INTEGER) AS value', [1]);
    if (binding.length !== 1 || binding[0]?.value !== 1) {
      throw new Error('DuckDB bindings unavailable');
    }
    await db.run(`CREATE TABLE ${stageRef(stage)} (${ddl(context.resolved.output_columns)})`);
    // An empty scan may skip runtime regex evaluation. A bound scalar probe forces
    // DuckDB's RE2 parser to validate patterns accepted by the JavaScript schema.
    for (const expectation of context.resolved.model.expect) {
      throwIfCancelled(signal);
      if (expectation.kind === 'regex') {
        const result = await db.query('SELECT regexp_matches(?, ?) AS matched', [
          'probe',
          expectation.pattern,
        ]);
        if (result.length !== 1 || typeof result[0]?.matched !== 'boolean') {
          throw new Error('Invalid DuckDB regex capability result');
        }
      }
    }
    for (const sql of publicationCheckSql(context, stage)) {
      throwIfCancelled(signal);
      const rows = await db.query(`SELECT violation_count FROM (${sql}) checks LIMIT 2`);
      const count = rows[0]?.violation_count;
      if (
        rows.length !== 1 ||
        !['number', 'bigint'].includes(typeof count) ||
        !Number.isSafeInteger(Number(count)) ||
        Number(count) < 0
      ) {
        throw new Error('Invalid DuckDB final-check capability result');
      }
    }
  } finally {
    // Rollback must complete even after cancellation so the transient relation is removed.
    await dbFor(runner).run('ROLLBACK');
  }
}
