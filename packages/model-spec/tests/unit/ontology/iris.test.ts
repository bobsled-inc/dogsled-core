import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { indexProjectFiles } from '@bobsled-inc/project-index';
import { loadOntologyCatalog } from '../../../src/ontology/catalog.js';
const validate = (iri: string, prefixes = { ex: 'https://example.com/' }) =>
  loadOntologyCatalog(
    indexProjectFiles([
      {
        path: 'o.yml',
        content: stringify({
          spec_version: '0.2',
          type: 'ontology',
          name: 'example',
          prefixes,
          ontology: [{ concept: 'Account', type: 'EntityType', iri }],
        }),
      },
    ])
  ).diagnostics;
it.each([
  'https://not a valid iri',
  'https://example.com/%ZZ',
  'https://',
  'urn:',
  'https://example.com/\\path',
  'https://example.com/<bad>',
])('rejects invalid IRI %s', (iri) =>
  expect(validate(iri)).toContainEqual(
    expect.objectContaining({ code: 'invalid_iri', severity: 'error' })
  )
);
it('rejects invalid prefix values and expanded identifiers', () => {
  expect(validate('ex:Account', { ex: 'not an IRI' })).toContainEqual(
    expect.objectContaining({ fieldPath: '/prefixes/ex', code: 'invalid_iri' })
  );
  expect(validate('ex:bad value')).toContainEqual(expect.objectContaining({ code: 'invalid_iri' }));
});
it.each([
  'https://example.com/企業',
  'urn:example:Account',
  'mailto:person@example.com',
  'ex:Account',
  'https://example.com/%20',
  'https://[::1]/Account',
])('preserves valid IRI %s', (iri) => expect(validate(iri)).toEqual([]));

it.each(['file:/definitions/Account', 'https:Account', 'custom:/definitions/Account'])(
  'accepts absolute IRI schemes without an authority: %s',
  (iri) => expect(validate(iri)).toEqual([])
);
