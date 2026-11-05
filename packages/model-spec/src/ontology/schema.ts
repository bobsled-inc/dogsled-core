import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { assertBounded, omit, record } from '../interchange/common.js';
import { CommandError } from '../errors.js';
import ontologySchema from './upstream/ontology.json' with { type: 'json' };
import mappingSchema from './upstream/mapping.json' with { type: 'json' };
import semanticSchema from './upstream/semantic-model.json' with { type: 'json' };

export const ONTOLOGY_OSSIE_VERSION = '0.2.0.dev0';
export const ONTOLOGY_SCHEMA_REVISION = '0a908aa87ef093588416dbbcde399f8bdeac00cd';
const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
ajv.addSchema(
  semanticSchema,
  'https://raw.githubusercontent.com/apache/ossie/main/core-spec/ossie-schema.json'
);
ajv.addSchema(
  ontologySchema,
  'https://raw.githubusercontent.com/apache/ossie/main/ontology/ontology.json'
);
const validateOntology = ajv.getSchema(
  'https://raw.githubusercontent.com/apache/ossie/main/ontology/ontology.json'
)!;
const validateMapping = ajv.compile(mappingSchema);
const text = z.string().min(1);
const expressions = z.array(text).optional();
const role = z.object({ concept: text, name: text.optional() }).strict();
export const OntologyRelationshipSchema = z
  .object({
    name: text,
    description: z.string().optional(),
    roles: z.array(role).optional(),
    multiplicity: z.enum(['ManyToOne', 'OneToOne']).optional(),
    derived_by: expressions,
    requires: expressions,
    verbalizes: z.array(text),
    iri: text.optional(),
  })
  .strict();
export const OntologyConceptSchema = z
  .object({
    concept: text,
    type: z.enum(['EntityType', 'ValueType']),
    description: z.string().optional(),
    extends: z.array(text).optional(),
    identify_by: z.array(text).optional(),
    derived_by: expressions,
    requires: expressions,
    relationships: z.array(OntologyRelationshipSchema).optional(),
    iri: text.optional(),
  })
  .strict();
const reference = z.object({ name: text, iri: text.optional() }).strict();
export const OntologyBindingsSchema = z
  .object({
    datasets: z.record(text, text),
    relationships: z.array(text).optional(),
    metrics: z.array(text).optional(),
    verified_queries: z.array(text).optional(),
  })
  .strict();
// Ajv checks the complete pinned shape. Zod supplies typed access without discarding fields.
const nativeOntology = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('ontology'),
    name: text,
    description: z.string().optional(),
    ontology: z.array(OntologyConceptSchema),
    prefixes: z.record(text, text).optional(),
    requires: expressions,
  })
  .passthrough();
const nativeMapping = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('ontology_mapping'),
    name: text,
    ontology_ref: reference,
    semantic_model_ref: reference.extend({ bindings: OntologyBindingsSchema.optional() }),
    concept_mappings: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();
export type OntologyDocument = z.infer<typeof nativeOntology>;
export type OntologyMappingDocument = z.infer<typeof nativeMapping>;
export type OntologyConcept = z.infer<typeof OntologyConceptSchema>;
export type OntologyRelationship = z.infer<typeof OntologyRelationshipSchema>;
export type OntologyFile = OntologyDocument | OntologyMappingDocument;

export function validateStandardOntology(value: unknown, mapping = false): void {
  assertBounded(value);
  const validate = mapping ? validateMapping : validateOntology;
  if (!validate(value)) {
    const issue = validate.errors?.[0];
    throw new CommandError(
      `ontology_schema: ${issue?.instancePath || '/'} ${issue?.message ?? 'Invalid document'}`,
      2
    );
  }
}
export function parseOntologyDocument(value: unknown): OntologyFile {
  assertBounded(value);
  const raw = record(value);
  const isMapping = raw['type'] === 'ontology_mapping';
  if (Object.hasOwn(raw, 'version')) {
    throw new CommandError('Native ontology files use spec_version, not version.', 2);
  }
  const checked = isMapping ? nativeMapping.safeParse(value) : nativeOntology.safeParse(value);
  if (!checked.success) throw new CommandError(checked.error.message, 2);
  const parsed = checked.data;
  const standard: Record<string, unknown> = {
    version: ONTOLOGY_OSSIE_VERSION,
    ...omit(raw, ['spec_version', 'type']),
  };
  if (isMapping) {
    standard['semantic_model_ref'] = omit(record(raw['semantic_model_ref']), ['bindings']);
  }
  validateStandardOntology(standard, isMapping);
  return parsed;
}
