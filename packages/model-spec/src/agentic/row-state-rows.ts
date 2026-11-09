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
import { AgenticStateError, type AgenticRunKey } from './state.js';
import type { AgenticStoreLimits } from './store-limits.js';

/**
 * Bounds on what one run may hold, derived from the limits of the store that holds it, so that
 * they rise together. A snapshot's rows hold it about once, plus the start rows of finished
 * attempts. An assignment has up to two writes per attempt, a long value takes several rows, and
 * orphans come on top.
 */
export function agenticStoredBounds(limits: AgenticStoreLimits) {
  const writes = 64 * limits.maxRows + 1024;
  return { chars: 4 * limits.maxCheckpointBytes, writes, rows: 2 * writes };
}
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

/** Scope, model and run ID are identities of at most 1,024 characters, and head and token are
 * a digest and a UUID, so no value `save` wrote in those columns is longer. */
const maxHeaderIdentityChars = 1024;

/**
 * The header columns one load needs. A text value past its cap comes back as null, so a stored
 * value is never fetched whole before anything can reject it. The summary is part of a snapshot
 * within the store's cap, and every other text column is an identity.
 */
export function agenticHeaderColumns(
  dialect: AgenticRowDialect,
  limits: AgenticStoreLimits
): string {
  const q = dialect.identifier;
  const capped = (name: string, cap: number) =>
    `CASE WHEN LENGTH(${q(name)}) <= ${cap} THEN ${q(name)} END AS ${q(name)}`;
  return [
    q('layout'),
    q('revision'),
    ...['head', 'token', 'scope', 'model', 'run_id'].map((name) =>
      capped(name, maxHeaderIdentityChars)
    ),
    capped('summary', limits.maxCheckpointBytes),
  ].join(', ');
}

/** The header that `agenticHeaderColumns` read, when it is the one header of `key` in `layout`. */
export function agenticRunHeaderOf(
  headers: Record<string, unknown>[],
  key: AgenticRunKey,
  layout: number
): { revision: number; head: string; token: string; summary: string } {
  const header = headers[0]!;
  if (
    headers.length !== 1 ||
    Number(header.layout) !== layout ||
    header.scope !== key.scope ||
    header.model !== key.model ||
    header.run_id !== key.id ||
    typeof header.summary !== 'string' ||
    typeof header.head !== 'string' ||
    typeof header.token !== 'string'
  ) {
    throw new AgenticStateError('corrupt');
  }
  const { head, token, summary } = header;
  return { revision: Number(header.revision), head, token, summary };
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
  stored: AgenticRunRows,
  write: AgenticRowWrite,
  beforeBatch: () => Promise<void>
): Promise<void> {
  await insertAgenticWrites(stored, [write], beforeBatch);
}

/** Inserts writes in as few statements as the dialect's bounds allow. Each row names its own
 * write, so writes that share a statement stay separate, and they commit only with the header. */
export async function insertAgenticWrites(
  stored: AgenticRunRows,
  writes: readonly AgenticRowWrite[],
  beforeBatch: () => Promise<void>
): Promise<void> {
  const rows = writes.flatMap((write) => agenticStoredRows(write, stored.dialect.maxRowChars));
  await insertAgenticRows(stored, rows, beforeBatch);
}

/** Inserts rows in as few statements as the dialect's bounds allow. Test fixtures write a large
 * run's rows through this in bulk. */
export async function insertAgenticRows(
  { db, dialect, table, hash }: AgenticRunRows,
  rows: AgenticStoredRow[],
  beforeBatch: () => Promise<void>
): Promise<void> {
  for (const batch of insertBatches(rows, dialect)) {
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
 * a reply this session lost might still commit. `limits` is what the store holds, which bounds
 * what this reads. `beforeStatement` runs before each statement after the first two, so a long
 * read can stop or extend its lease.
 */
export async function readAgenticWrites(
  { db, dialect, table, hash }: AgenticRunRows,
  head: string,
  revision: number,
  sweepOrphans: boolean,
  limits: AgenticStoreLimits,
  beforeStatement: () => Promise<void> = async () => {}
): Promise<AgenticRowWrite[]> {
  const bounds = agenticStoredBounds(limits);
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
  if (Number(total?.stored_rows) > bounds.rows || Number(total?.stored_chars) > bounds.chars) {
    throw tooMuch();
  }
  const writeColumns = `${q('write_id')}, ${q('parent')}, ${q('revision')}`;
  const infos = await db.query(
    `SELECT ${writeColumns} FROM ${table} WHERE ${where} GROUP BY ${writeColumns} LIMIT ${bounds.writes + 1}`,
    [hash]
  );
  if (infos.length > bounds.writes) throw tooMuch();
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
      await beforeStatement();
      await db.query(`DELETE FROM ${table} WHERE ${where} AND ${ids(batch)}`, [hash, ...batch]);
    }
  }
  // Rows can arrive after the count, so each batch is held to what the bounds have left: the
  // engine sums the batch's text before it sends any, and returns rows only when that fits.
  const columns = insertColumns.slice(1).map(q).join(', ');
  const batchChars = q('batch_chars');
  const stored: AgenticStoredRow[] = [];
  let chars = 0;
  for (const batch of idBatches([...committed])) {
    await beforeStatement();
    const left = { rows: bounds.rows - stored.length, chars: bounds.chars - chars };
    const fetched = `SELECT *, SUM(${text}) OVER () AS ${batchChars} FROM ${table} WHERE ${where} AND ${ids(batch)}`;
    const rows = await db.query(
      `SELECT ${columns}, ${batchChars} FROM (${fetched}) AS ${q('batch')} WHERE ${batchChars} <= ${left.chars} LIMIT ${left.rows + 1}`,
      [hash, ...batch]
    );
    // Every write on the chain has rows, so a batch that returns none holds more than is left.
    if (!rows.length || rows.length > left.rows) throw tooMuch();
    chars += Number(rows[0]!.batch_chars);
    for (const row of rows) stored.push(storedRow(row));
  }
  return assembleAgenticWrites(stored, committed);
}
