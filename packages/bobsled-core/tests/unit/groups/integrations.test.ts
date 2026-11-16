import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import { createIntegrationsGroup } from '../../../src/groups/integrations.js';

describe('createIntegrationsGroup', () => {
  it('registers the list, show, and init subcommands', () => {
    const group = createIntegrationsGroup();

    expect(group.name()).toBe('integrations');
    expect(group.commands.map((command) => command.name())).toEqual(['list', 'show', 'init']);
  });

  it('renders group help with subcommand descriptions', () => {
    const help = createIntegrationsGroup().helpInformation();

    expect(help).toContain('Usage: integrations');
    expect(help).toContain('list');
    expect(help).toContain('show');
    expect(help).toContain('init');
  });

  describe('--json after the subcommand', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function runWithRootJson(args: string[]): Promise<string> {
      const program = new Command('dogsled').option('--json', 'Emit JSON', false);
      program.addCommand(createIntegrationsGroup());
      const chunks: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
      await program.parseAsync(['node', 'dogsled', ...args]);
      return chunks.join('');
    }

    it('emits JSON for list even when the root program owns --json', async () => {
      const output = await runWithRootJson(['integrations', 'list', '--json']);
      const parsed = JSON.parse(output) as Array<{ name: string }>;
      expect(parsed.some((integration) => integration.name === 'github')).toBe(true);
    });

    it('emits JSON for show even when the root program owns --json', async () => {
      const output = await runWithRootJson(['integrations', 'show', 'github', '--json']);
      const parsed = JSON.parse(output) as { meta: { display_name: string } };
      expect(parsed.meta.display_name).toBe('GitHub');
    });

    it('keeps text output when --json is not given', async () => {
      const output = await runWithRootJson(['integrations', 'list']);
      expect(() => JSON.parse(output)).toThrow();
      expect(output).toContain('github');
    });
  });

  it('init copies the library source spec and the selected resources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bobsled-integrations-init-'));
    try {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const program = new Command('dogsled');
      program.addCommand(createIntegrationsGroup());
      await program.parseAsync([
        'node',
        'dogsled',
        'integrations',
        'init',
        'github',
        '--resources',
        'repos',
        '--directory',
        dir,
      ]);
      expect(readFileSync(join(dir, 'integrations', 'github.yml'), 'utf8')).toContain(
        'type: source'
      );
      const { getIntegration } = await import('@bobsled-inc/integrations');
      const declarations = getIntegration('github').meta.auth_setup!.map((entry) => entry.env);
      expect(declarations.length).toBeGreaterThan(0);
      expect(
        YAML.parse(readFileSync(join(dir, 'integrations', 'github.yml'), 'utf8'))
      ).toMatchObject({
        auth_env_vars: expect.arrayContaining(declarations),
      });
      expect(readFileSync(join(dir, 'resources', 'github', 'repos.yml'), 'utf8')).toContain(
        'name: repos'
      );
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
