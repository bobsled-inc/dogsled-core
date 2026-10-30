import { createWarehouseAgenticCursorStore } from './warehouse-cursors.js';
import { randomUUID } from 'node:crypto';
import {
  resolveRunner,
  throwIfCancelled,
  type IntegrationFile,
  type ResolveRunnerOptions,
} from '@bobsled-inc/connections';
import { caseName, quoteIdentifier } from '../compiler/dialect.js';
import { atomicPublication, sqlPublicationDb } from './sql-publication-storage.js';
import {
  publicationLiteral,
  publicationTableSuffix,
  publicationType,
} from './sql-publication-dialect.js';
import {
  AgenticRunKeySchema,
  AgenticRunSnapshotSchema,
  AgenticStateError,
  applyAgenticCheckpoint,
  digestAgenticState,
} from './state.js';
import type { AgenticStateStore, AgenticRunSnapshot } from './state.js';

export type WarehouseCheckpointOptions = ResolveRunnerOptions & {
  schema: string;
  leaseMs?: number;
  signal?: AbortSignal;
};

const maxBytes = 16 * 1024 * 1024;
const chunkSize = 64 * 1024;
// Seven full chunks (448 KiB), 21 bindings, and at most 64 KiB of SQL leave
// ample headroom below Snowflake's 1 MB recommendation including bound values.
// Base64, snapshot IDs and ordinals are ASCII with no JSON escaping expansion.
const chunksPerInsert = 7;
const maxInsertSqlBytes = 64 * 1024;

export function createWarehouseCheckpointStore(
  integration: IntegrationFile,
  options: WarehouseCheckpointOptions
): AgenticStateStore {
  if (integration.source_type === 'clickhouse' || integration.source_type === 'duckdb') {
    throw new Error('Checkpoint store requires PostgreSQL, Snowflake, BigQuery, or Databricks');
  }
  const dialect = integration.source_type;
  const sqlDialect = dialect;
  const schema = options.schema;
  const leaseMs = options.leaseMs ?? 120_000;
  if (
    !schema.trim() ||
    schema.length > 1024 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 10_000 ||
    leaseMs > 600_000
  ) {
    throw new AgenticStateError('limit');
  }
  const q = (name: string) => quoteIdentifier(caseName(name, dialect), dialect);
  const catalog =
    integration.source_type === 'snowflake'
      ? integration.connection?.database
      : integration.source_type === 'databricks'
        ? integration.connection?.catalog
        : integration.source_type === 'bigquery'
          ? integration.connection.project_id
          : undefined;
  if (dialect === 'bigquery' && !catalog) {
    throw new Error('Checkpoint store requires a single BigQuery project_id');
  }
  const namespace = [...(catalog ? [catalog] : []), schema].map(q).join('.');
  const textType = publicationType('string', sqlDialect);
  const intType = publicationType('integer', sqlDialect);
  const suffix = publicationTableSuffix(sqlDialect);
  const clock =
    dialect === 'snowflake'
      ? 'DATE_PART(EPOCH_MILLISECOND, CURRENT_TIMESTAMP())'
      : dialect === 'bigquery'
        ? 'UNIX_MILLIS(CURRENT_TIMESTAMP())'
        : dialect === 'databricks'
          ? 'unix_millis(current_timestamp())'
          : 'CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)';
  const lit = (value: string | number) => publicationLiteral(value, sqlDialect);
  return {
    cursors: createWarehouseAgenticCursorStore(integration, options),
    async acquire(rawKey) {
      throwIfCancelled(options.signal);
      const key = AgenticRunKeySchema.parse(rawKey);
      const hash = digestAgenticState(key).slice(0, 48);
      const control = `${namespace}.${q(`__dogsled_cp_${hash}_c`)}`;
      const payloads = `${namespace}.${q(`__dogsled_cp_${hash}_p`)}`;
      const runner = await resolveRunner(integration, options);
      let db: ReturnType<typeof sqlPublicationDb>;
      try {
        throwIfCancelled(options.signal);
        db = sqlPublicationDb(runner, sqlDialect, options.signal);
      } catch (error) {
        await runner.close?.();
        throw error;
      }
      const owner = randomUUID();
      let closed = false;
      let lost = false;
      const ownership = new AbortController();
      const loseOwnership = () => {
        lost = true;
        ownership.abort();
        return new AgenticStateError('lease_lost');
      };
      let queue: Promise<unknown> = Promise.resolve();
      const serial = <T>(fn: () => Promise<T>): Promise<T> => {
        const next = queue.then(fn);
        queue = next.catch(() => {});
        return next;
      };
      const guard = () => {
        throwIfCancelled(options.signal);
        if (lost) throw new AgenticStateError('lease_lost');
        if (closed) throw new AgenticStateError('conflict');
      };
      const predicate = `${q('owner')} = ${lit(owner)} AND ${q('expires')} > ${clock}`;
      const mutate = async (set: string, condition: string, extra: string[] = []) => {
        const token = randomUUID();
        const update = `UPDATE ${control} SET ${set}, ${q('token')} = ${lit(token)} WHERE ${condition}`;
        await atomicPublication(
          db,
          runner,
          sqlDialect,
          [update, ...extra],
          `(SELECT COUNT(*) FROM ${control}) = 1 AND (SELECT COUNT(*) FROM ${control} WHERE ${q('token')} = ${lit(token)}) = 1`,
          options.signal
        );
      };
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        await db.run(`CREATE SCHEMA IF NOT EXISTS ${namespace}`);
        await db.run(
          `CREATE TABLE IF NOT EXISTS ${control}${suffix} AS SELECT CAST('' AS ${textType}) AS ${q('owner')}, CAST(0 AS ${intType}) AS ${q('expires')}, CAST('' AS ${textType}) AS ${q('token')}, CAST('' AS ${textType}) AS ${q('snapshot')}`
        );
        await db.run(
          `CREATE TABLE IF NOT EXISTS ${payloads} (${q('snapshot')} ${textType} NOT NULL, ${q('ordinal')} ${intType} NOT NULL, ${q('data')} ${textType} NOT NULL)${suffix}`
        );
        if (dialect === 'databricks') {
          for (const table of [control, payloads]) {
            const details = await db.query(`DESCRIBE DETAIL ${table}`);
            if (
              details.length !== 1 ||
              !Array.isArray(details[0]?.tablefeatures) ||
              !details[0].tablefeatures.includes('catalogManaged')
            ) {
              throw new Error('Checkpoint store requires Databricks catalog commits');
            }
          }
        }
        await mutate(
          `${q('owner')} = ${lit(owner)}, ${q('expires')} = ${clock} + ${leaseMs}`,
          `${q('expires')} <= ${clock}`
        );
        const renew = async () => {
          guard();
          try {
            await mutate(`${q('expires')} = ${clock} + ${leaseMs}`, predicate);
          } catch {
            throwIfCancelled(options.signal);
            throw loseOwnership();
          }
        };
        let renewalPending = false;
        timer = setInterval(
          () => {
            if (renewalPending || closed || lost || options.signal?.aborted) return;
            renewalPending = true;
            void serial(renew)
              .catch(() => {
                loseOwnership();
              })
              .finally(() => {
                renewalPending = false;
              });
          },
          Math.floor(leaseMs / 3)
        );
        timer.unref();
        let pointer = '';
        const read = async (): Promise<AgenticRunSnapshot | null> => {
          guard();
          const rows = await db.query(
            `SELECT SUBSTR(${q('snapshot')}, 1, 102) AS ${q('snapshot')} FROM ${control} WHERE ${predicate} LIMIT 2`
          );
          if (rows.length === 0) throw loseOwnership();
          if (rows.length !== 1) throw new AgenticStateError('corrupt');
          const id = rows[0]!.snapshot;
          if (id === '') {
            pointer = '';
            return null;
          }
          if (typeof id !== 'string' || !/^[a-f0-9-]{36}_[a-f0-9]{64}$/.test(id)) {
            throw new AgenticStateError('corrupt');
          }
          const chunks = await db.query(
            `SELECT ${q('ordinal')}, SUBSTR(${q('data')}, 1, ${chunkSize + 1}) AS ${q('data')} FROM ${payloads} WHERE ${q('snapshot')} = ${db.p(1)} ORDER BY ${q('ordinal')} LIMIT 343`,
            [id]
          );
          if (!chunks.length || chunks.length > 342) throw new AgenticStateError('corrupt');
          const encoded = chunks
            .map((chunk, index) => {
              if (
                Number(chunk.ordinal) !== index ||
                typeof chunk.data !== 'string' ||
                chunk.data.length > chunkSize
              ) {
                throw new AgenticStateError('corrupt');
              }
              return chunk.data;
            })
            .join('');
          const bytes = Buffer.from(encoded, 'base64');
          if (bytes.byteLength > maxBytes || bytes.toString('base64') !== encoded) {
            throw new AgenticStateError('corrupt');
          }
          let snapshot: AgenticRunSnapshot;
          try {
            snapshot = AgenticRunSnapshotSchema.parse(JSON.parse(bytes.toString('utf8')));
          } catch {
            throw new AgenticStateError('corrupt');
          }
          if (
            digestAgenticState(snapshot) !== id.slice(37) ||
            digestAgenticState(snapshot.key) !== digestAgenticState(key)
          ) {
            throw new AgenticStateError('corrupt');
          }
          pointer = id;
          return snapshot;
        };
        const save = async (snapshot: AgenticRunSnapshot, previous: AgenticRunSnapshot | null) => {
          guard();
          const value = AgenticRunSnapshotSchema.parse(snapshot);
          if (digestAgenticState(value.key) !== digestAgenticState(key)) {
            throw new AgenticStateError('conflict');
          }
          const bytes = Buffer.from(JSON.stringify(value));
          if (bytes.byteLength > maxBytes) throw new AgenticStateError('limit');
          const digest = digestAgenticState(value);
          if (previous && digest === digestAgenticState(previous)) return value;
          const id = `${randomUUID()}_${digest}`;
          const oldId = pointer;
          await renew();
          const retained = await db.query(
            `SELECT COALESCE(SUM(LENGTH(${q('data')})), 0) AS retained FROM ${payloads}`
          );
          const retainedSize = Number(retained[0]?.retained);
          if (
            retained.length !== 1 ||
            !Number.isSafeInteger(retainedSize) ||
            retainedSize < 0 ||
            retainedSize > 64 * 1024 * 1024
          ) {
            throw new AgenticStateError('limit');
          }
          const encoded = bytes.toString('base64');
          let renewedAt = Date.now();
          for (let start = 0; start < encoded.length; start += chunkSize * chunksPerInsert) {
            guard();
            if (Date.now() - renewedAt >= leaseMs / 3) {
              await renew();
              renewedAt = Date.now();
            }
            const params: (string | number)[] = [];
            const rows: string[] = [];
            const end = Math.min(encoded.length, start + chunkSize * chunksPerInsert);
            for (let offset = start; offset < end; offset += chunkSize) {
              params.push(id, offset / chunkSize, encoded.slice(offset, offset + chunkSize));
              rows.push(
                `(${db.p(params.length - 2)}, ${db.p(params.length - 1)}, ${db.p(params.length)})`
              );
            }
            const sql = `INSERT INTO ${payloads} (${q('snapshot')}, ${q('ordinal')}, ${q('data')}) VALUES ${rows.join(', ')}`;
            if (Buffer.byteLength(sql) > maxInsertSqlBytes) throw new AgenticStateError('limit');
            await db.query(sql, params);
          }
          guard();
          await mutate(
            `${q('snapshot')} = ${lit(id)}, ${q('expires')} = ${clock} + ${leaseMs}`,
            `${predicate} AND ${q('snapshot')} = ${lit(oldId)}`,
            [`DELETE FROM ${payloads} WHERE ${q('snapshot')} <> ${lit(id)}`]
          );
          pointer = id;
          return value;
        };
        return {
          ownershipLost: ownership.signal,
          read: () => serial(read),
          create: (snapshot) =>
            serial(async () => {
              const previous = await read();
              if (previous) throw new AgenticStateError('conflict');
              return save(snapshot, null);
            }),
          checkpoint: (command) =>
            serial(async () => {
              const previous = await read();
              if (!previous) throw new AgenticStateError('missing');
              return save(applyAgenticCheckpoint(previous, command), previous);
            }),
          release: () =>
            serial(async () => {
              if (closed) return;
              if (timer) clearInterval(timer);
              try {
                // Release is cleanup. It must work after execution cancellation.
                if (!lost) {
                  const cleanupDb = sqlPublicationDb(runner, sqlDialect);
                  // A matching owner can relinquish an expired lease. A successor's
                  // different token makes this a no-op; no live lease is required.
                  await cleanupDb.run(
                    `UPDATE ${control} SET ${q('owner')} = '', ${q('expires')} = 0 WHERE ${q('owner')} = ${lit(owner)}`
                  );
                }
              } finally {
                closed = true;
                await runner.close?.();
              }
            }),
        };
      } catch (error) {
        if (timer) clearInterval(timer);
        await runner.close?.();
        throw error;
      }
    },
  };
}
