/** The shared materializer publishes to the model's selected integration. */
import { randomUUID } from 'node:crypto';
import {
  resolveRunner,
  throwIfCancelled,
  type IntegrationFile,
  type ResolveRunnerOptions,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import {
  generateUnprocessedRowsSql,
  generateStageReplacementDml,
} from '../compiler/materializer.js';
import { quoteIdentifier } from '../compiler/dialect.js';
import {
  createDuckDbAgenticPublisher,
  type DuckDbAgenticPublisherOptions,
} from './duckdb-publisher.js';
import { AgenticColumnsSchema } from './model.js';
import { createAgenticRowSchema } from './rows.js';
import { digestAgenticState } from './state.js';
import {
  AgenticPublicationIntentSchema,
  AgenticPublicationReceiptSchema,
  validateAgenticPublicationRows,
  type AgenticPublisher,
  type AgenticPublicationContext,
} from './publication.js';
import { publicationCheckSql, validatePublicationChecks } from './duckdb-checks.js';
import {
  publicationNames,
  publicationLiteral,
  type PublicationDialect,
} from './sql-publication-dialect.js';
import {
  sqlPublicationDb,
  initPublication,
  readSqlReceipt,
  assertSqlSchema,
  sameComparison,
  insertPublicationRows,
  atomicPublication,
  createPublicationTable,
  type ColumnComparison,
  type PublicationDb,
  type PublicationNames,
} from './sql-publication-storage.js';

export type SqlAgenticPublisherOptions = ResolveRunnerOptions &
  DuckDbAgenticPublisherOptions & { systemSchema?: string };
/** Runner factories must preserve single-connection PostgreSQL transactions and never replay writes. */
export async function createSqlAgenticPublisher(
  integration: IntegrationFile,
  options: SqlAgenticPublisherOptions = {}
): Promise<AgenticPublisher> {
  if (integration.source_type === 'duckdb') {
    return createDuckDbAgenticPublisher(integration, options);
  }
  if (integration.source_type === 'clickhouse') {
    throw new Error('Agentic publication does not support ClickHouse');
  }
  const dialect: PublicationDialect = integration.source_type;
  const maxStages = options.maxRetainedStages ?? 32;
  const maxRows = options.maxStageRows ?? 1_000_000;
  if (
    !Number.isSafeInteger(maxStages) ||
    maxStages < 1 ||
    maxStages > 1024 ||
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 10_000_000
  ) {
    throw new Error('Invalid publication retention limits');
  }
  const literal = (value: string | number) => publicationLiteral(value, dialect);
  const q = (name: string) => quoteIdentifier(name, dialect);
  function countValue(value: unknown): number {
    if (
      !['number', 'bigint', 'string'].includes(typeof value) ||
      (typeof value === 'string' && !/^\d+$/.test(value))
    ) {
      throw new Error('Invalid warehouse count');
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid warehouse count');
    return count;
  }
  let closed = false;
  // Control tables initialized by this publisher. Preflight and inspection always initialize;
  // claim reuses an earlier initialization. Any failed operation forgets them.
  const initialized = new Set<string>();
  // How the columns of the probe stage created by the latest preflight compared values, by
  // target. A no-op checks its target in place only when every target column matches.
  const stageColumns = new Map<string, ColumnComparison[]>();
  async function operation<T>(
    fn: (db: PublicationDb, runner: SqlRunnerModule) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (closed) throw new Error('Publisher is closed');
    throwIfCancelled(signal);
    const runner = await resolveRunner(integration, options);
    try {
      return await fn(sqlPublicationDb(runner, dialect, signal), runner);
    } catch (error) {
      initialized.clear();
      stageColumns.clear();
      throw error;
    } finally {
      await runner.close?.();
    }
  }
  async function initialize(db: PublicationDb, names: PublicationNames, always = false) {
    if (!always && initialized.has(names.control)) return;
    await initPublication(db, names, dialect);
    initialized.add(names.control);
  }
  async function checks(
    db: PublicationDb,
    context: AgenticPublicationContext,
    stage: string,
    relation: string,
    allowFailures = false
  ) {
    for (const sql of publicationCheckSql(context, stage, dialect, relation)) {
      const rows = await db.query(`SELECT violation_count FROM (${sql}) checks LIMIT 2`);
      const value = countValue(rows[0]?.violation_count);
      if (
        rows.length !== 1 ||
        rows[0]?.violation_count == null ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        (!allowFailures && value !== 0)
      ) {
        throw new Error('Agentic final check failed; staging retained');
      }
    }
  }
  async function catalogCommits(db: PublicationDb, relation: string) {
    if (dialect !== 'databricks') return;
    const detail = await db.query(`DESCRIBE DETAIL ${relation}`);
    const features = detail[0]?.tablefeatures;
    if (detail.length !== 1 || !Array.isArray(features) || !features.includes('catalogManaged')) {
      throw new Error(
        'Databricks publication requires Unity Catalog managed tables with catalog commits enabled'
      );
    }
  }
  async function manifest(db: PublicationDb, names: PublicationNames, operationId: string) {
    return db.query(
      `SELECT intent, columns_json, no_op, receipt, validated FROM ${names.manifests} WHERE operation_id = ${db.p(1)} LIMIT 2`,
      [operationId]
    );
  }
  function claimValid(claim: { version: number; fence: string }) {
    if (
      !Number.isSafeInteger(claim.version) ||
      claim.version < 0 ||
      claim.version >= Number.MAX_SAFE_INTEGER - 1 ||
      !/^[a-f0-9-]{36}$/.test(claim.fence)
    ) {
      throw new Error('Invalid publication claim');
    }
  }
  return {
    async preflight(context, signal) {
      validatePublicationChecks(context);
      AgenticColumnsSchema.parse(context.resolved.output_columns);
      const names = publicationNames(context.target, dialect, options.systemSchema);
      await operation(async (db, runner) => {
        await initialize(db, names, true);
        // Create the probe stage first, so the target's column query also reports how a
        // stage built in this storage schema compares values.
        const probe = randomUUID().replaceAll('-', '');
        const stage = names.stage(probe, '_p');
        await createPublicationTable(db, stage, context.resolved.output_columns, dialect);
        try {
          const exists = await assertSqlSchema(
            db,
            names,
            context,
            dialect,
            names.stageTable(probe, '_p')
          );
          stageColumns.delete(names.target);
          if (exists && exists.probe) stageColumns.set(names.target, exists.probe);
          await catalogCommits(db, names.control);
          await catalogCommits(db, names.receipts);
          if (exists) await catalogCommits(db, names.target);
          // Exercise a multi-table transaction before any assignment starts.
          await atomicPublication(
            db,
            runner,
            dialect,
            [
              `UPDATE ${names.control} SET revision = revision WHERE 1 = 0`,
              `DELETE FROM ${names.receipts} WHERE 1 = 0`,
            ],
            `(SELECT COUNT(*) FROM ${names.control}) = 1`,
            signal
          );
          for (const expectation of context.resolved.model.expect) {
            if (expectation.kind !== 'regex') continue;
            const pattern = db.p(1);
            const predicate =
              dialect === 'postgres'
                ? `'probe' ~ ${pattern}`
                : dialect === 'bigquery'
                  ? `REGEXP_CONTAINS('probe', ${pattern})`
                  : dialect === 'databricks'
                    ? `'probe' RLIKE ${pattern}`
                    : `REGEXP_LIKE('probe', ${pattern})`;
            const matched = await db.query(
              `SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS matched`,
              [expectation.pattern]
            );
            if (matched.length !== 1 || ![0, 1].includes(countValue(matched[0]?.matched))) {
              throw new Error('Invalid warehouse regex capability result');
            }
          }
          await checks(db, context, 'preflight', stage, true);
        } finally {
          await runner.run(`DROP TABLE ${stage}`);
        }
      }, signal);
    },
    async claim(target, signal) {
      const names = publicationNames(target, dialect, options.systemSchema);
      return operation(async (db) => {
        await initialize(db, names);
        const fence = randomUUID();
        await db.query(`UPDATE ${names.control} SET fence = ${db.p(1)} WHERE TRUE`, [fence]);
        const rows = await db.query(`SELECT revision, fence FROM ${names.control} LIMIT 2`);
        if (rows.length !== 1 || rows[0]!.fence !== fence) {
          throw new Error('Stale publication owner');
        }
        const claim = { version: countValue(rows[0]!.revision), fence };
        claimValid(claim);
        return claim;
      }, signal);
    },
    async prepare(context, identity, rows, processedKeys, claim, signal, limits) {
      claimValid(claim);
      const intent = AgenticPublicationIntentSchema.parse({
        identity,
        expected_version: claim.version,
        stage: `stage_${identity.operation_id}`,
      });
      validateAgenticPublicationRows(rows, processedKeys, limits);
      if (
        identity.target !== context.target ||
        identity.schema_digest !== digestAgenticState(context.resolved.output_columns) ||
        identity.results_digest !== digestAgenticState(rows) ||
        identity.processed_keys_digest !== digestAgenticState(processedKeys)
      ) {
        throw new Error('Publication payload identity mismatch');
      }
      const columns = context.resolved.output_columns;
      const keys = context.resolved.model.materialization.keys;
      const keyColumns = keys.map((key) => columns.find((column) => column.name === key)!);
      const rowSchema = createAgenticRowSchema(columns),
        keySchema = createAgenticRowSchema(keyColumns);
      rows.forEach((row) => rowSchema.parse(row));
      processedKeys.forEach((key) => keySchema.parse(key));
      const keyDigest = (row: unknown) =>
        digestAgenticState(keys.map((key) => (row as Record<string, unknown>)[key]));
      const prepared = new Set(processedKeys.map(keyDigest));
      if (rows.some((row) => !prepared.has(keyDigest(row)))) {
        throw new Error('Accepted row is outside prepared keys');
      }
      validatePublicationChecks(context);
      const names = publicationNames(context.target, dialect, options.systemSchema);
      return operation(async (db) => {
        const ownership = await db.query(
          `SELECT revision FROM ${names.control} WHERE fence = ${db.p(1)} AND revision = ${db.p(2)} LIMIT 2`,
          [claim.fence, claim.version]
        );
        if (ownership.length !== 1) throw new Error('Stale publication owner or target version');
        const saved = await manifest(db, names, identity.operation_id);
        if (saved.length) {
          if (saved.length !== 1 || saved[0]!.intent !== JSON.stringify(intent)) {
            throw new Error('Prepared publication conflict');
          }
          if (saved[0]!.validated === true) return intent;
        }
        const count = await db.query(`SELECT COUNT(*) AS count FROM ${names.manifests}`);
        if (!saved.length && countValue(count[0]?.count) >= maxStages) {
          throw new Error(
            'Publication stage retention limit reached; inspect and clean completed stages'
          );
        }
        if (!saved.length) {
          const receipt = AgenticPublicationReceiptSchema.parse({
            intent,
            committed_version: intent.expected_version + 1,
          });
          await db.query(
            `INSERT INTO ${names.manifests} VALUES (${[1, 2, 3, 4, 5, 6].map(db.p).join(', ')})`,
            [
              identity.operation_id,
              JSON.stringify(intent),
              JSON.stringify(columns),
              processedKeys.length === 0,
              JSON.stringify(receipt),
              false,
            ]
          );
        }
        const exists = await assertSqlSchema(db, names, context, dialect);
        const stage = names.stage(identity.operation_id);
        if (
          exists &&
          !processedKeys.length &&
          sameComparison(exists.columns, stageColumns.get(names.target))
        ) {
          // No processed keys means the published target is the current target. Its columns
          // compare values exactly like this run's probe stage, so count and check it in
          // place instead of copying it. Commit stays fenced by the claimed version.
          const count = await db.query(`SELECT COUNT(*) AS count FROM ${names.target}`);
          if (countValue(count[0]?.count) > maxRows) {
            throw new Error('Publication replacement exceeds stage row limit');
          }
          await checks(db, context, intent.stage, names.target);
        } else {
          // These names belong only to this uncommitted operation. An interrupted build can be rebuilt.
          await db.run(`DROP TABLE IF EXISTS ${stage}`);
          let oldSql: string | undefined;
          if (exists) {
            // Retained rows are needed only when a target exists.
            const processed = names.stage(identity.operation_id, '_k');
            await db.run(`DROP TABLE IF EXISTS ${processed}`);
            await createPublicationTable(db, processed, keyColumns, dialect);
            await insertPublicationRows(db, processed, keyColumns, processedKeys, dialect, signal);
            oldSql = generateUnprocessedRowsSql({
              target: names.target,
              processedKeys: processed,
              columns: columns.map((column) => column.name),
              keys,
              dialect,
            });
          }
          const kept = oldSql
            ? await db.query(`SELECT COUNT(*) AS count FROM (${oldSql}) kept`)
            : [{ count: 0 }];
          if (
            !Number.isSafeInteger(countValue(kept[0]?.count)) ||
            countValue(kept[0]?.count) + rows.length > maxRows
          ) {
            throw new Error('Publication replacement exceeds stage row limit');
          }
          await createPublicationTable(db, stage, columns, dialect);
          if (oldSql) await db.run(`INSERT INTO ${stage} ${oldSql}`);
          await insertPublicationRows(db, stage, columns, rows, dialect, signal);
          await checks(db, context, intent.stage, stage);
        }
        await db.query(
          `UPDATE ${names.manifests} SET validated = TRUE WHERE operation_id = ${db.p(1)}`,
          [identity.operation_id]
        );
        return intent;
      }, signal);
    },
    async inspect(intent, signal) {
      AgenticPublicationIntentSchema.parse(intent);
      const names = publicationNames(intent.identity.target, dialect, options.systemSchema);
      return operation(async (db) => {
        await initialize(db, names, true);
        return readSqlReceipt(db, names, intent);
      }, signal);
    },
    async commit(intent, claim, signal) {
      AgenticPublicationIntentSchema.parse(intent);
      claimValid(claim);
      if (claim.version !== intent.expected_version) {
        throw new Error('Stale publication target version');
      }
      const names = publicationNames(intent.identity.target, dialect, options.systemSchema);
      return operation(async (db, runner) => {
        const existing = await readSqlReceipt(db, names, intent);
        if (existing) return existing;
        const saved = await manifest(db, names, intent.identity.operation_id);
        if (
          saved.length !== 1 ||
          saved[0]!.intent !== JSON.stringify(intent) ||
          typeof saved[0]!.no_op !== 'boolean' ||
          saved[0]!.validated !== true
        ) {
          throw new Error('Publication stage is missing or unvalidated');
        }
        const receipt = AgenticPublicationReceiptSchema.parse(
          JSON.parse(String(saved[0]!.receipt))
        );
        if (digestAgenticState(receipt.intent) !== digestAgenticState(intent)) {
          throw new Error('Prepared receipt conflict');
        }
        const columns = AgenticColumnsSchema.parse(JSON.parse(String(saved[0]!.columns_json)));
        const commitToken = randomUUID();
        const statements = [
          `UPDATE ${names.control} SET revision = revision + 1, commit_token = ${literal(commitToken)} WHERE revision = ${intent.expected_version} AND fence = ${literal(claim.fence)}`,
        ];
        if (!saved[0]!.no_op) {
          // Permanent DDL cannot share the transaction on every warehouse. A failed first commit may leave an empty table.
          await createPublicationTable(db, names.target, columns, dialect, true);
          await catalogCommits(db, names.target);
          statements.push(
            ...generateStageReplacementDml({
              target: names.target,
              stage: names.stage(intent.identity.operation_id),
              columns: columns.map((column) => column.name),
              dialect,
            })
          );
        }
        statements.push(
          `INSERT INTO ${names.receipts} SELECT ${q('operation_id')}, ${q('receipt')} FROM ${names.manifests} WHERE operation_id = ${literal(intent.identity.operation_id)}`
        );
        const assertion = `(SELECT COUNT(*) FROM ${names.control}) = 1 AND (SELECT COUNT(*) FROM ${names.control} WHERE revision = ${intent.expected_version + 1} AND fence = ${literal(claim.fence)} AND commit_token = ${literal(commitToken)}) = 1 AND (SELECT COUNT(*) FROM ${names.receipts} WHERE operation_id = ${literal(intent.identity.operation_id)}) = 1`;
        await atomicPublication(db, runner, dialect, statements, assertion, signal);
        // Verify through persisted data, not an affected-row count from a driver.
        const observed = await readSqlReceipt(db, names, intent);
        if (!observed) throw new Error('Publication receipt is missing after commit');
        return observed;
      }, signal);
    },
    async close() {
      closed = true;
    },
  };
}
