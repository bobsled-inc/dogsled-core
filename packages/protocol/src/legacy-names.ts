/**
 * Every Blueprint spelling Core reads, old and new.
 *
 * The Dogsled -> Bobsled rename never rewrites this file (COMPAT_PATHS in the
 * rename tooling), so stored Blueprints keep validating whichever spelling
 * they use. The spelling Core treats as current lives in
 * legacy-blueprint-aliases.ts and follows the rename.
 */
export const BLUEPRINT_KEY_SPELLINGS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['dogsled_connection_ref', 'bobsled_connection_ref']),
  Object.freeze(['dogsled_source_kind', 'bobsled_source_kind']),
]);

/** Exact managed destination types; never a prefix (`bobsled_managed_snowflake` is a value). */
export const MANAGED_DESTINATION_TYPE_SPELLINGS: readonly string[] = Object.freeze([
  'dogsled_managed',
  'bobsled_managed',
]);

/** Prefixes of host extension keys that Core ignores in sources and destinations. */
export const BLUEPRINT_EXTENSION_KEY_PREFIXES: readonly string[] = Object.freeze([
  'dogsled_',
  'bobsled_',
]);

/** Destination types that are retired and stay rejected. */
export const RETIRED_DESTINATION_TYPES: readonly string[] = Object.freeze(['bobsled_lakehouse']);

/**
 * Core settings an earlier Core generation read, by the name that follows its prefix. Core never
 * reads the old value: setting `DOGSLED_OUTPUT_FORMAT` does nothing. Core warns when an old name
 * is set while its current twin is not, so a renamed setting is never lost silently. An explicit
 * list, never a prefix: users keep their own `DOGSLED_*` secrets.
 */
export const LEGACY_CORE_SETTING_PREFIX = 'DOGSLED_';
export const LEGACY_CORE_SETTINGS: readonly string[] = Object.freeze([
  'OUTPUT_FORMAT',
  'EXTRACTOR_ALLOW_PRIVATE_HOSTS',
  'ALLOW_PRIVATE_OAUTH_HOSTS',
  'ENTITY_GRAPH_ALLOW_REMOTE',
  'MCP_ALLOW_UNFILTERED',
  'STATE_BACKEND',
  'STATE_AUTH_ENV',
  'CREDENTIALS_TOKEN_COMMAND',
  'MATCH_KEY_SECRET',
  'SNOWFLAKE_ACCESS_TOKEN',
  'SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN',
  'XWH_STAGING_FORMAT',
  'XWH_SOURCE_TIMEOUT_S',
  'MODEL_SPEC_DEBUG_SQL',
  'QUERY_INFLIGHT_DEDUP',
  'QUERY_INCREMENTAL_REFRESH',
  'QUERY_PARTIAL_MATERIALIZATION',
  'QUERY_MAX_SQL_LIMIT',
  'MODEL_RUN_CANDIDATES',
  'AI_TEST_STUB',
  'EMBED_STUB',
  'CLI',
  'BUNDLED_INTEGRATIONS_DIR',
  'EMBEDDER_TMP_DIR',
  'PIPELINE_COMMAND',
  'PIPELINE_CWD',
  'PIPELINE_TIMEOUT_SECONDS',
  'INSTALL_ROOT',
  'INSTALL_DIR',
]);
