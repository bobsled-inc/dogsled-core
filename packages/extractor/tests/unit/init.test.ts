import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { registerInitCommand } from '../../src/commands/init.js';
import { IntegrationSpecSchema } from '../../src/framework/extractor/resource.js';

it('declares the environment references written by extract init', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'extract-init-declarations-'));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const program = new Command('extract');
    registerInitCommand(program);
    await program.parseAsync(['node', 'extract', 'init', directory]);
    const integration = IntegrationSpecSchema.parse(
      YAML.parse(readFileSync(join(directory, 'integrations', 'example_api.yml'), 'utf8'))
    );
    expect(integration).toMatchObject({ auth_env_vars: ['EXAMPLE_API_TOKEN'] });
  } finally {
    stderr.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
