/**
 * How a run snapshot maps to rows. Pure: no SQL and no clock.
 *
 * A command's rows are immutable and form one write. A write names its parent, and its ID is
 * a digest of its parent, revision, operation and content, so repeating a write repeats its
 * ID. The run header names the newest committed write. Walking parents from there gives the
 * committed writes in order. Anything else in the table is an orphan: a write whose header
 * update never committed. Orphans are inert, whatever they contain, so the layout needs no
 * uniqueness constraint and a retried operation can carry a different payload.
 */
import { createHash } from 'node:crypto';
import {
  AgenticStateError,
  type AgenticCheckpointCommand,
  type AgenticRunKey,
  type AgenticRunSnapshot,
} from './state.js';

export const AGENTIC_ROW_KINDS = ['definition', 'input', 'assignment', 'attempt'] as const;
export type AgenticRowKind = (typeof AGENTIC_ROW_KINDS)[number];

/** One logical row: the definition, the input batch, an assignment or an attempt's state. */
export interface AgenticRowItem {
  kind: AgenticRowKind;
  data: string;
}
export interface AgenticRowWrite {
  id: string;
  parent: string;
  revision: number;
  operationId: string;
  items: AgenticRowItem[];
}
/** One stored row. A long item spans several rows of the same write and item. */
export interface AgenticStoredRow {
  write_id: string;
  parent: string;
  revision: number;
  operation_id: string;
  kind: AgenticRowKind;
  item: number;
  part: number;
  parts: number;
  data: string;
}
/** Enough of each stored write to walk the chain without fetching its content. */
export interface AgenticWriteInfo {
  write_id: string;
  parent: string;
  revision: number;
}

const corrupt = (): never => {
  throw new AgenticStateError('corrupt');
};

/** Fields held in their own columns or rows rather than in the header's summary. */
const rowFields = [
  'key',
  'revision',
  'definition',
  'plan_inputs',
  'cursor_values',
  'work',
] as const;

/** The small mutable fields, rewritten with each header update. */
export function agenticRunSummary(snapshot: AgenticRunSnapshot): string {
  const summary: Partial<AgenticRunSnapshot> = { ...snapshot };
  for (const field of rowFields) delete summary[field];
  return JSON.stringify(summary);
}

/** Whether retention may remove this run once it is out of date. Runs still owed recovery
 * stay: a prepared publication needs its receipt reconciled, and a sealed incremental batch
 * has frozen inputs and spend behind its cursor reservation. A preparing run has neither. It
 * may hold a reservation, which takeover can replace once the run is gone. */
export function isAgenticRunReclaimable(snapshot: AgenticRunSnapshot): boolean {
  if (snapshot.superseded || snapshot.status === 'preparing') return true;
  if (snapshot.publication === 'prepared') return false;
  if (snapshot.publication === 'confirmed') {
    return !snapshot.cursor_values || snapshot.cursors_committed === true;
  }
  const { resolved } = snapshot.definition as {
    resolved: { model: { sources: Record<string, { incremental?: unknown }> } };
  };
  return !Object.values(resolved.model.sources).some((source) => source.incremental);
}

const assignmentItems = (work: AgenticRunSnapshot['work']): AgenticRowItem[] =>
  work.map(({ assignment }) => ({ kind: 'assignment', data: JSON.stringify(assignment) }));

function attemptItem(
  snapshot: AgenticRunSnapshot,
  work: number,
  attemptId: string
): AgenticRowItem {
  const state = snapshot.work[work]!;
  const attempt = state.attempts.find((item) => item.id === attemptId)!;
  return {
    kind: 'attempt',
    data: JSON.stringify({ work, attempt, accepted: state.accepted !== undefined }),
  };
}

/** The first write of a run. */
export function agenticCreateItems(snapshot: AgenticRunSnapshot): AgenticRowItem[] {
  return [{ kind: 'definition', data: JSON.stringify(snapshot.definition) }];
}

/**
 * The rows a command adds. Commands missing here change only header fields, so a command
 * that gains rows must be added, or a rebuilt snapshot would lose them. `switch` is
 * exhaustive so that a new command type fails to compile until it is considered.
 */
export function agenticCommandItems(
  after: AgenticRunSnapshot,
  command: AgenticCheckpointCommand,
  workBefore: number
): AgenticRowItem[] {
  switch (command.type) {
    case 'seal_work': {
      const { plan_inputs, cursor_values } = after;
      const input =
        plan_inputs || cursor_values
          ? [{ kind: 'input' as const, data: JSON.stringify({ plan_inputs, cursor_values }) }]
          : [];
      return [...input, ...assignmentItems(after.work)];
    }
    case 'append_step':
      return assignmentItems(after.work.slice(workBefore));
    case 'start_attempt':
    case 'finish_attempt':
      return [attemptItem(after, command.work, command.attempt_id)];
    case 'supersede':
    case 'begin_execution':
    case 'prepare_publication':
    case 'confirm_publication':
    case 'confirm_cursors':
    case 'complete':
      return [];
  }
}

/**
 * Applies commands in order with `apply` and returns the state they produce, with the writes that
 * store it: one for each command that adds rows, each chained to the one before, exactly as the
 * commands would be stored one at a time. A command that repeats one already saved has no effect
 * and adds no write. A refusal throws before anything is returned.
 */
export function agenticCommandWrites(
  before: { snapshot: AgenticRunSnapshot; head: string },
  commands: readonly AgenticCheckpointCommand[],
  apply: (state: AgenticRunSnapshot, command: AgenticCheckpointCommand) => AgenticRunSnapshot
): { snapshot: AgenticRunSnapshot; writes: AgenticRowWrite[] } {
  let { snapshot, head } = before;
  const writes: AgenticRowWrite[] = [];
  for (const command of commands) {
    const workBefore = snapshot.work.length;
    const next = apply(snapshot, command);
    if (next.revision === snapshot.revision) continue;
    const items = agenticCommandItems(next, command, workBefore);
    if (items.length) {
      const write = createAgenticRowWrite(head, next.revision, command.operation_id, items);
      writes.push(write);
      head = write.id;
    }
    snapshot = next;
  }
  return { snapshot, writes };
}

function digestWrite(
  parent: string,
  revision: number,
  operationId: string,
  items: readonly AgenticRowItem[]
): string {
  const hash = createHash('sha256');
  // Length prefixes keep field boundaries unambiguous.
  const field = (value: string) => hash.update(`${Buffer.byteLength(value)}:`).update(value);
  field(parent);
  field(String(revision));
  field(operationId);
  for (const item of items) {
    field(item.kind);
    field(item.data);
  }
  return hash.digest('hex');
}

export function createAgenticRowWrite(
  parent: string,
  revision: number,
  operationId: string,
  items: AgenticRowItem[]
): AgenticRowWrite {
  return {
    id: digestWrite(parent, revision, operationId, items),
    parent,
    revision,
    operationId,
    items,
  };
}

/** Splits text without separating a surrogate pair, so every part stays valid text. */
export function splitAgenticRowText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + maxChars);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

export function agenticStoredRows(write: AgenticRowWrite, maxChars: number): AgenticStoredRow[] {
  return write.items.flatMap((item, index) => {
    const parts = splitAgenticRowText(item.data, maxChars);
    return parts.map((data, part) => ({
      write_id: write.id,
      parent: write.parent,
      revision: write.revision,
      operation_id: write.operationId,
      kind: item.kind,
      item: index,
      part,
      parts: parts.length,
      data,
    }));
  });
}

/** Separates the committed writes reachable from `head` from everything else. */
export function walkAgenticWrites(
  infos: readonly AgenticWriteInfo[],
  head: string,
  revision: number
): { committed: Set<string>; orphans: string[] } {
  const byId = new Map(infos.map((info) => [info.write_id, info]));
  // A write's ID covers its parent and revision, so one ID cannot honestly name two of them.
  if (byId.size !== infos.length) return corrupt();
  const committed = new Set<string>();
  let newer = revision + 1;
  for (let id = head; id !== ''; ) {
    const info = byId.get(id);
    if (!info || committed.has(id) || info.revision >= newer) return corrupt();
    committed.add(id);
    newer = info.revision;
    id = info.parent;
  }
  return { committed, orphans: [...byId.keys()].filter((id) => !committed.has(id)) };
}

/**
 * Reassembles the committed writes, oldest first, and verifies each against its digest.
 * Identical repeats of a row are tolerated: a retried write has the same ID and content,
 * and engines that enforce no key can hold it twice.
 */
export function assembleAgenticWrites(
  rows: readonly AgenticStoredRow[],
  committed: ReadonlySet<string>
): AgenticRowWrite[] {
  const parts = new Map<string, Map<number, Map<number, AgenticStoredRow>>>();
  for (const row of rows) {
    if (!committed.has(row.write_id)) continue;
    let items = parts.get(row.write_id);
    if (!items) parts.set(row.write_id, (items = new Map()));
    let item = items.get(row.item);
    if (!item) items.set(row.item, (item = new Map()));
    const seen = item.get(row.part);
    if (seen && seen.data !== row.data) corrupt();
    item.set(row.part, row);
  }
  const writes = [...committed].map((id) => {
    const items = parts.get(id);
    if (!items) return corrupt();
    const first = items.get(0)?.get(0);
    if (!first) return corrupt();
    const assembled = Array.from({ length: items.size }, (_, index): AgenticRowItem => {
      const item = items.get(index);
      const head = item?.get(0);
      if (!item || !head || !AGENTIC_ROW_KINDS.includes(head.kind) || item.size !== head.parts) {
        return corrupt();
      }
      const text = Array.from({ length: head.parts }, (__, part) => {
        const row = item.get(part);
        if (!row || row.kind !== head.kind || row.parts !== head.parts) return corrupt();
        return row.data;
      });
      return { kind: head.kind, data: text.join('') };
    });
    const write = createAgenticRowWrite(
      first.parent,
      first.revision,
      first.operation_id,
      assembled
    );
    return write.id === id ? write : corrupt();
  });
  return writes.reverse();
}

/** The snapshot described by the header and its committed writes, oldest first. Unvalidated. */
export function rebuildAgenticSnapshot(
  header: { key: AgenticRunKey; revision: number; summary: string },
  writes: readonly AgenticRowWrite[]
): unknown {
  const snapshot = {
    ...(JSON.parse(header.summary) as Record<string, unknown>),
    key: header.key,
    revision: header.revision,
  } as Partial<AgenticRunSnapshot>;
  const work: AgenticRunSnapshot['work'] = [];
  for (const write of writes) {
    for (const { kind, data } of write.items) {
      const value = JSON.parse(data);
      if (kind === 'definition') {
        snapshot.definition = value;
      } else if (kind === 'input') {
        if (value.plan_inputs !== undefined) snapshot.plan_inputs = value.plan_inputs;
        if (value.cursor_values !== undefined) snapshot.cursor_values = value.cursor_values;
      } else if (kind === 'assignment') {
        work.push({ assignment: value, attempts: [] });
      } else {
        const target = work[value.work as number];
        if (!target) return corrupt();
        const index = target.attempts.findIndex((attempt) => attempt.id === value.attempt.id);
        if (index === -1) target.attempts.push(value.attempt);
        else target.attempts[index] = value.attempt;
        if (value.accepted) target.accepted = value.attempt.outcome;
      }
    }
  }
  snapshot.work = work;
  return snapshot;
}
