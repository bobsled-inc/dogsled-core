import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { registerExtractCommand } from '../../src/commands/extract.js';
import { makeResource } from '../helpers/fixtures.js';

describe('pipeline source host environment declarations', () => {
  it.each([false, true])('host declaration enabled: %s', async (declared) => {
    const root = mkdtempSync(join(tmpdir(), 'host-source-'));
    const cwd = process.cwd();
    const exitCode = process.exitCode;
    let output = '';
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 1, name: 'one' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('HOST_SOURCE_TOKEN', 'host-canary');
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      output += String(value);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
      output += String(value);
      return true;
    });
    try {
      mkdirSync(join(root, 'integrations'));
      mkdirSync(join(root, 'resources'));
      writeFileSync(
        join(root, 'integrations/custom.yml'),
        YAML.stringify({
          spec_version: '1',
          type: 'integration',
          name: 'custom',
          transport: {
            type: 'http',
            base_url: 'https://api.example.com',
            auth: { type: 'bearer', token: '${{ env.HOST_SOURCE_TOKEN }}' },
          },
        })
      );
      writeFileSync(
        join(root, 'resources/items.yml'),
        YAML.stringify({ ...makeResource(), name: 'items', integration: 'custom' })
      );
      process.chdir(root);
      process.exitCode = undefined;
      const program = new Command();
      registerExtractCommand(program);
      await program
        .parseAsync(
          [
            'run',
            'items',
            '--integration',
            'custom',
            '--no-state-write',
            ...(declared ? ['--host-env-names-json', '["HOST_SOURCE_TOKEN"]'] : []),
          ],
          { from: 'user' }
        )
        .catch((error: unknown) => {
          output += String(error);
        });
      if (declared) {
        expect(fetch).toHaveBeenCalled();
        expect(output).not.toContain('Undeclared environment variable');
      } else {
        expect(fetch).not.toHaveBeenCalled();
        expect(output).toContain('Undeclared environment variable: HOST_SOURCE_TOKEN');
      }
    } finally {
      process.chdir(cwd);
      process.exitCode = exitCode;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
