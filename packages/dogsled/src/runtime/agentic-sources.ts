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
      throw new CommandError('Agent source is not allowed', 2);
    }
    if (!['read', 'search'].includes(request.operation)) {
      throw new CommandError('Agent source operation is not allowed', 2);
    }
    if (Buffer.byteLength(JSON.stringify(request.arguments)) > limits.maxBytes) {
      throw new CommandError('Agent source arguments exceed byte limit', 2);
    }
    const entry = getSourceEntry(options.project.sourceEntries, request.source);
    try {
      let rows: unknown[];
      if (entry?.kind === 'api_resource') {
        const args = apiArgs.parse(request.arguments);
        if (request.operation === 'search' && !args.search) {
          throw new CommandError('Source search requires search text', 2);
        }
        const loadSpecs = options.integrationSpecLoader ?? loadQueryableResourceSpecs;
        const loaded = loadSpecs(entry.integration, entry.resource, {
          includeBillable: true,
        });
        if (!loaded) throw new CommandError('Agent source has no query interface', 2);
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
            if (count > args.limit) throw new CommandError('Agent source row limit exceeded', 2);
            bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
            if (bytes > limits.maxBytes) {
              throw new CommandError('Agent source result exceeds byte limit', 2);
            }
          },
        });
        rows = result.records;
      } else {
        if (request.operation !== 'read') {
          throw new CommandError('Table sources support read only', 2);
        }
        const args = readArgs.parse(request.arguments);
        const owner =
          entry?.connection ??
          options.project.models.find(
            (node) => node.name.toLowerCase() === request.source.toLowerCase()
          )?.integration;
        const candidates = options.contexts.filter(
          (candidate) => candidate.integration.handle === owner
        );
        if (candidates.length !== 1) {
          throw new CommandError('Agent source table is missing or ambiguous', 2);
        }
        const integration = candidates[0]!;
        const relation = resolveRef(request.source, integration.registry, integration.modelReg);
        if (!relation.ok) throw new CommandError('Agent source table was not found', 2);
        const declared = AgenticColumnsSchema.parse(options.inputs[request.source]);
        const columns = args.columns
          ? args.columns.map((name) => {
              const column = declared.find((candidate) => candidate.name === name);
              if (!column) throw new CommandError('Agent source column is not declared', 2);
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
          if (!runner.query) throw new CommandError('Agent source runner must support queries', 2);
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
        throw new CommandError('Agent source result exceeds limits', 2);
      }
      return JSON.parse(text);
    } catch (cause) {
      throwIfCancelled(context.signal);
      // Keep the cause for host diagnostics, never in the agent-facing message or payload.
      // Like native Error.cause, it must not be included by JSON serialization.
      const error = new CommandError(
        'Agent source request failed or was rejected by source policy',
        1
      );
      Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
      throw error;
    }
  };
}
