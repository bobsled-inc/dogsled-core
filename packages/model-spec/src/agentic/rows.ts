import { z } from 'zod';
import type { JsonValue } from '@bobsled-inc/protocol';
import { AgenticColumnsSchema, type AgenticColumn } from './model.js';

export const AGENTIC_MAX_BYTES = 1_048_576;
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
  'Expected bounded JSON data'
);
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
      _dogsled_evidence: z.array(evidence).min(1).max(256).nullable(),
      _dogsled_confidence: z.number().min(0).max(1).nullable(),
      _dogsled_reason: AgenticReasonSchema.nullable(),
    })
    .strict();
}
export const AgenticJudgmentSchema = judgmentSchema();

/** Business columns are inferred from references; unknown fields are never stripped. */
export function createAgenticRowSchema(
  columns: readonly AgenticColumn[],
  findings = false,
  evidenceSources?: readonly string[]
) {
  const parsed = AgenticColumnsSchema.parse(columns);
  const scalar = {
    string: z.string(),
    integer: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    number: z.number(),
    boolean: z.boolean(),
    timestamp: z.iso.datetime({ offset: true }),
    date: z.iso.date(),
    array: z.array(z.json()),
    object: z.record(z.string(), z.json()),
  };
  const shape: Record<string, z.ZodType> = {};
  for (const column of parsed) {
    // Metadata read from an earlier model must keep its fixed structure.
    const metadata = Object.hasOwn(AgenticJudgmentSchema.shape, column.name)
      ? AgenticJudgmentSchema.shape[column.name as keyof typeof AgenticJudgmentSchema.shape]
      : undefined;
    const schema = metadata ?? scalar[column.type];
    shape[column.name] = column.nullable ? schema.nullable() : schema;
  }
  if (findings) Object.assign(shape, judgmentSchema(evidenceSources).shape);
  return z
    .unknown()
    .refine((value): boolean => isBoundedAgenticJson(value), {
      message: 'Expected bounded JSON data',
      abort: true,
    })
    .pipe(z.object(shape).strict());
}
