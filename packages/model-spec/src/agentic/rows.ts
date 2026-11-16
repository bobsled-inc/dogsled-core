import { z } from 'zod';
import { agenticMetadataRole, agenticMetadataSpellings } from './metadata-names.js';
import type { JsonValue } from '@bobsled-inc/protocol';
import { AgenticColumnsSchema, type AgenticColumn } from './model.js';
import { AgenticStateError } from './state-errors.js';

export const AGENTIC_MAX_BYTES = 1_048_576;
/** Raising this also raises `maxStoredWrites` in row-state-rows.ts, which is derived from it. */
export const AGENTIC_MAX_ROWS = 1000;

/** Check depth and size before recursive schema validation or serialization. */
export function isBoundedAgenticJson(value: unknown): value is JsonValue {
  const pending: { value: unknown; depth: number; leave?: boolean }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let textBytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (current.leave) {
      seen.delete(current.value as object);
      continue;
    }
    if (++nodes > 16384 || current.depth > 16) return false;
    const item = current.value;
    if (typeof item === 'string') {
      textBytes += Buffer.byteLength(item, 'utf8');
      if (textBytes > AGENTIC_MAX_BYTES) return false;
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) return false;
    } else if (item !== null && typeof item !== 'boolean') {
      if (typeof item !== 'object' || seen.has(item)) return false;
      if (
        !Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        return false;
      }
      seen.add(item);
      pending.push({ value: item, depth: current.depth, leave: true });
      const entries = Object.entries(item);
      if (entries.length > 16384 - nodes) return false;
      if (
        Array.isArray(item) &&
        (entries.length !== item.length || entries.some(([key], index) => key !== String(index)))
      ) {
        return false;
      }
      for (const [key, child] of entries) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) return false;
        textBytes += Buffer.byteLength(key, 'utf8');
        if (textBytes > AGENTIC_MAX_BYTES) return false;
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= AGENTIC_MAX_BYTES;
}
export const AgenticJsonSchema = z.custom<JsonValue>(
  isBoundedAgenticJson,
  'Value exceeds the agentic JSON limits: at most 16,384 values, 16 levels deep and 1 MiB'
);

const formatMiB = (bytes: number): string => String(Math.round((bytes / 1048576) * 100) / 100);

/**
 * Bound a batch of rows: each row like any agentic value, the batch by row count and
 * total size. Applying the value limit per row keeps wide tables usable up to the row limit.
 */
export function boundedAgenticRows(
  value: unknown,
  label: string,
  limits: { maxRows: number; maxBatchBytes: number } = {
    maxRows: AGENTIC_MAX_ROWS,
    maxBatchBytes: AGENTIC_MAX_BYTES,
  }
): JsonValue[] {
  const fail = (reason: string, message: string): never => {
    throw new AgenticStateError('limit', { reason, message: `${label} ${message}` });
  };
  if (!Array.isArray(value)) return fail('invalid_rows', 'is not a list of rows.');
  if (value.length > limits.maxRows) {
    fail(
      'too_many_rows',
      `has ${value.length.toLocaleString('en-US')} rows; the limit is ${limits.maxRows.toLocaleString('en-US')}.`
    );
  }
  value.forEach((row, index) => {
    if (!isBoundedAgenticJson(row)) {
      fail(
        'row_too_large',
        `row ${index + 1} exceeds the per-row limits: at most 16,384 values, 16 levels deep and 1 MiB.`
      );
    }
  });
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > limits.maxBatchBytes) {
    fail(
      'batch_too_large',
      `is ${(bytes / 1048576).toFixed(2)} MiB; the limit is ${formatMiB(limits.maxBatchBytes)} MiB across its ${value.length} rows.`
    );
  }
  return value as JsonValue[];
}
export const AgenticEvidenceSchema = z
  .object({
    source: z.string().min(1).max(1024),
    reference: z.string().min(1).max(8192),
    support_excerpt: z.string().max(16384).nullable(),
    retrieved_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export const AgenticReasonSchema = z
  .object({
    summary: z.string().min(1).max(8192),
    supporting_factors: z.array(z.string().min(1).max(4096)).max(64),
    conflicting_factors: z.array(z.string().min(1).max(4096)).max(64),
  })
  .strict();
function judgmentSchema(evidenceSources?: readonly string[]) {
  const evidence =
    evidenceSources === undefined
      ? AgenticEvidenceSchema
      : AgenticEvidenceSchema.extend({ source: z.enum(evidenceSources) });
  return z
    .object({
      _bobsled_evidence: z.array(evidence).min(1).max(256).nullable(),
      _bobsled_confidence: z.number().min(0).max(1).nullable(),
      _bobsled_reason: AgenticReasonSchema.nullable(),
    })
    .strict();
}
export const AgenticJudgmentSchema = judgmentSchema();

// Field schemas are immutable. Checkpoint validation builds row schemas for every
// assignment, so share scalar fields and construct only each row object.
interface Field {
  required: z.ZodType;
  nullable: z.ZodType;
}
const field = (schema: z.ZodType): Field => ({ required: schema, nullable: schema.nullable() });
const scalarFields: Record<Exclude<AgenticColumn['type'], 'array' | 'object'>, Field> = {
  string: field(z.string()),
  integer: field(z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)),
  number: field(z.number()),
  boolean: field(z.boolean()),
  timestamp: field(z.iso.datetime({ offset: true })),
  date: field(z.iso.date()),
};
// Every generation's spelling of a metadata column keeps the same fixed structure.
const metadataFields = new Map(
  Object.entries(AgenticJudgmentSchema.shape).flatMap(([name, schema]) => {
    const role = agenticMetadataRole(name)!;
    return agenticMetadataSpellings(role).map((spelling) => [spelling, field(schema)] as const);
  })
);

/**
 * Renames a row's metadata keys to the spelling `shape` uses, so a row written
 * by an earlier Core generation (or an executor that still uses one) validates
 * against the current schema, and the other way round for saved definitions.
 */
function metadataSpellingOf(shape: Readonly<Record<string, unknown>>) {
  const spelling = new Map<string, string>();
  for (const name of Object.keys(shape)) {
    const role = agenticMetadataRole(name);
    if (role !== undefined) spelling.set(role, name);
  }
  if (!spelling.size) return undefined;
  return (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    let renamed: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const role = agenticMetadataRole(key);
      const target = role === undefined ? undefined : spelling.get(role);
      if (target === undefined || target === key || Object.hasOwn(value, target)) continue;
      renamed ??= { ...(value as Record<string, unknown>) };
      delete renamed[key];
      renamed[target] = item;
    }
    return renamed ?? value;
  };
}
const BoundedRowSchema = z.unknown().refine((value): boolean => isBoundedAgenticJson(value), {
  message: 'Expected bounded JSON data',
  abort: true,
});

/** Business columns are inferred from references; unknown fields are never stripped. */
export function createAgenticRowSchema(
  columns: readonly AgenticColumn[],
  findings = false,
  evidenceSources?: readonly string[]
) {
  const parsed = AgenticColumnsSchema.parse(columns);
  // JSON Schema export names recursive definitions by instance, so each row schema keeps
  // its own JSON value schemas, as it always has.
  let json: Record<'array' | 'object', Field> | undefined;
  const shape: Record<string, z.ZodType> = {};
  for (const column of parsed) {
    // Metadata read from an earlier model must keep its fixed structure.
    const columnField =
      metadataFields.get(column.name) ??
      (column.type === 'array' || column.type === 'object'
        ? (json ??= {
            array: field(z.array(z.json())),
            object: field(z.record(z.string(), z.json())),
          })[column.type]
        : scalarFields[column.type]);
    shape[column.name] = column.nullable ? columnField.nullable : columnField.required;
  }
  if (findings) {
    Object.assign(
      shape,
      evidenceSources === undefined
        ? AgenticJudgmentSchema.shape
        : judgmentSchema(evidenceSources).shape
    );
  }
  const respell = metadataSpellingOf(shape);
  const object = z.object(shape).strict();
  // Respelling happens on the input side, so JSON Schema (the output side) is unchanged.
  return (respell ? BoundedRowSchema.transform(respell) : BoundedRowSchema).pipe(object);
}
