import { assertApiCredentialName } from '@bobsled-inc/api-resource';
import {
  type ResolveRunnerOptions,
  interpolateSecrets,
  resolveRunner,
  throwIfCancelled,
  createTokenCommandProvider,
} from '@bobsled-inc/connections';
import {
  queryResource,
  type QueryFilterInput,
  type QueryResourceOptions,
} from '@bobsled-inc/extractor';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';
import { getSourceEntry, quoteIdentifier, resolveRef } from '@bobsled-inc/model-spec';
import {
  AgenticColumnsSchema,
  createAgenticRowSchema,
  type AgenticHost,
} from '@bobsled-inc/model-spec/agentic';
import { agenticSelfTableExists } from './agentic-self-table.js';
import { normalizeAgenticInputValue } from './agentic-input.js';
import {
  loadProject,
  selectIntegrationContexts,
  buildSecretResolver,
} from '@bobsled-inc/model-spec/project';
import { CommandError } from '@bobsled-inc/protocol';
import { z } from 'zod';

const limits = { maxRows: 100, maxBytes: 65536 };
export type AgenticResourceSpecLoader = (
  ...args: Parameters<typeof loadQueryableResourceSpecs>
) => Pick<QueryResourceOptions, 'integration' | 'resource'> | undefined;
const readArgs = z
  .object({
    limit: z.number().int().min(1).max(limits.maxRows).default(20),
    columns: z.array(z.string().min(1).max(128)).min(1).max(64).optional(),
  })
  .strict();
const apiArgs = z
  .object({
    limit: z.number().int().min(1).max(limits.maxRows).default(20),
    search: z.string().min(1).max(4000).optional(),
    filter: z
      .record(z.string(), z.union([z.string().max(4000), z.number().finite(), z.boolean()]))
      .optional(),
  })
  .strict();

/** This adapter's own fixed policy messages, safe to show the agent. */
class SourcePolicyError extends CommandError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'SourcePolicyError';
  }
}

/** Argument errors name fields, never values, so the agent can fix its request. */
function parseArgs<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const plain = (part: PropertyKey) => /^[A-Za-z0-9_]{1,64}$/.test(String(part));
  const fields = new Set<string>();
  const unknown = new Set<string>();
  for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) if (plain(key)) unknown.add(key);
    } else {
      const path = issue.path.filter(plain).join('.');
      if (path) fields.add(path);
    }
  }
  const parts = [
    ...(unknown.size ? [`remove unknown ${[...unknown].slice(0, 5).join(', ')}`] : []),
    ...(fields.size ? [`check ${[...fields].slice(0, 5).join(', ')}`] : []),
  ];
  throw new SourcePolicyError(
    `Agent source arguments are invalid${parts.length ? `: ${parts.join('; ')}` : ''}`
  );
}

/** The host owns source mapping and credentials. The agent can only request bounded data. */
export function createAgenticSources(options: {
  inputs: Record<string, unknown>;
  runnerOptions?: ResolveRunnerOptions;
  integrationSpecLoader?: AgenticResourceSpecLoader;
  project: Awaited<ReturnType<typeof loadProject>>;
  contexts: ReturnType<typeof selectIntegrationContexts>;
  secretResolver: Awaited<ReturnType<typeof buildSecretResolver>>;
  allowBillableSources?: string[];
  tokenProvider?: ReturnType<typeof createTokenCommandProvider>;
}): NonNullable<AgenticHost['sources']> {
  return async (request, context) => {
    throwIfCancelled(context.signal);
    if (!context.assignment.allowed_sources.includes(request.source)) {
      throw new SourcePolicyError('Agent source is not allowed');
    }
    if (!['read', 'search'].includes(request.operation)) {
      throw new SourcePolicyError('Agent source operation is not allowed');
    }
    if (Buffer.byteLength(JSON.stringify(request.arguments)) > limits.maxBytes) {
      throw new SourcePolicyError('Agent source arguments exceed byte limit');
    }
    const entry = getSourceEntry(options.project.sourceEntries, request.source);
    try {
      let rows: unknown[];
      if (entry?.kind === 'api_resource') {
        const args = parseArgs(apiArgs, request.arguments);
        if (request.operation === 'search' && !args.search) {
          throw new SourcePolicyError('Source search requires search text');
        }
        // A pinned filter scopes which rows this source may return. The query layer
        // cannot combine a filter with free-text search, so refuse instead of widening.
        if (args.search !== undefined && entry.filter) {
          throw new SourcePolicyError(
            'This source has a pinned filter, so it supports read but not search'
          );
        }
        const loadSpecs = options.integrationSpecLoader ?? loadQueryableResourceSpecs;
        const loaded = loadSpecs(entry.integration, entry.resource, {
          includeBillable: true,
        });
        if (!loaded) throw new SourcePolicyError('Agent source has no query interface');
        const apiSecretResolver = {
          declaredSecretNames: options.secretResolver.declaredSecretNames,
          resolve(name: string) {
            assertApiCredentialName(name);
            return options.secretResolver.resolve(name);
          },
        };
        const integration = await interpolateSecrets(loaded.integration, apiSecretResolver);
        const resource = await interpolateSecrets(loaded.resource, apiSecretResolver, {
          authEnvVars: loaded.integration.auth_env_vars,
        });
        let bytes = 2;
        let count = 0;
        const result = await queryResource({
          integration,
          resource,
          limit: args.limit,
          search: args.search,
          filter: entry.filter
            ? ({ ...args.filter, ...entry.filter } as QueryFilterInput)
            : args.filter,
          signal: context.signal,
          authorizeBillable: () => options.allowBillableSources?.includes(request.source) === true,
          onMappedRecord(record) {
            count += 1;
            if (count > args.limit) throw new SourcePolicyError('Agent source row limit exceeded');
            bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
            if (bytes > limits.maxBytes) {
              throw new SourcePolicyError('Agent source result exceeds byte limit');
            }
          },
        });
        rows = result.records;
      } else {
        if (request.operation !== 'read') {
          throw new SourcePolicyError('Table sources support read only');
        }
        const args = parseArgs(readArgs, request.arguments);
        const owner =
          entry?.connection ??
          options.project.models.find(
            (node) => node.name.toLowerCase() === request.source.toLowerCase()
          )?.integration;
        const candidates = options.contexts.filter(
          (candidate) => candidate.integration.handle === owner
        );
        if (candidates.length !== 1) {
          throw new SourcePolicyError('Agent source table is missing or ambiguous');
        }
        const integration = candidates[0]!;
        const relation = resolveRef(request.source, integration.registry, integration.modelReg);
        if (!relation.ok) throw new SourcePolicyError('Agent source table was not found');
        const declared = AgenticColumnsSchema.parse(options.inputs[request.source]);
        const columns = args.columns
          ? args.columns.map((name) => {
              const column = declared.find((candidate) => candidate.name === name);
              if (!column) throw new SourcePolicyError('Agent source column is not declared');
              return column;
            })
          : declared;
        const projection = columns
          .map((column) => quoteIdentifier(column.name, integration.dialect))
          .join(', ');
        const connection = await interpolateSecrets(
          integration.integration.integration,
          options.secretResolver
        );
        const runner = await resolveRunner(connection, {
          ...options.runnerOptions,
          secretResolver: options.secretResolver,
          tokenProvider: options.tokenProvider,
        });
        try {
          throwIfCancelled(context.signal);
          if (!runner.query) {
            throw new SourcePolicyError('Agent source runner must support queries');
          }
          const missingSelf =
            request.source === context.assignment.model_name &&
            !(await agenticSelfTableExists(
              runner.query,
              relation.fqTableName,
              integration.dialect,
              context.signal
            ));
          const rawRows = missingSelf
            ? []
            : await runner.query(
                `SELECT ${projection} FROM ${relation.fqTableName} LIMIT ${args.limit}`,
                undefined,
                { signal: context.signal }
              );
          const schema = createAgenticRowSchema(columns);
          rows = rawRows.map((row) => {
            const normalized = Object.create(null) as Record<string, unknown>;
            for (const column of columns) {
              const key = Object.keys(row).find(
                (name) => name.toLowerCase() === column.name.toLowerCase()
              );
              normalized[column.name] = normalizeAgenticInputValue(
                key === undefined ? undefined : row[key],
                column.type
              );
            }
            return schema.parse(normalized);
          });
        } finally {
          await runner.close?.();
        }
      }
      throwIfCancelled(context.signal);
      const text = JSON.stringify({ rows, retrieved_at: new Date().toISOString() });
      if (rows.length > limits.maxRows || Buffer.byteLength(text) > limits.maxBytes) {
        throw new SourcePolicyError('Agent source result exceeds limits');
      }
      return JSON.parse(text);
    } catch (cause) {
      throwIfCancelled(context.signal);
      // Keep the cause for host diagnostics, never in the agent-facing message or payload.
      // Like native Error.cause, it must not be included by JSON serialization. Only this
      // adapter's own fixed policy messages reach the agent, so it can correct the request.
      const error = new CommandError(
        cause instanceof SourcePolicyError
          ? cause.message
          : 'Agent source request failed or was rejected by source policy',
        cause instanceof SourcePolicyError ? 2 : 1
      );
      Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
      throw error;
    }
  };
}
