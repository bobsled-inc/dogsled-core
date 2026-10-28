import { getErrorMessage } from '../../framework/core/index.js';
import { McpExtractorClient } from '../../runtime/mcp-client.js';

import { redactErrorMessage, redactSensitiveValues } from './redaction.js';
import { inferShapeFromDryRun, inferShapeFromOutputSchema } from './shape.js';

import type { ApiIntegrationSpec } from '../../types/index.js';
import type { McpToolInfo } from '../../runtime/mcp-client.js';
import type { ShapeNode } from './shape.js';

export interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  shape: ShapeNode;
  shapeSource: 'outputSchema' | 'dryRun' | 'unknown';
  dryRunError?: string;
}

export interface DiscoverMcpToolsOptions {
  integration: ApiIntegrationSpec;
  dryRun?: boolean;
  concurrency?: number;
}

const READ_ONLY_PREFIXES = ['list_', 'search_', 'get_', 'find_', 'query_', 'read_', 'fetch_'];
const MUTATING_PREFIXES = [
  'archive_',
  'create_',
  'delete_',
  'post_',
  'remove_',
  'send_',
  'update_',
  'upsert_',
];

export async function discoverMcpTools(
  options: DiscoverMcpToolsOptions
): Promise<DiscoveredMcpTool[]> {
  const client = new McpExtractorClient({ integration: options.integration });
  try {
    const tools = (await client.listTools()).filter(isExtractionCandidate);
    return await mapWithConcurrency(
      tools,
      options.concurrency ?? 4,
      async (tool) => await describeTool(client, tool, options.dryRun ?? true)
    );
  } finally {
    await client.close();
  }
}

export function isExtractionCandidate(tool: McpToolInfo): boolean {
  if (tool.annotations?.readOnlyHint === false) {
    return false;
  }
  if (MUTATING_PREFIXES.some((prefix) => tool.name.startsWith(prefix))) {
    return false;
  }
  return (
    tool.annotations?.readOnlyHint === true ||
    READ_ONLY_PREFIXES.some((prefix) => tool.name.startsWith(prefix))
  );
}

async function describeTool(
  client: McpExtractorClient,
  tool: McpToolInfo,
  dryRun: boolean
): Promise<DiscoveredMcpTool> {
  if (tool.outputSchema) {
    return {
      ...tool,
      shape: inferShapeFromOutputSchema(tool.outputSchema),
      shapeSource: 'outputSchema',
    };
  }

  if (!dryRun) {
    return { ...tool, shape: { kind: 'unknown' }, shapeSource: 'unknown' };
  }

  try {
    const result = await client.callTool({
      operation: {
        input: {},
        tool: { tool_name: tool.name },
      },
    });
    return {
      ...tool,
      shape: inferShapeFromDryRun(redactSensitiveValues(result)),
      shapeSource: 'dryRun',
    };
  } catch (error) {
    return {
      ...tool,
      shape: { kind: 'unknown' },
      shapeSource: 'unknown',
      dryRunError: redactErrorMessage(getErrorMessage(error)),
    };
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  // Keep dry-run probes bounded even when callers pass a very large concurrency.
  const limit = Math.max(1, Math.min(concurrency, 8));
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => worker()));
  return results;
}
