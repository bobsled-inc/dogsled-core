import {
  type ResolveRunnerOptions,
  interpolateSecrets,
  withDeclaredSecretNames,
  resolveRunner,
  throwIfCancelled,
} from '@bobsled-inc/connections';
import {
  bucketColumnType,
  quoteIdentifier,
  quoteLiteral,
  resolveRef,
} from '@bobsled-inc/model-spec';
import {
  AgenticColumnsSchema,
  withHostModelDeclarations,
  createAgenticRowSchema,
  getModelOutputColumns,
  type AgenticHost,
  type ExecuteAgent,
} from '@bobsled-inc/model-spec/agentic';
import {
  buildSecretResolver,
  loadProject,
  selectIntegrationContexts,
} from '@bobsled-inc/model-spec/project';
import { CommandError } from '@bobsled-inc/protocol';
import { normalizeAgenticInputValue } from './agentic-input.js';
export { normalizeAgenticInputValue } from './agentic-input.js';
import { createAgenticSources, type AgenticResourceSpecLoader } from './agentic-sources.js';

export interface AgenticHostOptions {
  project: Awaited<ReturnType<typeof loadProject>>;
  executeAgent: ExecuteAgent;
  platform: AgenticHost['platform'];
  secretResolver: Awaited<ReturnType<typeof buildSecretResolver>>;
  declaredSecretNames?: readonly string[];
  /**
   * Set to `true` only when `executeAgent` runs every model profile and signs in
   * to the model provider itself, so no profile `api_key` is read. Each
   * profile's own `api_key` name then counts as declared. Source and
   * integration credentials still need declarations. Defaults to `false`.
   */
  hostManagedModelAuth?: boolean;
  runnerOptions?: ResolveRunnerOptions;
  integrationSpecLoader?: AgenticResourceSpecLoader;
  tokensPerAssignment?: number;
  supportedTools?: readonly string[];
  concurrency?: number;
  minDispatchIntervalMs?: number;
  allowBillableSources?: string[];
}

export function createAgenticHost(options: AgenticHostOptions): AgenticHost {
  const { project, executeAgent } = options;
  const secretResolver =
    options.declaredSecretNames === undefined
      ? options.secretResolver
      : withDeclaredSecretNames(options.secretResolver, options.declaredSecretNames);
  const tokenProvider = options.runnerOptions?.tokenProvider;
  const contexts = selectIntegrationContexts(project);
  const inputs: Record<string, unknown> = Object.create(null);
  for (const [ref, entry] of project.sourceEntries) {
    if ('columns' in entry && entry.columns?.length) {
      inputs[ref] = entry.columns.map((column) => ({
        name: column.name,
        type: column.sqlType.toLowerCase() === 'date' ? 'date' : column.type,
        nullable: !column.primary_key,
      }));
    }
  }
  for (const node of project.models) {
    const columns = getModelOutputColumns(node.parsedSpec);
    if (columns.every((column) => column.type)) {
      inputs[node.name] = columns.map((column) => ({
        name: column.name,
        type: column.type!.toLowerCase() === 'date' ? 'date' : bucketColumnType(column.type!),
        nullable:
          'nullable' in column
            ? column.nullable
            : !('not_null' in column && column.not_null) &&
              !('primary_key' in column && column.primary_key),
      }));
    }
  }
  return {
    executeAgent,
    supportedTools: options.supportedTools,
    sources: createAgenticSources({
      project,
      inputs,
      contexts,
      secretResolver,
      allowBillableSources: options.allowBillableSources,
      tokenProvider,
      runnerOptions: options.runnerOptions,
      integrationSpecLoader: options.integrationSpecLoader,
    }),
    inputs,
    platform: withHostModelDeclarations(options.platform, secretResolver.declaredSecretNames),
    ...(options.hostManagedModelAuth === true ? { hostManagedModelAuth: true } : {}),
    tokensPerAssignment: options.tokensPerAssignment,
    concurrency: options.concurrency ?? 1,
    minDispatchIntervalMs: options.minDispatchIntervalMs ?? 0,
    supportedDialects: ['duckdb', 'postgres', 'snowflake', 'bigquery', 'databricks'],
    async prepare(context) {
      throwIfCancelled(context.signal);
      const integration = contexts.find(
        (candidate) => candidate.integration.handle === context.integration
      );
      if (!integration) throw new CommandError('Agentic input integration was not found', 2);
      const columns = AgenticColumnsSchema.parse(
        context.inputColumns ?? context.resolved.steps[0]!.input_columns
      );
      const relation = resolveRef(context.inputRef, integration.registry, integration.modelReg);
      if (!relation.ok) throw new CommandError(relation.error, 2);
      const from = context.inputSql
        ? `(${context.inputSql}) AS ${quoteIdentifier('agent_input', integration.dialect)}`
        : relation.fqTableName;
      const filter =
        context.incremental?.after === undefined
          ? ''
          : ` WHERE ${quoteIdentifier(context.incremental.cursor_field, integration.dialect)} > ${quoteLiteral(context.incremental.after, integration.dialect)}`;
      const sql = `SELECT ${columns.map((column) => quoteIdentifier(column.name, integration.dialect)).join(', ')} FROM ${from}${filter} LIMIT ${context.maxRows + 1}`;
      const connection = await interpolateSecrets(
        integration.integration.integration,
        secretResolver
      );
      const runner = await resolveRunner(connection, {
        ...options.runnerOptions,
        secretResolver,
        tokenProvider,
      });
      try {
        throwIfCancelled(context.signal);
        if (!runner.query) throw new CommandError('Agentic input runner must support queries', 2);
        const rows = await runner.query(sql, undefined, { signal: context.signal });
        throwIfCancelled(context.signal);
        if (rows.length > context.maxRows) {
          throw new CommandError('Agentic input row limit exceeded', 2);
        }
        const schema = createAgenticRowSchema(columns);
        let bytes = 2;
        return rows.map((row) => {
          const normalized: Record<string, unknown> = Object.create(null);
          for (const column of columns) {
            const actual = Object.keys(row).find(
              (name) => name.toLowerCase() === column.name.toLowerCase()
            );
            const value = actual === undefined ? undefined : row[actual];
            if (typeof value === 'string' && Buffer.byteLength(value) > context.maxBytes) {
              throw new CommandError('Agentic input byte limit exceeded', 2);
            }
            normalized[column.name] = normalizeAgenticInputValue(value, column.type);
          }
          const parsed = schema.parse(normalized);
          bytes += Buffer.byteLength(JSON.stringify(parsed)) + 1;
          if (bytes > context.maxBytes) {
            throw new CommandError('Agentic input byte limit exceeded', 2);
          }
          return parsed;
        });
      } finally {
        await runner.close?.();
      }
    },
  };
}
