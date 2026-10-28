import { z } from 'zod';
import { AgenticStateError } from './state-errors.js';
export const CursorValuesSchema = z
  .record(z.string().min(1).max(256), z.union([z.string().max(128), z.number().finite()]))
  .refine((values) => Object.keys(values).length <= 256);
export type AgenticCursorValues = z.infer<typeof CursorValuesSchema>;
export const AgenticCursorKeySchema = z
  .object({
    scope: z.string().min(1).max(1024),
    model: z.string().min(1).max(1024),
    target: z.string().min(1).max(1024),
  })
  .strict();
export type AgenticCursorKey = z.infer<typeof AgenticCursorKeySchema>;
export const CursorRecordSchema = z
  .object({
    signature: z.string().length(64),
    values: CursorValuesSchema,
    activeRun: z.string().max(1024).nullable(),
    committedRun: z.string().max(1024).nullable(),
  })
  .strict();
export type CursorRecord = z.infer<typeof CursorRecordSchema>;
/** Carries the current owner only inside the coordinator; messages do not expose run IDs. */
export class AgenticCursorConflict extends AgenticStateError {
  constructor(readonly activeRun: string) {
    super('cursor_busy');
  }
}
/** One shared store keyed by model identity. Progress advances only after publication. */
export interface AgenticCursorStore {
  /** Compare-and-swap ownership after the coordinator durably retires the previous run.
   * Optional for older custom stores, which continue to reject takeover. */
  supersede?(
    key: AgenticCursorKey,
    signature: string,
    previousRunId: string,
    runId: string
  ): Promise<AgenticCursorValues>;
  begin(key: AgenticCursorKey, signature: string, runId: string): Promise<AgenticCursorValues>;
  commit(
    key: AgenticCursorKey,
    signature: string,
    runId: string,
    values: AgenticCursorValues
  ): Promise<void>;
}
export function updateCursorRecord(
  previous: CursorRecord | null,
  signature: string,
  runId: string,
  values?: AgenticCursorValues,
  previousRunId?: string
): CursorRecord {
  z.string().length(64).parse(signature);
  z.string().min(1).max(1024).parse(runId);
  if (values) CursorValuesSchema.parse(values);
  if (previousRunId !== undefined) {
    z.string().min(1).max(1024).parse(previousRunId);
    if (values || previousRunId === runId || !previous || previous.signature !== signature) {
      throw new AgenticStateError('conflict');
    }
    if (previous.activeRun === runId) return previous; // Lost takeover response.
    if (previous.activeRun !== previousRunId) throw new AgenticStateError('conflict');
    return { ...previous, activeRun: runId };
  }
  if (
    values &&
    previous?.signature === signature &&
    previous.activeRun !== runId &&
    Object.entries(values).every(
      ([key, value]) =>
        typeof previous.values[key] === typeof value && previous.values[key]! >= value
    )
  ) {
    return previous;
  }
  if (previous && previous.signature !== signature) throw new AgenticStateError('conflict');
  if (previous?.activeRun && previous.activeRun !== runId) {
    throw new AgenticCursorConflict(previous.activeRun);
  }
  if (values) {
    if (previous?.committedRun === runId && !previous.activeRun) return previous;
    if (previous?.activeRun !== runId) throw new AgenticStateError('conflict');
    const next = CursorValuesSchema.parse(values);
    for (const [key, value] of Object.entries(previous.values)) {
      if (next[key] === undefined || typeof next[key] !== typeof value || next[key]! < value) {
        throw new AgenticStateError('conflict');
      }
    }
    return { signature, values: next, activeRun: null, committedRun: runId };
  }
  if (previous?.committedRun === runId) return previous;
  return {
    signature,
    values: previous?.values ?? {},
    activeRun: runId,
    committedRun: previous?.committedRun ?? null,
  };
}
/** Preserve sub-millisecond precision and reject ambiguous timestamp ordering. */
export function normalizeCursor(value: unknown, type: string): string | number {
  if (
    (type === 'integer' || type === 'number') &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (type !== 'integer' || Number.isSafeInteger(value))
  ) {
    return value;
  }
  if (
    type === 'date' &&
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    z.iso.date().safeParse(value).success
  ) {
    return value;
  }
  if (type === 'timestamp' && typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
    if (match && z.iso.datetime().safeParse(value).success) {
      return `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z`;
    }
  }
  throw new Error('Incremental cursor must be a non-null number, date, or UTC timestamp');
}
