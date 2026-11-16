import {
  AuthEnvVarsSchema,
  BLUEPRINT_EXTENSION_KEY_PREFIXES,
  isManagedDestinationType,
} from '@bobsled-inc/protocol';
import { z } from 'zod';

import { normalizeDestinationBlueprint } from './legacy-blueprint.js';
import { RESERVED_STAGING_TABLE_PREFIXES } from './legacy-names.js';

import {
  EnvPlaceholderSchema,
  isSchemaBehavior,
  isValidStreamSubfolder,
  normalizeStreamSubfolder,
  PlatformConfigSchema,
  SCHEMA_BEHAVIORS,
  STREAM_SUBFOLDER_RULE,
} from '@bobsled-inc/protocol';
// `/schema` keeps Dogsled's configuration surface safe for server-side / Lambda
// consumers. The embedder root re-exports
// `runEmbedder`, which transitively loads `@bobsled-inc/loader`'s DuckDB
// primitives at module-init — those static imports try to dlopen
// libduckdb.so, which Vercel Lambda doesn't ship. The `/schema` subpath
// is pure zod with no native dependencies.
import { createEmbedConfigSchema } from '@bobsled-inc/embedder/schema';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const DestinationFormatSchema = z.enum(['parquet', 'jsonl', 'csv']);
const LoadStrategySchema = z.enum(['append', 'merge', 'full_refresh']);
export const SchemaBehaviorSchema = z.enum(SCHEMA_BEHAVIORS);
export type SchemaBehavior = z.infer<typeof SchemaBehaviorSchema>;
/** Canonical pipeline runner ids emitted by Dogsled after config parsing. */
export const PipelineRunnerSchema = z.enum(['managed']);

const DestinationNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Destination names must use letters, numbers, underscores, hyphens');

// Resources resolve within the pipeline's source namespace. Project-local YAML
// overrides a bundled resource with the same name; `/` separators address
// nested project-local files.
const ResourceNameSchema = z.string().min(1);

const SourceHandleSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Source handle must be snake_case (matches a bundled integration name)'
  );
const PipelineScalarInputValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
// Cap on array input length so a hostile or malformed bobsled.yml can't materialize
// a multi-megabyte argv slot when piped to the extractor. 1000 entries is
// comfortably above the largest realistic fan-out target list (e.g. all repos
// in a large org) while still bounded for memory/argv safety.
const PIPELINE_INPUT_ARRAY_MAX = 1000;
const PipelineInputValueSchema = z.union([
  PipelineScalarInputValueSchema,
  z.array(PipelineScalarInputValueSchema).max(PIPELINE_INPUT_ARRAY_MAX),
]);

const InputMatrixAxisSchema = z
  .array(PipelineScalarInputValueSchema)
  .min(1, 'input_matrix axes must not be empty')
  .max(10_000, 'input_matrix axes cannot contain more than 10,000 values');
const InputMatrixSchema = z
  .object({
    axes: z
      .record(z.string().min(1), InputMatrixAxisSchema)
      .refine(
        (axes) => Object.keys(axes).length > 0,
        'input_matrix.axes must declare at least one axis'
      ),
    concurrency: z.coerce.number().finite().int().min(1).max(64).default(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Destination shapes (no `name` field — the name is the map key in the
// top-level `destinations:` record)
// ---------------------------------------------------------------------------

const SharedDestinationFields = {
  auth_env_vars: AuthEnvVarsSchema,
  load_strategy: LoadStrategySchema.optional(),
  schema_behavior: SchemaBehaviorSchema.optional(),
  table_prefix: z.string().optional(),
} as const;

/**
 * Reserved prefixes for orchestrator-specific extension keys on a
 * destination block. Dogsled ignores these — the orchestrator wrapping
 * Dogsled (e.g. an internal control plane, a SaaS scheduler) reads them.
 *
 * - `x-*`        — generic, OpenAPI-style extension namespace.
 * - `bobsled_*`  — fields used by a host application's managed ELT
 *                  adapter (e.g. `bobsled_connection_ref` linking the
 *                  destination to a host-managed connection row,
 *                  `bobsled_destination_kind` carrying a platform-side
 *                  hint).
 *
 * Mirrors the same convention used by V2 SourceSchema in
 * `packages/extractor/src/framework/core/source.ts`. Implemented as a
 * preprocess step so the inferred destination types stay clean (no
 * `[k: string]: unknown` index signature from `.passthrough()`) and
 * existing discriminated-union narrowing keeps working.
 */
/*
 * A managed destination type (an exact list in @bobsled-inc/protocol
 * legacy-names.ts, never a prefix) is NOT a real warehouse — it's an
 * intent the host application expands into a concrete
 * warehouse-native destination block before Dogsled CLI runs. For these
 * types the orchestrator's own host fields (e.g.
 * `bobsled_connection_ref`) ARE the schema, so the strip step below
 * preserves them for the matching managed-destination schema
 * branch. `x-*` extension keys are always stripped regardless of type.
 */
function stripDestinationExtensionKeys(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const obj = input as Record<string, unknown>;
  // Two-axis filter:
  //   - `x-*` is always stripped — generic OpenAPI-style extension
  //     namespace, never part of any destination's schema. Stripping
  //     applies even to managed types so authoring `x-foo: bar` still
  //     validates under the strict branch.
  //   - `bobsled_*` is stripped for real warehouse types (where it's
  //     an orchestrator extension), but PRESERVED for managed types
  //     (where `bobsled_connection_ref` and friends ARE the schema).
  const type = obj['type'];
  const isManagedDestination = isManagedDestinationType(type);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('x-')) continue;
    if (
      !isManagedDestination &&
      BLUEPRINT_EXTENSION_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

const BigQueryDestinationSchema = z
  .object({
    type: z.literal('bigquery'),
    project: z.string(),
    dataset: z.string(),
    location: z.string().optional(),
    credentials_secret: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Must be a valid environment variable name')
      .optional(),
    /**
     * Pre-minted short-lived OAuth 2.0 access token, expressed as a
     * `$VARNAME` env-var placeholder that the runner resolves at load
     * time. Mirrors dbt-bigquery's `oauth-secrets` Temporary Token
     * method. When set, bypasses ADC and the GitHub-secret path —
     * Dogsled's BigQuery loader passes the resolved value to
     * `new BigQuery({ token })` directly.
     *
     * The orchestrator wrapping Dogsled is responsible for minting +
     * shipping the token; refresh-while-running is not supported.
     * Tokens valid for the duration of the load (~1h default).
     */
    credentials_access_token: EnvPlaceholderSchema.optional(),
    /**
     * `$VARNAME` env-var placeholder resolving to a shell command that prints a
     * FRESH short-lived OAuth 2.0 access token as JSON
     * `{ "access_token": string, "expires_at": <unix seconds> }`. Unlike the
     * static `credentials_access_token`, the loader runs this per fetch and
     * refreshes the token mid-load (proactively before expiry, reactively on a
     * 401), so a single resource can load for much longer than the ~1h token
     * TTL. Takes precedence over `credentials_access_token` when both are set.
     * The orchestrator sets the env var to the actual mint command.
     */
    credentials_token_command: EnvPlaceholderSchema.optional(),
    ...SharedDestinationFields,
  })
  .strict();

const DuckDbDestinationSchema = z
  .object({
    type: z.literal('duckdb'),
    db_path: z.string(),
    schema: z.string().optional(),
    ...SharedDestinationFields,
  })
  .strict();

const SnowflakeDestinationSchema = z
  .object({
    type: z.literal('snowflake'),
    account: z.string(),
    username: z.string(),
    password: EnvPlaceholderSchema.optional(),
    private_key_path: z.string().optional(),
    private_key_passphrase: EnvPlaceholderSchema.optional(),
    /**
     * Pre-minted short-lived Snowflake OIDC JWT, expressed as an env-var
     * placeholder. The orchestrator issues the token; Dogsled passes the
     * resolved value to snowflake-sdk as `authenticator: 'OAUTH'` + `token`.
     */
    credentials_access_token: EnvPlaceholderSchema.optional(),
    /**
     * Env-var placeholder resolving to a command that prints a fresh token as
     * `{ "access_token": string, "expires_at": number }`. The shared
     * connections token provider runs it with the normal process environment
     * and refreshes Snowflake by reconnecting before expiry. Takes precedence
     * over `credentials_access_token`.
     */
    credentials_token_command: EnvPlaceholderSchema.optional(),
    /**
     * Env-var placeholder for a Snowflake workload identity token. The token
     * is supplied by the custom runner and must not be combined with another
     * Snowflake credential mode.
     */
    credentials_workload_identity_token: EnvPlaceholderSchema.optional(),
    warehouse: z.string(),
    database: z.string(),
    schema: z.string().optional(),
    role: z.string().optional(),
    ...SharedDestinationFields,
  })
  .strict()
  .superRefine((val, ctx) => {
    const conflictingFields = [
      'password',
      'private_key_path',
      'private_key_passphrase',
      'credentials_access_token',
      'credentials_token_command',
    ] as const;

    if (
      val.credentials_workload_identity_token !== undefined &&
      conflictingFields.some((field) => val[field] !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credentials_workload_identity_token'],
        message:
          'credentials_workload_identity_token cannot be combined with another Snowflake credential field.',
      });
    }
  });

const PostgresDestinationSchema = z
  .object({
    type: z.literal('postgres'),
    host: z.string(),
    port: z.number().int().positive().optional(),
    database: z.string(),
    schema: z.string().optional(),
    username: z.string(),
    password: EnvPlaceholderSchema.optional(),
    ssl: z.boolean().optional(),
    ...SharedDestinationFields,
  })
  .strict();

const DatabricksDestinationSchema = z
  .object({
    type: z.literal('databricks'),
    server_hostname: z.string().min(1),
    http_path: z.string().min(1),
    catalog: z.string().min(1),
    schema: z.string().min(1),
    credentials_access_token: EnvPlaceholderSchema.optional(),
    oauth_client_id: z.string().min(1).optional(),
    oauth_client_secret: EnvPlaceholderSchema.optional(),
    ...SharedDestinationFields,
  })
  .strict();

const MySqlDestinationSchema = z
  .object({
    type: z.literal('mysql'),
    host: z.string(),
    database: z.string(),
    user: z.string(),
    port: z.number().int().positive().optional(),
    password: EnvPlaceholderSchema.optional(),
    ssl: z.boolean().optional(),
    ...SharedDestinationFields,
  })
  .strict();

const ClickHouseDestinationSchema = z
  .object({
    type: z.literal('clickhouse'),
    host: z.string(),
    port: z.number().int().positive().optional(),
    database: z.string(),
    username: z.string().optional(),
    password: EnvPlaceholderSchema.optional(),
    ssl: z.boolean().optional(),
    vector_index: z.boolean().optional(),
    ...SharedDestinationFields,
  })
  .strict();

const TurbopufferDestinationSchema = z
  .object({
    type: z.literal('turbopuffer'),
    api_key: EnvPlaceholderSchema,
    region: z
      .string()
      .regex(/^[a-z0-9-]+$/, 'Must be a Turbopuffer region id')
      .optional(),
    namespace_prefix: z
      .string()
      .regex(/^[A-Za-z0-9._-]*$/)
      .optional(),
    distance_metric: z.enum(['cosine_distance', 'euclidean_squared']).optional(),
    full_text_columns: z.array(z.string().min(1)).optional(),
    ...SharedDestinationFields,
  })
  .strict();

/**
 * Opt-in folder added inside each stream's folder on file destinations, so a
 * file lands at `<prefix><stream>/<stream_subfolder>/<stream>-<n>.<ext>`.
 * Omitted by default, which keeps `<prefix><stream>/<stream>-<n>.<ext>`.
 */
const StreamSubfolderSchema = z
  .string()
  .refine(
    (value) =>
      EnvPlaceholderSchema.safeParse(value).success ||
      isValidStreamSubfolder(normalizeStreamSubfolder(value)),
    `${STREAM_SUBFOLDER_RULE}, or an environment variable placeholder`
  );

const FileDestinationFields = {
  stream_subfolder: StreamSubfolderSchema.optional(),
} as const;

// File destinations require an explicit format (no implicit default).
const LocalDestinationSchema = z
  .object({
    type: z.literal('local'),
    format: DestinationFormatSchema,
    ...FileDestinationFields,
    ...SharedDestinationFields,
  })
  .strict();

const GcsDestinationSchema = z
  .object({
    type: z.literal('gcs'),
    bucket: z.string(),
    prefix: z.string().optional(),
    format: DestinationFormatSchema,
    ...FileDestinationFields,
    ...SharedDestinationFields,
  })
  .strict();

const S3DestinationSchema = z
  .object({
    type: z.literal('s3'),
    bucket: z.string(),
    prefix: z.string().optional(),
    format: DestinationFormatSchema,
    ...FileDestinationFields,
    ...SharedDestinationFields,
  })
  .strict();

/**
 * Host-managed destination — orchestrator-resolved type.
 *
 * The host application expands this into a concrete warehouse-native
 * destination block (currently always `type: bigquery`, looked up from
 * the matching managed connection row keyed by
 * `bobsled_connection_ref`) before Dogsled CLI runs. Dogsled CLI itself
 * never sees this intent type at runtime — there is no
 * matching loader in `packages/loader/src/runtime/destinations/`. The
 * value of having Dogsled validate this shape at parse time is
 * structural — bundles authored against this offering pass Dogsled's
 * schema check at upload, and orchestrators that don't expand managed
 * types fail loud with "unknown loader" instead of silently
 * mis-routing the load.
 *
 * Future managed offerings (`bobsled_snowflake_warehouse`,
 * `bobsled_databricks_workspace`, …) follow the same pattern: one
 * additional schema branch + one additional orchestrator-side
 * expander. The credential plumbing (`iam-impersonate://` resolver,
 * `DOGSLED_<OFFERING>_CREDENTIALS_*` env-var convention) is a
 * concern of the orchestrator, not Dogsled.
 */
const BobsledManagedDestinationSchema = z
  .object({
    type: z.literal('bobsled_managed'),
    /**
     * Slug of the host-managed connection row to
     * expand from. Required: this destination is meaningful only when
     * pinned to a specific managed connection. Format mirrors the
     * managed connection slug shape (kebab/snake-case identifier:
     * lowercase alphanumerics separated by single hyphens or
     * underscores, no leading/trailing separators). Failing at schema
     * parse time means a malformed ref produces a clear error at
     * upload, not a confusing "row not found" later in expansion.
     */
    bobsled_connection_ref: z
      .string()
      .regex(
        /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
        'Must be a slug: lowercase letters/digits separated by single hyphens or underscores, no leading/trailing separators'
      ),
    ...SharedDestinationFields,
  })
  .strict();

export const DestinationSchema = z.preprocess(
  (input, ctx) => stripDestinationExtensionKeys(normalizeDestinationBlueprint(input, ctx)),
  z.discriminatedUnion('type', [
    BigQueryDestinationSchema,
    DuckDbDestinationSchema,
    SnowflakeDestinationSchema,
    PostgresDestinationSchema,
    DatabricksDestinationSchema,
    MySqlDestinationSchema,
    ClickHouseDestinationSchema,
    TurbopufferDestinationSchema,
    LocalDestinationSchema,
    GcsDestinationSchema,
    S3DestinationSchema,
    BobsledManagedDestinationSchema,
  ])
);

// NamedDestination is the inline destination config plus the `name` it carries
// in the top-level destinations map. Runtime consumers (fan-out, destination-args,
// the pipeline subprocess) work with this shape because they need to identify
// individual destinations across boundaries (CLI args, manifest entries, JSON
// payloads). The loader resolves a name + map entry into this shape.
const namedFields = z
  .object({
    name: DestinationNameSchema,
  })
  .strict();

export const NamedDestinationSchema = z.preprocess(
  (input, ctx) => stripDestinationExtensionKeys(normalizeDestinationBlueprint(input, ctx)),
  z.union([
    BigQueryDestinationSchema.safeExtend(namedFields.shape),
    DuckDbDestinationSchema.safeExtend(namedFields.shape),
    SnowflakeDestinationSchema.safeExtend(namedFields.shape),
    PostgresDestinationSchema.safeExtend(namedFields.shape),
    DatabricksDestinationSchema.safeExtend(namedFields.shape),
    MySqlDestinationSchema.safeExtend(namedFields.shape),
    ClickHouseDestinationSchema.safeExtend(namedFields.shape),
    TurbopufferDestinationSchema.safeExtend(namedFields.shape),
    LocalDestinationSchema.safeExtend(namedFields.shape),
    GcsDestinationSchema.safeExtend(namedFields.shape),
    S3DestinationSchema.safeExtend(namedFields.shape),
    BobsledManagedDestinationSchema.safeExtend(namedFields.shape),
  ])
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

// Transport id selector. Must reference one of the source integration's
// `transports[].id`. Pipeline-level `via:` overrides the integration's
// `default_transport` for THIS pipeline only; per-resource `via:` (on an
// override object) overrides the pipeline-level value for THAT resource.
// Cross-file validation in loader.ts checks the value against the resolved
// source — Zod only enforces shape here.
const TransportIdSchema = z.string().min(1, 'via must be a non-empty transport id');
const ResourceTableNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'table must start with a letter or underscore and contain only letters, digits, or underscores'
  )
  .refine(
    (value) =>
      !RESERVED_STAGING_TABLE_PREFIXES.some((prefix) => value.toLowerCase().startsWith(prefix)),
    { message: 'table uses the reserved loader staging prefix "_bobsled_stg_"' }
  );

const ResourceOverrideSchema = z
  .object({
    resource: ResourceNameSchema,
    load_strategy: LoadStrategySchema.optional(),
    schema_behavior: SchemaBehaviorSchema.optional(),
    // This is a destination table identifier, not a qualified table path. The
    // pipeline already selects the destination schema/dataset separately, and
    // every loader enforces this same identifier contract at execution time.
    table: ResourceTableNameSchema.optional(),
    /** Stable marker proving this run owns an exact Snowflake destination table. */
    table_ownership_marker: z.string().min(1).max(256).optional(),
    inputs: z.record(z.string(), PipelineInputValueSchema).optional(),
    input_matrix: InputMatrixSchema.optional(),
    via: TransportIdSchema.optional(),
    /**
     * Optional authored parent for `extract.for_each` resources. The manifest
     * compiler co-locates the parent and child in one subprocess node.
     */
    for_each_parent: ResourceNameSchema.optional(),
    /**
     * Per-resource warehouse selector. Accepted by the schema ONLY so the
     * loader can detect and REJECT it: per-resource (and per-model) warehouse
     * selection is not supported yet — the runtime opens one Snowflake session
     * per run, so only pipeline-grained selection is implementable. Set
     * `warehouse:` at the pipeline level instead.
     */
    warehouse: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.table_ownership_marker !== undefined && value.table === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['table_ownership_marker'],
        message: 'table_ownership_marker requires an exact table override',
      });
    }
  });

export const ResourceRefSchema = z.union([ResourceNameSchema, ResourceOverrideSchema], {
  error: (issue) => {
    const input = issue.input;
    if (
      typeof input === 'object' &&
      input !== null &&
      'schema_behavior' in input &&
      (typeof input.schema_behavior !== 'string' || !isSchemaBehavior(input.schema_behavior))
    ) {
      return `schema_behavior must be one of: ${SCHEMA_BEHAVIORS.join(', ')}`;
    }
    return undefined;
  },
});

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export const EmbedConfigSchema = createEmbedConfigSchema(EnvPlaceholderSchema);

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

// `pipelines.<name>.type` discriminates between three pipeline kinds:
//   - `extract` (default for back-compat): pulls data from an integration
//     into one or more destinations.
//   - `models`: schedules materialization of derived Model Spec models for a given
//     connection (the v1 surface for Dogsled-side scheduling of model pipelines).
//   - `entity-graph`: schedules entity-graph workflows (resolve, cluster) for
//     identity resolution specs defined under `entity-graph/` in the project.
//     Mirrors `models` structurally — same connection + schedule + wildcard
//     selector shape — but dispatches to `@bobsled-inc/entity-graph/api` at
//     run time instead of the Model Spec model runner.
//
// `type:` defaults to `extract` if omitted — every existing bobsled.yml keeps
// validating without edits. The default is injected by `preprocess` so the
// discriminator is a clean `z.literal(...)` (a `.default()` ZodDefault would
// confuse `z.discriminatedUnion`).

const ConnectionNameSchema = z
  .string()
  .min(1, 'Connection name is required')
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Connection name must be snake_case (matches the Model Spec integration handle)'
  );

const ModelNameSchema = z.string().min(1, 'Model name is required');

const ModelsListSchema = z.union([
  z.literal('*'),
  z.array(ModelNameSchema).min(1, 'models: must be a non-empty list or the wildcard "*"'),
]);

const EntityNameSchema = z.string().min(1, 'Entity name is required');

// Entity selector for `type: entity-graph` pipelines. Mirrors `ModelsListSchema`
// shape — wildcard `'*'` means "every resolution spec discovered under
// entity-graph/", an explicit non-empty array names specific entities.
const EntitiesListSchema = z.union([
  z.literal('*'),
  z.array(EntityNameSchema).min(1, 'entities: must be a non-empty list or the wildcard "*"'),
]);

// Subset of entity-graph runtime phases a pipeline executes per tick. Defaults
// to the resolution phases (`resolve` + `cluster`). The full set:
//   - `resolve` runs the resolution pipeline up through auto-merge +
//     review-queue population (CLI: `entity-graph resolve run`).
//   - `cluster` runs Union-Find over the `__review_decisions` table to produce
//     the final `__clusters` / `__crosswalks` tables (CLI:
//     `entity-graph resolve cluster`). The resolve/cluster split lets the host application
//     run resolve frequently (continuous candidate-pair generation) and cluster
//     on a separate cadence (after human or agent review).
//   - `profile` runs `entity-graph resolve profile` — builds the per-entity
//     `__entity_profile` table (trust scores, activation projections) the
//     construction phases consume. It is exposed so hosts can request the
//     preparation step explicitly before construction.
//   - `extract_mentions` runs `entity-graph mentions extract` — links
//     warehouse-text chunks to resolved entities, populating
//     `__document_mentions`.
//   - `extract_relationships` runs `entity-graph relationships extract` —
//     extracts typed, evidence-cited relationships between resolved entities.
// The construction phases (`extract_mentions` / `extract_relationships`) require
// resolution (`__clusters`/`__crosswalks`) and chunks (`__chunks`) to already
// exist. Phase 1 callers that don't care can omit the field and get the
// both-resolution-phases default.
const EntityGraphPhaseSchema = z.enum([
  'resolve',
  'cluster',
  'profile',
  'extract_mentions',
  'extract_relationships',
]);

const EntityGraphPhasesSchema = z
  .array(EntityGraphPhaseSchema)
  .min(1, 'phases: must include at least one entity-graph phase')
  .refine((phases) => new Set(phases).size === phases.length, {
    message: 'phases: must not contain duplicates',
  });

// Declares one warehouse text column to chunk into the entity-graph `__chunks`
// table, which the `extract_mentions` phase then links to resolved entities.
// Consumed by entity-graph execution hosts. Snake_case keys match the rest of
// `bobsled.yml` (e.g. `load_strategy`, `table_prefix`). Tokenizer values mirror
// `@bobsled-inc/document-parsers` `ChunkOptions`.
const ChunkSourceSchema = z
  .object({
    entity: z.string().min(1), // resolution-spec / entity name whose mention extraction consumes these chunks
    source_table: z.string().min(1), // fully-qualified warehouse text table, e.g. raw.documents
    text_column: z.string().min(1), // column holding the unstructured text to chunk
    uri_column: z.string().min(1).optional(), // optional source-uri column for document identity
    title_column: z.string().min(1).optional(), // optional document title column
    max_tokens: z.coerce.number().int().positive().default(512),
    overlap_tokens: z.coerce.number().int().nonnegative().default(64),
    tokenizer: z.enum(['cl100k_base', 'o200k_base', 'p50k_base']).default('cl100k_base'),
  })
  .strict();

// Free-form authored description surfaced to AI agents and the Explorer UI.
// Cap kept short enough to fit in prompt context without being a novella, but
// long enough for a couple of sentences explaining intent.
const PipelineDescriptionSchema = z.string().max(2000);

// Reserved sentinel value for `schedule:` that signals "no automatic trigger —
// only manual invocation". Accepted on both `type: extract` and `type: models`
// pipelines, and on `defaults.models.schedule`. Authors get a pipeline that is
// still part of the project's deployable surface (a GitHub Actions workflow
// with `workflow_dispatch:`) but no cron is created. The CLI emits manual
// pipelines through the same `dogsled runner dispatch` /
// `dogsled runner run` entry points as scheduled ones.
export const MANUAL_SCHEDULE = 'manual' as const;

export type PipelineTrigger = 'schedule' | 'manual';

export function isManualSchedule(schedule: string | undefined): boolean {
  return typeof schedule === 'string' && schedule.trim().toLowerCase() === MANUAL_SCHEDULE;
}

export function pipelineTriggerFor(schedule: string | undefined): PipelineTrigger {
  return isManualSchedule(schedule) ? 'manual' : 'schedule';
}

const ScheduleSchema = z.string().trim().min(1, 'schedule must be a non-empty string');

export const ExtractPipelineConfigSchema = z
  .object({
    type: z.literal('extract'),
    description: PipelineDescriptionSchema.optional(),
    schedule: ScheduleSchema,
    source: SourceHandleSchema,
    destination: DestinationNameSchema.optional(),
    destinations: z.array(DestinationNameSchema).min(1).optional(),
    resources: z.array(ResourceRefSchema).min(1),
    load_strategy: LoadStrategySchema.optional(),
    schema_behavior: SchemaBehaviorSchema.optional(),
    table_prefix: z.string().optional(),
    /**
     * Records buffered per load file before the loader flushes and converts a
     * chunk (e.g. JSONL -> Parquet for BigQuery). Defaults to 100_000 in the
     * loader when omitted. Lower it for streams with large/nested columns whose
     * per-chunk conversion would otherwise exceed the loader's statement
     * timeout (e.g. wide JSON `object` columns).
     */
    buffer_size: z.coerce.number().int().positive().optional(),
    inputs: z.record(z.string(), PipelineInputValueSchema).optional(),
    enabled: z.boolean().default(true),
    runner: PipelineRunnerSchema.default('managed'),
    embed: EmbedConfigSchema.optional(),
    via: TransportIdSchema.optional(),
    /**
     * Pipeline-level Snowflake warehouse selector. Names one of the source
     * connection's declared `warehouses` by stable ID. Cross-validation in the
     * loader checks it against the declared ID set; managed runtime plumbing
     * resolves it for the Snowflake source session. Per-resource selection is
     * rejected — selection is pipeline-grained only.
     */
    warehouse: z.string().min(1).optional(),
    /**
     * Stable managed-connection warehouse ID for destination load compute.
     * The managed orchestrator validates and resolves this ID; Dogsled only
     * preserves it as pipeline-scoped execution metadata.
     */
    destination_warehouse: z.string().min(1).optional(),
  })
  .strict();

export const ModelsPipelineConfigSchema = z
  .object({
    type: z.literal('models'),
    description: PipelineDescriptionSchema.optional(),
    connection: ConnectionNameSchema,
    schedule: ScheduleSchema,
    models: ModelsListSchema,
    enabled: z.boolean().default(true),
    /**
     * Pipeline-level Snowflake warehouse selector. Names one of the
     * `connection`'s declared `warehouses` by stable ID. A v5 managed
     * manifest carries the selector as programmatic execution metadata;
     * per-model selection is not supported, so it stays pipeline-grained.
     */
    warehouse: z.string().min(1).optional(),
  })
  .strict();

/**
 * Schema for a `type: entity-graph` pipeline entry in `bobsled.yml`. Mirrors
 * `ModelsPipelineConfigSchema` (connection + schedule + wildcard selector +
 * enabled) with entity-graph-specific additions:
 *
 *   - `entities`: `'*' | string[]` — which resolution specs (from the
 *     project's `entity-graph/` directory) the pipeline runs against.
 *   - `phases`: ordered subset of `['resolve', 'cluster', 'extract_mentions',
 *     'extract_relationships']` (defaults to the resolution phases
 *     `['resolve', 'cluster']`). `resolve` runs the resolution pipeline
 *     through auto-merge + review-queue population; `cluster` runs Union-Find
 *     over the `__review_decisions` table to produce final `__clusters` /
 *     `__crosswalks`. The construction phases `extract_mentions`
 *     (`entity-graph mentions extract`) and `extract_relationships`
 *     (`entity-graph relationships extract`) require resolution + chunks to
 *     already exist; they link warehouse-text chunks to resolved entities and
 *     extract typed, evidence-cited relationships. The split lets callers
 *     schedule each phase on its own cadence (e.g. cluster after a batch review
 *     window, construction after chunks are prepared).
 *   - `chunk_sources` (optional): declares which warehouse text column(s) to
 *     chunk into the `__chunks` table that `extract_mentions` consumes. Read by
 *     the managed runner; absence is fully backward compatible.
 */
export const EntityGraphPipelineConfigSchema = z
  .object({
    type: z.literal('entity-graph'),
    description: PipelineDescriptionSchema.optional(),
    connection: ConnectionNameSchema,
    schedule: ScheduleSchema,
    entities: EntitiesListSchema,
    phases: EntityGraphPhasesSchema.default(['resolve', 'cluster']),
    chunk_sources: z.array(ChunkSourceSchema).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

function injectExtractTypeDefault(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const obj = input as Record<string, unknown>;
  if (obj['type'] === undefined) {
    return { ...obj, type: 'extract' };
  }
  return obj;
}

/**
 * Pre-validation guard: catch unknown `type:` values BEFORE Zod's
 * discriminated-union narrowing surfaces an opaque
 * "invalid_union_discriminator". Emits a fix-suggesting message with the
 * stable UNKNOWN_PIPELINE_TYPE code so agents can branch on it. `fatal: true`
 * short-circuits the `.pipe()` so the inner discriminated-union check
 * doesn't run with a known-bad type.
 */
const _PipelineConfigInner = z
  .discriminatedUnion('type', [
    ExtractPipelineConfigSchema,
    ModelsPipelineConfigSchema,
    EntityGraphPipelineConfigSchema,
  ])
  .superRefine((p, ctx) => {
    // Cross-field validation only applies to extract pipelines — the
    // destination/destinations rules are extract-specific.
    if (p.type !== 'extract') return;
    if (p.destination !== undefined && p.destinations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destinations'],
        message: 'Cannot specify both "destination" and "destinations"',
      });
    }
    if (p.destination === undefined && p.destinations === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'Pipeline must specify either "destination" or "destinations"',
      });
    }
    if (p.destination_warehouse !== undefined && p.destination === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination_warehouse'],
        message: '"destination_warehouse" requires a singular "destination"',
      });
    }
  });

export const PipelineConfigSchema = z
  .unknown()
  .superRefine((data, ctx) => {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const t = (data as Record<string, unknown>)['type'];
    if (typeof t === 'string' && t !== 'extract' && t !== 'models' && t !== 'entity-graph') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message:
          `[UNKNOWN_PIPELINE_TYPE] Unknown pipeline type "${t}" — pipelines are 'extract', 'models', or 'entity-graph' only. ` +
          `('managed' is a runner: value, not type:.)`,
        fatal: true,
      });
    }
  })
  .pipe(z.preprocess(injectExtractTypeDefault, _PipelineConfigInner));

// ---------------------------------------------------------------------------
// Top-level optional sections (unchanged from the previous schema)
// ---------------------------------------------------------------------------

// Project-level fallback for orphan models (derived models with non-view
// materialization that no `type: models` pipeline mentions). The host application
// expands this into synthetic pipelines at parse time; Dogsled validates the
// shape so a malformed `defaults.models.schedule` fails loud at compile time
// rather than silently falling through to host application.
export const DefaultsModelsSchema = z
  .object({
    schedule: z.string().trim().min(1, 'defaults.models.schedule must be a non-empty string'),
  })
  .strict();

/**
 * Resolve the effective `PipelineTrigger` for a pipeline config entry, based on
 * its `schedule` field. `'manual'` (case-insensitive) opts the pipeline out of
 * automatic firing — workflows are still generated with `workflow_dispatch:`,
 * but no cron is registered.
 */
export function pipelineTrigger(pipeline: PipelineConfig): PipelineTrigger {
  return pipelineTriggerFor(pipeline.schedule);
}

export const DefaultsSchema = z
  .object({
    timeout: z.string().default('4h'),
    retry: z
      .object({
        attempts: z.number().int().positive().default(3),
        backoff: z.enum(['exponential', 'linear', 'fixed']).default('exponential'),
      })
      .optional(),
    models: DefaultsModelsSchema.optional(),
  })
  .strict()
  .optional();

export const ModelsSchema = z
  .object({
    project: z.string(),
    schedule: z.string().optional(),
    after: z.array(z.string()).optional(),
    sequence: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

// Pipeline names starting with `_` are reserved for synthetic pipelines emitted
// by the manifest generator (e.g. `_models_default_<connection>`). Authored
// pipelines that try to claim that prefix are rejected at parse time so a
// hand-written `_models_default_bigquery` can never collide with the synthetic
// one Dogsled would emit.
const PipelineMapSchema = z.record(z.string(), PipelineConfigSchema).superRefine((map, ctx) => {
  for (const name of Object.keys(map)) {
    if (name.startsWith('_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: `Pipeline name "${name}" is invalid: the leading "_" prefix is reserved for synthetic pipelines emitted by Dogsled (e.g. "_models_default_<connection>"). Choose a name without a leading underscore.`,
      });
    }
  }
});

const BobsledConfigObjectSchema = z
  .object({
    // Declares this file as the project's pipeline configuration so it can
    // live outside the project root. An untyped root `bobsled.yml` is still the
    // pipeline configuration.
    type: z.literal('pipeline_config').optional(),
    // `destinations:` is optional so a model-only `bobsled.yml` (no extract
    // pipelines) doesn't have to declare an unused destination. Extract
    // pipelines still require at least one destination — that's enforced by
    // the cross-field `superRefine` below, where we know which pipelines are
    // present.
    destinations: z.record(DestinationNameSchema, DestinationSchema).default({}),
    pipelines: PipelineMapSchema,
    defaults: DefaultsSchema,
    models: ModelsSchema,
    platform: PlatformConfigSchema.optional(),
  })
  .strict();

/** Strict schema for one typed pipeline-config fragment before ownership merge. */
export const BobsledConfigFragmentSchema = BobsledConfigObjectSchema.omit({ type: true })
  .partial()
  .strict();

export const BobsledConfigSchema = BobsledConfigObjectSchema.superRefine((cfg, ctx) => {
  const hasExtractPipeline = Object.values(cfg.pipelines).some((p) => p.type === 'extract');
  if (hasExtractPipeline && Object.keys(cfg.destinations).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['destinations'],
      message:
        'At least one destination must be defined in the destinations map when any extract pipeline is present.',
    });
  }
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type BobsledConfig = z.infer<typeof BobsledConfigSchema>;
export type DestinationConfig = z.infer<typeof DestinationSchema>;
export type NamedDestination = z.infer<typeof NamedDestinationSchema>;
export type PipelineInputValue = z.infer<typeof PipelineInputValueSchema>;
export type ResourceRef = z.infer<typeof ResourceRefSchema>;
export type ResourceOverride = z.infer<typeof ResourceOverrideSchema>;
export type InputMatrix = z.infer<typeof InputMatrixSchema>;
export type EmbedConfig = z.infer<typeof EmbedConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type ExtractPipelineConfig = z.infer<typeof ExtractPipelineConfigSchema>;
export type ModelsPipelineConfig = z.infer<typeof ModelsPipelineConfigSchema>;
export type EntityGraphPipelineConfig = z.infer<typeof EntityGraphPipelineConfigSchema>;
export type EntityGraphPhase = z.infer<typeof EntityGraphPhaseSchema>;
export type ChunkSource = z.infer<typeof ChunkSourceSchema>;
export type PipelineRunner = z.infer<typeof PipelineRunnerSchema>;
export type DefaultsModelsConfig = z.infer<typeof DefaultsModelsSchema>;

// Lenient guard: treats anything that isn't an explicit `type: 'models'` or
// `type: 'entity-graph'` as an extract pipeline. Post-parse all pipelines
// carry a literal `type` field (the preprocess injects `'extract'` when
// omitted), but consumers that construct configs programmatically — including
// unit tests — may pass objects that bypass the schema's preprocess. Defaulting
// to `extract` here preserves back-compat for those callers while still
// correctly excluding the two non-extract kinds.
export function isExtractPipelineConfig(p: PipelineConfig): p is ExtractPipelineConfig {
  return p.type !== 'models' && p.type !== 'entity-graph';
}

export function isModelsPipelineConfig(p: PipelineConfig): p is ModelsPipelineConfig {
  return p.type === 'models';
}

/**
 * Strict guard that matches only `type: 'entity-graph'` pipelines. Unlike
 * `isExtractPipelineConfig`, there is no lenient fallback — entity-graph
 * pipelines must declare their type explicitly.
 */
export function isEntityGraphPipelineConfig(p: PipelineConfig): p is EntityGraphPipelineConfig {
  return p.type === 'entity-graph';
}
