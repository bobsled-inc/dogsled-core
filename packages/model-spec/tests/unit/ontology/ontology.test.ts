import { describe, expect, it } from 'vitest';
import { indexProjectFiles } from '@bobsled-inc/project-index';
import { stringify } from 'yaml';
import {
  loadOntologyCatalog,
  getOntologyContext,
  parseOntologyDocument,
} from '../../../src/ontology/index.js';

const definition = {
  spec_version: '0.2',
  type: 'ontology',
  name: 'sales',
  ontology: [
    { concept: 'OrderNumber', type: 'ValueType', extends: ['String'] },
    {
      concept: 'Order',
      type: 'EntityType',
      identify_by: ['number'],
      relationships: [
        {
          name: 'number',
          roles: [{ concept: 'OrderNumber' }],
          multiplicity: 'OneToOne',
          verbalizes: ['{Order} has number {OrderNumber}'],
        },
      ],
    },
  ],
};
const catalog = (document: unknown = definition) =>
  loadOntologyCatalog(
    indexProjectFiles([{ path: 'business/sales/meaning.yml', content: stringify(document) }])
  );

describe('customer ontology catalog', () => {
  it('loads typed definitions from any indexed folder and retrieves exact concepts', () => {
    const loaded = catalog();
    expect(loaded.diagnostics).toEqual([]);
    expect(getOntologyContext(loaded, { ontology: 'sales', concept: 'Order' })).toMatchObject({
      concepts: expect.arrayContaining([expect.objectContaining({ concept: 'Order' })]),
      sourcePaths: ['business/sales/meaning.yml'],
      truncated: false,
    });
  });
  it('rejects unsupported fields rather than dropping them', () => {
    expect(() => parseOntologyDocument({ ...definition, custom_extensions: [] })).toThrow();
  });
  it('reports missing concepts with a field path', () => {
    const loaded = catalog({
      ...definition,
      ontology: [{ concept: 'Order', type: 'EntityType', extends: ['Missing'] }],
    });
    expect(loaded.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'unknown_concept',
        fieldPath: '/ontology/0/extends/0',
        severity: 'error',
      })
    );
  });
  it('rejects inheritance cycles but validates recursive rule references without execution', () => {
    expect(
      catalog({
        ...definition,
        ontology: [{ concept: 'Order', type: 'EntityType', extends: ['Order'] }],
      }).diagnostics
    ).toContainEqual(expect.objectContaining({ code: 'inheritance_cycle' }));
    const recursive = catalog({
      ...definition,
      ontology: [{ concept: 'Order', type: 'EntityType', derived_by: ['Order'] }],
    });
    expect(recursive.diagnostics).toEqual([]);
  });
  it('rejects duplicate identities without choosing a definition', () => {
    const loaded = loadOntologyCatalog(
      indexProjectFiles(
        ['a.yml', 'b.yml'].map((path) => ({ path, content: stringify(definition) }))
      )
    );
    expect(loaded.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'duplicate_identity' })
    );
    expect(() => getOntologyContext(loaded, { ontology: 'sales' })).toThrow();
  });
  it('distinguishes incomplete mappings from valid unmapped ontologies', () => {
    const loaded = catalog({
      spec_version: '0.2',
      type: 'ontology_mapping',
      name: 'orders',
      ontology_ref: { name: 'sales' },
      semantic_model_ref: { name: 'warehouse', bindings: { datasets: {} } },
      concept_mappings: [],
    });
    expect(loaded.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unknown_ontology' })
    );
  });
  it('reports omitted concept identities and rejects invalid result bounds', () => {
    expect(getOntologyContext(catalog(), { ontology: 'sales', limit: 1 })).toMatchObject({
      truncated: true,
      omitted: ['Order'],
    });
    expect(() => getOntologyContext(catalog(), { limit: 0 })).toThrow();
  });
});

it('rejects missing fields and conflicting mapping scopes', () => {
  const mapping = {
    spec_version: '0.2',
    type: 'ontology_mapping',
    name: 'orders',
    ontology_ref: { name: 'sales' },
    semantic_model_ref: {
      name: 'warehouse',
      bindings: { datasets: { orders: 'warehouse.orders' } },
    },
    concept_mappings: [{ concept: 'Order', object_mappings: [{ expression: 'orders.missing' }] }],
  };
  const index = indexProjectFiles([
    { path: 'a.yml', content: stringify(definition) },
    { path: 'm.yml', content: stringify(mapping) },
    {
      path: 's.yml',
      content: stringify({
        spec_version: '0.2',
        type: 'source',
        connection: 'warehouse',
        name: 'orders',
        schema: { columns: [{ name: 'id', type: 'VARCHAR' }] },
      }),
    },
    {
      path: 'm2.yml',
      content: stringify({
        ...mapping,
        name: 'other',
        semantic_model_ref: {
          name: 'warehouse',
          bindings: { datasets: { orders: 'warehouse.other' } },
        },
      }),
    },
  ]);
  const result = loadOntologyCatalog(index);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown_field' }));
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'conflicting_scope' }));
});

it('rejects undefined namespace prefixes', () => {
  const result = catalog({
    ...definition,
    ontology: [{ concept: 'Order', type: 'EntityType', iri: 'missing:Order' }],
  });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown_prefix' }));
});

it('returns parent and root meaning for an exact subtype lookup', () => {
  const loaded = catalog({
    ...definition,
    prefixes: { ex: 'https://example.com/' },
    requires: ['Order'],
    ontology: [
      ...definition.ontology,
      { concept: 'PriorityOrder', type: 'EntityType', extends: ['Order'] },
    ],
  });
  const result = getOntologyContext(loaded, { ontology: 'sales', concept: 'PriorityOrder' });
  expect(result.concepts.map((c) => c.concept)).toContain('Order');
  expect(result.ontologies[0]).toMatchObject({
    requires: ['Order'],
    prefixes: { ex: 'https://example.com/' },
  });
});

it('maps inherited identifiers and checks n-ary links by tree depth', () => {
  const doc = {
    ...definition,
    ontology: [
      ...definition.ontology,
      { concept: 'PriorityOrder', type: 'EntityType', extends: ['Order'] },
      { concept: 'Store', type: 'ValueType', extends: ['String'] },
      { concept: 'Amount', type: 'ValueType', extends: ['Decimal'] },
    ],
  };
  doc.ontology[1] = {
    ...doc.ontology[1],
    relationships: [
      ...definition.ontology[1]!.relationships!,
      {
        name: 'sold',
        roles: [{ concept: 'Store' }, { concept: 'Amount' }],
        verbalizes: ['{Order} sells in {Store} for {Amount}'],
      },
    ],
  } as (typeof doc.ontology)[number];
  const mapping = {
    spec_version: '0.2',
    type: 'ontology_mapping',
    name: 'sales',
    ontology_ref: { name: 'sales' },
    semantic_model_ref: { name: 'data', bindings: { datasets: { orders: 'db.orders' } } },
    concept_mappings: [
      { concept: 'PriorityOrder', object_mappings: [{ expression: 'orders.id' }] },
      {
        concept: 'Order',
        link_mappings: [
          {
            object_mapping: { expression: 'orders.id' },
            children: [
              {
                object_mapping: { concept: 'Store', expression: 'orders.store' },
                children: [
                  {
                    relationship: 'sold',
                    object_mapping: { concept: 'Amount', expression: 'orders.amount' },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const loaded = loadOntologyCatalog(
    indexProjectFiles([
      { path: 'a.yml', content: stringify(doc) },
      { path: 'b.yml', content: stringify(mapping) },
      {
        path: 'c.yml',
        content: stringify({
          type: 'source',
          spec_version: '0.2',
          name: 'orders',
          connection: 'db',
          schema: { columns: ['id', 'store', 'amount'].map((name) => ({ name, type: 'VARCHAR' })) },
        }),
      },
    ])
  );
  expect(loaded.diagnostics).toEqual([]);
});

it.each(['wrong', [null]])(
  'reports malformed bound model columns without crashing (%j)',
  (columns) => {
    const result = loadOntologyCatalog(
      indexProjectFiles([
        { path: 'a.yml', content: stringify(definition) },
        {
          path: 'b.yml',
          content: stringify({
            spec_version: '0.2',
            type: 'ontology_mapping',
            name: 'm',
            ontology_ref: { name: 'sales' },
            semantic_model_ref: { name: 'data', bindings: { datasets: { orders: 'db.orders' } } },
            concept_mappings: [
              { concept: 'Order', object_mappings: [{ expression: 'orders.id' }] },
            ],
          }),
        },
        {
          path: 'c.yml',
          content: stringify({
            spec_version: '0.2',
            type: 'source',
            name: 'orders',
            connection: 'db',
            schema: { columns },
          }),
        },
      ])
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid_model_columns' })
    );
  }
);

it('accepts Ossie named role verbalizations and rejects non-binary identifiers', () => {
  const doc = {
    ...definition,
    ontology: [
      {
        concept: 'Person',
        type: 'EntityType',
        identify_by: ['child'],
        relationships: [
          {
            name: 'child',
            roles: [{ concept: 'Person', name: 'child' }],
            verbalizes: ['{Person} has child {Person:child}'],
          },
        ],
      },
    ],
  };
  expect(catalog(doc).diagnostics).toEqual([]);
  doc.ontology[0]!.relationships[0]!.roles.push({ concept: 'Person', name: 'other' });
  expect(catalog(doc).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'invalid_identifier' })
  );
});

it('reports missing selected semantic metadata instead of silently omitting it', () => {
  const loaded = catalog({
    spec_version: '0.2',
    type: 'ontology_mapping',
    name: 'mapping',
    ontology_ref: { name: 'sales' },
    semantic_model_ref: { name: 'data', bindings: { datasets: {}, metrics: ['missing'] } },
    concept_mappings: [],
  });
  expect(loaded.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'unresolved_binding' })
  );
});
