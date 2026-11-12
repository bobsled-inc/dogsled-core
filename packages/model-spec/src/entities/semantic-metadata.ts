import { z } from 'zod';

import { identifierMsg, identifierRegex } from '../compiler/shared-validators.js';
import { boundedJson } from '../interchange/storage.js';

const MAX_METADATA_BYTES = 1_000_000;

const AiContextObjectSchema = z
  .record(z.string(), z.unknown())
  .refine(boundedJson, 'AI context must be bounded JSON data (maximum depth 40 and 1 MB)');

/** Open AI guidance copied without assigning meaning to its property names. */
export const AiContextSchema = z.union([z.string().max(MAX_METADATA_BYTES), AiContextObjectSchema]);

export const SemanticExpressionSchema = z
  .object({
    dialects: z
      .array(
        z
          .object({
            dialect: z.string().trim().min(1),
            expression: z.string().min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

/** Alternative names users may say instead of the object's name. */
export const SynonymsSchema = z.array(z.string().trim().min(1));

export const SemanticFieldMetadataSchema = z.object({
  semantic_expression: SemanticExpressionSchema.optional(),
  is_time: z.boolean().optional(),
  ai_context: AiContextSchema.optional(),
  synonyms: SynonymsSchema.optional(),
});

const synonymKey = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

function synonymList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Synonyms may be written as native `synonyms` or inside `ai_context.synonyms`, the
 * Ossie location. Both are kept. Consumers merge them: native entries first, then
 * ai_context entries, dropping blanks and repeats that differ only in case or spacing.
 */
export function mergeSynonyms(...lists: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of lists.flatMap(synonymList)) {
    const trimmed = entry.trim();
    const key = synonymKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged;
}

/** Reads `ai_context.synonyms` when ai_context is an object. A string ai_context has none. */
export function aiContextSynonyms(aiContext: unknown): unknown {
  return aiContext && typeof aiContext === 'object' && !Array.isArray(aiContext)
    ? (aiContext as Record<string, unknown>)['synonyms']
    : undefined;
}

/** Native synonyms merged with `ai_context.synonyms`. */
export function effectiveSynonyms(owner: {
  readonly synonyms?: unknown;
  readonly ai_context?: unknown;
}): string[] {
  return mergeSynonyms(owner.synonyms, aiContextSynonyms(owner.ai_context));
}

/**
 * Returns ai_context with `synonyms` set to the given list, for Ossie output. A string
 * ai_context becomes `{ instructions, synonyms }` because Ossie keeps synonyms in the
 * object form. `synonyms` is always the last key, so an export after an import writes the
 * same document. An empty list leaves ai_context unchanged.
 */
export function withAiContextSynonyms(aiContext: unknown, synonyms: readonly string[]): unknown {
  if (!synonyms.length) return aiContext;
  if (typeof aiContext === 'string') return { instructions: aiContext, synonyms: [...synonyms] };
  const base =
    aiContext && typeof aiContext === 'object' && !Array.isArray(aiContext)
      ? (aiContext as Record<string, unknown>)
      : {};
  const { synonyms: _previous, ...rest } = base;
  return { ...rest, synonyms: [...synonyms] };
}

/**
 * Returns ai_context without `synonyms`, for native output after an Ossie import. Only a
 * string or a list of strings is removed, because only those are merged into native
 * synonyms. An object that held only synonyms becomes undefined.
 */
export function withoutAiContextSynonyms(aiContext: unknown): unknown {
  const value = aiContextSynonyms(aiContext);
  const mergeable =
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
  if (!mergeable) return aiContext;
  const { synonyms: _synonyms, ...rest } = aiContext as Record<string, unknown>;
  return Object.keys(rest).length ? rest : undefined;
}

/**
 * Native properties for an imported Ossie object: synonyms from every given list and
 * from `ai_context.synonyms`, and ai_context without the synonyms it gave up.
 */
export function nativeSynonymProperties(
  aiContext: unknown,
  ...nativeSynonyms: readonly unknown[]
): { ai_context?: unknown; synonyms?: string[] } {
  const synonyms = mergeSynonyms(...nativeSynonyms, aiContextSynonyms(aiContext));
  const remaining = synonyms.length ? withoutAiContextSynonyms(aiContext) : aiContext;
  return {
    ...(remaining !== undefined ? { ai_context: remaining } : {}),
    ...(synonyms.length ? { synonyms } : {}),
  };
}

export const OssieLogicalDataTypeSchema = z.enum([
  'String',
  'Integer',
  'Decimal',
  'Float',
  'Boolean',
  'Date',
  'Time',
  'DateTime',
  'DateTimeTz',
  'Opaque',
]);

/** A bare name is a derived model. `<connection>.<source>` is a source. */
export const DatasetReferenceSchema = z
  .string()
  .trim()
  .min(1, 'Dataset reference is required')
  .regex(
    new RegExp(
      `^${identifierRegex.source.slice(1, -1)}(?:\\.${identifierRegex.source.slice(1, -1)})?$`
    ),
    `${identifierMsg}; source references use <connection>.<source>`
  );

export type AiContext = z.infer<typeof AiContextSchema>;
export type SemanticExpression = z.infer<typeof SemanticExpressionSchema>;
export type OssieLogicalDataType = z.infer<typeof OssieLogicalDataTypeSchema>;
export type DatasetReference = z.infer<typeof DatasetReferenceSchema>;
