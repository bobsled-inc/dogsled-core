/** Reading and writing a run's immutable rows. Knows nothing of ownership. */
import { randomUUID } from 'node:crypto';
import type { SqlParamValue } from '@bobsled-inc/connections';
import type { AgenticRowDb, AgenticRowDialect } from './row-state-dialect.js';
import {
  agenticStoredRows,
  assembleAgenticWrites,
  walkAgenticWrites,
  type AgenticRowKind,
  type AgenticRowWrite,
  type AgenticStoredRow,
} from './row-state-layout.js';
import { agenticRowColumns, agenticStatement } from './row-state-tables.js';
import { AgenticStateError } from './state.js';

// Bounds on what one load reads. A snapshot is at most 16 MiB; its rows hold it about once,
// plus the start rows of finished attempts.
const maxStoredChars = 64 * 1024 * 1024;
const maxStoredWrites = 65_536;
/** Expired runs removed per acquisition, so a backlog cannot delay a run. */
const maxPurgedRuns = 64;
const insertColumns = agenticRowColumns.map((column) => column.name);

function insertBatches(rows: AgenticStoredRow[], dialect: AgenticRowDialect) {
  const batches: AgenticStoredRow[][] = [];
  let batch: AgenticStoredRow[] = [];
  let chars = 0;
  for (const row of rows) {
    if (
      batch.length &&
      (batch.length >= dialect.maxInsertRows || chars + row.data.length > dialect.maxInsertChars)
    ) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(row);
    chars += row.data.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function storedRow(row: Record<string, unknown>): AgenticStoredRow {
  return {
    write_id: String(row.write_id),
    parent: String(row.parent),
    revision: Number(row.revision),
    operation_id: String(row.operation_id),
    kind: row.kind as AgenticRowKind,
    item: Number(row.item),
    part: Number(row.part),
    parts: Number(row.parts),
    data: String(row.data),
  };
}

export interface AgenticRunRows {
  db: AgenticRowDb;
  dialect: AgenticRowDialect;
  /** Quoted name of the rows table. */
  table: string;
  hash: string;
}

/**
 * Removes runs past their retention date, other than the one being opened. The purge takes
 * each run as an owner would, so a resume cannot start while its rows are being deleted. If
 * it stops partway, its lease ends, the header is still expired, and a later purge finishes.
 * Everything is by run ID, so it touches only the runs it removes.
 */
export async function purgeExpiredAgenticRuns(
  { db, dialect, table, hash }: AgenticRunRows,
  runs: string,
  leaseMs: number
): Promise<void> {
  const q = dialect.identifier;
  const { clock } = dialect;
  const id = q('run_hash');
  const expired = (statement: ReturnType<typeof agenticStatement>): string =>
    `${q('retain_until')} <= ${clock} AND ${q('reclaimable')} AND ${q('lease_expires')} <= ${clock} AND ${id} <> ${statement.bind(hash)}`;
  const find = agenticStatement(dialect);
  const due = await db.query(
    `SELECT ${id} FROM ${runs} WHERE ${expired(find)} LIMIT ${maxPurgedRuns}`,
    find.params
  );
  if (!due.length) return;
  const owner = randomUUID();
  const claim = agenticStatement(dialect);
  const set = `${q('lease_owner')} = ${claim.bind(owner)}, ${q('lease_expires')} = ${clock} + ${claim.bind(leaseMs)}`;
  const candidates = due.map((row) => claim.bind(String(row.run_hash))).join(', ');
  await dialect.changed(
    db,
    `UPDATE ${runs} SET ${set} WHERE ${id} IN (${candidates}) AND ${expired(claim)}`,
    claim.params
  );
  const mine = `${q('lease_owner')} = ${dialect.bind(1)}`;
  const claimed = await db.query(`SELECT ${id} FROM ${runs} WHERE ${mine}`, [owner]);
  if (!claimed.length) return;
  const remove = agenticStatement(dialect);
  const ids = claimed.map((row) => remove.bind(String(row.run_hash))).join(', ');
  await db.query(`DELETE FROM ${table} WHERE ${id} IN (${ids})`, remove.params);
  await db.query(`DELETE FROM ${runs} WHERE ${mine}`, [owner]);
}

/** Inserts one write. `beforeBatch` runs before each statement, so a long write can stop or
 * extend its lease. */
export async function insertAgenticWrite(
  { db, dialect, table, hash }: AgenticRunRows,
  write: AgenticRowWrite,
  beforeBatch: () => Promise<void>
): Promise<void> {
  for (const batch of insertBatches(agenticStoredRows(write, dialect.maxRowChars), dialect)) {
    await beforeBatch();
    const params: SqlParamValue[] = batch.flatMap((row) => [
      hash,
      row.write_id,
      row.parent,
      row.revision,
      row.operation_id,
      row.kind,
      row.item,
      row.part,
      row.parts,
      row.data,
    ]);
    await db.query(dialect.insertRows(table, insertColumns, batch.length), params);
  }
}

/**
 * The committed writes reachable from `head`, oldest first. Only a new owner may set
 * `sweepOrphans`: by then no earlier writer's header update can still land, whereas later
 * a reply this session lost might still commit.
 */
export async function readAgenticWrites(
  { db, dialect, table, hash }: AgenticRunRows,
  head: string,
  revision: number,
  sweepOrphans: boolean
): Promise<AgenticRowWrite[]> {
  const q = dialect.identifier;
  const where = `${q('run_hash')} = ${dialect.bind(1)}`;
  const writeColumns = `${q('write_id')}, ${q('parent')}, ${q('revision')}`;
  const infos = await db.query(
    `SELECT ${writeColumns}, SUM(LENGTH(${q('data')})) AS ${q('chars')} FROM ${table} WHERE ${where} GROUP BY ${writeColumns} LIMIT ${maxStoredWrites + 1}`,
    [hash]
  );
  const tooMuch = (): AgenticStateError =>
    new AgenticStateError('limit', {
      reason: 'stored_rows_exceeded',
      message: 'This run holds more stored data than a checkpoint can contain.',
      hint: 'Stop all writers and inspect the run rows.',
    });
  if (infos.length > maxStoredWrites) throw tooMuch();
  const { committed, orphans, chars } = walkAgenticWrites(
    infos.map((info) => ({
      write_id: String(info.write_id),
      parent: String(info.parent),
      revision: Number(info.revision),
      chars: Number(info.chars),
    })),
    head,
    revision
  );
  if (chars > maxStoredChars) throw tooMuch();
  if (sweepOrphans) {
    for (let start = 0; start < orphans.length; start += 256) {
      const ids = orphans.slice(start, start + 256);
      await db.query(
        `DELETE FROM ${table} WHERE ${where} AND ${q('write_id')} IN (${ids.map((_, index) => dialect.bind(index + 2)).join(', ')})`,
        [hash, ...ids]
      );
    }
  }
  const stored = await db.query(
    `SELECT ${insertColumns.slice(1).map(q).join(', ')} FROM ${table} WHERE ${where}`,
    [hash]
  );
  return assembleAgenticWrites(stored.map(storedRow), committed);
}
