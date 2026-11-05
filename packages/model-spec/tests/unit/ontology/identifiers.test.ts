import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { indexProjectFiles } from '@bobsled-inc/project-index';
import { loadOntologyCatalog } from '../../../src/ontology/catalog.js';

const relationship = (name: string, concept: string) => ({
  name,
  roles: [{ concept }],
  verbalizes: [],
});
const definition = {
  spec_version: '0.2',
  type: 'ontology',
  name: 'licenses',
  ontology: [
    { concept: 'Region', type: 'ValueType', extends: ['String'] },
    {
      concept: 'Account',
      type: 'EntityType',
      identify_by: ['region', 'number'],
      relationships: [relationship('region', 'Region'), relationship('number', 'Integer')],
    },
    {
      concept: 'License',
      type: 'EntityType',
      identify_by: ['account'],
      relationships: [relationship('account', 'Account')],
    },
  ],
};
const validate = (object: unknown) =>
  loadOntologyCatalog(
    indexProjectFiles([
      { path: 'o.yml', content: stringify(definition) },
      {
        path: 'm.yml',
        content: stringify({
          spec_version: '0.2',
          type: 'ontology_mapping',
          name: 'licenses',
          ontology_ref: { name: 'licenses' },
          semantic_model_ref: { name: 'data', bindings: { datasets: { licenses: 'db.licenses' } } },
          concept_mappings: [{ concept: 'License', object_mappings: [object] }],
        }),
      },
      {
        path: 's.yml',
        content: stringify({
          spec_version: '0.2',
          type: 'source',
          name: 'licenses',
          connection: 'db',
          schema: {
            columns: ['id', 'region', 'number'].map((name) => ({ name, type: 'VARCHAR' })),
          },
        }),
      },
    ])
  ).diagnostics;
it.each([
  { expression: 'licenses.id' },
  { referent_mappings: [{ relationship: 'account', expression: 'licenses.id' }] },
])('rejects value expressions that bypass entity identifiers (%j)', (object) => {
  expect(validate(object)).toContainEqual(
    expect.objectContaining({ code: 'compound_identifier', severity: 'error' })
  );
});
it('accepts complete nested identifiers including built-in value targets', () => {
  expect(
    validate({
      referent_mappings: [
        {
          relationship: 'account',
          referent_mappings: [
            { relationship: 'region', expression: 'licenses.region' },
            { relationship: 'number', expression: 'licenses.number' },
          ],
        },
      ],
    })
  ).toEqual([]);
});
