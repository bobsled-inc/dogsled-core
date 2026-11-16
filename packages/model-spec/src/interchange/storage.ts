import { z } from 'zod';

export interface BoundedJsonLimits {
  /** Most string bytes, keys included. Default 1_000_000. */
  maxBytes?: number;
  /** Most values visited. Default 100_000. */
  maxNodes?: number;
}

export interface BoundedJsonProblem {
  /** Where the problem is, such as `ai_context.examples[0]`; empty for the value itself. */
  path: string;
  reason: string;
}

function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? parent
      ? `${parent}.${key}`
      : key
    : `${parent}[${JSON.stringify(key)}]`;
}

/**
 * Metadata is data only. Bound it before traversing or copying an untrusted tree. A YAML alias
 * makes two places share one object; that is allowed because the node and byte limits still
 * count every visit. Only an object that contains itself is a cycle.
 */
export function boundedJsonProblem(
  value: unknown,
  { maxBytes = 1_000_000, maxNodes = 100_000 }: BoundedJsonLimits = {}
): BoundedJsonProblem | undefined {
  type Visit = { value: unknown; depth: number; path: string } | { leave: object };
  const pending: Visit[] = [{ value, depth: 0, path: '' }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if ('leave' in item) {
      ancestors.delete(item.leave);
      continue;
    }
    if (++nodes > maxNodes) return { path: item.path, reason: `has more than ${maxNodes} values` };
    if (item.depth > 40) return { path: item.path, reason: 'is nested more than 40 levels deep' };
    const v = item.value;
    if (typeof v === 'string') bytes += v.length;
    else if (v === null || typeof v === 'boolean') continue;
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) return { path: item.path, reason: 'is not a finite number' };
    } else if (typeof v === 'object') {
      if (ancestors.has(v)) return { path: item.path, reason: 'contains itself' };
      const array = Array.isArray(v);
      if (
        !array &&
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      ) {
        return { path: item.path, reason: 'is not plain JSON data' };
      }
      ancestors.add(v);
      pending.push({ leave: v });
      for (const [key, child] of Object.entries(v)) {
        const path = childPath(item.path, array ? Number(key) : key);
        if (!array && ['__proto__', 'prototype', 'constructor'].includes(key)) {
          return { path, reason: `uses the reserved key ${key}` };
        }
        bytes += key.length;
        pending.push({ value: child, depth: item.depth + 1, path });
      }
    } else return { path: item.path, reason: `is a ${typeof v}, not JSON data` };
    if (bytes > maxBytes) {
      return { path: item.path, reason: `makes the data larger than ${maxBytes / 1_000_000} MB` };
    }
  }
  return undefined;
}

export function boundedJson(value: unknown): boolean {
  return boundedJsonProblem(value) === undefined;
}
const metadata = z
  .record(z.string(), z.unknown())
  .refine(boundedJson, 'Metadata must be bounded JSON data (maximum depth 40 and 1 MB)');
const id = z.string().min(1).max(200);
export const OssieCustomExtensionSchema = z
  .object({
    vendor_name: z.string().min(1).max(200),
    data: z.string().max(1_000_000),
  })
  .strict();
const customExtensions = z.array(OssieCustomExtensionSchema).max(1_000);

/** Owner-local storage used by the converter-only design. */
export const OssieDatasetInterchangeSchema = z
  .object({
    custom_extensions: customExtensions.optional(),
    fields: z
      .array(
        z
          .object({
            origin_id: id,
            field: z.string().min(1),
            custom_extensions: customExtensions,
          })
          .strict()
      )
      .max(10_000)
      .optional(),
  })
  .strict()
  .refine(boundedJson, 'Ossie interchange data must be bounded JSON data');

export const EntityInterchangeSchema = z
  .object({
    ossie: z
      .object({ custom_extensions: customExtensions })
      .strict()
      .refine(boundedJson, 'Ossie interchange data must be bounded JSON data'),
  })
  .strict();

export const InterchangeSchema = z
  .object({
    ossie: OssieDatasetInterchangeSchema,
  })
  .strict();
export const InterchangeDocumentSchema = z
  .object({
    type: z.literal('interchange'),
    spec_version: z.literal('1'),
    name: id,
    format: z.literal('ossie'),
    profile_revision: z.string(),
    members: z
      .array(
        z.object({ dataset_id: id, name: z.string(), kind: z.enum(['source', 'derived']) }).strict()
      )
      .min(1)
      .max(10_000),
    metadata,
  })
  .strict();

export type OssieDatasetInterchange = z.infer<typeof OssieDatasetInterchangeSchema>;
export type EntityInterchange = z.infer<typeof EntityInterchangeSchema>;
export type OssieCustomExtension = z.infer<typeof OssieCustomExtensionSchema>;
export type InterchangeDocument = z.infer<typeof InterchangeDocumentSchema>;
