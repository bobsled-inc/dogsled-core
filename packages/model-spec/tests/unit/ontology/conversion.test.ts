import { expect, it } from 'vitest';
import {
  exportOntologyDocuments,
  importOntologyDocuments,
} from '../../../src/ontology/conversion.js';
const ontology = {
  spec_version: '0.2',
  type: 'ontology',
  name: '../Sales',
  ontology: [{ concept: 'Order', type: 'EntityType', derived_by: ['Order'] }],
};
it('round trips standard definitions with safe output names', () => {
  const exported = exportOntologyDocuments([{ path: 'business.yml', document: ontology }], {
    ossieVersion: '0.2.0.dev0',
  });
  expect(exported.ok).toBe(true);
  expect(exported.files[0]!.path).not.toContain('..');
  expect(exported.files[0]!.document).toMatchObject({ version: '0.2.0.dev0', name: '../Sales' });
  const imported = importOntologyDocuments(exported.files);
  expect(imported.ok).toBe(true);
  expect(imported.files[0]!.document).toEqual(ontology);
});
it.each([false, true])(
  'rejects unsupported versions before producing files (strict=%s)',
  (strict) => {
    const result = exportOntologyDocuments([{ path: 'a.yml', document: ontology }], {
      ossieVersion: '0.1.1',
      strict,
    });
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
  }
);
it('preserves native bindings and unknown vendor extensions in mapping round trips', () => {
  const mapping = {
    spec_version: '0.2',
    type: 'ontology_mapping',
    name: 'orders',
    ontology_ref: { name: '../Sales' },
    semantic_model_ref: { name: 'warehouse', bindings: { datasets: { orders: 'sales.orders' } } },
    concept_mappings: [{ concept: 'Order', object_mappings: [{ expression: 'orders.id' }] }],
    custom_extensions: [{ vendor_name: 'EXAMPLE', data: '{}' }],
  };
  const result = exportOntologyDocuments([{ path: 'm.yml', document: mapping }], {
    ossieVersion: '0.2.0.dev0',
  });
  expect(result.ok).toBe(true);
  expect(importOntologyDocuments(result.files).files[0]!.document).toEqual(mapping);
});
it('rejects invalid version on import', () => {
  expect(
    importOntologyDocuments([
      { path: 'a.yml', document: { version: '0.2.2', name: 'sales', ontology: [] } },
    ]).ok
  ).toBe(false);
});
