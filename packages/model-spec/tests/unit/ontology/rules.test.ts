import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { indexProjectFiles } from '@bobsled-inc/project-index';
import { loadOntologyCatalog } from '../../../src/ontology/catalog.js';
const relation = (name: string, roles: { concept: string; name?: string }[] = [], extra = {}) => ({
  name,
  roles,
  verbalizes: [],
  ...extra,
});
const definition = {
  spec_version: '0.2',
  type: 'ontology',
  name: 'people',
  ontology: [
    { concept: 'Salary', type: 'ValueType', extends: ['Decimal'], requires: ['Salary > 0.0'] },
    {
      concept: 'Person',
      type: 'EntityType',
      relationships: [
        relation('earns', [{ concept: 'Salary' }]),
        relation('files_single'),
        relation('parent_of', [{ concept: 'Person', name: 'child' }]),
        relation('ancestor_of', [{ concept: 'Person', name: 'descendant' }], {
          derived_by: ['Person.parent_of(descendant)', 'Person.ancestor_of.parent_of(descendant)'],
        }),
        relation('taxed_at', [{ concept: 'Decimal', name: 'rate' }], {
          derived_by: ['Person.files_single AND Person.earns <= 11925 AND rate == 10.0'],
        }),
      ],
    },
    {
      concept: 'Employee',
      type: 'EntityType',
      extends: ['Person'],
      derived_by: ['EXISTS ( Person.earns )'],
    },
  ],
};
function validate(doc: unknown) {
  return loadOntologyCatalog(indexProjectFiles([{ path: 'rules.yml', content: stringify(doc) }]))
    .diagnostics;
}
it('validates documented navigation, recursive calls, comparisons, and EXISTS without executing them', () => {
  expect(validate(definition)).toEqual([]);
});
it.each([
  ['MissingConcept.no_such_relation', 'expression_reference'],
  ['Person.missing', 'expression_reference'],
  ['Person.earns < "ten"', 'expression_type'],
  ['Person.parent_of(Salary)', 'expression_type'],
  ['Person.parent_of(Person, Person)', 'expression_arity'],
  ['Person.earns >', 'expression_syntax'],
])('rejects invalid rule %s', (expression, code) => {
  const doc = structuredClone(definition);
  Object.assign(doc.ontology[1]!, { requires: [expression] });
  expect(validate(doc)).toContainEqual(expect.objectContaining({ code, severity: 'error' }));
});
it('keeps unknown syntax labeled as unverified rather than rejecting valid extensions', () => {
  const doc = structuredClone(definition);
  Object.assign(doc.ontology[1]!, { requires: ['CUSTOM_CHECK(Person)'] });
  expect(validate(doc)).toEqual([
    expect.objectContaining({ code: 'expression_not_verified', severity: 'warning' }),
  ]);
});
it('checks that concept constraints refer to the constrained concept', () => {
  const doc = structuredClone(definition);
  Object.assign(doc.ontology[1]!, { requires: ['Salary > 0'] });
  expect(validate(doc)).toContainEqual(
    expect.objectContaining({ code: 'expression_scope', severity: 'error' })
  );
});
it('checks all derived relationship roles and permits an implicit final value', () => {
  const doc = structuredClone(definition);
  doc.ontology[1]!.relationships!.push(
    relation('double_salary', [{ concept: 'Salary' }], { derived_by: ['Person.earns'] })
  );
  expect(validate(doc)).toEqual([]);
  doc.ontology[1]!.relationships!.push(
    relation('incomplete', [{ concept: 'Person', name: 'other' }], {
      derived_by: ['Person.files_single'],
    })
  );
  expect(validate(doc)).toContainEqual(
    expect.objectContaining({ code: 'expression_scope', severity: 'error' })
  );
});
it('bounds deeply nested rules and ignores reference-like text inside string literals', () => {
  const doc = structuredClone(definition);
  Object.assign(doc.ontology[1]!, { requires: ['('.repeat(200) + 'Person' + ')'.repeat(200)] });
  expect(validate(doc)).toContainEqual(
    expect.objectContaining({ code: 'expression_not_verified' })
  );
  Object.assign(doc.ontology[1]!, {
    requires: ['Person.files_single AND "Missing.field" == "Missing.field"'],
  });
  expect(validate(doc)).toEqual([]);
});

it.each(['Person.earns BETWEEN 0 AND 99', 'Person.earns IS NOT NULL'])(
  'preserves unsupported SQL forms as unverified: %s',
  (expression) => {
    const doc = structuredClone(definition);
    Object.assign(doc.ontology[1]!, { requires: [expression] });
    expect(validate(doc)).toEqual([
      expect.objectContaining({ code: 'expression_not_verified', severity: 'warning' }),
    ]);
  }
);
it('accepts lowercase SQL keywords in supported rule forms', () => {
  const doc = structuredClone(definition);
  Object.assign(doc.ontology[1]!, {
    requires: [
      'Person.earns > 0 and Person.earns < 99',
      'exists (Person.earns) or not Person.files_single',
    ],
  });
  expect(validate(doc)).toEqual([]);
});
