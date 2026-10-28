import type { Command } from 'commander';

import { isSourceSpec } from '../../framework/core/index.js';
import type { Transport } from '../../framework/core/index.js';
import { listFilterBuilders } from '../../framework/query/index.js';
import { buildApiIntegrationSpec } from '../../runtime/api-integration-spec.js';
import { McpExtractorClient } from '../../runtime/mcp-client.js';
import { isWarehouseSource } from '../../runtime/warehouse-extractor.js';

import { discoverMcpTools } from './discovery.js';
import { redactErrorMessage, redactSensitiveValues } from './redaction.js';
import { writeMcpScaffold } from './scaffold.js';
import { writeCommandJson, writeCommandLines, writeCommandText } from '../output.js';

import type { ApiIntegrationSpec, SourceSpec } from '../../types/index.js';
import {
  CommandError,
  buildCommandContext,
  findIntegrationFile,
  isMcpIntegration,
  loadIntegrationSpec,
  parseGlobalFlags,
  type CommandContext,
} from '../common.js';

interface JsonFormatOptions {
  format?: 'text' | 'json';
}

interface McpTransportOptions {
  transportId?: string;
}

interface DiscoverOptions extends JsonFormatOptions, McpTransportOptions {
  write?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
  concurrency?: string;
}

interface VerifyRedactionOptions extends JsonFormatOptions, McpTransportOptions {
  tool?: string;
}

interface LoadedMcpIntegration {
  integration: ApiIntegrationSpec;
  transportId: string;
}

export function registerMcpCommand(program: Command): void {
  const command = program.command('mcp').description('Author and inspect MCP extractor resources');

  command
    .command('list-builders')
    .description('List contained MCP query filter builders')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action(async (opts: JsonFormatOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const builders = listFilterBuilders();
      if (opts.format === 'json') {
        await writeCommandJson(ctx, { builders });
        return;
      }
      await writeCommandLines(
        ctx,
        builders.map((builder) => `${builder.id}\t${builder.label}`)
      );
    });

  command
    .command('list-tools')
    .description('List tools exposed by an MCP integration')
    .argument('<integration>', 'Integration name')
    .option('--transport-id <id>', 'MCP transport id to use for multi-transport sources')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action(async (integrationName: string, opts: JsonFormatOptions & McpTransportOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const loaded = loadMcpIntegration(ctx, integrationName, opts);
      const client = new McpExtractorClient({ integration: loaded.integration });
      try {
        const tools = await client.listTools();
        if (opts.format === 'json') {
          await writeCommandJson(ctx, { tools });
          return;
        }
        await writeCommandLines(
          ctx,
          tools.map((tool) => `${tool.name}${tool.description ? `\t${tool.description}` : ''}`)
        );
      } finally {
        await client.close();
      }
    });

  command
    .command('discover')
    .description('Discover MCP tools and optionally write resource scaffolds')
    .argument('<integration>', 'Integration name')
    .option('--transport-id <id>', 'MCP transport id to use for multi-transport sources')
    .option('--write', 'Write safe resource scaffold files')
    .option('--overwrite', 'Overwrite existing scaffold files')
    .option('--no-dry-run', 'Do not call tools without outputSchema for shape inference')
    .option('--concurrency <n>', 'Maximum concurrent dry-run probes (capped at 8)', '4')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action(async (integrationName: string, opts: DiscoverOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const loaded = loadMcpIntegration(ctx, integrationName, opts);
      const tools = await discoverMcpTools({
        integration: loaded.integration,
        dryRun: opts.dryRun,
        concurrency: parseConcurrency(opts.concurrency),
      });
      const scaffolds = opts.write
        ? tools.map((tool) =>
            writeMcpScaffold({
              cwd: ctx.cwd,
              outputDir: ctx.resourcesDir,
              integrationName,
              transportId: loaded.transportId,
              toolName: tool.name,
              description: tool.description,
              shape: tool.shape,
              overwrite: opts.overwrite,
            })
          )
        : [];

      if (opts.format === 'json') {
        await writeCommandJson(ctx, { tools, scaffolds });
        return;
      }

      await writeCommandLines(ctx, [
        ...tools.map((tool) => `${tool.name}\tshape:${tool.shapeSource}`),
        ...scaffolds.map(
          (scaffold) => `${scaffold.skipped ? 'skipped' : 'wrote'}\t${scaffold.filePath}`
        ),
      ]);
    });

  command
    .command('verify-redaction')
    .description('Dry-run a tool and print the redacted result or error')
    .argument('<integration>', 'Integration name')
    .option('--transport-id <id>', 'MCP transport id to use for multi-transport sources')
    .option('--tool <name>', 'Tool name to dry-run')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action(async (integrationName: string, opts: VerifyRedactionOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      if (!opts.tool) {
        throw new CommandError('verify-redaction requires --tool <name>.');
      }
      const loaded = loadMcpIntegration(ctx, integrationName, opts);
      const client = new McpExtractorClient({ integration: loaded.integration });
      let payload: unknown;
      try {
        payload = redactSensitiveValues(
          await client.callTool({
            operation: {
              input: {},
              tool: { tool_name: opts.tool },
            },
          })
        );
      } catch (error) {
        payload = {
          error: redactErrorMessage(error instanceof Error ? error.message : String(error)),
        };
      } finally {
        await client.close();
      }

      if (opts.format === 'json') {
        await writeCommandJson(ctx, payload);
        return;
      }
      await writeCommandText(ctx, `${JSON.stringify(payload)}\n`);
    });
}

function loadMcpIntegration(
  ctx: CommandContext,
  integrationName: string,
  options: McpTransportOptions = {}
): LoadedMcpIntegration {
  const integrationFile = findIntegrationFile(
    ctx.project,
    integrationName,
    ctx.bundledIntegrationsDir
  );
  const integration = loadIntegrationSpec(integrationFile);
  if (isWarehouseSource(integration)) {
    throw new CommandError('MCP commands only support API integrations with MCP transports.');
  }

  if (isSourceSpec(integration)) {
    const transport = selectMcpTransport(integration, options.transportId);
    return {
      integration: buildApiIntegrationSpec(integration, transport),
      transportId: transport.id,
    };
  }

  const apiIntegration = integration as ApiIntegrationSpec;
  if (options.transportId && options.transportId !== 'default') {
    throw new CommandError(
      `Legacy MCP integration "${integrationName}" does not support --transport-id.`
    );
  }
  if (!isMcpIntegration(apiIntegration)) {
    throw new CommandError(`Integration "${integrationName}" is not an MCP integration.`);
  }
  return { integration: apiIntegration, transportId: 'default' };
}

type McpSourceTransport = Extract<Transport, { type: 'mcp_http' | 'mcp_stdio' }>;

function isMcpSourceTransport(transport: Transport): transport is McpSourceTransport {
  return transport.type === 'mcp_http' || transport.type === 'mcp_stdio';
}

function selectMcpTransport(source: SourceSpec, requestedId?: string): McpSourceTransport {
  if (requestedId) {
    const transport = source.transports.find((candidate) => candidate.id === requestedId);
    if (!transport) {
      throw new CommandError(
        `Source "${source.name}" does not declare transport "${requestedId}". Available: ${source.transports
          .map((candidate) => candidate.id)
          .join(', ')}.`
      );
    }
    if (!isMcpSourceTransport(transport)) {
      throw new CommandError(
        `Transport "${requestedId}" on source "${source.name}" is ${transport.type}, not MCP.`
      );
    }
    return transport;
  }

  const defaultTransport = source.default_transport
    ? source.transports.find((candidate) => candidate.id === source.default_transport)
    : undefined;
  if (defaultTransport && isMcpSourceTransport(defaultTransport)) {
    return defaultTransport;
  }

  const mcpTransports = source.transports.filter(isMcpSourceTransport);
  if (mcpTransports.length === 1) {
    return mcpTransports[0]!;
  }
  if (mcpTransports.length > 1) {
    throw new CommandError(
      `Source "${source.name}" declares multiple MCP transports (${mcpTransports
        .map((transport) => transport.id)
        .join(', ')}). Pass --transport-id <id>.`
    );
  }

  throw new CommandError(`Source "${source.name}" does not declare an MCP transport.`);
}

function parseConcurrency(value: string | undefined): number {
  const parsed = Number(value ?? 4);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommandError('--concurrency must be a positive integer.');
  }
  return parsed;
}
