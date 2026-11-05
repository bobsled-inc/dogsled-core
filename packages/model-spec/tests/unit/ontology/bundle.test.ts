import { expect, it } from 'vitest';
import { exportOssieDocuments } from '../../../src/interchange/export.js';
import { importOntologyDocuments } from '../../../src/ontology/conversion.js';
it('does not silently omit ontologies from a mixed GA export', () => {
  const result = exportOssieDocuments(
    [
      {
        path: 'a.yml',
        document: {
          spec_version: '0.2',
          type: 'ontology',
          name: 'sales',
          ontology: [{ concept: 'Order', type: 'EntityType' }],
        },
      },
    ],
    { ossieVersion: '0.1.1' }
  );
  expect(result.ok).toBe(false);
  expect(result.files).toEqual([]);
  expect(result.diagnostics.some((d) => d.message.includes('0.2.0.dev0'))).toBe(true);
});
it('exports native ontologies through the existing document converter', () => {
  const result = exportOssieDocuments(
    [
      {
        path: 'a.yml',
        document: {
          spec_version: '0.2',
          type: 'ontology',
          name: 'sales',
          ontology: [{ concept: 'Order', type: 'EntityType' }],
        },
      },
    ],
    { ossieVersion: '0.2.0.dev0' }
  );
  expect(result.ok).toBe(true);
  expect(result.files[0]!.document).toMatchObject({
    ontology: [{ concept: 'Order', type: 'EntityType' }],
  });
});
it('turns embedded mappings into separate native mapping files', () => {
  const result = importOntologyDocuments([
    {
      path: 'a.yml',
      document: {
        version: '0.2.0.dev0',
        name: 'sales',
        ontology: [{ concept: 'Order', type: 'EntityType' }],
        ontology_mappings: [
          {
            name: 'orders',
            semantic_model: {
              version: '0.2.0.dev0',
              name: 'data',
              datasets: [{ name: 'orders', source: 'ORDERS', fields: [] }],
            },
            concept_mappings: [],
          },
        ],
      },
    },
  ]);
  expect(result.files.some((f) => f.document['type'] === 'ontology_mapping')).toBe(true);
  expect(result.files.find((f) => f.document['type'] === 'ontology')!.document).not.toHaveProperty(
    'ontology_mappings'
  );
});

it('exports each mapping scope using its declared name and dataset aliases', () => {
  const inputs = [
    {
      path: 'a.yml',
      document: {
        spec_version: '0.2',
        type: 'ontology',
        name: 'sales',
        ontology: [{ concept: 'Order', type: 'EntityType' }],
      },
    },
    {
      path: 'b.yml',
      document: {
        spec_version: '0.2',
        type: 'ontology_mapping',
        name: 'orders',
        ontology_ref: { name: 'sales' },
        semantic_model_ref: {
          name: 'warehouse_sales',
          bindings: { datasets: { orders: 'db.raw_orders' } },
        },
        concept_mappings: [],
      },
    },
    {
      path: 'c.yml',
      document: {
        spec_version: '0.2',
        type: 'source',
        source_type: 'warehouse_table',
        name: 'raw_orders',
        connection: 'db',
        table: 'RAW.ORDERS',
        schema: { columns: [{ name: 'id', type: 'BIGINT' }] },
      },
    },
  ];
  const result = exportOssieDocuments(inputs, { ossieVersion: '0.2.0.dev0' });
  expect(result.ok).toBe(true);
  expect(result.files.find((f) => f.document['datasets'])?.document).toMatchObject({
    name: 'warehouse_sales',
    datasets: [{ name: 'orders' }],
  });
});

it('keeps dependent model references valid when a scope renames a source', () => {
  const result = exportOssieDocuments(
    [
      {
        path: 'mapping.yml',
        document: {
          spec_version: '0.2',
          type: 'ontology_mapping',
          name: 'mapping',
          ontology_ref: { name: 'sales' },
          semantic_model_ref: {
            name: 'data',
            bindings: { datasets: { items: 'db.raw', derived: 'derived' } },
          },
          concept_mappings: [],
        },
      },
      {
        path: 'source.yml',
        document: {
          spec_version: '0.2',
          type: 'source',
          name: 'raw',
          connection: 'db',
          source_type: 'warehouse_table',
          table: 'RAW.ITEMS',
          schema: { columns: [{ name: 'id', type: 'BIGINT' }] },
        },
      },
      {
        path: 'model.yml',
        document: {
          spec_version: '0.2',
          type: 'model',
          name: 'derived',
          description: 'Derived items',
          grain: ['id'],
          source: { ref: 'db.raw' },
          materialization: { type: 'ephemeral' },
          columns: [{ name: 'id', type: 'BIGINT', expr: 'id' }],
        },
      },
    ],
    { ossieVersion: '0.2.0.dev0' }
  );
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  const imported = importOntologyDocuments(result.files);
  expect(imported.ready, JSON.stringify(imported.diagnostics)).toBe(true);
  expect(imported.files.find((f) => f.document['type'] === 'model')?.document['source']).toEqual({
    ref: 'db.items',
  });
});
