import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { editOntologyFile } from '../../../src/ontology/edit.js';
const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'ontology-'));
  roots.push(root);
  return root;
};
afterEach(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const content =
  "# Keep this comment\nspec_version: '0.2'\ntype: ontology\nname: sales\nontology:\n  - concept: Order\n    type: EntityType\n";
it('previews edits and preserves unrelated comments when applied', () => {
  const root = setup();
  writeFileSync(join(root, 'concepts.yml'), content);
  const preview = editOntologyFile(root, {
    path: 'concepts.yml',
    patch: { description: 'Orders' },
  });
  expect(preview.content).toContain('# Keep this comment');
  expect(readFileSync(join(root, 'concepts.yml'), 'utf8')).toBe(content);
  editOntologyFile(root, { path: 'concepts.yml', patch: { description: 'Orders' }, apply: true });
  expect(readFileSync(join(root, 'concepts.yml'), 'utf8')).toContain('description: Orders');
});
it('rejects path escapes, links, and overwriting during creation', () => {
  const root = setup();
  const other = setup();
  mkdirSync(join(root, 'business'));
  symlinkSync(other, join(root, 'linked'));
  expect(() => editOntologyFile(root, { path: '../escape.yml', content })).toThrow();
  expect(() => editOntologyFile(root, { path: 'linked/a.yml', content, apply: true })).toThrow();
  writeFileSync(join(root, 'a.yml'), content);
  expect(() => editOntologyFile(root, { path: 'a.yml', content, apply: true })).toThrow();
});
it('shows references affected by a rename without silently changing them', () => {
  const root = setup();
  writeFileSync(join(root, 'a.yml'), content);
  writeFileSync(
    join(root, 'map.yml'),
    "spec_version: '0.2'\ntype: ontology_mapping\nname: orders\nontology_ref: {name: sales}\nsemantic_model_ref: {name: data}\nconcept_mappings: []\n"
  );
  expect(
    editOntologyFile(root, { path: 'a.yml', patch: { name: 'new_sales' } }).affectedPaths
  ).toContain('map.yml');
});

it('does not follow a planted temporary-file link', () => {
  const root = setup();
  const other = setup();
  writeFileSync(join(root, 'a.yml'), content);
  const sentinel = join(other, 'keep.txt');
  writeFileSync(sentinel, 'unchanged');
  symlinkSync(sentinel, join(root, `.a.yml.${process.pid}.tmp`));
  editOntologyFile(root, { path: 'a.yml', patch: { description: 'Orders' }, apply: true });
  expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
});
