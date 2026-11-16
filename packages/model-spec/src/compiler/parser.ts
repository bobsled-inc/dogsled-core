import { expandOssieIndex } from '../ossie/index.js';
/**
 * Parser for source and transform spec files.
 *
 * Builds a source registry from source YAML files and resolves
 * refs in transform specs to fully-qualified table names.
 *
 * Auto-generates table aliases (t0, t1, t2, ...) and replaces
 * ref-based qualifiers in expressions with the generated aliases.
 */

import {
  assertValidProjectIndex,
  entriesOfKind,
  entryFilePath,
  type ProjectIndex,
} from '@bobsled-inc/project-index';

import type { ModelSpec } from '../agentic/model.js';
import { readYamlFile, readYamlFileWithContent } from '../files/reader.js';
import { buildPositionMap, formatZodErrorWithPositions } from '../files/yaml-positions.js';

import { collectYamlFiles } from './dag.js';
import { buildFqNameWithDatabase, caseName, getOrThrow, quoteLiteral } from './dialect.js';
import { MODEL_SPEC_ERROR_CODES, modelSpecHint, didYouMean } from './error-hints.js';
import { nodeFs } from './node-fs.js';
import { desugarHierarchy } from './recursion.js';
import {
  SourceSpecSchema,
  TransformSpecSchema,
  getPublishTarget,
  getPublishTargetDatabase,
  getPublishTargetSchema,
} from './schemas.js';

import type { SupportedDialect } from './dialect.js';
import type {
  DataTest,
  DedupeSpec,
  DerivedColumn,
  ExpectSpec,
  MaterializationType,
  RecurseSpec,
  RefreshStrategy,
  SemanticRole,
  SourceDestinationOverride,
  SourceMode,
  SourceSpec,
  TrustConfig,
  TrustTier,
} from './schemas.js';
import type { HierarchyMeta } from './recursion.js';
import type { FileSystem } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Maps "connection.name" → fully-qualified table name from the source spec. */
export type SourceRegistry = Map<string, string>;

/** Maps "connection.name" → list of column names from the source spec schema. */
export type SourceColumnRegistry = Map<string, string[]>;

export type SourceEntryColumnType =
  'string' | 'integer' | 'number' | 'boolean' | 'timestamp' | 'array' | 'object';

const sourceColumnTypeMap: Record<string, SourceEntryColumnType> = {
  ARRAY: 'array',
  BIGDECIMAL: 'number',
  BIGNUMERIC: 'number',
  BIGINT: 'integer',
  BINARY: 'string',
  BOOL: 'boolean',
  BOOLEAN: 'boolean',
  BYTEINT: 'integer',
  BYTES: 'string',
  CHAR: 'string',
  CHARACTER: 'string',
  CLOB: 'string',
  DATE: 'timestamp',
  DATETIME: 'timestamp',
  DECIMAL: 'number',
  DOUBLE: 'number',
  'DOUBLE PRECISION': 'number',
  FIXED: 'number',
  FLOAT: 'number',
  FLOAT32: 'number',
  FLOAT64: 'number',
  GEOGRAPHY: 'object',
  GEOMETRY: 'object',
  INT: 'integer',
  INT16: 'integer',
  INT32: 'integer',
  INT64: 'integer',
  INT8: 'integer',
  INTEGER: 'integer',
  JSON: 'object',
  JSONB: 'object',
  LIST: 'array',
  MAP: 'object',
  NCHAR: 'string',
  NTEXT: 'string',
  NVARCHAR: 'string',
  NUMBER: 'number',
  NUMERIC: 'number',
  OBJECT: 'object',
  REAL: 'number',
  RECORD: 'object',
  REPEATED: 'array',
  SMALLINT: 'integer',
  STRING: 'string',
  STRUCT: 'object',
  TEXT: 'string',
  TIME: 'timestamp',
  TIMESTAMP: 'timestamp',
  TIMESTAMPTZ: 'timestamp',
  TIMESTAMP_LTZ: 'timestamp',
  TIMESTAMP_NTZ: 'timestamp',
  TIMESTAMP_TZ: 'timestamp',
  'TIMESTAMP WITH LOCAL TIME ZONE': 'timestamp',
  'TIMESTAMP WITH TIME ZONE': 'timestamp',
  'TIMESTAMP WITHOUT TIME ZONE': 'timestamp',
  TINYINT: 'integer',
  VARBINARY: 'string',
  VARIANT: 'object',
  VARCHAR: 'string',
};

export function bucketColumnType(type: string): SourceEntryColumnType {
  const normalized = normalizeSourceColumnType(type);
  if (normalized.endsWith('[]')) {
    return 'array';
  }
  return sourceColumnTypeMap[normalized] ?? 'string';
}

export interface SourceEntryColumn {
  name: string;
  sqlType: string;
  type: SourceEntryColumnType;
  description?: string;
  primary_key?: boolean;
  semantic_role?: SemanticRole;
  tags?: string[];
  unit?: string;
  format?: string;
  pii?: boolean;
  enum_values?: string[];
  examples?: unknown[];
  references?: string;
  business_rule?: string;
  quality_notes?: string;
  owner?: string;
  deprecated?: boolean;
  embedding_candidate?: boolean;
}

interface SourceColumnInput {
  name: string;
  type: string;
  description?: string;
  primary_key?: boolean;
  semantic_role?: SemanticRole;
  tags?: string[];
  unit?: string;
  format?: string;
  pii?: boolean;
  enum_values?: string[];
  examples?: unknown[];
  references?: string;
  business_rule?: string;
  quality_notes?: string;
  owner?: string;
  deprecated?: boolean;
  embedding_candidate?: boolean;
}

export type SourceRegistryEntry =
  | {
      kind: 'warehouse_table';
      /** Authored qualified source identity, preserving display case. */
      sourceRef?: string;
      sourceName?: string;
      fqRef: string;
      connection: string;
      columns: SourceEntryColumn[];
    }
  | {
      kind: 'api_resource';
      /** Authored qualified source identity, preserving display case. */
      sourceRef?: string;
      sourceName?: string;
      fqRef: `sources.${string}`;
      integration: string;
      resource: string;
      connection: string;
      filter?: Record<string, unknown>;
      maxAge?: string;
      mode?: SourceMode;
      refresh?: RefreshStrategy;
      destination?: SourceDestinationOverride;
      columns: SourceEntryColumn[];
    };

/** Maps authored "connection.name" keys to fully resolved source entries. */
export type SourceEntryRegistry = Map<string, SourceRegistryEntry>;

/** Canonical lookup key for a qualified Bobsled Core source reference. */
export function normalizeSourceRef(ref: string): string {
  return ref.trim().toLowerCase();
}

function getSourceRegistryValue<T>(
  registry: ReadonlyMap<string, T> | undefined,
  ref: string
): T | undefined {
  if (!registry) return undefined;
  const exact = registry.get(ref);
  if (exact !== undefined) return exact;
  const normalizedRef = normalizeSourceRef(ref);
  const normalized = registry.get(normalizedRef);
  if (normalized !== undefined) return normalized;
  for (const [key, value] of registry) {
    if (normalizeSourceRef(key) === normalizedRef) return value;
  }
  return undefined;
}

/** Case-insensitive source-entry lookup that preserves authored registry keys. */
export function getSourceEntry(
  registry: SourceEntryRegistry | undefined,
  ref: string
): SourceRegistryEntry | undefined {
  return getSourceRegistryValue(registry, ref);
}

/** Maps model name (lowercase) → fully-qualified table name ("SCHEMA.MODEL_NAME"). */
export type ModelRegistry = Map<string, string>;

export interface ResolvedColumn {
  name: string;
  expr: string;
  description?: string;
  type?: string;
  primary_key?: boolean;
  not_null?: boolean;
  semantic_role?: SemanticRole;
  references?: string;
  tags?: string[];
  unit?: string;
  format?: string;
  pii?: boolean;
  enum_values?: string[];
  examples?: unknown[];
  business_rule?: string;
  quality_notes?: string;
  owner?: string;
  deprecated?: boolean;
  embedding_candidate?: boolean;
}

export interface ResolvedJoin {
  fqTableName: string;
  ref: string;
  alias: string;
  type: 'left' | 'inner' | 'cross' | 'full';
  on: string;
  description?: string;
  preAggregate?: {
    group_by: string[];
    columns: Array<{ name: string; expr: string }>;
  };
}

export interface ResolvedFlattenJson {
  column?: string;
  input?: string;
  path?: string;
  alias?: string;
  outer?: boolean;
}

export interface ResolvedPivot {
  column: string;
  values: (string | number)[];
  aggregate: string;
  value_column: string;
}

export type SetOperation = 'union_all' | 'union' | 'intersect' | 'except' | 'minus';

export interface ResolvedUnpivot {
  columns: string[];
  exclude?: string[];
  field_name: string;
  value_name: string;
  cast_to?: string;
}

export interface ResolvedUnionBranch {
  fqTableName: string;
  ref: string;
  filter?: string;
  includeAllColumns?: boolean;
  excludeColumns?: string[];
  columns?: Array<{ name: string; expr: string }>;
  operation?: SetOperation;
}

export interface ResolvedTransformSpec {
  name: string;
  description: string;
  grain: string | string[];
  tags?: string[];
  owner?: string;
  publish?: string;
  trustTier: TrustTier;
  trustConfig?: TrustConfig;
  sourceRef: string;
  source: { fqTableName: string; alias: string; filter?: string; refKey?: string };
  joins: ResolvedJoin[];
  includeAllColumns?: boolean;
  excludeColumns?: string[];
  columns: ResolvedColumn[];
  distinct?: boolean;
  groupBy?: string[];
  where?: string;
  having?: string;
  qualify?: string;
  dedupe?: DedupeSpec;
  orderBy?: Array<{ column: string; direction?: 'asc' | 'desc'; nulls?: 'first' | 'last' }>;
  windows?: Array<{
    name: string;
    partitionBy?: string[];
    orderBy?: Array<{ column: string; direction?: 'asc' | 'desc'; nulls?: 'first' | 'last' }>;
    frame?: string;
  }>;
  limit?: number;
  offset?: number;
  derivedColumns?: DerivedColumn[];
  flattenJson?: ResolvedFlattenJson[];
  pivot?: ResolvedPivot;
  unpivot?: ResolvedUnpivot;
  union?: ResolvedUnionBranch[];
  recurse?: {
    spec: RecurseSpec;
    /** Physical table or CTE the recursive step joins in. */
    stepSourceTable: string;
    stepSourceRef: string;
    hierarchy?: HierarchyMeta;
  };
  materialization: MaterializationType;
  materializationConfig?: {
    strategy?: 'merge' | 'delete_insert' | 'append';
    unique_key?: string | string[];
    /**
     * Alias- and variable-substituted form of `incremental_filter`, ready for
     * SQL codegen (`buildWhereClause`/`transpileOrEmit`).
     */
    incremental_filter?: string;
    /**
     * Raw `incremental_filter` string from the authored YAML, before
     * `substitute()` rewrites `<ref>.<col>` qualifiers to compile-time
     * aliases. Persisted to `ModelRunState.incrementalFilter` so drift
     * comparisons stay stable across structural changes that don't touch
     * the filter itself (adding a join shifts every `t{n}` index;
     * reordering joins swaps aliases). Compare like-with-like across runs.
     */
    authored_incremental_filter?: string;
    cursor_field?: string;
    on_schema_change?: 'fail' | 'full_refresh';
    target_lag?: string;
    warehouse?: string;
    max_staleness?: string;
    // Snapshot (SCD Type 2) specific
    tracked_columns?: string[];
    valid_from_column?: string;
    valid_to_column?: string;
  };
  targetSchema?: string;
  targetDatabase?: string;
  preHook?: string[];
  postHook?: string[];
  tests?: DataTest[];
  expect?: ExpectSpec[];
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

function toSourceEntryColumns(columns: SourceColumnInput[]): SourceEntryColumn[] {
  return columns.map((column) => {
    const entry: SourceEntryColumn = {
      name: column.name,
      sqlType: column.type,
      type: bucketColumnType(column.type),
    };
    if (column.description !== undefined) entry.description = column.description;
    if (column.primary_key !== undefined) entry.primary_key = column.primary_key;
    if (column.semantic_role !== undefined) entry.semantic_role = column.semantic_role;
    if (column.tags !== undefined) entry.tags = column.tags;
    if (column.unit !== undefined) entry.unit = column.unit;
    if (column.format !== undefined) entry.format = column.format;
    if (column.pii !== undefined) entry.pii = column.pii;
    if (column.enum_values !== undefined) entry.enum_values = column.enum_values;
    if (column.examples !== undefined) entry.examples = column.examples;
    if (column.references !== undefined) entry.references = column.references;
    if (column.business_rule !== undefined) entry.business_rule = column.business_rule;
    if (column.quality_notes !== undefined) entry.quality_notes = column.quality_notes;
    if (column.owner !== undefined) entry.owner = column.owner;
    if (column.deprecated !== undefined) entry.deprecated = column.deprecated;
    if (column.embedding_candidate !== undefined) {
      entry.embedding_candidate = column.embedding_candidate;
    }
    return entry;
  });
}

function normalizeSourceColumnType(type: string): string {
  return type
    .trim()
    .toUpperCase()
    .replace(/<.*>$/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ');
}

export function resolveSourceEntry(
  spec: SourceSpec,
  options: { runtimeAlias?: string } = {}
): SourceRegistryEntry {
  const columns = toSourceEntryColumns(spec.schema.columns);
  const sourceRef = `${spec.connection}.${spec.name}`;
  if (spec.source_type === 'warehouse_table') {
    return {
      kind: 'warehouse_table',
      sourceRef,
      sourceName: spec.name,
      fqRef: spec.table,
      connection: spec.connection,
      columns,
    };
  }

  return {
    kind: 'api_resource',
    sourceRef,
    sourceName: spec.name,
    fqRef: `sources.${options.runtimeAlias ?? spec.name}`,
    integration: spec.integration,
    resource: spec.resource,
    connection: spec.connection,
    filter: spec.filter,
    maxAge: spec.max_age,
    mode: spec.mode,
    refresh: spec.refresh,
    destination: spec.destination,
    columns,
  };
}

function duplicateSourceNames(specs: readonly SourceSpec[]): Set<string> {
  const counts = new Map<string, number>();
  for (const spec of specs) {
    const name = spec.name.toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

/**
 * Build a deterministic SQL identifier from the full qualified source ref.
 * Hex encoding is deliberately reversible and collision-free for the authored
 * string, unlike replacing punctuation with underscores.
 */
function qualifiedApiSourceAlias(sourceRef: string): string {
  const encoded = [...normalizeSourceRef(sourceRef)]
    .map((character) => character.codePointAt(0)!.toString(16).padStart(4, '0'))
    .join('');
  return `__bobsled_source_${encoded}`;
}

export type SourceRegistryResult =
  | {
      ok: true;
      registry: SourceRegistry;
      columnRegistry: SourceColumnRegistry;
      entryRegistry: SourceEntryRegistry;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Scan one directory tree for source YAML files and build a registry
 * mapping "connection.name" → fully-qualified table name, and a column
 * registry mapping "connection.name" → list of column names. YAML that is not
 * a source spec is skipped. Project loaders use `buildIndexedSourceRegistry`,
 * which finds sources anywhere in the project.
 */
export function buildSourceRegistry(
  sourceDir: string,
  fsImpl: FileSystem = nodeFs
): SourceRegistryResult {
  if (!fsImpl.existsSync(sourceDir)) {
    return { ok: true, registry: new Map(), columnRegistry: new Map(), entryRegistry: new Map() };
  }

  const parsedSpecs: Array<{ filePath: string; spec: SourceSpec }> = [];
  for (const filePath of collectYamlFiles(sourceDir, [], fsImpl)) {
    const readResult = readYamlFile(filePath);
    if (!readResult.ok) {
      return { ok: false, error: `${filePath}: ${readResult.error}` };
    }

    const parsed = SourceSpecSchema.safeParse(readResult.data);
    if (!parsed.success) {
      // Skip non-source files silently (they might be other YAML)
      continue;
    }
    parsedSpecs.push({ filePath, spec: parsed.data });
  }
  return registerSourceSpecs(parsedSpecs);
}

/**
 * Build the source registries from every model source (`type: source`,
 * `spec_version: '0.2'`) in a project index, wherever it lives. Like
 * `buildSourceRegistry`, a source that fails its schema (for example one with
 * no `schema:` block) stays out of the registry; hosts such as Entity Graph
 * resolve those tables through their own fallback. An index with blocking
 * issues is refused.
 */
export function buildIndexedSourceRegistry(index: ProjectIndex): SourceRegistryResult {
  index = expandOssieIndex(index);
  assertValidProjectIndex(index);
  const parsedSpecs: Array<{ filePath: string; spec: SourceSpec }> = [];
  for (const entry of entriesOfKind(index, 'source')) {
    const parsed = SourceSpecSchema.safeParse(entry.document);
    if (parsed.success) {
      parsedSpecs.push({ filePath: entryFilePath(index, entry), spec: parsed.data });
    }
  }
  return registerSourceSpecs(parsedSpecs);
}

function registerSourceSpecs(
  parsedSpecs: ReadonlyArray<{ filePath: string; spec: SourceSpec }>
): SourceRegistryResult {
  const registry: SourceRegistry = new Map();
  const columnRegistry: SourceColumnRegistry = new Map();
  const entryRegistry: SourceEntryRegistry = new Map();
  const sourceRefToFile = new Map<string, string>();
  for (const { filePath, spec } of parsedSpecs) {
    const authoredKey = `${spec.connection}.${spec.name}`;
    const key = normalizeSourceRef(authoredKey);
    const existingFile = sourceRefToFile.get(key);
    if (existingFile) {
      return {
        ok: false,
        error: `${filePath}: Duplicate source ref "${authoredKey}" detected (case-insensitive); first defined in ${existingFile}. Source refs must be unique.`,
      };
    }
    sourceRefToFile.set(key, filePath);
  }

  const duplicateNames = duplicateSourceNames(parsedSpecs.map(({ spec }) => spec));
  for (const { filePath, spec } of parsedSpecs) {
    const authoredKey = `${spec.connection}.${spec.name}`;
    let entry: SourceRegistryEntry;
    try {
      entry = resolveSourceEntry(spec, {
        ...(spec.source_type === 'api_resource' && duplicateNames.has(spec.name.toLowerCase())
          ? { runtimeAlias: qualifiedApiSourceAlias(authoredKey) }
          : {}),
      });
    } catch (err) {
      return {
        ok: false,
        error: `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    registry.set(authoredKey, entry.fqRef);
    entryRegistry.set(authoredKey, entry);
    columnRegistry.set(
      authoredKey,
      spec.schema.columns.map((c) => c.name)
    );
  }

  return { ok: true, registry, columnRegistry, entryRegistry };
}

/**
 * File-less counterpart of `buildSourceRegistry`. Builds the same three
 * registries from already-parsed `SourceSpec` objects supplied by a host
 * application when source YAML is stored in a database rather than on disk.
 *
 * Without this, in-memory callers of `compileInMemory` / `dryRunInMemory` have
 * no way to supply `entryRegistry`, and BigQuery union models with
 * `include_all_columns: true` trip the `bigquery_union_drift_guard` because
 * the compiler can't look up source column lists.
 */
export function buildInMemorySourceEntryRegistry(specs: readonly SourceSpec[]):
  | {
      ok: true;
      registry: SourceRegistry;
      columnRegistry: SourceColumnRegistry;
      entryRegistry: SourceEntryRegistry;
    }
  | {
      ok: false;
      error: string;
    } {
  const registry: SourceRegistry = new Map();
  const columnRegistry: SourceColumnRegistry = new Map();
  const entryRegistry: SourceEntryRegistry = new Map();

  const duplicateNames = duplicateSourceNames(specs);
  const sourceRefs = new Set<string>();
  for (const spec of specs) {
    const authoredKey = `${spec.connection}.${spec.name}`;
    const key = normalizeSourceRef(authoredKey);
    if (sourceRefs.has(key)) {
      return {
        ok: false,
        error: `Duplicate source ref "${authoredKey}" detected (case-insensitive). Source refs must be unique.`,
      };
    }
    sourceRefs.add(key);
    let entry: SourceRegistryEntry;
    try {
      entry = resolveSourceEntry(spec, {
        ...(spec.source_type === 'api_resource' && duplicateNames.has(spec.name.toLowerCase())
          ? { runtimeAlias: qualifiedApiSourceAlias(authoredKey) }
          : {}),
      });
    } catch (err) {
      return {
        ok: false,
        error: `${authoredKey}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    registry.set(authoredKey, entry.fqRef);
    entryRegistry.set(authoredKey, entry);
    columnRegistry.set(
      authoredKey,
      spec.schema.columns.map((c) => c.name)
    );
  }

  return { ok: true, registry, columnRegistry, entryRegistry };
}

/**
 * Return the subset of a source registry whose keys start with
 * `<handle>.` — the prefix encodes the integration handle each source was
 * declared under. Used by the multi-integration compile loop so each
 * integration's compile sees only its own sources.
 */
export function filterSourceRegistry(registry: SourceRegistry, handle: string): SourceRegistry {
  const prefix = `${handle.toLowerCase()}.`;
  const filtered: SourceRegistry = new Map();
  for (const [key, value] of registry) {
    if (normalizeSourceRef(key).startsWith(prefix)) filtered.set(key, value);
  }
  return filtered;
}

export function filterSourceEntryRegistry(
  registry: SourceEntryRegistry,
  handle: string
): SourceEntryRegistry {
  const prefix = `${handle.toLowerCase()}.`;
  const filtered: SourceEntryRegistry = new Map();
  for (const [key, value] of registry) {
    if (normalizeSourceRef(key).startsWith(prefix)) filtered.set(key, value);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a ref string to a fully-qualified table name.
 *
 * - Dotted refs (e.g. "ecom.raw_orders") → source registry lookup.
 * - Bare refs (e.g. "stg_orders") → model registry lookup (if provided).
 */
export function resolveRef(
  ref: string,
  sourceRegistry: SourceRegistry,
  modelRegistry?: ModelRegistry
): { ok: true; fqTableName: string } | { ok: false; error: string } {
  const isDotted = ref.includes('.');
  const normalizedRef = normalizeSourceRef(ref);

  if (isDotted) {
    const fqTableName = getSourceRegistryValue(sourceRegistry, normalizedRef);
    if (!fqTableName) {
      const available = [...sourceRegistry.keys()].join(', ') || '(none)';
      const suggestion = didYouMean(ref, sourceRegistry.keys(), 3);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
      return {
        ok: false,
        error: modelSpecHint(
          MODEL_SPEC_ERROR_CODES.UNRESOLVED_REF_WITH_HINT,
          `Unknown source ref "${ref}".${hint} Available: ${available}`
        ),
      };
    }
    return { ok: true, fqTableName };
  }

  // Bare ref → model registry
  if (modelRegistry) {
    const fqTableName = modelRegistry.get(ref.toLowerCase());
    if (fqTableName) {
      return { ok: true, fqTableName };
    }
  }

  // Fallback: try source registry (backward compat for old-style refs)
  const fqTableName = getSourceRegistryValue(sourceRegistry, normalizedRef);
  if (fqTableName) {
    return { ok: true, fqTableName };
  }

  // Build a "did you mean" hint that searches BOTH registries. When a bare
  // ref's tail matches a source's tail (e.g. user wrote `orders` but the
  // source is `ecom.orders`), surface the integration-qualified form
  // explicitly — agent hosts can otherwise confuse these values.
  const modelNames = modelRegistry ? [...modelRegistry.keys()] : [];
  const sourceKeys = [...sourceRegistry.keys()];
  const available = [...modelNames, ...sourceKeys].join(', ') || '(none)';

  const lowerRef = ref.toLowerCase();
  const qualifiedSource = sourceKeys.find((k) => k.toLowerCase().endsWith(`.${lowerRef}`));
  const fuzzyAcrossAll = didYouMean(ref, [...modelNames, ...sourceKeys], 2);

  let hint = '';
  if (qualifiedSource) {
    hint = ` Did you mean source "${qualifiedSource}"? Sources need the integration prefix (e.g. \`source: { ref: ${qualifiedSource} }\`); bare names resolve only to models.`;
  } else if (fuzzyAcrossAll) {
    hint = ` Did you mean "${fuzzyAcrossAll}"?`;
  }

  return {
    ok: false,
    error: modelSpecHint(
      MODEL_SPEC_ERROR_CODES.UNRESOLVED_REF_WITH_HINT,
      `Unknown ref "${ref}".${hint} Available: ${available}`
    ),
  };
}

/**
 * Build a model registry mapping model name → fully-qualified table name.
 *
 * Accepts optional per-model schema overrides. When a model has a `targetSchema`
 * (and optionally `targetDatabase`), its FQ name uses those instead of the global schema.
 */
export function buildModelRegistry(
  modelNames: string[],
  targetSchema: string,
  dialect: SupportedDialect = 'snowflake',
  modelOverrides?: Map<string, { targetSchema?: string; targetDatabase?: string }>
): ModelRegistry {
  const registry: ModelRegistry = new Map();
  for (const name of modelNames) {
    const override = modelOverrides?.get(name.toLowerCase());
    const schema = override?.targetSchema ?? targetSchema;
    const database = override?.targetDatabase;
    let fqName: string;
    if (database) {
      // 3-part name: database.schema.table (uses quoting)
      fqName = buildFqNameWithDatabase(schema, name, dialect, database);
    } else {
      // 2-part name: schema.table (uses caseName for backward compat)
      fqName = `${caseName(schema, dialect)}.${caseName(name, dialect)}`;
    }
    registry.set(name.toLowerCase(), fqName);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Ref-to-alias replacement
// ---------------------------------------------------------------------------

/**
 * Replace ref-based qualifiers with auto-generated aliases in an expression.
 * E.g. "stg_orders.CUSTOMER_ID" → "t0.CUSTOMER_ID"
 *
 * Ref names are sorted longest-first to avoid partial replacements.
 */
/** Pre-compiled ref replacer: avoids creating RegExp per ref per call. */
function buildRefReplacer(refAliasMap: Map<string, string>): (expr: string) => string {
  const refs = [...refAliasMap.keys()].sort((a, b) => b.length - a.length);
  const compiled = refs.map((ref) => ({
    pattern: new RegExp(`(?<!\\w)${ref.replace(/\./g, '\\.')}\\.`, 'g'),
    alias: getOrThrow(refAliasMap, ref, 'refAliasMap'),
  }));
  return (expr: string) => {
    let result = expr;
    for (const { pattern, alias } of compiled) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, `${alias}.`);
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/** Replace $varName references with literal values from variables map. */
function buildVarReplacer(
  variables: Record<string, string | number | boolean>
): (expr: string) => string {
  // Sort keys longest-first to avoid partial replacements
  const keys = Object.keys(variables).sort((a, b) => b.length - a.length);
  const compiled = keys.map((key) => ({
    pattern: new RegExp(`\\$${key}(?!\\w)`, 'g'),
    value: variables[key]!,
  }));
  return (expr: string) => {
    let result = expr;
    for (const { pattern, value } of compiled) {
      pattern.lastIndex = 0;
      const sqlLiteral =
        typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : quoteLiteral(value);
      result = result.replace(pattern, sqlLiteral);
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Transform spec parsing
// ---------------------------------------------------------------------------

/**
 * Parse and validate a transform spec file, resolving all refs
 * to fully-qualified table names.
 */
export function parseTransformSpec(
  filePath: string,
  registry: SourceRegistry,
  modelRegistry?: ModelRegistry
): { ok: true; spec: ResolvedTransformSpec } | { ok: false; error: string } {
  const readResult = readYamlFileWithContent(filePath);
  if (!readResult.ok) {
    return { ok: false, error: readResult.error };
  }

  const parsed = TransformSpecSchema.safeParse(readResult.data.data);
  if (!parsed.success) {
    const positionMap = buildPositionMap(readResult.data.content);
    const formatted = formatZodErrorWithPositions(parsed.error, positionMap, filePath);
    return { ok: false, error: `Validation failed:\n${formatted}` };
  }

  return parseTransformSpecFromParsed(parsed.data, registry, modelRegistry);
}

/**
 * Resolve refs in an already-parsed TransformSpec to produce a ResolvedTransformSpec.
 *
 * Generates auto-aliases (t0 for source, t1/t2/... for joins) and replaces
 * ref-based qualifiers in column expressions, ON clauses, and filters.
 */
export function parseTransformSpecFromParsed(
  spec: ModelSpec,
  registry: SourceRegistry,
  modelRegistry?: ModelRegistry
): { ok: true; spec: ResolvedTransformSpec } | { ok: false; error: string } {
  if (spec.model_kind === 'agentic') {
    return {
      ok: false,
      error: 'Agentic models require agentic dispatch and cannot compile as SQL',
    };
  }
  // Rewrite hierarchy before resolving SQL models so both recursive operators
  // share one resolution and codegen path.
  const desugared = desugarHierarchy(spec);
  spec = desugared.spec;

  // Resolve primary source ref
  const sourceResult = resolveRef(spec.source.ref, registry, modelRegistry);
  if (!sourceResult.ok) {
    return { ok: false, error: `source.ref: ${sourceResult.error}` };
  }

  // The recursive step reads a table too; it defaults to the model's own source.
  let resolvedRecurse: ResolvedTransformSpec['recurse'];
  if (spec.recurse) {
    const stepRef = spec.recurse.step.source.ref ?? spec.source.ref;
    const stepResult = resolveRef(stepRef, registry, modelRegistry);
    if (!stepResult.ok) {
      return { ok: false, error: `recurse.step.source.ref: ${stepResult.error}` };
    }
    resolvedRecurse = {
      spec: spec.recurse,
      stepSourceTable: stepResult.fqTableName,
      stepSourceRef: stepRef,
      ...(desugared.hierarchy ? { hierarchy: desugared.hierarchy } : {}),
    };
  }

  // Resolve join refs
  const resolvedJoins: ResolvedJoin[] = [];
  for (const join of spec.joins) {
    const joinResult = resolveRef(join.ref, registry, modelRegistry);
    if (!joinResult.ok) {
      return { ok: false, error: `joins: ${joinResult.error}` };
    }
    resolvedJoins.push({
      fqTableName: joinResult.fqTableName,
      ref: join.ref,
      alias: '', // placeholder, assigned below
      type: join.type,
      on: join.on,
      description: join.description,
      preAggregate: join.pre_aggregate
        ? {
            group_by: join.pre_aggregate.group_by,
            columns: join.pre_aggregate.columns,
          }
        : undefined,
    });
  }

  // Resolve union branch refs
  let resolvedUnion: ResolvedUnionBranch[] | undefined;
  if (spec.union && spec.union.length > 0) {
    resolvedUnion = [];
    for (const branch of spec.union) {
      const branchResult = resolveRef(branch.ref, registry, modelRegistry);
      if (!branchResult.ok) {
        return { ok: false, error: `union: ${branchResult.error}` };
      }
      resolvedUnion.push({
        fqTableName: branchResult.fqTableName,
        ref: branch.ref,
        filter: branch.filter,
        includeAllColumns: branch.include_all_columns,
        excludeColumns: branch.exclude_columns,
        columns: branch.columns,
        operation: branch.operation,
      });
    }
  }

  // Build ref-to-alias map: source → t0, joins → t1, t2, ...
  const refAliasMap = new Map<string, string>();
  refAliasMap.set(spec.source.ref, 't0');
  for (const [i, join] of spec.joins.entries()) {
    refAliasMap.set(join.ref, `t${i + 1}`);
  }

  // Pre-compile ref replacement patterns (once per model, reused across all expressions)
  const replaceRefs = buildRefReplacer(refAliasMap);

  // Variable substitution: replace $varName with literal values
  const replaceVars = spec.variables ? buildVarReplacer(spec.variables) : (s: string) => s;

  // Composed substitution: variables → ref aliases (order matters)
  const substitute = (s: string) => replaceRefs(replaceVars(s));
  const substituteOptional = (s?: string) => (s ? substitute(s) : undefined);

  const publishTarget = getPublishTarget(spec.publish);
  const publishTargetSchema = getPublishTargetSchema(spec.publish);
  const publishTargetDatabase = getPublishTargetDatabase(spec.publish);

  // Assign auto-generated aliases and replace ref qualifiers in ON clauses
  for (const join of resolvedJoins) {
    join.alias = getOrThrow(refAliasMap, join.ref, 'refAliasMap join alias');
    join.on = substitute(join.on);
  }

  // Replace ref qualifiers in column expressions
  const columns = spec.columns.map((col) => ({
    ...col,
    expr: substitute(col.expr),
  }));

  // Replace ref qualifiers in source filter
  const filter = substituteOptional(spec.source.filter);

  // Apply variable + ref substitution to where, having, qualify clauses
  const where = substituteOptional(spec.where);
  const having = substituteOptional(spec.having);
  const qualify = substituteOptional(spec.qualify);
  const flattenJson = spec.flatten_json
    ? (Array.isArray(spec.flatten_json) ? spec.flatten_json : [spec.flatten_json]).map(
        (flatten) => ({
          column: flatten.column,
          input: substituteOptional(flatten.input),
          path: flatten.path,
          alias: flatten.alias,
          outer: flatten.outer,
        })
      )
    : undefined;

  return {
    ok: true,
    spec: {
      name: spec.name,
      description: spec.description,
      grain: spec.grain,
      tags: spec.tags,
      owner: spec.owner,
      publish: publishTarget,
      trustTier: spec.trust_tier,
      trustConfig: spec.trust_config,
      sourceRef: spec.source.ref,
      source: {
        fqTableName: sourceResult.fqTableName,
        alias: getOrThrow(refAliasMap, spec.source.ref, 'refAliasMap source alias'),
        filter,
        refKey: spec.source.ref,
      },
      joins: resolvedJoins,
      includeAllColumns: spec.include_all_columns,
      excludeColumns: spec.exclude_columns,
      columns,
      distinct: spec.distinct,
      groupBy: spec.group_by?.map((g) => substitute(g)),
      where,
      having,
      qualify,
      dedupe: spec.dedupe,
      orderBy: spec.order_by,
      windows: spec.windows?.map((w) => ({
        name: w.name,
        partitionBy: w.partition_by?.map((p) => substitute(p)),
        orderBy: w.order_by?.map((o) => ({ ...o, column: substitute(o.column) })),
        frame: w.frame ? substitute(w.frame) : undefined,
      })),
      limit: spec.limit,
      offset: spec.offset,
      ...(resolvedRecurse ? { recurse: resolvedRecurse } : {}),
      derivedColumns: spec.derived_columns?.map((dc) => ({
        ...dc,
        expr: substitute(dc.expr),
      })),
      flattenJson,
      pivot: spec.pivot
        ? {
            column: spec.pivot.column,
            values: spec.pivot.values,
            aggregate: spec.pivot.aggregate,
            value_column: spec.pivot.value_column,
          }
        : undefined,
      unpivot: spec.unpivot
        ? {
            columns: spec.unpivot.columns,
            exclude: spec.unpivot.exclude,
            field_name: spec.unpivot.field_name,
            value_name: spec.unpivot.value_name,
            cast_to: spec.unpivot.cast_to,
          }
        : undefined,
      union: resolvedUnion,
      materialization: spec.materialization.type,
      materializationConfig:
        spec.materialization.type === 'incremental'
          ? {
              strategy: spec.materialization.strategy,
              unique_key: spec.materialization.unique_key,
              // `incremental_filter` is part of the model's expression vocabulary
              // (same as `expr`, `on`, `where`, `having`, `qualify`, etc.) and
              // must go through the same ref → alias substitution. Without this,
              // a filter like `stg_customers.signup_date > self.signup_date`
              // compiles to `STG_CUSTOMERS.SIGNUP_DATE > ...` and Snowflake (and
              // every other dialect) errors on an unaliased table name in a
              // SELECT that joined under `t0`/`t1`. `unique_key` is intentionally
              // *not* substituted — it names this model's own output columns,
              // not source-side identifiers.
              incremental_filter: substituteOptional(spec.materialization.incremental_filter),
              // Authored form sits next to the substituted one so codegen can
              // keep using the alias-resolved value while `buildConfigSnapshot`
              // (in run-project.ts) persists the unrewritten form to state.
              // Drift checks then compare like-with-like across runs even when
              // structural changes (new joins, etc.) shift the alias scheme.
              authored_incremental_filter: spec.materialization.incremental_filter,
              // `cursor_field` is constrained by the schema to a bare
              // identifier (`/^[a-zA-Z_]\w*$/`), so the dotted form that
              // broke `incremental_filter` can't reach this point today.
              // Route it through `substitute()` anyway so the two related
              // fields share one code path — if the schema is ever relaxed
              // to accept `<ref>.<col>`, this gets the right behavior for
              // free instead of becoming a second bug-fix PR.
              cursor_field: substituteOptional(spec.materialization.cursor_field),
              on_schema_change: spec.materialization.on_schema_change,
            }
          : spec.materialization.type === 'snapshot'
            ? {
                unique_key: spec.materialization.unique_key,
                tracked_columns: spec.materialization.tracked_columns,
                valid_from_column: spec.materialization.valid_from_column,
                valid_to_column: spec.materialization.valid_to_column,
                on_schema_change: spec.materialization.on_schema_change,
              }
            : spec.materialization.type === 'dynamic_table'
              ? {
                  target_lag: spec.materialization.target_lag,
                  warehouse: spec.materialization.warehouse,
                }
              : spec.materialization.type === 'materialized_view'
                ? {
                    max_staleness: spec.materialization.max_staleness,
                  }
                : undefined,
      targetSchema: publishTargetSchema ?? spec.target_schema,
      targetDatabase: publishTargetDatabase ?? spec.target_database,
      preHook: spec.pre_hook,
      postHook: spec.post_hook,
      tests: spec.tests,
      expect: spec.expect,
    },
  };
}
