/**
 * Shared compile loop: iterates DAG nodes in topological order,
 * handles ephemeral CTE tracking, and collects results/errors.
 *
 * Used by the `@bobsled-inc/model-spec` compile command and exposed
 * through `@bobsled-inc/dogsled`'s subprocess delegation.
 */

import { AgenticModelSpecSchema, getModelOutputColumns } from '../agentic/model.js';
import { buildMetadataHeader, generateSelectSql, generateSql } from './codegen.js';
import { materializeSql } from './materializer.js';
import { parseTransformSpecFromParsed } from './parser.js';

import type { DagNode } from './dag.js';
import type { SupportedDialect } from './dialect.js';
import { getSourceEntry } from './parser.js';
import type {
  ModelRegistry,
  ResolvedTransformSpec,
  SourceEntryRegistry,
  SourceRegistry,
} from './parser.js';
import type { CompileResult } from './schemas.js';

/**
 * Track an ephemeral model's SELECT SQL for CTE inlining in downstream models.
 */
export function trackEphemeralModel(
  node: DagNode,
  selectSql: string,
  modelReg: ModelRegistry,
  ephemeralSqlMap: Map<string, string>
): void {
  const fqTableName = modelReg.get(node.name.toLowerCase());
  if (fqTableName) {
    ephemeralSqlMap.set(fqTableName, selectSql);
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompileAllOptions {
  dialect: SupportedDialect;
  targetSchema: string;
  /** Target database for DDL generation (e.g., Snowflake). Omit for single-database providers like Postgres. */
  targetDatabase?: string;
  /** Default Snowflake warehouse for dynamic table DDL, derived from the active integration. */
  defaultDynamicTableWarehouse?: string;
  sourceDialect?: SupportedDialect;
  isFullRefresh?: boolean;
  strict?: boolean;
  warnings?: boolean;
  /** When true, emit SELECT-only SQL (no DDL wrapper). Used for preview. */
  selectOnly?: boolean;
  entryRegistry?: SourceEntryRegistry;
  /**
   * Inline upstream model dependencies as CTEs instead of referencing them by
   * fully-qualified physical name. Two forms:
   *
   *   - `true` — inline every upstream model in the DAG.
   *   - `Set<string>` — inline only models whose name appears (case-insensitive)
   *     in the set. Everything else is referenced by physical name.
   *
   * Sources are never inlined (they're the anchor refs into the warehouse).
   *
   * Useful for "dry run" tooling where the agent is drafting multiple
   * interdependent models that don't yet exist in the warehouse — inlining
   * them lets the resulting SQL be executed against the warehouse as a
   * single self-contained statement.
   *
   * Caveats for stateful upstream materializations (incremental, snapshot,
   * dynamic_table): inlining drops MERGE/SCD-2/incremental_filter semantics
   * and turns the upstream into a one-shot SELECT. The exploded SQL is
   * suitable for syntactic / schema validation, not for parity with what
   * `dogsled model run` would actually do.
   */
  inlineDeps?: boolean | ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Core compile loop
// ---------------------------------------------------------------------------

/**
 * Compile an ordered set of DAG nodes into SQL results.
 *
 * Handles:
 * - Ephemeral model tracking (CTE inlining)
 * - Per-node parse + generateSql
 * - Error collection (non-fatal per model)
 * - Warning aggregation when `options.warnings` is true
 */
export function compileAll(
  orderedNodes: DagNode[],
  registry: SourceRegistry,
  modelReg: ModelRegistry,
  options: CompileAllOptions
): CompileResult[] {
  const { dialect, targetSchema } = options;

  const results: CompileResult[] = [];
  const cteSqlMap = new Map<string, string>();

  // Normalize the inline set to lowercase once up front. DAG node names are
  // canonicalized to lowercase, so this keeps the membership test O(1) without
  // re-allocating per node.
  const inlineSetLower =
    options.inlineDeps && options.inlineDeps !== true
      ? new Set([...options.inlineDeps].map((s) => s.toLowerCase()))
      : undefined;
  const shouldInline = (name: string): boolean => {
    if (!options.inlineDeps) return false;
    if (options.inlineDeps === true) return true;
    return inlineSetLower!.has(name.toLowerCase());
  };

  for (const node of orderedNodes) {
    const parseResult = parseTransformSpecFromParsed(node.parsedSpec, registry, modelReg);
    if (!parseResult.ok) {
      results.push({ ok: false, error: parseResult.error, modelName: node.name });
      continue;
    }

    const { spec } = parseResult;
    const modelWarnings: string[] = [];

    try {
      // Ephemeral models: store SELECT SQL for CTE inlining, don't emit DDL
      if (node.materialization === 'ephemeral') {
        const selectSql = generateSelectSql(spec, dialect, cteSqlMap, {
          warnings: modelWarnings,
          strict: options.strict,
          entryRegistry: options.entryRegistry,
        });
        trackEphemeralModel(node, selectSql, modelReg, cteSqlMap);
        continue;
      }

      // Non-ephemeral: when inlineDeps applies, generate the SELECT once and
      // track it before deciding how to wrap output, so downstream nodes can
      // substitute this model's `fqTableName` with a CTE reference instead of
      // a warehouse-physical name.
      const inlineThis = shouldInline(node.name);
      let sql: string;

      if (inlineThis) {
        const effectiveSchema = spec.targetSchema ?? targetSchema;
        const effectiveDatabase = spec.targetDatabase ?? options.targetDatabase;
        const selectSql = generateSelectSql(spec, dialect, cteSqlMap, {
          warnings: modelWarnings,
          strict: options.strict,
          targetSchema: effectiveSchema,
          targetDatabase: effectiveDatabase,
          entryRegistry: options.entryRegistry,
        });
        trackEphemeralModel(node, selectSql, modelReg, cteSqlMap);

        if (options.selectOnly) {
          sql = selectSql;
        } else {
          const header = buildMetadataHeader(spec);
          const ddlStatements = materializeSql(
            selectSql,
            spec,
            effectiveSchema,
            dialect,
            { defaultDynamicTableWarehouse: options.defaultDynamicTableWarehouse },
            effectiveDatabase
          );
          sql =
            ddlStatements.length === 0
              ? ''
              : ddlStatements.map((s) => `${header}${s}`).join('\n\n');
        }
      } else {
        // Honor per-model overrides on selectOnly too — `generateSql` resolves
        // these internally, but `generateSelectSql` doesn't, so without this
        // the selectOnly path would emit a 2-part or wrong-schema `self`.
        const effectiveSchema = spec.targetSchema ?? targetSchema;
        const effectiveDatabase = spec.targetDatabase ?? options.targetDatabase;
        sql = options.selectOnly
          ? generateSelectSql(spec, dialect, cteSqlMap, {
              warnings: modelWarnings,
              strict: options.strict,
              targetSchema: effectiveSchema,
              targetDatabase: effectiveDatabase,
              entryRegistry: options.entryRegistry,
            })
          : generateSql(spec, targetSchema, dialect, cteSqlMap, {
              warnings: modelWarnings,
              strict: options.strict,
              targetDatabase: options.targetDatabase,
              defaultDynamicTableWarehouse: options.defaultDynamicTableWarehouse,
              entryRegistry: options.entryRegistry,
            });
      }

      results.push({
        ok: true,
        sql,
        modelName: spec.name,
        warnings: modelWarnings.length > 0 ? modelWarnings : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ ok: false, error: message, modelName: node.name });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidateModelResult {
  name: string;
  columnCount: number;
  errors: string[];
  warnings: string[];
}

export interface ValidateAllOptions {
  dialect: SupportedDialect;
  strict?: boolean;
  entryRegistry?: SourceEntryRegistry;
  semanticCheck?: 'warn' | 'strict';
}

/**
 * Validate all DAG nodes without generating DDL.
 * Returns per-model validation results with errors and warnings.
 */
export function validateAll(
  orderedNodes: DagNode[],
  registry: SourceRegistry,
  modelReg: ModelRegistry,
  options: ValidateAllOptions
): ValidateModelResult[] {
  const { dialect, strict = true } = options;
  const results: ValidateModelResult[] = [];
  const ephemeralSqlMap = new Map<string, string>();

  for (const node of orderedNodes) {
    const modelResult: ValidateModelResult = {
      name: node.name,
      columnCount: 0,
      errors: [],
      warnings: [],
    };

    if (node.parsedSpec.model_kind === 'agentic') {
      const parsed = AgenticModelSpecSchema.safeParse(node.parsedSpec);
      if (!parsed.success) modelResult.errors.push(parsed.error.message);
      modelResult.columnCount = getModelOutputColumns(node.parsedSpec).length;
      for (const ref of [...node.refs, ...node.sourceRefs]) {
        if (
          !modelReg.has(ref.toLowerCase()) &&
          ![...registry.keys()].some((key) => key.toLowerCase() === ref.toLowerCase())
        ) {
          modelResult.errors.push(`Unknown agentic input "${ref}"`);
        }
      }
      results.push(modelResult);
      continue;
    }

    const parseResult = parseTransformSpecFromParsed(node.parsedSpec, registry, modelReg);
    if (!parseResult.ok) {
      modelResult.errors.push(parseResult.error);
      results.push(modelResult);
      continue;
    }

    const { spec } = parseResult;
    modelResult.columnCount = spec.columns.length;

    const modelWarnings: string[] = [];
    try {
      const selectSql = generateSelectSql(spec, dialect, ephemeralSqlMap, {
        warnings: modelWarnings,
        strict,
        entryRegistry: options.entryRegistry,
      });
      if (node.materialization === 'ephemeral') {
        trackEphemeralModel(node, selectSql, modelReg, ephemeralSqlMap);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      modelResult.errors.push(message);
    }

    modelResult.warnings.push(...modelWarnings);
    applySemanticValidation(spec, options, modelResult);

    // Grain cross-check
    const grainValues = Array.isArray(spec.grain) ? spec.grain : [spec.grain];
    const columnNames = new Set(spec.columns.map((c) => c.name.toLowerCase()));
    for (const g of grainValues) {
      if (!columnNames.has(g.toLowerCase())) {
        modelResult.warnings.push(
          `Grain "${g}" does not match any column name — verify it refers to an upstream column`
        );
      }
    }

    results.push(modelResult);
  }

  return results;
}

function applySemanticValidation(
  spec: ResolvedTransformSpec,
  options: ValidateAllOptions,
  result: ValidateModelResult
): void {
  if (!options.semanticCheck) return;

  const findings: string[] = [];
  const add = (message: string) => findings.push(`semantic: ${message}`);

  const sourceEntry = getSourceEntry(options.entryRegistry, spec.source.refKey ?? spec.sourceRef);
  const sourceColumns = new Map(
    sourceEntry?.columns.map((column) => [column.name.toLowerCase(), column]) ?? []
  );

  for (const column of sourceEntry?.columns ?? []) {
    if (!column.description) {
      add(`source ${spec.sourceRef}.${column.name} is missing description`);
    }
    if (!column.semantic_role) {
      add(`source ${spec.sourceRef}.${column.name} is missing semantic_role`);
    }
  }

  for (const column of spec.columns) {
    if (!column.description) {
      add(`model ${spec.name}.${column.name} is missing description`);
    }
    if (!column.semantic_role) {
      add(`model ${spec.name}.${column.name} is missing semantic_role`);
    }

    const sourceColumnName = directSourceColumnName(column.expr, spec.source.alias);
    if (!sourceColumnName) continue;
    const sourceColumn = sourceColumns.get(sourceColumnName.toLowerCase());
    if (!sourceColumn) continue;

    if (
      sourceColumn.description &&
      column.description &&
      normalizeMetadataText(sourceColumn.description) !== normalizeMetadataText(column.description)
    ) {
      add(
        `metadata divergence for ${spec.name}.${column.name}: description differs from source ${spec.sourceRef}.${sourceColumn.name}`
      );
    }

    if (
      sourceColumn.semantic_role &&
      column.semantic_role &&
      sourceColumn.semantic_role !== column.semantic_role
    ) {
      add(
        `metadata divergence for ${spec.name}.${column.name}: semantic_role ${column.semantic_role} differs from source ${spec.sourceRef}.${sourceColumn.name} (${sourceColumn.semantic_role})`
      );
    }
  }

  if (options.semanticCheck === 'strict') {
    result.errors.push(...findings);
  } else {
    result.warnings.push(...findings);
  }
}

function normalizeMetadataText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

const DIRECT_COLUMN_RE =
  /^(?:(?<table>[A-Za-z_]\w*)\.)?(?:"(?<dq>[^"]+)"|`(?<bt>[^`]+)`|(?<bare>[A-Za-z_]\w*))$/;

function directSourceColumnName(expr: string, sourceAlias: string): string | undefined {
  const trimmed = expr.trim();
  const match = DIRECT_COLUMN_RE.exec(trimmed);
  if (!match?.groups) return undefined;
  const table = match.groups['table'];
  if (table && table.toLowerCase() !== sourceAlias.toLowerCase()) return undefined;
  return match.groups['dq'] ?? match.groups['bt'] ?? match.groups['bare'];
}
