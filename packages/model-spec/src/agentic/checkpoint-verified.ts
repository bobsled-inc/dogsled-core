import { attemptsAreConsistent, preparationRevisionOf, workMatchesRun } from './checkpoint-work.js';
import {
  AGENTIC_MAX_CHECKPOINT_BYTES,
  AGENTIC_MAX_CHECKPOINT_VALUES,
  measureCheckpoint,
  type CheckpointMeasure,
} from './checkpoint-json.js';
import { isExactJson } from './json-equal.js';
import {
  AgenticCheckpointCommandSchema,
  AgenticTokensSchema,
  AgenticWorkProgressSchema,
  applyParsedCommand,
  isOverchargedAttempt,
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

function latestTimeOf(run: AgenticRunSnapshot): number {
  const times = [
    ...(run.execution_windows ?? []).map((window) => window.started_at),
    ...Object.values(run.plan_inputs ?? {}).map((input) => input.retrieved_at),
    ...run.work.flatMap((work) => work.attempts.flatMap((attempt) => attempt.finished_at ?? [])),
  ];
  return times.reduce((latest, time) => Math.max(latest, Date.parse(time)), -Infinity);
}

/**
 * Registers a private frozen copy of AgenticRunSnapshotSchema output. A value whose JSON is not
 * what the schema read, such as one with a hidden toJSON, cannot be vouched for, so it is
 * returned as it came and stays on the complete path.
 */
export function verifiedCheckpoint(snapshot: AgenticRunSnapshot): AgenticRunSnapshot {
  if (verified.has(snapshot)) return snapshot;
  const copy = jsonCopy(snapshot);
  const size = measureCheckpoint(copy);
  if (!size || !isExactJson(copy, snapshot)) return snapshot;
  const holders = new Map<string, number[]>();
  copy.work.forEach((work, index) => {
    for (const attempt of work.attempts) holders.set(attempt.id, [index]);
  });
  deepFreeze(copy);
  verified.set(copy, {
    ...size,
    jsonBytes: jsonBytes(copy),
    overcharged: copy.work.some((work) => work.attempts.some(isOverchargedAttempt)),
    latestTime: latestTimeOf(copy),
    holders,
  });
  return copy;
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
  facts: VerifiedFacts
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
    values > AGENTIC_MAX_CHECKPOINT_VALUES ||
    textBytes > AGENTIC_MAX_CHECKPOINT_BYTES ||
    bytes > AGENTIC_MAX_CHECKPOINT_BYTES
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

/**
 * Applies a start or finish of an attempt to a verified snapshot without reading the rest of the
 * run. Returns undefined when it cannot prove the result: another command, an unverified
 * snapshot, a command the transition refuses, or a result it cannot show to be valid.
 */
export function advanceVerifiedCheckpoint(
  value: unknown,
  input: AgenticCheckpointCommand,
  now: number
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
    const proved = proveChange(value, next, command.work, facts);
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
