import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerOntologyCommand } from '../../../src/commands/ontology.js';
it('validates a project without a database and returns JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ontology-cli-'));
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    writeFileSync(
      join(root, 'a.yml'),
      "spec_version: '0.2'\ntype: ontology\nname: sales\nontology: [{concept: Order, type: EntityType}]\n"
    );
    const program = new Command();
    registerOntologyCommand(program);
    await program.parseAsync([
      'node',
      'dogsled',
      'ontology',
      'validate',
      '--project-root',
      root,
      '--json',
    ]);
    const result = JSON.parse(output.mock.calls.map((c) => String(c[0])).join(''));
    expect(result).toMatchObject({ ok: true, diagnostics: [] });
  } finally {
    output.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it('honors a project root passed before the command group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ontology-root-'));
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    writeFileSync(
      join(root, 'a.yml'),
      "spec_version: '0.2'\ntype: ontology\nname: target_only\nontology: [{concept: Order, type: EntityType}]\n"
    );
    const program = new Command().option('--project-root <path>');
    registerOntologyCommand(program);
    await program.parseAsync(['node', 'dogsled', '--project-root', root, 'ontology', 'list']);
    expect(JSON.parse(output.mock.calls.map((c) => String(c[0])).join('')).entries).toEqual([
      expect.objectContaining({ name: 'target_only' }),
    ]);
  } finally {
    output.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
