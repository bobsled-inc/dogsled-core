import { createDuckDbCursorStore } from './duckdb-cursors.js';
import {
  generateUnprocessedRowsSql,
  generateStageReplacementDml,
} from '../compiler/materializer.js';
import { preflightPublicationChecks } from './duckdb-preflight.js';
/** File-backed DuckDB publication. Each operation owns one freshly opened runner. */
import { randomUUID } from 'node:crypto';
import { canonicalDuckDbPath, withDuckDbFile } from './duckdb-file.js';
import {
  buildDuckDbRunner,
  throwIfCancelled,
  type DuckDbIntegration,
  type SqlRunnerModule,
  type SqlParams,
} from '@bobsled-inc/connections';
import type { JsonValue } from '@bobsled-inc/protocol';
import { AgenticColumnsSchema, type AgenticColumn } from './model.js';
import { createAgenticRowSchema } from './rows.js';
import { digestAgenticState } from './state.js';
import {
  agenticRowsDigest,
  agenticSchemaDigest,
  AgenticPublicationIntentSchema,
  AgenticPublicationReceiptSchema,
  validateAgenticPublicationRows,
  type AgenticPublisher,
} from './publication.js';
import { stageRef, validatePublicationChecks, publicationCheckSql } from './duckdb-checks.js';

import {
  control,
  manifests,
  receipts,
  targetParts,
  ddl,
  boundValue,
  dbFor,
  init,
  readReceipt,
  assertSchema,
  type Db,
} from './duckdb-publication-storage.js';

// Internal helper: relation is already quoted by the publisher, and values remain bound.
export async function insertDuckDbPublicationRows(
  db: Db,
  relation: string,
  columns: readonly AgenticColumn[],
  rows: readonly JsonValue[],
  signal?: AbortSignal
): Promise<void> {
  // Keep statements small even for wide schemas. These are application caps,
  // deliberately below database limits, not a claim about DuckDB's maximum.
  const batchRows = Math.min(128, Math.floor(4096 / columns.length));
  if (batchRows < 1 || !columns.length) throw new Error('Invalid publication column count');
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  for (let start = 0; start < rows.length; start += batchRows) {
    throwIfCancelled(signal);
    const batch = rows.slice(start, start + batchRows);
    const params = batch.flatMap((row) =>
      columns.map((column) => boundValue((row as Record<string, JsonValue>)[column.name], column))
    ) as SqlParams;
    await db.query(`INSERT INTO ${relation} VALUES ${batch.map(() => tuple).join(', ')}`, params);
  }
}

export interface DuckDbAgenticPublisherOptions {
  /** Retained stages per database. No automatic deletion. Default: 32. */
  maxRetainedStages?: number;
  /** Bounds each full replacement stage, including untouched rows. Default: 1,000,000. */
  maxStageRows?: number;
}
/** Hosts must exclude other live DuckDB instances for this file during each operation. */
export async function createDuckDbAgenticPublisher(
  integration: DuckDbIntegration,
  options: DuckDbAgenticPublisherOptions = {}
): Promise<AgenticPublisher> {
  if (integration.auth.type !== 'file' || integration.auth.read_only) {
    throw new Error('Agentic publication requires writable file-backed DuckDB');
  }
  const canonical = await canonicalDuckDbPath(integration.auth.path);
  const config = { ...integration, auth: { ...integration.auth, path: canonical } };
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
  let closed = false;
  async function operation<T>(
    fn: (db: Db, runner: SqlRunnerModule) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (closed) throw new Error('Publisher is closed');
    return withDuckDbFile(canonical, async () => {
      let runner: SqlRunnerModule | undefined;
      try {
        throwIfCancelled(signal);
        runner = await buildDuckDbRunner(config);
        if (!runner.query || !runner.supportsBindings || !runner.close) {
          throw new Error('DuckDB publication requires bindings, queries and close');
        }
        return await fn(dbFor(runner, signal), runner);
      } finally {
        await runner?.close?.();
      }
    });
  }
  return {
    cursors: createDuckDbCursorStore(operation),
    async preflight(context, signal) {
      validatePublicationChecks(context);
      AgenticColumnsSchema.parse(context.resolved.output_columns);
      targetParts(context.target);
      await operation(async (db, runner) => {
        await init(db);
        await assertSchema(db, context);
        await preflightPublicationChecks(db, runner, context, signal);
      }, signal);
    },
    async claim(target, signal) {
      targetParts(target);
      return operation(async (db) => {
        await init(db);
        const fence = randomUUID();
        const rows = await db.query(
          `INSERT INTO ${control} VALUES (?, 0, ?) ON CONFLICT (target) DO UPDATE SET fence = excluded.fence RETURNING revision`,
          [targetParts(target).controlKey, fence]
        );
        if (rows.length !== 1) throw new Error('Unable to claim publication target');
        const version = Number(rows[0]!.revision);
        if (!Number.isSafeInteger(version) || version < 0) {
          throw new Error('Invalid target version');
        }
        return { version, fence };
      }, signal);
    },
    async prepare(context, identity, rows, processedKeys, claim, signal, limits) {
      const intent = AgenticPublicationIntentSchema.parse({
        identity,
        expected_version: claim.version,
        stage: `stage_${identity.operation_id}`,
      });
      validateAgenticPublicationRows(rows, processedKeys, limits);
      if (
        identity.target !== context.target ||
        identity.schema_digest !== agenticSchemaDigest(context.resolved.output_columns) ||
        identity.results_digest !== agenticRowsDigest(rows) ||
        identity.processed_keys_digest !== digestAgenticState(processedKeys)
      ) {
        throw new Error('Publication payload identity mismatch');
      }
      const columns = context.resolved.output_columns;
      const keys = context.resolved.model.materialization.keys;
      const keyColumns = keys.map((key) => columns.find((column) => column.name === key)!);
      const rowSchema = createAgenticRowSchema(columns);
      rows.forEach((row) => rowSchema.parse(row));
      const keySchema = createAgenticRowSchema(keyColumns);
      processedKeys.forEach((key) => keySchema.parse(key));
      validatePublicationChecks(context);
      return operation(async (db, runner) => {
        await init(db);
        const ownership = await db.query(
          `SELECT revision FROM ${control} WHERE target = ? AND fence = ? AND revision = ? LIMIT 1`,
          [targetParts(context.target).controlKey, claim.fence, claim.version]
        );
        if (ownership.length !== 1) throw new Error('Stale publication owner or target version');
        const saved = await db.query(
          `SELECT intent FROM ${manifests} WHERE operation_id = ? LIMIT 1`,
          [identity.operation_id]
        );
        if (saved.length && saved[0]!.intent !== JSON.stringify(intent)) {
          throw new Error('Prepared publication conflict');
        }
        if (!saved.length) {
          const count = await db.query(`SELECT COUNT(*) AS count FROM ${manifests}`);
          if (Number(count[0]?.count) >= maxStages) {
            throw new Error(
              'Publication stage retention limit reached; inspect and clean completed stages'
            );
          }
          const exists = await assertSchema(db, context);
          const target = targetParts(context.target).sql;
          const oldSql = exists
            ? generateUnprocessedRowsSql({
                target,
                processedKeys: 'processed',
                columns: columns.map((column) => column.name),
                keys,
                dialect: 'duckdb',
              })
            : '';
          await db.run('BEGIN TRANSACTION');
          try {
            await db.run(`CREATE TEMP TABLE processed (${ddl(keyColumns)})`);
            await insertDuckDbPublicationRows(db, 'processed', keyColumns, processedKeys, signal);
            const oldCount = oldSql
              ? await db.query(`SELECT COUNT(*) AS count FROM (${oldSql}) kept`)
              : [{ count: 0 }];
            if (Number(oldCount[0]?.count) + rows.length > maxRows) {
              throw new Error('Publication replacement exceeds stage row limit');
            }
            await db.run(`CREATE TABLE ${stageRef(intent.stage)} (${ddl(columns)})`);
            if (oldSql) await db.run(`INSERT INTO ${stageRef(intent.stage)} ${oldSql}`);
            await insertDuckDbPublicationRows(db, stageRef(intent.stage), columns, rows, signal);
            // Membership is checked against accepted rows only; untouched target rows have other keys.
            const prepared = new Set(
              processedKeys.map((key) =>
                digestAgenticState(keys.map((name) => (key as Record<string, JsonValue>)[name]))
              )
            );
            if (
              rows.some(
                (row) =>
                  !prepared.has(
                    digestAgenticState(keys.map((name) => (row as Record<string, JsonValue>)[name]))
                  )
              )
            ) {
              throw new Error('Accepted row is outside prepared keys');
            }
            await db.query(`INSERT INTO ${manifests} VALUES (?, ?, ?, ?, FALSE)`, [
              identity.operation_id,
              JSON.stringify(intent),
              JSON.stringify(columns),
              processedKeys.length === 0,
            ]);
            await db.run('COMMIT');
          } catch (error) {
            await dbFor(runner)
              .run('ROLLBACK')
              .catch(() => {});
            throw error;
          }
        }
        for (const sql of publicationCheckSql(context, intent.stage)) {
          throwIfCancelled(signal);
          const result = await db.query(`SELECT violation_count FROM (${sql}) checks LIMIT 2`);
          const value = result[0]?.violation_count;
          if (
            result.length !== 1 ||
            !['number', 'bigint'].includes(typeof value) ||
            Number(value) !== 0
          ) {
            throw new Error('Agentic final check failed; staging retained');
          }
        }
        await db.query(`UPDATE ${manifests} SET validated = TRUE WHERE operation_id = ?`, [
          identity.operation_id,
        ]);
        return intent;
      }, signal);
    },
    async inspect(intent, signal) {
      AgenticPublicationIntentSchema.parse(intent);
      return operation(async (db) => {
        await init(db);
        return readReceipt(db, intent);
      }, signal);
    },
    async commit(intent, claim, signal) {
      AgenticPublicationIntentSchema.parse(intent);
      return operation(async (db, runner) => {
        const existing = await readReceipt(db, intent);
        if (existing) return existing;
        const saved = await db.query(
          `SELECT intent, columns_json, no_op, validated FROM ${manifests} WHERE operation_id = ? LIMIT 2`,
          [intent.identity.operation_id]
        );
        if (
          saved.length !== 1 ||
          saved[0]!.intent !== JSON.stringify(intent) ||
          saved[0]!.validated !== true
        ) {
          throw new Error('Publication stage is missing or unvalidated');
        }
        const columns = AgenticColumnsSchema.parse(JSON.parse(String(saved[0]!.columns_json)));
        const target = targetParts(intent.identity.target).sql;
        const receipt = AgenticPublicationReceiptSchema.parse({
          intent,
          committed_version: intent.expected_version + 1,
        });
        await db.run('BEGIN TRANSACTION');
        let committing = false;
        try {
          const advanced = await db.query(
            `UPDATE ${control} SET revision = revision + 1 WHERE target = ? AND revision = ? AND fence = ? RETURNING revision`,
            [targetParts(intent.identity.target).controlKey, intent.expected_version, claim.fence]
          );
          if (advanced.length !== 1) throw new Error('Stale publication owner or target version');
          if (!saved[0]!.no_op) {
            await db.run(`CREATE TABLE IF NOT EXISTS ${target} (${ddl(columns)})`);
            for (const sql of generateStageReplacementDml({
              target,
              stage: stageRef(intent.stage),
              columns: columns.map((column) => column.name),
              dialect: 'duckdb',
            })) {
              await db.run(sql);
            }
          }
          await db.query(`INSERT INTO ${receipts} VALUES (?, ?)`, [
            intent.identity.operation_id,
            JSON.stringify(receipt),
          ]);
          throwIfCancelled(signal);
          committing = true;
          await db.run('COMMIT');
          return receipt;
        } catch (error) {
          const uncancelled = dbFor(runner);
          await uncancelled.run('ROLLBACK').catch(() => {});
          if (committing) {
            const observed = await readReceipt(uncancelled, intent);
            if (observed) return observed;
          }
          throw error;
        }
      }, signal);
    },
    async close() {
      closed = true;
    },
  };
}
