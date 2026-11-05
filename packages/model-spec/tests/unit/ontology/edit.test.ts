import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { RelationshipOntologySpecSchema } from '../../../src/entities/relationship-ontology.js';
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

it('repairs or deletes invalid drafts while refusing other file types', () => {
  const root = setup();
  const path = join(root, 'broken.yml');
  const broken = "spec_version: '0.2'\ntype: ontology\nname: sales\nontology: wrong\n";
  writeFileSync(path, broken);
  const patch = { ontology: [{ concept: 'Order', type: 'EntityType' }] };
  expect(editOntologyFile(root, { path: 'broken.yml', patch }).diagnostics).toEqual([]);
  expect(readFileSync(path, 'utf8')).toBe(broken);
  expect(editOntologyFile(root, { path: 'broken.yml', patch, apply: true }).applied).toBe(true);
  writeFileSync(path, broken);
  expect(editOntologyFile(root, { path: 'broken.yml', delete: true, apply: true }).deleted).toBe(
    true
  );
  writeFileSync(path, 'type: model\nname: sales\n');
  expect(() => editOntologyFile(root, { path: 'broken.yml', delete: true, apply: true })).toThrow();
  expect(readFileSync(path, 'utf8')).toContain('type: model');
});

it.each([{ patch: { name: 'renamed' } }, { delete: true }])(
  'reports extraction consumers when changing an ontology (%j)',
  (change) => {
    const root = setup();
    const definition =
      content +
      `    relationships:
      - name: customer
        roles: [{concept: Customer}]
        verbalizes: ['{Order} belongs to {Customer}']
  - concept: Customer
    type: EntityType
`;
    writeFileSync(join(root, 'concepts.yml'), definition);
    writeFileSync(
      join(root, 'extraction.yml'),
      `spec_version: '0.2'
type: relationship_ontology
name: extracted
relations:
  - relation_type: order_customer
    left_entity: orders
    right_entity: customers
    direction: directed
    cardinality: many_to_one
    temporal: stateful
    review_thresholds: {auto_confirm: 0.9, review: 0.5, auto_reject: 0.1}
    ontology_ref:
      ontology: sales
      concept: Order
      relationship: customer
      left_concept: Order
      right_concept: Customer
`
    );
    expect(
      RelationshipOntologySpecSchema.safeParse(
        parse(readFileSync(join(root, 'extraction.yml'), 'utf8'))
      ).success
    ).toBe(true);
    expect(editOntologyFile(root, { path: 'concepts.yml', patch: {} }).diagnostics).toEqual([]);
    const preview = editOntologyFile(root, { path: 'concepts.yml', ...change });
    expect(preview.affectedPaths).toContain('extraction.yml');
    expect(preview.diagnostics).toContainEqual(
      expect.objectContaining({
        filePath: 'extraction.yml',
        code: 'unknown_ontology',
        severity: 'error',
      })
    );
    expect(readFileSync(join(root, 'concepts.yml'), 'utf8')).toBe(definition);
  }
);
