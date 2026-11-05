import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOntologyTools } from '../../../src/ontology/tools.js';
it('requires host authorization before loading or editing files', async () => {
  const tools = createOntologyTools({ projectRoot: '/does-not-exist', authorize: () => false });
  await expect(tools.call('ontology_list', {})).rejects.toThrow('permission');
  await expect(tools.call('ontology_edit', { path: 'a.yml', patch: {} })).rejects.toThrow(
    'permission'
  );
});
it('returns config-only catalog results with validation status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ontology-tools-'));
  try {
    writeFileSync(
      join(root, 'a.yml'),
      "spec_version: '0.2'\ntype: ontology\nname: sales\nontology: [{concept: Order, type: EntityType}]\n"
    );
    const tools = createOntologyTools({ projectRoot: root, authorize: (mode) => mode === 'read' });
    expect(
      await tools.call('ontology_describe', { ontology: 'sales', concept: 'Order' })
    ).toMatchObject({ concepts: [{ concept: 'Order', type: 'EntityType' }], truncated: false });
    expect(await tools.call('ontology_validate', {})).toMatchObject({ ok: true, diagnostics: [] });
    await expect(
      tools.call('ontology_edit', { path: 'a.yml', patch: { description: 'Changed' }, apply: true })
    ).rejects.toThrow('permission');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('fails export when an ontology file could not be loaded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ontology-export-'));
  try {
    writeFileSync(
      join(root, 'bad.yml'),
      "spec_version: '0.2'\ntype: ontology\nname: bad\nontology: invalid\n"
    );
    const tools = createOntologyTools({ projectRoot: root, authorize: () => true });
    expect(await tools.call('ontology_export', { ossieVersion: '0.2.0.dev0' })).toMatchObject({
      ok: false,
      files: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
