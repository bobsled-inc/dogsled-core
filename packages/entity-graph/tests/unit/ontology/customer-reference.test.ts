import { expect, it } from 'vitest';
import { indexProjectFiles } from '@bobsled-inc/project-index';
import { loadOntologyCatalog } from '@bobsled-inc/model-spec/ontology';
import { resolveCustomerOntologyReference } from '../../../src/compiler/ontology/customer-reference.js';
const catalog = loadOntologyCatalog(
  indexProjectFiles([
    {
      path: 'sales.yml',
      content:
        "spec_version: '0.2'\ntype: ontology\nname: sales\nontology:\n  - concept: Order\n    type: EntityType\n    relationships:\n      - name: customer\n        description: The customer that placed the order.\n        roles: [{concept: Customer}]\n        verbalizes: ['{Order} belongs to {Customer}']\n  - concept: Customer\n    type: EntityType\n",
    },
  ])
);
it('resolves shared meaning while keeping runtime entity bindings explicit', () => {
  expect(
    resolveCustomerOntologyReference(catalog, {
      ontology: 'sales',
      concept: 'Order',
      relationship: 'customer',
      left_concept: 'Order',
      right_concept: 'Customer',
    })
  ).toEqual({
    description: 'The customer that placed the order.',
    leftConcept: 'Order',
    rightConcept: 'Customer',
  });
});
it('rejects a role binding that changes the relationship meaning', () => {
  expect(() =>
    resolveCustomerOntologyReference(catalog, {
      ontology: 'sales',
      concept: 'Order',
      relationship: 'customer',
      left_concept: 'Customer',
      right_concept: 'Order',
    })
  ).toThrow();
});

it('rejects local cardinality that weakens shared multiplicity', () => {
  const constrained = structuredClone(catalog);
  const document = constrained.entries[0]!.document;
  if (document.type === 'ontology') {
    document.ontology[0]!.relationships![0]!.multiplicity = 'OneToOne';
  }
  expect(() =>
    resolveCustomerOntologyReference(
      constrained,
      {
        ontology: 'sales',
        concept: 'Order',
        relationship: 'customer',
        left_concept: 'Order',
        right_concept: 'Customer',
      },
      'many_to_many'
    )
  ).toThrow();
});
