import { validateOssieBindings } from './ossie-bindings.js';
/**
 * Per-integration compile-context assembly — neutral module shared by the
 * CLI layer (`commands/common.ts`) and the programmatic `/project` API
 * (`api/load-project.ts`, `api/run-project.ts`).
 *
 * Lives here (not in `commands/`) so the Layer 3 orchestrators never have
 * to import from the CLI surface. No Commander, no runner loading, no
 * stderr formatting.
 */

import { getModelOutputColumns } from '../agentic/model.js';
import { bucketColumnType } from '../compiler/parser.js';
import {
  buildModelRegistry,
  getCanonicalDialect,
  type DagNode,
  type ModelRegistry,
} from '../compiler/index.js';
import { CommandError } from '../errors.js';
import { getPublishTargetDatabase } from '../compiler/publish-execution.js';

import type { ResolvedIntegration } from '../integrations.js';
import type { SourceEntryRegistry, SourceRegistry, SupportedDialect } from '../compiler/index.js';

export interface DagContext {
  orderedNodes: DagNode[];
  registry: SourceRegistry;
  entryRegistry: SourceEntryRegistry;
}

/**
 * Per-integration slice of a compile context. Identical to the legacy
 * single-integration `CompileContext` fields that vary per integration —
 * DAG nodes, source registry, model registry, dialect, schema, and the
 * resolved integration itself.
 */
export interface IntegrationCompileContext extends DagContext {
  dialect: SupportedDialect;
  targetSchema: string;
  targetDatabase?: string;
  targetWarehouse?: string;
  integration: ResolvedIntegration;
  modelReg: ModelRegistry;
}

const schemaRegex = /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/;

/** Validate that a schema name is a safe identifier (e.g. PUBLIC, my_schema, project.dataset). */
export function validateSchema(schema: string): string {
  if (!schemaRegex.test(schema)) {
    throw new CommandError(
      `Invalid schema name "${schema}" — must be a valid identifier (e.g. PUBLIC, my_schema)`
    );
  }
  return schema;
}

const POSTGRES_DIALECTS = new Set<SupportedDialect>(['postgres', 'pgvector', 'redshift']);

/**
 * Assemble one integration's compile context from a shared DAG + registry.
 * Used by `buildMultiCompileContext` (CLI) and `selectIntegrationContexts`
 * (programmatic API) to produce identical per-integration slices.
 *
 * `nodes` is the EXECUTION set — the models that get materialized (DDL emitted,
 * state written). `registryNodes` is the REF-RESOLUTION set — every model whose
 * physical name a `ref` might need to resolve to; it defaults to `nodes` but
 * must be the FULL project model set when a selection narrows execution, so a
 * selected model's ref to an unselected upstream still resolves to that
 * upstream's physical table (dbt parity for exact selection). The model
 * registry + per-model target overrides are built from `registryNodes`; the
 * Postgres cross-database guard runs over them too.
 */
export function buildIntegrationContext(
  integration: ResolvedIntegration,
  nodes: DagNode[],
  registry: SourceRegistry,
  entryRegistry: SourceEntryRegistry,
  registryNodes: DagNode[] = nodes
): IntegrationCompileContext {
  const targetSchema = validateSchema(integration.targetSchema);

  const modelOverrides = new Map<string, { targetSchema?: string; targetDatabase?: string }>();
  for (const node of registryNodes) {
    const spec = node.parsedSpec;
    if (spec.target_database && POSTGRES_DIALECTS.has(integration.dialect)) {
      throw new CommandError(
        `Model "${node.name}" sets \`target_database\` but the active integration ` +
          `"${integration.handle}" uses dialect "${integration.dialect}". Postgres-family ` +
          `dialects do not support cross-database DDL — remove \`target_database\` from the ` +
          `model or point at an integration whose dialect does (snowflake / bigquery / databricks / duckdb).`,
        2
      );
    }
    for (const [field, value] of [
      ['target_database', spec.target_database],
      ['publish.target_database', getPublishTargetDatabase(spec.publish)],
    ] as const) {
      if (value?.includes('-') && getCanonicalDialect(integration.dialect) !== 'bigquery') {
        throw new CommandError(
          `Model "${node.name}" sets \`${field}\` to "${value}", but only ` +
            `BigQuery project ids may contain hyphens. The active integration ` +
            `"${integration.handle}" uses dialect "${integration.dialect}"; use letters, digits, ` +
            `and underscores.`,
          2
        );
      }
    }
    modelOverrides.set(node.name.toLowerCase(), {
      targetSchema: spec.target_schema,
      targetDatabase: spec.target_database ?? integration.targetDatabase,
    });
  }

  const modelReg = buildModelRegistry(
    registryNodes.map((n) => n.name),
    targetSchema,
    integration.dialect,
    modelOverrides.size > 0 ? modelOverrides : undefined
  );

  validateOssieBindings(registryNodes, modelReg, integration.dialect);

  const registeredEntries = new Map(entryRegistry);
  for (const node of registryNodes) {
    if (node.parsedSpec.model_kind !== 'agentic') continue;
    registeredEntries.set(node.name, {
      kind: 'warehouse_table',
      fqRef: modelReg.get(node.name)!,
      connection: node.integration ?? integration.handle,
      columns: getModelOutputColumns(node.parsedSpec).map((column) => ({
        name: column.name,
        type: bucketColumnType(column.type!),
        sqlType: column.type!,
      })),
    });
  }

  return {
    dialect: integration.dialect,
    targetSchema,
    targetDatabase: integration.targetDatabase,
    targetWarehouse: integration.targetWarehouse,
    integration,
    modelReg,
    orderedNodes: nodes,
    registry,
    entryRegistry: registeredEntries,
  };
}
