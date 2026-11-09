import { attemptsAreConsistent, preparationRevisionOf, workMatchesRun } from './checkpoint-work.js';
import { measureCheckpoint, type CheckpointMeasure } from './checkpoint-json.js';
import { isExactJson } from './json-equal.js';
import { AgenticStateError } from './state-errors.js';
import {
  AGENTIC_DEFAULT_STORE_LIMITS,
  agenticSizeLimitError,
  type AgenticCheckpointSize,
  type AgenticStoreLimits,
} from './store-limits.js';
import {
  AgenticCheckpointCommandSchema,
  AgenticRunSnapshotSchema,
  AgenticTokensSchema,
  AgenticWorkProgressSchema,
  applyParsedCommand,
  isOverchargedAttempt,
  transitionAgenticCheckpoint,
  type AgenticCheckpointCommand,
  type AgenticRunLookups,
  type AgenticRunSnapshot,
} from './state.js';

type Work = AgenticRunSnapshot['work'][number];

/**
 * A verified snapshot has passed AgenticRunSnapshotSchema, directly or by a chain of proved
 * commands from one that did, and is deeply frozen, so only the clock can invalidate it. That is
 * what lets a start or finish of an attempt check only what it changed: everything else is the
 * same frozen object as in its predecessor. A failed proof decides nothing. The caller takes the
 * complete path, which accepts or reports the error exactly as it would without this module.
 */
interface VerifiedFacts extends CheckpointMeasure {
  jsonBytes: number;
  overcharged: boolean;
  /** The newest saved time the schema compares with the clock. */
  latestTime: number;
  /**
   * Which work items hold each attempt ID, over every state descended from one verified root.
   * Only ever added to, so a sibling state's entry can be present here: `hasAttempt` confirms an
   * entry against the snapshot it is asked about. A state's own attempts are always listed.
   */
  holders: Map<string, number[]>;
}

const verified = new WeakMap<object, VerifiedFacts>();

const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Stops at frozen values, so everything reachable must be verified state or a private copy. */
function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

/** A state with a time ahead of the clock fails the schema, so it stops being verified too. */
export function isVerifiedCheckpoint(value: unknown): value is AgenticRunSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const facts = verified.get(value);
  return facts !== undefined && facts.latestTime <= Date.now();
}

/** The snapshot's size as JSON. A verified snapshot already knows it, so nothing is read. */
export function checkpointJsonBytes(snapshot: AgenticRunSnapshot): number {
  return verified.get(snapshot)?.jsonBytes ?? jsonBytes(snapshot);
}

/** The most rows in any one frozen input: at most 256 inputs, so this reads no rows. */
const inputRowsOf = (run: AgenticRunSnapshot): number =>
  Object.values(run.plan_inputs ?? {}).reduce(
    (most, input) => Math.max(most, input.rows.length),
    0
  );

/**
 * Why `snapshot` does not fit what a store holds, as the `limit` error the store should report,
 * or undefined when it does. For a store that validates with AgenticRunSnapshotSchema alone, which
 * accepts what the largest store holds. A verified snapshot knows its size, so this reads nothing
 * of it. Anything else is measured, and a value the measure refuses does not fit.
 */
export function agenticCheckpointLimitError(
  snapshot: AgenticRunSnapshot,
  limits: AgenticStoreLimits = AGENTIC_DEFAULT_STORE_LIMITS
): AgenticStateError | undefined {
  const facts = verified.get(snapshot);
  const size = facts ?? measureCheckpoint(snapshot);
  const json = facts ? facts.jsonBytes : size ? jsonBytes(snapshot) : Infinity;
  return agenticSizeLimitError(
    {
      work: snapshot.work.length,
      inputRows: inputRowsOf(snapshot),
      values: size?.values ?? Infinity,
      textBytes: size?.textBytes ?? Infinity,
      jsonBytes: json,
    },
    limits
  );
}

/** Assignments and the most rows in one input of plain JSON that no schema has read yet. */
function countsOf(json: unknown): Pick<AgenticCheckpointSize, 'work' | 'inputRows'> {
  const run = (typeof json === 'object' && json !== null ? json : {}) as {
    work?: unknown;
    plan_inputs?: unknown;
  };
  let inputRows = 0;
  if (typeof run.plan_inputs === 'object' && run.plan_inputs !== null) {
    for (const input of Object.values(run.plan_inputs)) {
      const rows = (input as { rows?: unknown } | null)?.rows;
      if (Array.isArray(rows)) inputRows = Math.max(inputRows, rows.length);
    }
  }
  return { work: Array.isArray(run.work) ? run.work.length : 0, inputRows };
}

function latestTimeOf(run: AgenticRunSnapshot): number {
  const times = [
    ...(run.execution_windows ?? []).map((window) => window.started_at),
    ...Object.values(run.plan_inputs ?? {}).map((input) => input.retrieved_at),
    ...run.work.flatMap((work) => work.attempts.flatMap((attempt) => attempt.finished_at ?? [])),
  ];
  return times.reduce((latest, time) => Math.max(latest, Date.parse(time)), -Infinity);
}

type SnapshotParse = ReturnType<typeof AgenticRunSnapshotSchema.safeParse>;

/**
 * Validates `value` and, when it can, returns it as verified state: a private frozen copy that is
 * itself what the schema read, so nothing in it went unvalidated. A value whose JSON is not what a
 * reader of it sees, such as one with a hidden toJSON, cannot be vouched for. It gets the schema's
 * verdict on the value itself and stays unverified, so the complete path keeps handling it.
 */
export function safeParseVerifiedCheckpoint(value: unknown): SnapshotParse {
  return verify(value) as SnapshotParse;
}

/**
 * As parseVerifiedCheckpoint, for a value that must also fit `limits`: one that does not is
 * AgenticStateError('corrupt'). Its size is checked against `limits` before any schema reads it,
 * with the measure that bounds the parse and the plain copy the parse reads, so a run larger than
 * the store holds is never validated.
 */
export function parseVerifiedCheckpointWithin(
  value: unknown,
  limits: AgenticStoreLimits
): AgenticRunSnapshot {
  const parsed = verify(value, limits);
  if (parsed === 'too_large') throw new AgenticStateError('corrupt');
  if (!parsed.success) throw parsed.error;
  if (agenticCheckpointLimitError(parsed.data, limits)) throw new AgenticStateError('corrupt');
  return parsed.data;
}

function verify(value: unknown, limits?: AgenticStoreLimits): SnapshotParse | 'too_large' {
  if (isVerifiedCheckpoint(value)) return { success: true, data: value };
  // Measured first: it bounds the value and refuses what JSON.stringify would throw on.
  const size = measureCheckpoint(value);
  const text = size && JSON.stringify(value);
  const copy: unknown = text && JSON.parse(text);
  if (!size || !text || !isExactJson(copy, value)) {
    return AgenticRunSnapshotSchema.safeParse(value);
  }
  const measured = { ...size, ...countsOf(copy), jsonBytes: Buffer.byteLength(text) };
  if (limits && agenticSizeLimitError(measured, limits)) return 'too_large';
  const parsed = AgenticRunSnapshotSchema.safeParse(copy);
  if (!parsed.success) return parsed;
  const snapshot = parsed.data;
  const holders = new Map<string, number[]>();
  snapshot.work.forEach((work, index) => {
    for (const attempt of work.attempts) holders.set(attempt.id, [index]);
  });
  deepFreeze(snapshot);
  verified.set(snapshot, {
    ...size,
    jsonBytes: measured.jsonBytes,
    overcharged: snapshot.work.some((work) => work.attempts.some(isOverchargedAttempt)),
    latestTime: latestTimeOf(snapshot),
    holders,
  });
  return parsed;
}

/** As safeParseVerifiedCheckpoint, throwing what AgenticRunSnapshotSchema.parse would throw. */
export function parseVerifiedCheckpoint(value: unknown): AgenticRunSnapshot {
  const parsed = safeParseVerifiedCheckpoint(value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

function lookups(run: AgenticRunSnapshot, facts: VerifiedFacts): AgenticRunLookups {
  return {
    hasOvercharge: () => facts.overcharged,
    hasAttempt: (attemptId) =>
      (facts.holders.get(attemptId) ?? []).some((index) =>
        run.work[index]?.attempts.some((attempt) => attempt.id === attemptId)
      ),
  };
}

const chargeOf = (work: Work): number => work.attempts.reduce((sum, item) => sum + item.charge, 0);
const microusdOf = (work: Work): number =>
  work.attempts.reduce((sum, item) => sum + (item.charge_microusd ?? 0), 0);
/** The only run fields an attempt changes. All of them are checked in proveChange. */
const attemptFields = new Set(['revision', 'charged', 'charged_microusd', 'work']);
const counterDigits = (run: AgenticRunSnapshot): number =>
  `${run.revision}${run.charged}${run.charged_microusd ?? ''}`.length;

function changedOnlyAttemptFields(run: AgenticRunSnapshot, next: AgenticRunSnapshot): boolean {
  const before = run as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  const keys = Object.keys(after);
  return (
    keys.length === Object.keys(before).length &&
    keys.every((key) => attemptFields.has(key) || after[key] === before[key])
  );
}

/**
 * Proves that `next`, which the transition could change only at `index`, passes the snapshot
 * schema, and returns its facts. The whole-snapshot rules left unchecked here cannot be broken by
 * such a change: see "Why a proved command is valid" in docs/agentic-state.md.
 */
function proveChange(
  run: AgenticRunSnapshot,
  next: AgenticRunSnapshot,
  index: number,
  facts: VerifiedFacts,
  limits: AgenticStoreLimits
): VerifiedFacts | undefined {
  const before = run.work[index]!;
  const work = next.work[index]!;
  const { assignment, ...progress } = work;
  if (
    !changedOnlyAttemptFields(run, next) ||
    assignment !== before.assignment ||
    next.revision !== run.revision + 1 ||
    !AgenticTokensSchema.safeParse(next.charged).success ||
    (next.charged_microusd !== undefined &&
      !AgenticTokensSchema.safeParse(next.charged_microusd).success) ||
    next.charged - run.charged !== chargeOf(work) - chargeOf(before) ||
    (next.charged_microusd ?? 0) - (run.charged_microusd ?? 0) !==
      microusdOf(work) - microusdOf(before) ||
    !AgenticWorkProgressSchema.safeParse(progress).success ||
    !workMatchesRun(next, work) ||
    !attemptsAreConsistent(next, work, {
      preparationRevision: preparationRevisionOf(next),
      // All earlier revisions are below this one, and all earlier charges are in `run.charged`.
      chargesBefore: new Map([[run.revision, run.charged]]),
      revisions: new Set(),
      attemptIds: new Set(),
      transitions: 0,
    })
  ) {
    return undefined;
  }
  const old = measureCheckpoint(before);
  const size = measureCheckpoint(work);
  if (!old || !size) return undefined;
  const values = facts.values - old.values + size.values;
  const textBytes = facts.textBytes - old.textBytes + size.textBytes;
  const bytes =
    facts.jsonBytes -
    jsonBytes(before) +
    jsonBytes(work) +
    counterDigits(next) -
    counterDigits(run);
  if (
    agenticSizeLimitError(
      {
        work: next.work.length,
        inputRows: inputRowsOf(next),
        values,
        textBytes,
        jsonBytes: bytes,
      },
      limits
    )
  ) {
    return undefined;
  }
  const finishedAt = work.attempts.at(-1)?.finished_at;
  return {
    values,
    textBytes,
    jsonBytes: bytes,
    overcharged: facts.overcharged || work.attempts.some(isOverchargedAttempt),
    latestTime: finishedAt ? Math.max(facts.latestTime, Date.parse(finishedAt)) : facts.latestTime,
    holders: facts.holders,
  };
}

/** Commands a proof can apply without reading the run. Every other one reads all of it. */
export const isProvableCommand = (command: AgenticCheckpointCommand): boolean =>
  command.type === 'start_attempt' || command.type === 'finish_attempt';

/**
 * Applies a start or finish of an attempt to a verified snapshot without reading the rest of the
 * run. Returns undefined when it cannot prove the result: another command, an unverified
 * snapshot, a command the transition refuses, or a result it cannot show to be valid and within
 * `limits`.
 */
export function advanceVerifiedCheckpoint(
  value: unknown,
  input: AgenticCheckpointCommand,
  now: number,
  limits: AgenticStoreLimits
): AgenticRunSnapshot | undefined {
  if (!isVerifiedCheckpoint(value)) return undefined;
  const facts = verified.get(value)!;
  try {
    if (input.type !== 'start_attempt' && input.type !== 'finish_attempt') return undefined;
    const parsed = AgenticCheckpointCommandSchema.parse(input) as typeof input;
    const current = value.work[parsed.work];
    if (!current) return undefined;
    // Frozen state must not capture the caller's objects, so the command is copied first.
    const command = jsonCopy(parsed);
    if (!isExactJson(command, parsed)) return undefined;
    // Only the run, this work item, its attempt list and its last attempt can be written.
    // Everything else stays frozen, so a transition that reached further would throw.
    const attempts = [...current.attempts];
    if (attempts.length) attempts[attempts.length - 1] = { ...attempts.at(-1)! };
    const work = { ...current, attempts };
    // Spread, not slice(): V8 copies a frozen array about 150 times faster this way.
    const items = [...value.work];
    items[command.work] = work;
    Object.freeze(items);
    const next = { ...value, work: items };
    if (!applyParsedCommand(next, command, now, lookups(value, facts))) return value;
    const proved = proveChange(value, next, command.work, facts, limits);
    if (!proved) return undefined;
    deepFreeze(work);
    Object.freeze(next);
    const holders = proved.holders.get(command.attempt_id) ?? [];
    if (!holders.includes(command.work)) {
      proved.holders.set(command.attempt_id, [...holders, command.work]);
    }
    verified.set(next, proved);
    return next;
  } catch {
    return undefined;
  }
}

/**
 * As applyAgenticCheckpoint, for a store that holds `limits`. A start or finish of an attempt is
 * proved without reading the run. Anything else takes the complete check, which decides and
 * reports. Verified state needs no reading before its transition, so that check reads the run
 * once, in the result.
 */
export function applyAgenticCheckpointWithin(
  value: AgenticRunSnapshot,
  input: AgenticCheckpointCommand,
  now: number,
  limits: AgenticStoreLimits
): AgenticRunSnapshot {
  const advanced = advanceVerifiedCheckpoint(value, input, now, limits);
  if (advanced) return advanced;
  const state = isVerifiedCheckpoint(value)
    ? jsonCopy(value)
    : AgenticRunSnapshotSchema.parse(value);
  transitionAgenticCheckpoint(state, input, now);
  const next = parseVerifiedCheckpoint(state);
  const error = agenticCheckpointLimitError(next, limits);
  if (error) throw error;
  return next;
}
