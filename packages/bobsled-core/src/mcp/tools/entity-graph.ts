import {
  getEntity,
  getRelationships,
  listEntities,
  lookupMatch,
  specSearchConfig,
  type MatchContext,
} from '@bobsled-inc/entity-graph/runtime/services';
import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

import type {
  McpToolResponse,
  PrincipalContext,
  RoutingMetadata,
  BobsledMcpServer,
} from '../server.js';

interface QueryableRunner {
  run(sql: string): Promise<unknown>;
  query?: (sql: string) => Promise<Array<Record<string, unknown>>>;
}

export interface EntityGraphMcpFactoryOptions {
  server: BobsledMcpServer;
  runner: QueryableRunner;
  schema: string;
  dialect: SupportedDialect;
  specs: readonly MatchContext['spec'][];
  principal: PrincipalContext | null;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

const routing: RoutingMetadata = {
  resolved_via: 'direct',
  cache_hit: false,
  embedding_available: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(input: Record<string, unknown>, name: string, required?: true): string;
function stringArg(
  input: Record<string, unknown>,
  name: string,
  required: false
): string | undefined;
function stringArg(
  input: Record<string, unknown>,
  name: string,
  required = true
): string | undefined {
  const value = input[name];
  if (value === undefined) {
    if (!required) return undefined;
    throw new CommandError(`${name} is required.`, 2);
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CommandError(`${name} must be a non-empty string.`, 2);
  }
  return value;
}

function numberArg(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CommandError(`${name} must be an integer.`, 2);
  }
  return value;
}

function response<T>(server: BobsledMcpServer, result: T): McpToolResponse<T> {
  return {
    result,
    permissions: server.permissionsEnvelope(),
    citations: [],
    routing_metadata: routing,
  };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required };
}

export function entityGraphToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: 'entity_search',
      description: 'Search golden entity profiles by entity type and query text.',
      inputSchema: objectSchema(
        {
          entity_type: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'integer' },
          cursor: { type: 'string' },
        },
        ['entity_type']
      ),
      outputSchema: objectSchema({ result: { type: 'object' } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'entity_get',
      description: 'Fetch one golden entity profile by entity type and entity ID.',
      inputSchema: objectSchema(
        {
          entity_type: { type: 'string' },
          entity_id: { type: 'string' },
        },
        ['entity_type', 'entity_id']
      ),
      outputSchema: objectSchema({ result: { type: 'object' } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'entity_match',
      description: 'Lookup a record against an entity graph without mutating warehouse state.',
      inputSchema: objectSchema(
        {
          entity_type: { type: 'string' },
          record: { type: 'object' },
        },
        ['entity_type', 'record']
      ),
      outputSchema: objectSchema({ result: { type: 'object' } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'entity_relationships',
      description: 'Fetch relationships for one entity ID.',
      inputSchema: objectSchema(
        {
          entity_type: { type: 'string' },
          entity_id: { type: 'string' },
          relation: { type: 'string' },
          limit: { type: 'integer' },
          cursor: { type: 'string' },
        },
        ['entity_type', 'entity_id']
      ),
      outputSchema: objectSchema({ result: { type: 'object' } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'entity_explain',
      description:
        'Explain an entity by returning its profile, crosswalks, and current relationships.',
      inputSchema: objectSchema(
        {
          entity_type: { type: 'string' },
          entity_id: { type: 'string' },
        },
        ['entity_type', 'entity_id']
      ),
      outputSchema: objectSchema({ result: { type: 'object' } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
}

export function createEntityGraphMcpServer(options: EntityGraphMcpFactoryOptions): {
  tools: McpToolDefinition[];
  callTool: (name: string, args: unknown) => Promise<McpToolResponse<unknown>>;
} {
  const specByEntity = new Map(options.specs.map((spec) => [spec.entity, spec]));
  const baseContext = {
    runner: options.runner,
    schema: options.schema,
    dialect: options.dialect,
  };
  const requireEntitySpec = (entity: string): MatchContext['spec'] => {
    const spec = specByEntity.get(entity);
    if (!spec) throw new CommandError(`No entity spec found for '${entity}'.`, 2);
    return spec;
  };

  return {
    tools: entityGraphToolDefinitions(),
    async callTool(name, args) {
      options.server.requirePrincipal(options.principal);
      const input = isRecord(args) ? args : {};
      if (name === 'entity_search') {
        const entity = stringArg(input, 'entity_type');
        const spec = requireEntitySpec(entity);
        return response(
          options.server,
          await listEntities(baseContext, {
            entity,
            query: stringArg(input, 'query', false),
            limit: numberArg(input, 'limit'),
            cursor: stringArg(input, 'cursor', false),
            search: specSearchConfig(spec),
          })
        );
      }
      if (name === 'entity_get') {
        const entity = stringArg(input, 'entity_type');
        requireEntitySpec(entity);
        const entityId = stringArg(input, 'entity_id');
        const result = await getEntity(baseContext, { entity, entityId });
        if (!result) {
          throw new CommandError(
            `No entity with id '${entityId}'. Use entity_search to find IDs.`,
            2
          );
        }
        return response(options.server, result);
      }
      if (name === 'entity_match') {
        const entity = stringArg(input, 'entity_type');
        const spec = requireEntitySpec(entity);
        const record = input['record'];
        if (!isRecord(record)) throw new CommandError('entity_match.record must be an object.', 2);
        return response(options.server, await lookupMatch({ ...baseContext, spec }, record));
      }
      if (name === 'entity_relationships') {
        const entity = stringArg(input, 'entity_type');
        requireEntitySpec(entity);
        return response(
          options.server,
          await getRelationships(baseContext, {
            entity,
            entityId: stringArg(input, 'entity_id'),
            relation: stringArg(input, 'relation', false),
            limit: numberArg(input, 'limit'),
            cursor: stringArg(input, 'cursor', false),
          })
        );
      }
      if (name === 'entity_explain') {
        const entity = stringArg(input, 'entity_type');
        requireEntitySpec(entity);
        const entityId = stringArg(input, 'entity_id');
        const [profile, relationships] = await Promise.all([
          getEntity(baseContext, { entity, entityId }),
          getRelationships(baseContext, { entity, entityId }),
        ]);
        if (!profile) {
          throw new CommandError(
            `No entity with id '${entityId}'. Use entity_search to find IDs.`,
            2
          );
        }
        return response(options.server, { profile, relationships: relationships.relationships });
      }
      throw new CommandError(`Unknown MCP tool: ${name}`, 2);
    },
  };
}
