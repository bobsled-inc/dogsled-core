import * as readline from 'node:readline';

import type { Command } from 'commander';
import { loadEntityGraphProjectContext } from '@bobsled-inc/entity-graph/api';
import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { loadProject } from '@bobsled-inc/model-spec/project';
import { createDialectOption, loadRunnerModule } from '@bobsled-inc/model-spec/shared';
import { CommandError } from '@bobsled-inc/protocol';

import {
  BobsledMcpServer,
  createEntityGraphMcpServer,
  readSource,
  type ReadSourceInput,
  type SourceRowData,
} from '../mcp/index.js';
import type { Principal } from '../mcp/permissions.js';

interface McpServeOptions {
  transport: string;
  runner?: string;
  allowUnfiltered?: boolean;
  /**
   * Default principal applied to every tool call. Required when
   * `--allow-unfiltered` is not set so the fail-closed code path is
   * reachable through the CLI. Per-request principal override lands in
   * Drop 7; until then a single principal services the whole MCP session.
   */
  principalId?: string;
  /** Optional comma-separated groups attached to the default principal. */
  principalGroups?: string;
  dialect?: SupportedDialect;
  schema?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface EntityGraphContextLoadResult {
  context?: Awaited<ReturnType<typeof loadEntityGraphProjectContext>>;
  error?: string;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requestId(request: JsonRpcRequest): string | number | null {
  return request.id === undefined ? null : request.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseReadSourceInput(params: unknown): ReadSourceInput {
  const input = isRecord(params) && isRecord(params['arguments']) ? params['arguments'] : params;
  if (!isRecord(input) || typeof input['source_table'] !== 'string') {
    throw new CommandError('read_source requires arguments.source_table.', 2);
  }
  const out: ReadSourceInput = { source_table: input['source_table'] };
  if (input['limit'] !== undefined) {
    // Explicit type check beats `Number(unknown)` coercion: `Number({...})`
    // and `Number('42abc')` both produce NaN, and `Number('')` produces 0,
    // each of which the downstream `Number.isInteger`/`>= 1` check rejects
    // but with a confusing "limit must be a positive integer" message
    // rather than a clear input-shape error.
    if (typeof input['limit'] !== 'number' || !Number.isInteger(input['limit'])) {
      throw new CommandError('read_source.limit must be an integer (no string coercion).', 2);
    }
    out.limit = input['limit'];
  }
  if (input['cursor'] !== undefined) {
    if (typeof input['cursor'] !== 'string') {
      throw new CommandError('read_source.cursor must be a string when supplied.', 2);
    }
    out.cursor = input['cursor'];
  }
  return out;
}

function parseToolArguments(params: unknown): unknown {
  return isRecord(params) && isRecord(params['arguments']) ? params['arguments'] : params;
}

async function loadOptionalEntityGraphContext(
  options: McpServeOptions
): Promise<EntityGraphContextLoadResult> {
  try {
    return {
      context: await loadEntityGraphProjectContext({
        dialect: options.dialect,
        schema: options.schema,
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runMcpServe(options: McpServeOptions): Promise<void> {
  if (options.transport !== 'stdio') {
    throw new CommandError('mcp serve currently supports only --transport stdio.', 2);
  }
  if (!options.runner) {
    throw new CommandError('mcp serve requires --runner <path>.', 2);
  }
  // Fail-closed posture: require an explicit principal unless the operator
  // opts into unfiltered reads. Without this guard `principal: null` would
  // pin every tools/call to a JSON-RPC error envelope on the secure path,
  // making the only operational mode the insecure one.
  const principalId = options.principalId?.trim();
  if (!options.allowUnfiltered && !principalId) {
    throw new CommandError(
      'mcp serve requires --principal-id <id> (default principal applied to every tool call). ' +
        'Pass --allow-unfiltered AND set BOBSLED_CORE_MCP_ALLOW_UNFILTERED=1 to opt into unfiltered reads ' +
        'while the per-request principal override lands in Drop 7.',
      2
    );
  }
  const defaultPrincipal: Principal | null = principalId
    ? {
        principal_id: principalId,
        ...(options.principalGroups
          ? {
              groups: options.principalGroups
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            }
          : {}),
      }
    : null;

  const project = await loadProject(process.cwd());
  const runner = await loadRunnerModule(options.runner);
  if (runner.query == null) {
    throw new CommandError('mcp serve requires a runner module that exports query(sql).', 2);
  }
  const server = new BobsledMcpServer({
    allowUnfiltered: options.allowUnfiltered,
    allowedSourceTables: new Set(project.sources.values()),
  });
  const entityContextLoad = await loadOptionalEntityGraphContext(options);
  const entityGraphMcp = entityContextLoad.context
    ? createEntityGraphMcpServer({
        server,
        runner,
        schema: entityContextLoad.context.targetSchema,
        dialect: entityContextLoad.context.dialect,
        specs: entityContextLoad.context.specs,
        principal: defaultPrincipal,
      })
    : undefined;

  const fetcher = async (request: {
    input: ReadSourceInput;
  }): Promise<{ rows: SourceRowData[] }> => {
    const limit = request.input.limit ?? 100;
    const rows = await runner.query!(`SELECT * FROM ${request.input.source_table} LIMIT ${limit}`);
    return { rows };
  };

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      const request = JSON.parse(line) as JsonRpcRequest;
      try {
        if (request.method === 'initialize') {
          writeJson({
            jsonrpc: '2.0',
            id: requestId(request),
            result: { protocolVersion: '2024-11-05', serverInfo: { name: 'bobsled' } },
          });
          continue;
        }
        if (request.method === 'tools/list') {
          writeJson({
            jsonrpc: '2.0',
            id: requestId(request),
            result: {
              tools: [
                {
                  name: 'read_source',
                  description:
                    'Read rows from a Bobsled Core source table with permission metadata.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      source_table: { type: 'string' },
                      limit: { type: 'number' },
                      cursor: { type: 'string' },
                    },
                    required: ['source_table'],
                  },
                },
                ...(entityGraphMcp?.tools ?? []),
              ],
            },
          });
          continue;
        }
        if (request.method === 'tools/call') {
          const params = isRecord(request.params) ? request.params : {};
          const toolName = String(params['name']);
          const result =
            toolName === 'read_source'
              ? await readSource(
                  {
                    server,
                    principal: defaultPrincipal,
                    fetcher,
                  },
                  parseReadSourceInput(params)
                )
              : await entityGraphMcp?.callTool(toolName, parseToolArguments(params));
          if (!result && toolName.startsWith('entity_') && entityContextLoad.error) {
            throw new CommandError(
              `Entity graph MCP tools unavailable: ${entityContextLoad.error}`,
              2
            );
          }
          if (!result) throw new CommandError(`Unknown MCP tool: ${toolName}`, 2);
          writeJson({ jsonrpc: '2.0', id: requestId(request), result });
          continue;
        }
        writeJson({
          jsonrpc: '2.0',
          id: requestId(request),
          error: { code: -32601, message: `Unsupported method: ${String(request.method)}` },
        });
      } catch (error) {
        writeJson({
          jsonrpc: '2.0',
          id: requestId(request),
          error: {
            code: error instanceof CommandError && error.exitCode === 2 ? -32602 : -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  } finally {
    rl.close();
    await runner.close?.();
  }
}

export function registerMcpServeCommand(parent: Command): void {
  parent
    .command('serve')
    .description('Serve Bobsled Core MCP tools over stdio')
    .requiredOption('--transport <transport>', 'MCP transport: stdio')
    .requiredOption('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--allow-unfiltered', 'Allow no-principal MCP reads with env double-gate', false)
    .option(
      '--principal-id <id>',
      'Default principal applied to every tool call (required unless --allow-unfiltered).'
    )
    .option(
      '--principal-groups <csv>',
      'Comma-separated groups attached to the default principal (optional).'
    )
    .addOption(createDialectOption())
    .option('--schema <schema>', 'Entity graph schema for entity tools')
    .action(async (options: McpServeOptions) => {
      await runMcpServe(options);
    });
}
