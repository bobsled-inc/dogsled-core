/**
 * `inventoryEntityGraph` — the bridge that `@bobsled-inc/sdk-codegen` consumes.
 *
 * Reads an entity-graph project on disk and emits the SDK codegen IR
 * (`ir_version: '1.0'`) — a typed inventory of entity types, relationships,
 * polymorphic groups (reserved, empty in v1.0), and dialect capabilities.
 *
 * Implements the "SDK codegen IR" contract.
 *
 * Projection rules:
 *
 * - `profile_attrs[]` projects from `ResolvedResolutionSpec.profile.attributes`
 *   when the spec declares an explicit profile block (the canonical surface
 *   for SDK-level typed accessors). When no profile block is declared, the
 *   inventory falls back to the union of fields surfaced through scoring
 *   features so the generated SDK still produces typed projections rather
 *   than ID-only stubs.
 *
 * - `relationships[]` projects from `discoverEntityRelationshipSpecs()` +
 *   `resolveEntityRelationshipSpec()`. Every entity_relationship YAML in the
 *   `mdmDir` becomes one inventory entry — left/right entity, cardinality,
 *   and the join-column pairs. Relationships whose endpoints are not in the
 *   inventory's `entities[]` are dropped with a warning so the IR remains
 *   internally consistent (an SDK can't traverse to an entity type that
 *   wasn't generated).
 */

import { CommandError } from '@bobsled-inc/protocol';

import {
  discoverEntityRelationshipSpecs,
  resolveEntityRelationshipSpec,
} from '../compiler/relationship/parser.js';
import {
  discoverRelationshipExtractionSpecs,
  validateRelationshipExtractionOntologyRefs,
} from '../compiler/extraction/parser.js';
import {
  discoverRelationshipOntologySpecs,
  resolveRelationshipOntologySpec,
} from '../compiler/ontology/parser.js';
import { validateRelationshipOntologyEndpoints } from '../compiler/ontology/validate.js';
import {
  loadEntityGraphProjectContext,
  type EntityGraphProjectOptions,
} from '../runtime/project-context.js';

import type { ResolvedResolutionSpec } from '../compiler/identity/types.js';
import type { FieldMetadata } from '@bobsled-inc/protocol';

export const SDK_IR_VERSION = '1.0' as const;

export type SdkAttrType = 'string' | 'number' | 'boolean' | 'timestamp' | 'json' | 'vector';

export interface SdkEmbeddedFromMetadata {
  column: string;
  provider: string;
  model: string;
  distance_metric?: 'cosine' | 'l2' | 'dot';
}

export interface SdkProfileAttr {
  name: string;
  type: SdkAttrType;
  nullable: boolean;
  description?: string;
  dimension?: number;
  embedded_from?: SdkEmbeddedFromMetadata;
}

export interface SdkEntityInventory {
  name: string;
  primary_key: string;
  branded_id_type: string;
  profile_attrs: SdkProfileAttr[];
  quality_columns: string[];
  relationships_as_left: string[];
  relationships_as_right: string[];
  capabilities: { match: boolean };
}

export interface SdkRelationshipInventory {
  name: string;
  left_entity: string;
  right_entity: string;
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  join_attrs: { left: string; right: string }[];
}

export interface SdkDialectCapabilities {
  supports_json_path: boolean;
  supports_full_text: boolean;
  supports_vector: boolean;
}

export interface SdkOntologyInventory {
  name: string;
  ontology_version: string;
  relation_types: string[];
  entity_types: string[];
}

export interface EntityGraphInventory {
  ir_version: typeof SDK_IR_VERSION;
  entities: SdkEntityInventory[];
  relationships: SdkRelationshipInventory[];
  ontology?: SdkOntologyInventory;
  /** Reserved slot — empty in v1.0; populated in v1.x as additive minor bump. */
  polymorphic_groups: never[];
  dialect_capabilities: SdkDialectCapabilities;
  /**
   * Non-fatal warnings collected during projection (e.g. relationships
   * pointing at undeclared entities, source-spec normalization warnings).
   * Surfaced by the CLI so operators see what was skipped without an
   * error-level fail. Empty when projection produced no warnings.
   */
  warnings: string[];
}

const DEFAULT_QUALITY_COLUMNS = [
  'confidence',
  'freshness_age_seconds',
  'source_diversity',
  'profile_coverage',
];

function brandedIdName(entityName: string): string {
  const titled = entityName
    .split(/[_-]+/)
    .map((part) => (part.length === 0 ? '' : part[0]!.toUpperCase() + part.slice(1)))
    .join('');
  return `${titled}Id`;
}

function metadataForField(spec: ResolvedResolutionSpec, field: string): FieldMetadata | undefined {
  const candidates = [field, field.replace(/^standardized_/, '')].map((value) =>
    value.toLowerCase()
  );
  const matches: FieldMetadata[] = [];
  for (const input of spec.inputs) {
    for (const [name, metadata] of Object.entries(input.sourceFieldMetadata ?? {})) {
      if (candidates.includes(name.toLowerCase())) {
        matches.push(metadata);
        break;
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const [first, ...rest] = matches;
    if (first && rest.every((metadata) => JSON.stringify(metadata) === JSON.stringify(first))) {
      return first;
    }
  }
  return undefined;
}

function sdkAttrType(metadata: FieldMetadata | undefined): SdkAttrType {
  if (!metadata) return 'string';
  if (metadata.embedded_from) return 'vector';
  switch (metadata.type) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'timestamp':
    case 'date':
      return 'timestamp';
    case 'array':
    case 'object':
      return 'json';
    case 'string':
      return 'string';
  }
}

function profileAttrFromMetadata(
  name: string,
  metadata: FieldMetadata | undefined
): SdkProfileAttr {
  const attr: SdkProfileAttr = {
    name,
    type: sdkAttrType(metadata),
    nullable: true,
    ...(metadata?.description ? { description: metadata.description } : {}),
  };
  if (attr.type === 'vector' && metadata?.embedded_from) {
    attr.embedded_from = metadata.embedded_from;
  }
  return attr;
}

function deriveProfileAttrs(spec: ResolvedResolutionSpec): SdkProfileAttr[] {
  // Explicit profile block — the canonical projection list.
  if (spec.profile?.attributes && spec.profile.attributes.length > 0) {
    return spec.profile.attributes.map((attr) =>
      profileAttrFromMetadata(attr.alias, metadataForField(spec, attr.field))
    );
  }

  // Fallback: surface the union of fields referenced by scoring features so
  // the generated SDK has typed accessors even when the project hasn't yet
  // declared an explicit profile block. Deduplicate to avoid emitting the
  // same field twice when multiple algorithms target it.
  const scoringFields: Array<{ field: string }> =
    spec.scoring?.method === 'fellegi_sunter'
      ? spec.scoring.comparisons
      : (spec.scoring?.features ?? []);
  if (scoringFields.length === 0) return [];
  const seen = new Set<string>();
  const attrs: SdkProfileAttr[] = [];
  for (const feature of scoringFields) {
    if (seen.has(feature.field)) continue;
    seen.add(feature.field);
    attrs.push(profileAttrFromMetadata(feature.field, metadataForField(spec, feature.field)));
  }
  return attrs;
}

export interface RelationshipInventoryResult {
  relationships: SdkRelationshipInventory[];
  warnings: string[];
}

function buildRelationshipInventory(
  mdmDir: string,
  targetSchema: string,
  knownEntities: Set<string>
): RelationshipInventoryResult {
  const parsed = discoverEntityRelationshipSpecs(mdmDir);
  const relationships: SdkRelationshipInventory[] = [];
  const warnings: string[] = [];
  for (const ps of parsed) {
    const resolved = resolveEntityRelationshipSpec(ps, targetSchema);
    // Drop edges whose endpoints aren't generated as entity types — the SDK
    // cannot traverse to an undeclared entity. Surface as a warning rather
    // than an error to keep the inventory permissive against partial graphs.
    if (!knownEntities.has(resolved.leftEntity) || !knownEntities.has(resolved.rightEntity)) {
      warnings.push(
        `Skipping relationship '${resolved.name}' — endpoint(s) not in inventory entities (` +
          `left='${resolved.leftEntity}', right='${resolved.rightEntity}').`
      );
      continue;
    }
    relationships.push({
      name: resolved.name,
      left_entity: resolved.leftEntity,
      right_entity: resolved.rightEntity,
      cardinality: resolved.relationshipType,
      join_attrs: resolved.joinColumns.map((j) => ({ left: j.left, right: j.right })),
    });
  }
  return { relationships, warnings };
}

function applyRelationshipIndexes(
  entities: SdkEntityInventory[],
  relationships: readonly SdkRelationshipInventory[]
): void {
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  for (const relationship of relationships) {
    byName.get(relationship.left_entity)?.relationships_as_left.push(relationship.name);
    byName.get(relationship.right_entity)?.relationships_as_right.push(relationship.name);
  }
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function applyOntologyRelationshipIndexes(
  entities: SdkEntityInventory[],
  ontologies: readonly ReturnType<typeof resolveRelationshipOntologySpec>[]
): void {
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  for (const ontology of ontologies) {
    for (const relation of ontology.relations) {
      const left = byName.get(relation.left_entity);
      const right = byName.get(relation.right_entity);
      if (left) pushUnique(left.relationships_as_left, relation.relation_type);
      if (right) pushUnique(right.relationships_as_right, relation.relation_type);
      if (relation.direction === 'symmetric') {
        if (left) pushUnique(left.relationships_as_right, relation.relation_type);
        if (right) pushUnique(right.relationships_as_left, relation.relation_type);
      }
    }
  }
}

/**
 * Build the SDK IR for an entity-graph project on disk.
 *
 * Reads resolution specs (`mdmDir`) via the existing project-context loader
 * and projects them into the declared SDK codegen IR shape. Populates
 * `polymorphic_groups` as the reserved (empty) slot.
 */
export async function inventoryEntityGraph(
  options: EntityGraphProjectOptions = {}
): Promise<EntityGraphInventory> {
  const ctx = await loadEntityGraphProjectContext(options);

  const entities: SdkEntityInventory[] = ctx.specs.map((spec) => {
    return {
      name: spec.name,
      primary_key: 'entity_id',
      branded_id_type: brandedIdName(spec.name),
      profile_attrs: deriveProfileAttrs(spec),
      quality_columns: [...DEFAULT_QUALITY_COLUMNS],
      relationships_as_left: [],
      relationships_as_right: [],
      capabilities: { match: true },
    };
  });

  if (entities.length === 0) {
    throw new CommandError(
      `No entity-graph specs found at ${ctx.mdmDir}. Add at least one resolution spec under that directory.`,
      2
    );
  }

  const knownEntities = new Set(entities.map((e) => e.name));
  const { relationships, warnings: relationshipWarnings } = buildRelationshipInventory(
    ctx.mdmDir,
    ctx.targetSchema,
    knownEntities
  );
  applyRelationshipIndexes(entities, relationships);

  const parsedOntologies = discoverRelationshipOntologySpecs(ctx.mdmDir);
  const ontologies = parsedOntologies.map((parsed) => resolveRelationshipOntologySpec(parsed));
  validateRelationshipOntologyEndpoints(ontologies, knownEntities);
  applyOntologyRelationshipIndexes(entities, ontologies);

  const extractionSpecs = discoverRelationshipExtractionSpecs(ctx.mdmDir);
  validateRelationshipExtractionOntologyRefs(
    extractionSpecs,
    new Set(ontologies.map((ontology) => ontology.name))
  );
  for (const entity of entities) {
    entity.relationships_as_left.sort();
    entity.relationships_as_right.sort();
  }

  const ontology =
    ontologies.length === 0
      ? undefined
      : {
          name: ontologies[0]!.name,
          ontology_version: ontologies[0]!.ontologyVersion,
          relation_types: ontologies[0]!.relationTypes,
          entity_types: ontologies[0]!.entityTypes,
        };
  if (ontologies.length > 1) {
    ctx.warnings.push(
      `Multiple relationship ontologies found (${ontologies
        .map((item) => item.name)
        .join(', ')}); SDK IR exposes '${ontologies[0]!.name}' as the default ontology.`
    );
  }
  // Surface relationship-level warnings on the project context so the
  // CLI emits them next to the existing source/spec warnings.
  ctx.warnings.push(...relationshipWarnings);

  const dialect = ctx.dialect;
  const capabilities: SdkDialectCapabilities = {
    supports_json_path: dialect !== 'mysql',
    supports_full_text: dialect === 'postgres' || dialect === 'snowflake' || dialect === 'bigquery',
    supports_vector:
      dialect === 'postgres' ||
      dialect === 'snowflake' ||
      dialect === 'duckdb' ||
      dialect === 'bigquery',
  };

  return {
    ir_version: SDK_IR_VERSION,
    entities,
    relationships,
    ...(ontology ? { ontology } : {}),
    polymorphic_groups: [],
    dialect_capabilities: capabilities,
    warnings: [...ctx.warnings],
  };
}
