import { z } from 'zod';

/**
 * SDK codegen IR schema (`ir_version: '1.0'`).
 *
 * This schema is the source of truth for the SDK codegen IR contract.
 *
 * Versioning policy:
 *  - Additions (new entity types, new attrs, new relationships) → minor.
 *  - Renames + deletions → major; consumers coordinate downstream
 *    migration before regenerating.
 *  - `polymorphic_groups` slot is reserved (empty in v1.0); populating in v1.x
 *    is an additive minor bump.
 */

export const SDK_IR_VERSION = '1.0' as const;

/**
 * Codegen build version embedded in every emitted SDK file header. tsup's
 * `define` plugin substitutes `__SDK_CODEGEN_VERSION__` with the literal
 * `package.json#version` at build time so the header stays in sync with the
 * package release without manual edits. Tests + the unbundled dev runtime
 * fall back to a sentinel string so accidental drift surfaces immediately
 * rather than masquerading as a real version.
 */
declare const __SDK_CODEGEN_VERSION__: string | undefined;
export const SDK_CODEGEN_VERSION =
  typeof __SDK_CODEGEN_VERSION__ !== 'undefined' && __SDK_CODEGEN_VERSION__
    ? __SDK_CODEGEN_VERSION__
    : '0.0.0-dev';

/**
 * Identifier-shaped strings used verbatim as class names, property
 * names, import specifiers, and filenames in the emitted SDK. Tightening
 * validation at the IR boundary prevents a malformed IR from generating
 * invalid TS/Python or escaping the intended output tree via names like
 * `../foo`.
 *
 * Pattern: standard JS/Python identifier — `[A-Za-z_][A-Za-z0-9_]*` —
 * which both languages accept without quoting.
 */
export const SdkIdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Expected an SDK-safe identifier (matches /^[A-Za-z_]\\w*$/)');

export const SdkAttrTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'timestamp',
  'json',
  'vector',
]);

/**
 * Provenance for an embedding column projected onto the SDK IR. Mirrors the
 * `embedded_from` block on Model Spec columns and the runtime SCHEMA message. The
 * host agent reads `provider`/`model` to generate a query embedding in
 * the same family at vector-search time. Distance metric is reserved.
 */
export const SdkEmbeddedFromSchema = z.strictObject({
  column: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  distance_metric: z.enum(['cosine', 'l2', 'dot']).optional(),
});

/**
 * `dimension` and `embedded_from` are only meaningful on vector attrs.
 * The schema accepts them as optional fields, but `superRefine` rejects
 * payloads that put them on scalar attrs — so the IR parser catches
 * invalid combos at the boundary instead of letting codegen blow up.
 */
export const SdkProfileAttrSchema = z
  .strictObject({
    name: SdkIdentifierSchema,
    type: SdkAttrTypeSchema,
    nullable: z.boolean(),
    description: z.string().optional(),
    dimension: z.number().int().positive().optional(),
    embedded_from: SdkEmbeddedFromSchema.optional(),
  })
  .superRefine((attr, ctx) => {
    if (attr.type !== 'vector' && attr.dimension !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimension'],
        message: 'dimension is only valid for vector attrs',
      });
    }
    if (attr.type !== 'vector' && attr.embedded_from !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['embedded_from'],
        message: 'embedded_from is only valid for vector attrs',
      });
    }
  });

export const SdkEntitySchema = z.strictObject({
  name: SdkIdentifierSchema,
  primary_key: SdkIdentifierSchema,
  branded_id_type: SdkIdentifierSchema,
  profile_attrs: z.array(SdkProfileAttrSchema),
  quality_columns: z.array(z.string()),
  relationships_as_left: z.array(SdkIdentifierSchema).default([]),
  relationships_as_right: z.array(SdkIdentifierSchema).default([]),
  capabilities: z
    .strictObject({
      match: z.boolean(),
    })
    .default({ match: false }),
});

export const SdkRelationshipSchema = z.strictObject({
  name: SdkIdentifierSchema,
  left_entity: SdkIdentifierSchema,
  right_entity: SdkIdentifierSchema,
  cardinality: z.enum(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']),
  join_attrs: z.array(z.strictObject({ left: SdkIdentifierSchema, right: SdkIdentifierSchema })),
});

export const SdkDialectCapabilitiesSchema = z.strictObject({
  supports_json_path: z.boolean(),
  supports_full_text: z.boolean(),
  supports_vector: z.boolean(),
});

export const SdkOntologySchema = z.strictObject({
  name: SdkIdentifierSchema,
  ontology_version: z.string().min(1),
  relation_types: z.array(SdkIdentifierSchema),
  entity_types: z.array(SdkIdentifierSchema),
});

export const SdkIrSchema = z.strictObject({
  ir_version: z.literal(SDK_IR_VERSION),
  entities: z.array(SdkEntitySchema),
  relationships: z.array(SdkRelationshipSchema),
  ontology: SdkOntologySchema.optional(),
  /** Reserved slot — empty in v1.0, populated in v1.x as additive minor. */
  polymorphic_groups: z.array(z.never()),
  dialect_capabilities: SdkDialectCapabilitiesSchema,
});

export type SdkAttrType = z.infer<typeof SdkAttrTypeSchema>;
export type SdkEmbeddedFrom = z.infer<typeof SdkEmbeddedFromSchema>;
export type SdkProfileAttr = z.infer<typeof SdkProfileAttrSchema>;
export type SdkEntity = z.infer<typeof SdkEntitySchema>;
export type SdkRelationship = z.infer<typeof SdkRelationshipSchema>;
export type SdkDialectCapabilities = z.infer<typeof SdkDialectCapabilitiesSchema>;
export type SdkOntology = z.infer<typeof SdkOntologySchema>;
export type SdkIr = z.infer<typeof SdkIrSchema>;

/**
 * Validates a pre-parsed JSON object as an SDK IR.
 * Throws a typed Zod error on invalid input.
 */
export function parseSdkIr(input: unknown): SdkIr {
  return SdkIrSchema.parse(input);
}
