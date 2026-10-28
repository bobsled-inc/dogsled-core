import { z } from 'zod';

import { FieldMetadataSchema } from '@bobsled-inc/protocol';

import { FieldTypeSchema, JsonValueSchema } from './shared.js';
import { parseJsonPathTokens } from './json-path.js';

const OutputFieldMetadataSchema = FieldMetadataSchema.omit({
  name: true,
  type: true,
  description: true,
  embedding_candidate: true,
});

type OutputFieldMetadata = z.infer<typeof OutputFieldMetadataSchema>;

export interface InputFieldDefinition {
  type: z.infer<typeof FieldTypeSchema>;
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  items?: InputFieldDefinition;
  properties?: Record<string, InputFieldDefinition>;
}

export interface OutputFieldDefinition extends OutputFieldMetadata {
  type: z.infer<typeof FieldTypeSchema>;
  /** Single JSONPath. Optional only when `paths` is provided instead. */
  path?: string;
  /**
   * Ordered fallback JSONPaths — the first one that resolves to a
   * non-`undefined` value wins (ahead of `default`). Use for
   * type-discriminated payloads (e.g. Notion blocks) so a "whichever key is
   * present" column resolves in one field without downstream COALESCE SQL.
   */
  paths?: string[];
  /** A value projected from the declared, mapped output of a fan-out ancestor. */
  from?: OutputFieldOrigin;
  description?: string;
  embedding_candidate?: boolean;
  default?: unknown;
  items?: OutputFieldDefinition;
  properties?: Record<string, OutputFieldDefinition>;
}

export interface OutputFieldContextOrigin {
  /** A mapped output field from a proven extract.for_each ancestor. */
  resource: string;
  path: string;
}

export interface OutputFieldInputOrigin {
  /** A value from the request input tuple used for this extraction. */
  input: string;
}

export type OutputFieldOrigin = OutputFieldContextOrigin | OutputFieldInputOrigin;

const BLOCKED_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_CONTEXT_PATH_LENGTH = 256;
const MAX_CONTEXT_PATH_TOKENS = 32;
const CONTEXT_PATH_RE =
  /^\$\.[A-Za-z_][A-Za-z0-9_]*(?:\[-?\d+\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[-?\d+\])?)*$/;

const ResourceOutputOriginSchema = z
  .object({
    resource: z.string().min(1),
    path: z.string().min(1).max(MAX_CONTEXT_PATH_LENGTH),
  })
  .strict()
  .superRefine((value, ctx) => {
    const tokens = parseJsonPathTokens(value.path);
    if (
      tokens === null ||
      !CONTEXT_PATH_RE.test(value.path) ||
      tokens.length === 0 ||
      tokens.length > MAX_CONTEXT_PATH_TOKENS ||
      tokens.some((token) => token.type === 'prop' && BLOCKED_PATH_KEYS.has(token.value))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          '`from.path` must be a bounded property/index path such as `$.id` or `$.owner.ids[0]`',
        path: ['path'],
      });
    }
  });

const InputOutputOriginSchema = z
  .object({
    input: z
      .string()
      .min(1)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        '`from.input` must name a declared input such as `tour` or `event_id`'
      ),
  })
  .strict();

/** Output context may come from a proven parent output or the current request input tuple. */
export const OutputFieldContextOriginSchema = z.union([
  ResourceOutputOriginSchema,
  InputOutputOriginSchema,
]);

function validateOutputPaths(
  path: string | undefined,
  paths: string[] | undefined,
  from: OutputFieldOrigin | undefined,
  ctx: z.RefinementCtx
): void {
  // `paths` takes runtime precedence over `path`, so accepting both would
  // silently ignore `path`. Reject the ambiguous combo instead of resolving it
  // by hidden precedence.
  const origins =
    Number(path !== undefined) + Number(paths !== undefined) + Number(from !== undefined);
  if (path !== undefined && paths !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Set either `path` or `paths`, not both',
      path: ['paths'],
    });
  } else if (origins > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Set exactly one of `path`, `paths`, or `from`',
      path: ['from'],
    });
  }

  if (paths !== undefined && paths.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '`paths` must list at least one JSONPath',
      path: ['paths'],
    });
  }

  if (path === undefined && paths === undefined && from === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Output field requires `path` or a non-empty `paths`, or `from` (exactly one)',
      path: ['path'],
    });
  }
}

function validateNestedShape(
  type: string,
  items: unknown,
  properties: unknown,
  ctx: z.RefinementCtx
): void {
  if (type !== 'array' && items !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only array fields can declare items',
      path: ['items'],
    });
  }

  if (type !== 'object' && properties !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only object fields can declare properties',
      path: ['properties'],
    });
  }
}

export const InputFieldSchema: z.ZodType<InputFieldDefinition> = z.lazy(() =>
  z
    .object({
      type: FieldTypeSchema,
      required: z.boolean().optional(),
      description: z.string().optional(),
      default: JsonValueSchema.optional(),
      enum: z.array(z.string()).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      pattern: z.string().optional(),
      items: InputFieldSchema.optional(),
      properties: z.record(z.string(), InputFieldSchema).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      validateNestedShape(value.type, value.items, value.properties, ctx);
    })
);

/**
 * Nested output shape declarations describe the value already selected by a
 * top-level output mapping. They may map nested response paths, but cannot
 * introduce fan-out ancestry: runtime lineage projection is deliberately a
 * top-level column contract.
 */
const NestedOutputFieldSchema: z.ZodType<OutputFieldDefinition> = z.lazy(() =>
  z
    .object({
      type: FieldTypeSchema,
      path: z.string().optional(),
      paths: z.array(z.string()).optional(),
      description: z.string().optional(),
      embedding_candidate: z.boolean().optional(),
      default: JsonValueSchema.optional(),
      items: NestedOutputFieldSchema.optional(),
      properties: z.record(z.string(), NestedOutputFieldSchema).optional(),
    })
    .merge(OutputFieldMetadataSchema)
    .strict()
    .superRefine((value, ctx) => {
      validateNestedShape(value.type, value.items, value.properties, ctx);
      validateOutputPaths(value.path, value.paths, undefined, ctx);
    })
);

export const OutputFieldSchema: z.ZodType<OutputFieldDefinition> = z.lazy(() =>
  z
    .object({
      type: FieldTypeSchema,
      path: z.string().optional(),
      paths: z.array(z.string()).optional(),
      from: OutputFieldContextOriginSchema.optional(),
      description: z.string().optional(),
      embedding_candidate: z.boolean().optional(),
      default: JsonValueSchema.optional(),
      items: NestedOutputFieldSchema.optional(),
      properties: z.record(z.string(), NestedOutputFieldSchema).optional(),
    })
    .merge(OutputFieldMetadataSchema)
    .strict()
    .superRefine((value, ctx) => {
      validateNestedShape(value.type, value.items, value.properties, ctx);
      validateOutputPaths(value.path, value.paths, value.from, ctx);
    })
);

/** Resolve a bounded path against the declared shape of a mapped output record. */
export function resolveDeclaredOutputPath(
  output: Record<string, OutputFieldDefinition>,
  path: string
): OutputFieldDefinition | undefined {
  const tokens = parseJsonPathTokens(path);
  if (!tokens || tokens.length === 0 || tokens.length > MAX_CONTEXT_PATH_TOKENS) return undefined;

  let current: OutputFieldDefinition | undefined;
  for (const token of tokens) {
    if (token.type === 'prop') {
      if (BLOCKED_PATH_KEYS.has(token.value)) return undefined;
      if (current === undefined) {
        current = output[token.value];
      } else if (current.type === 'object' && current.properties) {
        current = current.properties[token.value];
      } else {
        return undefined;
      }
    } else if (current?.type === 'array' && current.items) {
      current = current.items;
    } else {
      return undefined;
    }

    if (!current) return undefined;
  }
  return current;
}

export function hasContextualOutputOrigin(output: Record<string, OutputFieldDefinition>): boolean {
  return Object.values(output).some(
    (field) =>
      field.from !== undefined ||
      (field.properties !== undefined && hasContextualOutputOrigin(field.properties)) ||
      (field.items?.properties !== undefined &&
        hasContextualOutputOrigin(field.items.properties)) ||
      field.items?.from !== undefined
  );
}

export function hasFanOutOutputOrigin(output: Record<string, OutputFieldDefinition>): boolean {
  return Object.values(output).some(
    (field) =>
      (field.from !== undefined && 'resource' in field.from) ||
      (field.properties !== undefined && hasFanOutOutputOrigin(field.properties)) ||
      (field.items?.properties !== undefined && hasFanOutOutputOrigin(field.items.properties)) ||
      (field.items?.from !== undefined && 'resource' in field.items.from)
  );
}

export function validateContextualOutputSupport(
  output: Record<string, OutputFieldDefinition>,
  supported: boolean,
  ctx: z.RefinementCtx,
  message = 'contextual output fields require extract.for_each'
): void {
  if (!supported && hasFanOutOutputOrigin(output)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['output'] });
  }
}

/**
 * Warehouse output field — same as OutputFieldSchema but `path` is optional.
 *
 * DW/DB resources map columns directly by name rather than using JSONPath
 * extraction, so the `path` field is unnecessary.
 */
export interface WarehouseOutputFieldDefinition extends OutputFieldMetadata {
  type: z.infer<typeof FieldTypeSchema>;
  path?: string;
  description?: string;
  embedding_candidate?: boolean;
  default?: unknown;
  items?: WarehouseOutputFieldDefinition;
  properties?: Record<string, WarehouseOutputFieldDefinition>;
}

export const WarehouseOutputFieldSchema: z.ZodType<WarehouseOutputFieldDefinition> = z.lazy(() =>
  z
    .object({
      type: FieldTypeSchema,
      path: z.string().optional(),
      description: z.string().optional(),
      embedding_candidate: z.boolean().optional(),
      default: JsonValueSchema.optional(),
      items: WarehouseOutputFieldSchema.optional(),
      properties: z.record(z.string(), WarehouseOutputFieldSchema).optional(),
    })
    .merge(OutputFieldMetadataSchema)
    .strict()
    .superRefine((value, ctx) => {
      validateNestedShape(value.type, value.items, value.properties, ctx);
    })
);

export type InputFieldSchemaType = z.infer<typeof InputFieldSchema>;
export type OutputFieldSchemaType = z.infer<typeof OutputFieldSchema>;
export type WarehouseOutputFieldSchemaType = z.infer<typeof WarehouseOutputFieldSchema>;
