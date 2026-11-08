/** Reading and writing a run's immutable rows. Knows nothing of ownership. */
import { randomUUID } from 'node:crypto';
import type { SqlParamValue } from '@bobsled-inc/connections';
import { AGENTIC_MAX_CHECKPOINT_BYTES } from './checkpoint-json.js';
import type { AgenticRowDb, AgenticRowDialect } from './row-state-dialect.js';
import {
  agenticStoredRows,
  assembleAgenticWrites,
  walkAgenticWrites,
  type AgenticRowKind,
  type AgenticRowWrite,
  type AgenticStoredRow,
} from './row-state-layout.js';
import { AGENTIC_MAX_ROWS } from './rows.js';
import { agenticRowColumns, agenticStatement } from './row-state-tables.js';
import { AgenticStateError } from './state.js';

// Bounds on what one run may hold, derived from the caps so that they rise together. A snapshot's
// rows hold it about once, plus the start rows of finished attempts. An assignment has up to two
// writes per attempt, a long value takes several rows, and orphans come on top.
const maxStoredChars = 4 * AGENTIC_MAX_CHECKPOINT_BYTES;
const maxStoredWrites = 64 * AGENTIC_MAX_ROWS + 1024;
const maxStoredRows = 2 * maxStoredWrites;
/** Write IDs named in one statement: few enough for any engine, and a long run takes two. */
const maxIdsPerStatement = 1024;
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

function idBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += maxIdsPerStatement) {
    batches.push(ids.slice(start, start + maxIdsPerStatement));
  }
  return batches;
}

/**
 * The header columns one load needs. A text value past the snapshot cap comes back as null, so
 * a stored value is never fetched whole before anything can reject it. No value `save` wrote is
 * that long: each is part of a snapshot within the cap.
 */
export function agenticHeaderColumns(dialect: AgenticRowDialect): string {
  const q = dialect.identifier;
  const capped = ['head', 'token', 'summary', 'scope', 'model', 'run_id'].map(
    (name) =>
      `CASE WHEN LENGTH(${q(name)}) <= ${AGENTIC_MAX_CHECKPOINT_BYTES} THEN ${q(name)} END AS ${q(name)}`
  );
  return [q('layout'), q('revision'), ...capped].join(', ');
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
 * Everything is by run ID, so it touches only the runs it removes. One statement looks in every
 * header table, so that no table depends on a run happening to land in it, and the usual case
 * of nothing due stays one statement however many tables there are.
 */
export async function purgeExpiredAgenticRuns(
  { db, dialect, table, hash }: AgenticRunRows,
  headers: readonly string[],
  leaseMs: number
): Promise<void> {
  const q = dialect.identifier;
  const { clock } = dialect;
  const id = q('run_hash');
  const expired = (statement: ReturnType<typeof agenticStatement>): string =>
    `${q('retain_until')} <= ${clock} AND ${q('reclaimable')} AND ${q('lease_expires')} <= ${clock} AND ${id} <> ${statement.bind(hash)}`;
  const find = agenticStatement(dialect);
  const sources = headers.map(
    (header, index) =>
      `SELECT ${index} AS ${q('source')}, ${id} FROM ${header} WHERE ${expired(find)}`
  );
  const due = await db.query(`${sources.join(' UNION ALL ')} LIMIT ${maxPurgedRuns}`, find.params);
  for (const [index, header] of headers.entries()) {
    const runs = due.filter((row) => Number(row.source) === index);
    if (!runs.length) continue;
    const owner = randomUUID();
    const claim = agenticStatement(dialect);
    const set = [
      `${q('lease_owner')} = ${claim.bind(owner)}`,
      `${q('lease_expires')} = ${clock} + ${claim.bind(leaseMs)}`,
      `${q('revision')} = -1`,
      `${q('head')} = ''`,
      `${q('summary')} = ''`,
    ].join(', ');
    const candidates = runs.map((row) => claim.bind(String(row.run_hash))).join(', ');
    await dialect.changed(
      db,
      `UPDATE ${header} SET ${set} WHERE ${id} IN (${candidates}) AND ${expired(claim)}`,
      claim.params
    );
    const mine = `${q('lease_owner')} = ${dialect.bind(1)}`;
    const claimed = await db.query(`SELECT ${id} FROM ${header} WHERE ${mine}`, [owner]);
    if (!claimed.length) continue;
    const remove = agenticStatement(dialect);
    const ids = claimed.map((row) => remove.bind(String(row.run_hash))).join(', ');
    await db.query(`DELETE FROM ${table} WHERE ${id} IN (${ids})`, remove.params);
    await db.query(`DELETE FROM ${header} WHERE ${mine}`, [owner]);
  }
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
  const ids = (batch: readonly string[]): string =>
    `${q('write_id')} IN (${batch.map((_, index) => dialect.bind(index + 2)).join(', ')})`;
  const tooMuch = (): AgenticStateError =>
    new AgenticStateError('limit', {
      reason: 'stored_rows_exceeded',
      message: 'This run holds more stored data than a checkpoint can contain.',
      hint: 'Stop all writers and inspect the run rows.',
    });
  // First, and over every stored row, so nothing below reads more than these bounds allow.
  const text = ['write_id', 'parent', 'operation_id', 'kind', 'data']
    .map((name) => `COALESCE(LENGTH(${q(name)}), 0)`)
    .join(' + ');
  const [total] = await db.query(
    `SELECT COUNT(*) AS ${q('stored_rows')}, SUM(${text}) AS ${q('stored_chars')} FROM ${table} WHERE ${where}`,
    [hash]
  );
  if (Number(total?.stored_rows) > maxStoredRows || Number(total?.stored_chars) > maxStoredChars) {
    throw tooMuch();
  }
  const writeColumns = `${q('write_id')}, ${q('parent')}, ${q('revision')}`;
  const infos = await db.query(
    `SELECT ${writeColumns} FROM ${table} WHERE ${where} GROUP BY ${writeColumns} LIMIT ${maxStoredWrites + 1}`,
    [hash]
  );
  if (infos.length > maxStoredWrites) throw tooMuch();
  const { committed, orphans } = walkAgenticWrites(
    infos.map((info) => ({
      write_id: String(info.write_id),
      parent: String(info.parent),
      revision: Number(info.revision),
    })),
    head,
    revision
  );
  if (sweepOrphans) {
    for (const batch of idBatches(orphans)) {
      await db.query(`DELETE FROM ${table} WHERE ${where} AND ${ids(batch)}`, [hash, ...batch]);
    }
  }
  const stored: AgenticStoredRow[] = [];
  for (const batch of idBatches([...committed])) {
    const rows = await db.query(
      `SELECT ${insertColumns.slice(1).map(q).join(', ')} FROM ${table} WHERE ${where} AND ${ids(batch)}`,
      [hash, ...batch]
    );
    for (const row of rows) stored.push(storedRow(row));
  }
  return assembleAgenticWrites(stored, committed);
}
