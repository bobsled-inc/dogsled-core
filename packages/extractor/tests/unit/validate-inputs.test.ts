import { describe, expect, it } from 'vitest';

import {
  assertApiResourceSemanticsForExtraction,
  checkInputCompleteness,
} from '../../src/commands/validate.js';
import {
  checkSemanticMetadata,
  normalizeSemanticCheckMode,
} from '../../src/commands/semantic-check.js';
import type { ResourceSpec } from '../../src/types/index.js';
import { makeResource } from '../helpers/fixtures.js';

/**
 * Helper: attach for_each to a resource created by makeResource.
 * makeResource does not forward for_each, so we patch it directly.
 */
function withForEach(
  resource: ResourceSpec,
  forEach: NonNullable<ResourceSpec['extract']['for_each']>
): ResourceSpec {
  return { ...resource, extract: { ...resource.extract, for_each: forEach } };
}

describe('checkInputCompleteness', () => {
  it('returns no findings when all inputs have defaults', () => {
    const resource = makeResource({
      api: { endpoint: '/items/${{ input.id }}', method: 'GET' },
      input: {
        id: { type: 'string', required: true, default: 'default-id' },
      },
    });

    const findings = checkInputCompleteness(resource, [resource]);
    expect(findings).toEqual([]);
  });

  it('returns no findings when required input is covered by for_each', () => {
    const parent = makeResource({
      name: 'parents',
      output: {
        parent_id: { type: 'string', path: '$.id' },
      },
    });

    const child = withForEach(
      makeResource({
        name: 'children',
        api: { endpoint: '/parents/${{ input.parent_id }}/children', method: 'GET' },
        input: {
          parent_id: { type: 'string', required: true },
        },
      }),
      { resource: 'parents', field: 'parent_id', input: 'parent_id' }
    );

    const findings = checkInputCompleteness(child, [parent, child]);
    expect(findings).toEqual([]);
  });

  it('warns on required path parameter without for_each', () => {
    const resource = makeResource({
      api: { endpoint: '/orgs/${{ input.org_id }}/repos', method: 'GET' },
      input: {
        org_id: { type: 'string', required: true },
      },
    });

    const findings = checkInputCompleteness(resource, [resource]);
    expect(findings).toEqual([
      {
        field: 'org_id',
        message: "path parameter 'org_id' requires a value — add for_each or provide via --input",
        severity: 'warn',
      },
    ]);
  });

  it('warns on required query parameter without default', () => {
    const resource = makeResource({
      api: {
        endpoint: '/items',
        method: 'GET',
        query_params: { filter: '${{ input.filter }}' },
      },
      input: {
        filter: { type: 'string', required: true },
      },
    });

    const findings = checkInputCompleteness(resource, [resource]);
    expect(findings).toEqual([
      {
        field: 'filter',
        message: "required parameter 'filter' has no default and no for_each",
        severity: 'warn',
      },
    ]);
  });

  it('errors when for_each references non-existent resource', () => {
    const resource = withForEach(
      makeResource({
        name: 'children',
        api: { endpoint: '/children', method: 'GET' },
        input: {
          parent_id: { type: 'string', required: true },
        },
      }),
      { resource: 'nonexistent', field: 'id', input: 'parent_id' }
    );

    const findings = checkInputCompleteness(resource, [resource]);
    expect(findings).toEqual([
      {
        field: 'nonexistent',
        message: "for_each references non-existent resource 'nonexistent'",
        severity: 'error',
      },
    ]);
  });

  it('errors when for_each references non-existent field in parent resource', () => {
    const parent = makeResource({
      name: 'parents',
      output: {
        name: { type: 'string', path: '$.name' },
      },
    });

    const child = withForEach(
      makeResource({
        name: 'children',
        api: { endpoint: '/children', method: 'GET' },
        input: {
          parent_id: { type: 'string', required: true },
        },
      }),
      { resource: 'parents', field: 'missing_field', input: 'parent_id' }
    );

    const findings = checkInputCompleteness(child, [parent, child]);
    expect(findings).toEqual([
      {
        field: 'missing_field',
        message:
          "for_each binding 'missing_field' does not exist in resource 'parents' output fields",
        severity: 'error',
      },
    ]);
  });

  it('returns no findings when resource has no inputs', () => {
    const resource = makeResource({
      input: {},
    });

    const findings = checkInputCompleteness(resource, [resource]);
    expect(findings).toEqual([]);
  });

  it('validates binding destinations and exact source/input types', () => {
    const parent = makeResource({
      name: 'parents',
      output: { id: { type: 'integer', path: '$.id' } },
    });
    const child = withForEach(
      makeResource({ name: 'children', input: { parent_id: { type: 'string' } } }),
      {
        resource: 'parents',
        bindings: [
          { field: 'id', input: 'parent_id' },
          { field: 'id', input: 'undeclared' },
        ],
      }
    );

    expect(checkInputCompleteness(child, [parent, child])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'parent_id',
          message: expect.stringContaining('type mismatch'),
        }),
        expect.objectContaining({
          field: 'undeclared',
          message: expect.stringContaining('not a declared input'),
        }),
      ])
    );
  });

  it('validates contextual output ancestry, declared nested paths, and exact types', () => {
    const organization = makeResource({
      name: 'organizations',
      output: {
        id: { type: 'integer', path: '$.id' },
        identity: {
          type: 'object',
          path: '$.identity',
          properties: { id: { type: 'integer', path: '$.id' } },
        },
      },
    });
    const project = withForEach(
      makeResource({
        name: 'projects',
        input: { organization_id: { type: 'integer' } },
        output: { id: { type: 'integer', path: '$.id' } },
      }),
      { resource: 'organizations', field: 'id', input: 'organization_id' }
    );
    const event = withForEach(
      makeResource({
        name: 'events',
        input: { project_id: { type: 'integer' } },
        output: {
          organization_id: {
            type: 'integer',
            from: { resource: 'organizations', path: '$.identity.id' },
          },
          project_id: {
            type: 'integer',
            from: { resource: 'projects', path: '$.id' },
          },
        },
      }),
      { resource: 'projects', field: 'id', input: 'project_id' }
    );

    const findings = checkInputCompleteness(event, [organization, project, event]);
    expect(findings.filter((finding) => finding.field.endsWith('_id'))).toEqual([]);
  });

  it('rejects contextual outputs from non-ancestors, opaque paths, and mismatched types', () => {
    const parent = makeResource({
      name: 'parents',
      output: {
        id: { type: 'integer', path: '$.id' },
        opaque: { type: 'object', path: '$.opaque' },
      },
    });
    const unrelated = makeResource({
      name: 'unrelated',
      output: { id: { type: 'integer', path: '$.id' } },
    });
    const child = withForEach(
      makeResource({
        name: 'children',
        input: { parent_id: { type: 'integer' } },
        output: {
          wrong_type: { type: 'string', from: { resource: 'parents', path: '$.id' } },
          opaque: { type: 'string', from: { resource: 'parents', path: '$.opaque.id' } },
          unrelated_id: { type: 'integer', from: { resource: 'unrelated', path: '$.id' } },
        },
      }),
      { resource: 'parents', field: 'id', input: 'parent_id' }
    );

    const findings = checkInputCompleteness(child, [parent, unrelated, child]);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'wrong_type',
          message: expect.stringContaining('type mismatch'),
        }),
        expect.objectContaining({ field: 'opaque', message: expect.stringContaining('opaque') }),
        expect.objectContaining({
          field: 'unrelated_id',
          message: expect.stringContaining('not an ancestor'),
        }),
      ])
    );
  });

  it('skips non-required inputs without defaults', () => {
    const resource = makeResource({
      api: {
        endpoint: '/items',
        method: 'GET',
        query_params: { filter: '${{ input.filter }}' },
      },
      input: {
        filter: { type: 'string' },
      },
    });

    const findings = checkInputCompleteness(resource, [resource]);
    expect(findings).toEqual([]);
  });
});

describe('assertApiResourceSemanticsForExtraction', () => {
  it('rejects an undeclared ancestor output path before extraction', () => {
    const parent = makeResource({
      name: 'projects',
      output: { id: { type: 'integer', path: '$.id' } },
    });
    const child = withForEach(
      makeResource({
        name: 'events',
        input: { project_id: { type: 'integer', required: true } },
        output: {
          id: { type: 'string', path: '$.id' },
          project_id: {
            type: 'integer',
            from: { resource: 'projects', path: '$.missing' },
          },
        },
      }),
      { resource: 'projects', field: 'id', input: 'project_id' }
    );

    expect(() => assertApiResourceSemanticsForExtraction([child], [parent, child])).toThrow(
      /validation failed before extraction.*missing or opaque/s
    );
  });

  it('rejects a contextual origin outside the proven ancestry chain before extraction', () => {
    const parent = makeResource({
      name: 'projects',
      output: { id: { type: 'integer', path: '$.id' } },
    });
    const unrelated = makeResource({
      name: 'organizations',
      output: { id: { type: 'integer', path: '$.id' } },
    });
    const child = withForEach(
      makeResource({
        name: 'events',
        input: { project_id: { type: 'integer', required: true } },
        output: {
          id: { type: 'string', path: '$.id' },
          organization_id: {
            type: 'integer',
            from: { resource: 'organizations', path: '$.id' },
          },
        },
      }),
      { resource: 'projects', field: 'id', input: 'project_id' }
    );

    expect(() =>
      assertApiResourceSemanticsForExtraction([child], [parent, unrelated, child])
    ).toThrow(/validation failed before extraction.*not an ancestor/s);
  });
});

describe('semantic metadata validation', () => {
  it('normalizes semantic-check modes', () => {
    expect(normalizeSemanticCheckMode(undefined)).toBe('off');
    expect(normalizeSemanticCheckMode('off')).toBe('off');
    expect(normalizeSemanticCheckMode(true)).toBe('warn');
    expect(normalizeSemanticCheckMode('warn')).toBe('warn');
    expect(normalizeSemanticCheckMode('strict')).toBe('strict');
    expect(() => normalizeSemanticCheckMode('loose')).toThrow(
      'Invalid --semantic-check mode "loose"'
    );
  });

  it('warns on missing descriptions and semantic roles', () => {
    const resource = makeResource({
      output: {
        id: { type: 'integer', path: '$.id', description: 'Primary key' },
        email: { type: 'string', path: '$.email', semantic_role: 'email' },
      },
    });

    expect(checkSemanticMetadata(resource)).toEqual([
      {
        field: 'id',
        message: 'output field "id" is missing semantic_role (inferred candidate: entity_id)',
      },
      {
        field: 'email',
        message: 'output field "email" is missing description',
      },
    ]);
  });

  it('returns no findings when output fields have descriptions and semantic roles', () => {
    const resource = makeResource({
      output: {
        id: {
          type: 'integer',
          path: '$.id',
          description: 'Primary key',
          semantic_role: 'entity_id',
        },
        email: {
          type: 'string',
          path: '$.email',
          description: 'Primary email address',
          semantic_role: 'email',
        },
      },
    });

    expect(checkSemanticMetadata(resource)).toEqual([]);
  });
});
