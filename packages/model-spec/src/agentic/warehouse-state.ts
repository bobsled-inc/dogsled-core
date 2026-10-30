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
  digestAgenticState,
  transitionAgenticCheckpoint,
} from './state.js';
import type { AgenticStateStore, AgenticRunSnapshot } from './state.js';

interface Confirmed {
  id: string;
  json: string;
  digest: string;
}

export type WarehouseCheckpointOptions = ResolveRunnerOptions & {
  schema: string;
  leaseMs?: number;
  signal?: AbortSignal;
};

const maxBytes = 16 * 1024 * 1024;
const chunkSize = 64 * 1024;
// Seven full chunks (448 KiB) and 21 bindings leave ample headroom below
// Snowflake's 1 MB recommendation including bound values. SQL contains only
// names and placeholders; its separate ceiling defensively bounds namespace text.
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
      // The last snapshot this session committed or verified, keyed by its unique pointer ID,
      // as JSON text. It is reused only while the fenced pointer still names it.
      let confirmed: Confirmed | undefined;
      // Local time at which the last successful lease extension was requested.
      let extendedAt = 0;
      const ownership = new AbortController();
      const loseOwnership = () => {
        lost = true;
        confirmed = undefined;
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
        const acquiredAt = Date.now();
        await mutate(
          `${q('owner')} = ${lit(owner)}, ${q('expires')} = ${clock} + ${leaseMs}`,
          `${q('expires')} <= ${clock}`
        );
        extendedAt = acquiredAt;
        const renew = async () => {
          guard();
          const started = Date.now();
          try {
            await mutate(`${q('expires')} = ${clock} + ${leaseMs}`, predicate);
          } catch {
            throwIfCancelled(options.signal);
            throw loseOwnership();
          }
          extendedAt = started;
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
        // Commands may reuse this session's committed snapshot; reads always verify the payload.
        const current = async (reuse: boolean): Promise<Confirmed | null> => {
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
          // Every save writes a new random ID, and another coordinator can change the pointer
          // only after this session's predicate stops matching. The fenced pointer commit of the
          // next save replaces these rows.
          if (reuse && confirmed?.id === id) {
            pointer = id;
            return confirmed;
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
          const text = bytes.toString('utf8');
          // Bytes identical to the JSON this session committed need no second validation.
          if (confirmed?.id === id && text === confirmed.json) {
            pointer = id;
            return confirmed;
          }
          let snapshot: AgenticRunSnapshot;
          try {
            snapshot = AgenticRunSnapshotSchema.parse(JSON.parse(text));
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
          confirmed = { id, json: JSON.stringify(snapshot), digest: id.slice(37) };
          return confirmed;
        };
        // Each caller receives its own copy of the confirmed state.
        const read = async (): Promise<AgenticRunSnapshot | null> => {
          const state = await current(false);
          return state && JSON.parse(state.json);
        };
        const save = async (
          snapshot: AgenticRunSnapshot,
          previous: Confirmed | null,
          validated = false
        ) => {
          guard();
          const value = validated ? snapshot : AgenticRunSnapshotSchema.parse(snapshot);
          if (digestAgenticState(value.key) !== digestAgenticState(key)) {
            throw new AgenticStateError('conflict');
          }
          const json = JSON.stringify(value);
          const bytes = Buffer.from(json);
          if (bytes.byteLength > maxBytes) throw new AgenticStateError('limit');
          const digest = digestAgenticState(value);
          if (previous && digest === previous.digest) return value;
          const id = `${randomUUID()}_${digest}`;
          const oldId = pointer;
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
          for (let start = 0; start < encoded.length; start += chunkSize * chunksPerInsert) {
            guard();
            // Renew only when a third of the lease has elapsed since the last extension
            // started, counting response delays and the retained-size read.
            if (Date.now() - extendedAt >= leaseMs / 3) await renew();
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
          // The queued heartbeat cannot run during save. Leave a fresh lease
          // for the pointer transaction after a slow final staging request.
          if (Date.now() - extendedAt >= leaseMs / 3) await renew();
          guard();
          const committing = Date.now();
          await mutate(
            `${q('snapshot')} = ${lit(id)}, ${q('expires')} = ${clock} + ${leaseMs}`,
            `${predicate} AND ${q('snapshot')} = ${lit(oldId)}`,
            [`DELETE FROM ${payloads} WHERE ${q('snapshot')} <> ${lit(id)}`]
          );
          extendedAt = committing;
          pointer = id;
          // Only a confirmed commit replaces the reusable state. After an uncertain commit,
          // the next read finds the new ID and verifies its payload.
          confirmed = { id, json, digest };
          return value;
        };
        return {
          ownershipLost: ownership.signal,
          read: () => serial(read),
          create: (snapshot) =>
            serial(async () => {
              const previous = await current(false);
              if (previous) throw new AgenticStateError('conflict');
              return save(snapshot, null);
            }),
          checkpoint: (command) =>
            serial(async () => {
              const previous = await current(true);
              if (!previous) throw new AgenticStateError('missing');
              // Transition a copy of the validated state, then validate only the result.
              const next: AgenticRunSnapshot = JSON.parse(previous.json);
              if (!transitionAgenticCheckpoint(next, command, Date.now())) return next;
              return save(AgenticRunSnapshotSchema.parse(next), previous, true);
            }),
          release: () =>
            serial(async () => {
              if (closed) return;
              confirmed = undefined;
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
