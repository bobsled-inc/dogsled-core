import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import YAML from 'yaml';

vi.mock('../../../src/runtime/mcp-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtime/mcp-transport.js')>();
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  return {
    ...actual,
    createStdioTransport: (
      transport: Parameters<typeof actual.createStdioTransport>[0],
      resolvedEnv: Parameters<typeof actual.createStdioTransport>[1]
    ) =>
      transport.command === 'node'
        ? new StdioClientTransport({
            command: transport.command,
            args: transport.args ?? [],
            env: resolvedEnv,
            stderr: 'pipe',
          })
        : actual.createStdioTransport(transport, resolvedEnv),
  };
});

import { discoverMcpTools, isExtractionCandidate } from '../../../src/commands/mcp/discovery.js';
import { registerMcpCommand } from '../../../src/commands/mcp/index.js';
import { redactErrorMessage, redactSensitiveValues } from '../../../src/commands/mcp/redaction.js';
import { writeMcpScaffold } from '../../../src/commands/mcp/scaffold.js';
import { inferShapeFromOutputSchema, sanitizeJsonSchema } from '../../../src/commands/mcp/shape.js';
import { ResourceSpecSchema } from '../../../src/schemas/resource.js';

import type { ApiIntegrationSpec, IntegrationSpec } from '../../../src/types/index.js';

const fixturePath = fileURLToPath(new URL('../../fixtures/mcp/test-server.mjs', import.meta.url));
const tempDirs: string[] = [];

function createIntegration(): IntegrationSpec {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'fixture_mcp',
    transport: {
      type: 'mcp_stdio',
      command: 'node',
      args: [fixturePath],
      timeout_ms: 10_000,
    },
  } as IntegrationSpec;
}

function writeSourceWithMcpTransport(bundledDir: string): void {
  const sourceDir = path.join(bundledDir, 'linear');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'source.yml'),
    YAML.stringify({
      spec_version: '2',
      type: 'source',
      name: 'linear',
      default_transport: 'graphql',
      transports: [
        {
          id: 'graphql',
          type: 'http',
          base_url: 'https://api.linear.example',
        },
        {
          id: 'mcp',
          type: 'mcp_stdio',
          command: 'node',
          args: [fixturePath],
          timeout_ms: 10_000,
        },
      ],
    }),
    'utf-8'
  );
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-command-test-'));
  tempDirs.push(dir);
  return dir;
}

// Commands index the project in their working directory, so each test runs
// in an empty project rather than the package checkout.
const originalCwd = process.cwd();

beforeEach(() => {
  process.chdir(makeTempDir());
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MCP authoring helpers', () => {
  it('redacts dry-run values and error messages', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(
      redactSensitiveValues({
        token: 'not-a-real-token',
        nested: { email: 'admin@example.com' },
        circular,
      })
    ).toEqual({
      token: '[REDACTED]',
      nested: { email: '[REDACTED_EMAIL]' },
      circular: { self: '[CIRCULAR]' },
    });
    expect(redactErrorMessage('api_key ghp_1234567890abcdef for admin@example.com')).toBe(
      'api_key [REDACTED] for [REDACTED_EMAIL]'
    );
    expect(redactErrorMessage('request failed: Authorization: Bearer short-token')).toBe(
      'request failed: Authorization: Bearer [REDACTED]'
    );
  });

  it('infers shape from outputSchema and strips value keywords', () => {
    const schema = {
      type: 'object',
      examples: [{ id: 'secret' }],
      properties: {
        id: { type: 'string', default: 'secret' },
      },
    };

    expect(JSON.stringify(sanitizeJsonSchema(schema))).not.toContain('secret');
    expect(inferShapeFromOutputSchema(schema)).toEqual({
      kind: 'object',
      fields: {
        id: { kind: 'string' },
      },
    });
  });

  it('preserves nullable outputSchema union types', () => {
    expect(
      inferShapeFromOutputSchema({
        type: 'object',
        properties: {
          nickname: { type: ['string', 'null'] },
        },
      })
    ).toEqual({
      kind: 'object',
      fields: {
        nickname: { kind: 'string', nullable: true },
      },
    });
  });

  it('writes scaffold YAML with metadata and rejects unsafe resource names', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'resources');
    const result = writeMcpScaffold({
      cwd,
      outputDir,
      integrationName: 'fixture_mcp',
      transportId: 'mcp',
      toolName: 'list_with_output_schema',
      shape: { kind: 'object', fields: { id: { kind: 'string' } } },
    });

    const parsed = YAML.parse(fs.readFileSync(result.filePath, 'utf-8')) as Record<string, unknown>;
    expect(parsed['_scaffold_metadata']).toMatchObject({ review_required: true });
    expect(parsed['tool']).toEqual({ tool_name: 'list_with_output_schema' });
    expect(parsed['via']).toBe('mcp');
    expect(parsed).not.toHaveProperty('integration');
    expect(parsed).not.toHaveProperty('spec_version');
    expect(ResourceSpecSchema.safeParse(parsed).success).toBe(true);

    expect(() =>
      writeMcpScaffold({
        cwd,
        outputDir,
        integrationName: 'fixture_mcp',
        toolName: '../escape',
        resourceName: '../escape',
        shape: { kind: 'unknown' },
      })
    ).toThrow('Invalid resource name');
  });

  it('discovers tools using outputSchema before dry-run fallback', async () => {
    const tools = await discoverMcpTools({
      integration: createIntegration() as ApiIntegrationSpec,
      dryRun: true,
      concurrency: 2,
    });

    expect(tools).toContainEqual(
      expect.objectContaining({
        name: 'list_with_output_schema',
        shapeSource: 'outputSchema',
        shape: expect.objectContaining({ kind: 'object' }),
      })
    );
    expect(tools).toContainEqual(
      expect.objectContaining({
        name: 'list_error_leaks_values',
        dryRunError: expect.not.stringContaining('admin@example.com'),
      })
    );
    expect(tools).not.toContainEqual(expect.objectContaining({ name: 'create_item' }));
  });

  it('filters MCP discovery to read-only extraction candidates', () => {
    expect(isExtractionCandidate({ name: 'list_items' })).toBe(true);
    expect(isExtractionCandidate({ name: 'create_item' })).toBe(false);
    expect(
      isExtractionCandidate({ name: 'list_items', annotations: { readOnlyHint: false } })
    ).toBe(false);
    expect(
      isExtractionCandidate({ name: 'custom_report', annotations: { readOnlyHint: true } })
    ).toBe(true);
  });

  it('prints list-builders JSON from the MCP command group', async () => {
    const program = new Command();
    program.exitOverride();
    registerMcpCommand(program);

    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await program.parseAsync(['mcp', 'list-builders', '--format', 'json'], { from: 'user' });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(JSON.parse(output)).toEqual({
      builders: expect.arrayContaining([expect.objectContaining({ id: 'hubspot/crm-search' })]),
    });
  });

  it('lists tools from a v2 source MCP transport', async () => {
    const bundledDir = path.join(makeTempDir(), 'bundled');
    writeSourceWithMcpTransport(bundledDir);

    const program = new Command();
    program.exitOverride();
    registerMcpCommand(program);

    const originalBundledDir = process.env['DOGSLED_BUNDLED_INTEGRATIONS_DIR'];
    let output = '';
    const originalWrite = process.stdout.write;
    process.env['DOGSLED_BUNDLED_INTEGRATIONS_DIR'] = bundledDir;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await program.parseAsync(['mcp', 'list-tools', 'linear', '--format', 'json'], {
        from: 'user',
      });
    } finally {
      if (originalBundledDir === undefined) {
        delete process.env['DOGSLED_BUNDLED_INTEGRATIONS_DIR'];
      } else {
        process.env['DOGSLED_BUNDLED_INTEGRATIONS_DIR'] = originalBundledDir;
      }
      process.stdout.write = originalWrite;
    }

    expect(JSON.parse(output)).toEqual({
      tools: expect.arrayContaining([expect.objectContaining({ name: 'list_with_output_schema' })]),
    });
  });

  it('suppresses MCP command output when quiet is set', async () => {
    const program = new Command();
    program.exitOverride();
    program.option('-q, --quiet', 'Suppress non-error output');
    registerMcpCommand(program);

    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await program.parseAsync(['--quiet', 'mcp', 'list-builders', '--format', 'json'], {
        from: 'user',
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(output).toBe('');
  });
});
