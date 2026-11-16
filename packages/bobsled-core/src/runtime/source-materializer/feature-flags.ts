export interface SourceMaterializerFeatureFlags {
  inFlightDedup: boolean;
  incrementalRefresh: boolean;
  partialMaterialization: boolean;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function enabled(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

export function resolveSourceMaterializerFlags(
  overrides: Partial<SourceMaterializerFeatureFlags> = {},
  env: NodeJS.ProcessEnv = process.env
): SourceMaterializerFeatureFlags {
  return {
    inFlightDedup: overrides.inFlightDedup ?? enabled(env.BOBSLED_CORE_QUERY_INFLIGHT_DEDUP),
    incrementalRefresh:
      overrides.incrementalRefresh ?? enabled(env.BOBSLED_CORE_QUERY_INCREMENTAL_REFRESH),
    partialMaterialization:
      overrides.partialMaterialization ?? enabled(env.BOBSLED_CORE_QUERY_PARTIAL_MATERIALIZATION),
  };
}
