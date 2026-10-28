import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { registerHealthCheckCommand } from '../../src/commands/health-check.js';
import { registerScaffoldTestCommand } from '../../src/commands/scaffold-test.js';
import { registerValidateCommand } from '../../src/commands/validate.js';
import { makeResource } from '../helpers/fixtures.js';

describe('declaration command diagnostics', () => {
  it.each(['health-check', 'scaffold-test', 'validate'])(
    '%s names undeclared headers and explains the fix',
    async (command) => {
      const root = mkdtempSync(join(tmpdir(), 'declaration-diagnostics-'));
      const cwd = process.cwd();
      const exitCode = process.exitCode;
      let output = '';
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
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
              headers: { 'X-Token': '${{ env.CANARY }}' },
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
        registerHealthCheckCommand(program);
        registerScaffoldTestCommand(program);
        registerValidateCommand(program);
        await program.parseAsync([command, 'custom'], { from: 'user' }).catch((error: unknown) => {
          output += String(error);
        });
        expect(output).toContain(
          'Undeclared environment variable: CANARY. Add CANARY to auth_env_vars.'
        );
        if (command === 'health-check') expect(output).toContain('"env_vars_ok":false');
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        process.chdir(cwd);
        process.exitCode = exitCode;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
