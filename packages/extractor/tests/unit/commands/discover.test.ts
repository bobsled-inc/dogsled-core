import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import YAML from 'yaml';

import { registerDiscoverCommand } from '../../../src/commands/discover.js';

const tempDirs: string[] = [];
let originalCwd: string | undefined;

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-command-test-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'integrations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  return dir;
}

function writeResource(
  projectDir: string,
  integrationName: string,
  resource: Record<string, unknown>
): void {
  const resourceDir = path.join(projectDir, 'resources', integrationName);
  fs.mkdirSync(resourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(resourceDir, `${String(resource['name'])}.yml`),
    YAML.stringify(resource)
  );
}

function writeMcpIntegration(projectDir: string): void {
  fs.writeFileSync(
    path.join(projectDir, 'integrations', 'fixture_mcp.yml'),
    YAML.stringify({
      spec_version: '1',
      type: 'integration',
      name: 'fixture_mcp',
      transport: {
        type: 'mcp_stdio',
        command: 'node',
        args: ['server.mjs'],
      },
    })
  );
}

function writeMcpSource(projectDir: string): void {
  fs.writeFileSync(
    path.join(projectDir, 'integrations', 'fixture_mcp.yml'),
    YAML.stringify({
      spec_version: '2',
      type: 'source',
      name: 'fixture_mcp',
      default_transport: 'mcp',
      transports: [
        {
          id: 'mcp',
          type: 'mcp_stdio',
          command: 'node',
          args: ['server.mjs'],
        },
      ],
    })
  );
  writeResource(projectDir, 'fixture_mcp', {
    type: 'resource',
    name: 'items',
    via: 'mcp',
    description: 'MCP items',
    tool: { tool_name: 'list_items' },
    input: {},
    output: { id: { type: 'string', path: '$.id' } },
    extract: { record_path: '$', table: { primary_key: ['id'] } },
  });
}

function writeMixedSource(projectDir: string): void {
  fs.writeFileSync(
    path.join(projectDir, 'integrations', 'fixture_mixed.yml'),
    YAML.stringify({
      spec_version: '2',
      type: 'source',
      name: 'fixture_mixed',
      default_transport: 'rest',
      transports: [
        {
          id: 'rest',
          type: 'http',
          base_url: 'https://api.example.com',
        },
        {
          id: 'mcp',
          type: 'mcp_stdio',
          command: 'node',
          args: ['server.mjs'],
        },
      ],
    })
  );
  writeResource(projectDir, 'fixture_mixed', {
    type: 'resource',
    name: 'a_mcp_items',
    via: 'mcp',
    description: 'MCP items',
    tool: { tool_name: 'list_items' },
    input: {},
    output: { id: { type: 'string', path: '$.id' } },
    extract: { record_path: '$', table: { primary_key: ['id'] } },
  });
  writeResource(projectDir, 'fixture_mixed', {
    type: 'resource',
    name: 'b_rest_items',
    via: 'rest',
    description: 'REST items',
    api: { endpoint: '/items', method: 'GET' },
    input: {},
    output: { id: { type: 'string', path: '$.id' } },
    extract: { record_path: '$', table: { primary_key: ['id'] } },
  });
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerDiscoverCommand(program);
  return program;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCwd) {
    process.chdir(originalCwd);
    originalCwd = undefined;
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('discover command MCP consolidation', () => {
  it('removes the legacy --auto MCP discovery option', async () => {
    await expect(
      createProgram().parseAsync(['discover', 'fixture_mcp', '--auto'], { from: 'user' })
    ).rejects.toThrow("error: unknown option '--auto'");
  });

  it('directs MCP integrations to the MCP command group', async () => {
    const projectDir = makeTempProject();
    writeMcpIntegration(projectDir);
    originalCwd = process.cwd();
    process.chdir(projectDir);

    await expect(
      createProgram().parseAsync(['discover', 'fixture_mcp'], { from: 'user' })
    ).rejects.toThrow('MCP discovery is available only through `dogsled extract mcp`');
  });

  it('directs MCP source transports to the MCP command group', async () => {
    const projectDir = makeTempProject();
    writeMcpSource(projectDir);
    originalCwd = process.cwd();
    process.chdir(projectDir);

    await expect(
      createProgram().parseAsync(['discover', 'fixture_mcp'], { from: 'user' })
    ).rejects.toThrow('MCP discovery is available only through `dogsled extract mcp`');
  });

  it('allows HTTP resources in a mixed HTTP and MCP source', async () => {
    const projectDir = makeTempProject();
    writeMixedSource(projectDir);
    originalCwd = process.cwd();
    process.chdir(projectDir);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ id: '1' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await createProgram().parseAsync(['discover', 'fixture_mixed'], { from: 'user' });
  });
});
