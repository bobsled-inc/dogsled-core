import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';

import { CommandError } from '../errors.js';
import upstreamSchema from './upstream-schema.json' with { type: 'json' };
import { OSSIE_VENDOR, isOwnOssieVendor } from '../interchange/common.js';

export const OSSIE_VERSION = '0.2.0.dev0';
export const OSSIE_SCHEMA_REVISION = '9cb2ad99f335beacdedc85c861e8f47f354bf449';
const validate = new Ajv2020({ strict: false, allErrors: false }).compile(upstreamSchema);
const extensions = z.array(z.object({ vendor_name: z.string(), data: z.string() })).optional();
const expression = z.object({
  dialects: z.array(z.object({ dialect: z.string(), expression: z.string() })),
});
const field = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    datatype: z.string().optional(),
    expression,
    custom_extensions: extensions,
  })
  .passthrough();
const dataset = z
  .object({
    name: z.string(),
    source: z.string(),
    description: z.string().optional(),
    fields: z.array(field).optional(),
    primary_key: z.array(z.string()).optional(),
    unique_keys: z.array(z.array(z.string())).optional(),
    custom_extensions: extensions,
  })
  .passthrough();
const documentSchema = z
  .object({
    version: z.literal(OSSIE_VERSION),
    name: z.string(),
    datasets: z.array(dataset),
    metrics: z
      .array(
        z
          .object({
            name: z.string(),
            description: z.string().optional(),
            expression,
            custom_extensions: extensions,
            ai_context: z.unknown().optional(),
          })
          .passthrough()
      )
      .optional(),
    relationships: z
      .array(
        z
          .object({
            name: z.string(),
            from: z.string(),
            to: z.string(),
            from_columns: z.array(z.string()),
            to_columns: z.array(z.string()),
            custom_extensions: extensions,
          })
          .passthrough()
      )
      .optional(),
    custom_extensions: extensions,
  })
  .passthrough();
export type OssieDocument = z.infer<typeof documentSchema>;
export type OssieDataset = z.infer<typeof dataset>;
export type OssieField = z.infer<typeof field>;

export function validateOssieDocument(document: unknown, filePath: string): OssieDocument {
  if (!validate(document)) {
    const error = validate.errors?.[0];
    throw new CommandError(
      `${filePath}: Invalid Ossie document (${OSSIE_VERSION}, schema ${OSSIE_SCHEMA_REVISION}): ${error?.instancePath || '/'} ${error?.message ?? 'schema validation failed'}`,
      2
    );
  }
  return documentSchema.parse(document);
}

export function bobsledExtension(
  value: { custom_extensions?: { vendor_name: string; data: string }[] },
  where: string,
  required = false,
  vendor = 'BOBSLED'
): Record<string, unknown> {
  // Core's own vendor tag is read in every generation's spelling.
  const own = (name: string) =>
    vendor === OSSIE_VENDOR ? isOwnOssieVendor(name) : name === vendor;
  const entries = value.custom_extensions?.filter((e) => own(e.vendor_name)) ?? [];
  if (entries.length > 1) throw new CommandError(`${where}: duplicate ${vendor} extensions`, 2);
  const entry = entries[0];
  if (!entry) {
    if (required) throw new CommandError(`${where}: ${vendor} extension required for execution`, 2);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(entry.data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('object required');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new CommandError(`${where}: ${vendor} extension data must be a JSON object string`, 2);
  }
}
