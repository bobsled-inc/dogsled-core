import { z } from 'zod';

/** Metadata is data only. Bound it before traversing or copying an untrusted tree. */
export function boundedJson(value: unknown): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || ++nodes > 100_000 || item.depth > 40) return false;
    const v = item.value;
    if (typeof v === 'string') bytes += v.length;
    else if (v === null || typeof v === 'boolean') continue;
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false;
    } else if (typeof v === 'object') {
      if (seen.has(v)) return false;
      seen.add(v);
      if (
        !Array.isArray(v) &&
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      ) {
        return false;
      }
      for (const [key, child] of Object.entries(v)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) return false;
        bytes += key.length;
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else return false;
    if (bytes > 1_000_000) return false;
  }
  return true;
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
