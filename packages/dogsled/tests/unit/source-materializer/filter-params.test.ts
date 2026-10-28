import { describe, expect, it } from 'vitest';

import { applySourceFilterParams } from '../../../src/runtime/source-materializer/filter-params.js';
import type { ApiResourceEntry } from '../../../src/runtime/source-materializer/load-specs.js';

const baseEntry = {
  kind: 'api_resource',
  fqRef: 'sources.issues',
  integration: 'github',
  resource: 'issues',
  connection: 'github_prod',
  columns: [{ name: 'id', type: 'integer' }],
} as ApiResourceEntry;

describe('applySourceFilterParams', () => {
  it('resolves params and session templates inside source filters', () => {
    const [entry] = applySourceFilterParams(
      [
        {
          ...baseEntry,
          filter: {
            status: '${{ params.status }}',
            owner: { eq: '${{ session.owner }}' },
            tags: { in: ['core', '${{ params.tag }}'] },
          },
        },
      ],
      {
        params: { status: 'open', tag: 'urgent' },
        session: { owner: 'team-data' },
      }
    );

    expect(entry?.filter).toEqual({
      status: 'open',
      owner: { eq: 'team-data' },
      tags: { in: ['core', 'urgent'] },
    });
  });

  it('fails fast when a filter references a missing runtime parameter', () => {
    expect(() =>
      applySourceFilterParams([
        {
          ...baseEntry,
          filter: {
            status: '${{ params.status }}',
          },
        },
      ])
    ).toThrow('source.filter references missing runtime params parameter "status"');
  });

  it('fails fast when a filter references a missing session parameter', () => {
    expect(() =>
      applySourceFilterParams(
        [
          {
            ...baseEntry,
            filter: {
              tenant: '${{ session.tenant_id }}',
            },
          },
        ],
        { params: { tenant_id: 'caller-supplied' } }
      )
    ).toThrow('source.filter references missing runtime session parameter "tenant_id"');
  });
});
