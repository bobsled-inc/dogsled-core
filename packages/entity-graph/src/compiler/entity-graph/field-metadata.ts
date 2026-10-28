import { z } from 'zod';
import { FieldMetadataSchema } from '@bobsled-inc/protocol';

import type { FieldMetadata } from '@bobsled-inc/protocol';
import type {
  FieldMetadataOverride,
  ResolvedResolutionSpec,
  SemanticOverrides,
  SourceFieldMetadataMap,
} from '../identity/types.js';
import { resolveEffectiveProfileConfig } from '../identity/profile-config.js';

export const FieldMetadataOverrideSchema = FieldMetadataSchema.omit({ name: true, type: true })
  .partial()
  .strict();

export const SemanticOverridesSchema = z
  .record(z.string().min(1), FieldMetadataOverrideSchema)
  .optional();

export interface EntitySchemaCatalogField {
  attribute: string;
  sourceField: string;
}

export interface EntitySchemaCatalogMetadata {
  attribute: string;
  sourceField: string;
  fieldMetadata: FieldMetadata;
}

export interface BuildEntitySchemaCatalogMetadataOptions {
  inheritedMetadata?: SourceFieldMetadataMap | readonly SourceFieldMetadataMap[];
}

function isSourceMetadataMapArray(
  value: SourceFieldMetadataMap | readonly SourceFieldMetadataMap[] | undefined
): value is readonly SourceFieldMetadataMap[] {
  return Array.isArray(value);
}

export function inferCatalogRole(attribute: string): FieldMetadata['semantic_role'] {
  const normalized = attribute.toLowerCase();
  if (normalized.endsWith('_id') || normalized === 'id') return 'identifier';
  if (normalized.includes('email')) return 'email';
  if (normalized.includes('phone')) return 'phone';
  if (normalized.includes('url') || normalized.includes('domain')) return 'url';
  if (normalized.includes('name')) return 'name';
  return 'categorical';
}

export function listEntitySchemaCatalogFields(
  spec: ResolvedResolutionSpec
): EntitySchemaCatalogField[] {
  const profile = resolveEffectiveProfileConfig(spec);
  const fields: EntitySchemaCatalogField[] = [
    ...(profile.displayName
      ? [{ attribute: profile.displayName.field, sourceField: profile.displayName.field }]
      : []),
    ...profile.attributes.map((attribute) => ({
      attribute: attribute.alias,
      sourceField: attribute.field,
    })),
    ...spec.standardize.map((transform) => ({
      attribute: transform.field,
      sourceField: transform.field,
    })),
  ];

  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.attribute)) {
      return false;
    }
    seen.add(field.attribute);
    return true;
  });
}

function sourceMetadataMaps(
  spec: ResolvedResolutionSpec,
  inheritedMetadata?: SourceFieldMetadataMap | readonly SourceFieldMetadataMap[]
): SourceFieldMetadataMap[] {
  if (isSourceMetadataMapArray(inheritedMetadata)) {
    return [...inheritedMetadata];
  }
  if (inheritedMetadata != null) {
    return [inheritedMetadata];
  }
  return spec.inputs
    .map((input) => input.sourceFieldMetadata)
    .filter((metadata): metadata is SourceFieldMetadataMap => metadata != null);
}

function lookupInheritedMetadata(
  maps: readonly SourceFieldMetadataMap[],
  attribute: string,
  sourceField: string
): FieldMetadata | undefined {
  for (const metadata of maps) {
    const bySourceField = metadata[sourceField];
    if (bySourceField != null) {
      return bySourceField;
    }
    const byAttribute = metadata[attribute];
    if (byAttribute != null) {
      return byAttribute;
    }
  }
  return undefined;
}

function lookupOverride(
  semanticOverrides: SemanticOverrides | undefined,
  attribute: string,
  sourceField: string
): FieldMetadataOverride | undefined {
  if (semanticOverrides == null) {
    return undefined;
  }
  return semanticOverrides[attribute] ?? semanticOverrides[sourceField];
}

function compactMetadata<T extends object>(metadata: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

export function mergeFieldMetadata(
  entityType: string,
  field: EntitySchemaCatalogField,
  inheritedMetadata?: FieldMetadata,
  semanticOverrides?: SemanticOverrides
): FieldMetadata {
  const override = compactMetadata(
    lookupOverride(semanticOverrides, field.attribute, field.sourceField) ?? {}
  );
  const inherited = inheritedMetadata == null ? undefined : compactMetadata(inheritedMetadata);
  const merged = {
    ...inherited,
    name: field.attribute,
    type: inherited?.type ?? 'string',
    description: inherited?.description ?? `Stub metadata for ${entityType}.${field.attribute}`,
    semantic_role: inherited?.semantic_role ?? inferCatalogRole(field.attribute),
    ...override,
  };

  return FieldMetadataSchema.parse(merged);
}

export function buildEntitySchemaCatalogMetadata(
  spec: ResolvedResolutionSpec,
  entityType: string,
  options: BuildEntitySchemaCatalogMetadataOptions = {}
): EntitySchemaCatalogMetadata[] {
  const metadataMaps = sourceMetadataMaps(spec, options.inheritedMetadata);
  return listEntitySchemaCatalogFields(spec).map((field) => ({
    attribute: field.attribute,
    sourceField: field.sourceField,
    fieldMetadata: mergeFieldMetadata(
      entityType,
      field,
      lookupInheritedMetadata(metadataMaps, field.attribute, field.sourceField),
      spec.semanticOverrides
    ),
  }));
}
