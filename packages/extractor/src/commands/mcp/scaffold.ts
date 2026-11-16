import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';

import { CommandError, SAFE_NAME_RE, assertPathContained } from '../common.js';

import type { ShapeNode } from './shape.js';

export interface McpScaffoldInput {
  integrationName: string;
  transportId?: string;
  toolName: string;
  resourceName?: string;
  description?: string;
  shape: ShapeNode;
  outputDir: string;
  cwd: string;
  overwrite?: boolean;
}

export interface McpScaffoldResult {
  resourceName: string;
  filePath: string;
  skipped: boolean;
}

export function toSafeResourceName(toolName: string): string {
  const normalized = toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  if (!SAFE_NAME_RE.test(normalized)) {
    throw new CommandError(`Tool name "${toolName}" cannot be converted to a safe resource name.`);
  }
  return normalized;
}

export function writeMcpScaffold(input: McpScaffoldInput): McpScaffoldResult {
  const resourceName = input.resourceName ?? toSafeResourceName(input.toolName);
  if (!SAFE_NAME_RE.test(resourceName)) {
    throw new CommandError(
      `Invalid resource name "${resourceName}". Must be lowercase snake_case.`
    );
  }

  assertPathContained(input.cwd, path.relative(input.cwd, input.outputDir), 'MCP scaffold output');
  const integrationDir = path.join(input.outputDir, input.integrationName);
  assertPathContained(input.cwd, path.relative(input.cwd, integrationDir), 'MCP scaffold output');

  fs.mkdirSync(integrationDir, { recursive: true });
  const filePath = path.join(integrationDir, `${resourceName}.yml`);
  assertPathContained(input.cwd, path.relative(input.cwd, filePath), 'MCP scaffold file');

  if (fs.existsSync(filePath) && !input.overwrite) {
    return { resourceName, filePath, skipped: true };
  }

  const firstClassResource = input.transportId !== undefined && input.transportId !== 'default';
  const spec = {
    _scaffold_metadata: {
      generated_by: 'bobsled extract mcp discover',
      review_required: true,
      shape: input.shape,
    },
    type: 'resource',
    name: resourceName,
    ...(firstClassResource
      ? { via: input.transportId }
      : { spec_version: '1', integration: input.integrationName }),
    description: input.description ?? `Extract ${resourceName} from ${input.integrationName}`,
    tool: {
      tool_name: input.toolName,
    },
    input: {},
    output: {},
    extract: {
      record_path: '$',
    },
  };

  const document = new YAML.Document(spec);
  fs.writeFileSync(filePath, String(document), { encoding: 'utf-8', flag: 'w' });
  return { resourceName, filePath, skipped: false };
}
