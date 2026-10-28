import type { ExtractPipelineConfig, ResourceRef } from './schema.js';
import type { ResolvedResource } from './loader.js';

export function normalizeResources(refs: ResourceRef[]): ResolvedResource[] {
  return refs.map((ref) => {
    if (typeof ref === 'string') return { name: ref };
    const override: NonNullable<ResolvedResource['override']> = {};
    if (ref.load_strategy !== undefined) override.loadStrategy = ref.load_strategy;
    if (ref.schema_behavior !== undefined) override.schemaBehavior = ref.schema_behavior;
    if (ref.table !== undefined) override.table = ref.table;
    if (ref.table_ownership_marker !== undefined) {
      override.tableOwnershipMarker = ref.table_ownership_marker;
    }
    if (ref.inputs !== undefined) override.inputs = ref.inputs;
    if (ref.input_matrix !== undefined) override.inputMatrix = ref.input_matrix;
    if (ref.via !== undefined) override.via = ref.via;
    if (ref.warehouse !== undefined) override.warehouse = ref.warehouse;
    return {
      name: ref.resource,
      override: Object.keys(override).length > 0 ? override : undefined,
      ...(ref.for_each_parent !== undefined ? { forEachParent: ref.for_each_parent } : {}),
    };
  });
}

export function normalizeDestinationNames(entry: ExtractPipelineConfig): string[] {
  if (entry.destinations !== undefined) return entry.destinations;
  if (entry.destination !== undefined) return [entry.destination];
  return [];
}
