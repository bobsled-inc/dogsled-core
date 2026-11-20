import { describe, expect, it } from 'vitest';

import {
  collectDuplicateEndpointFindings,
  collectForEachDependencyFindings,
  collectIntegrationStructuralFindings,
  collectResourceQualityFindings,
} from '../../src/commands/verify-shared.js';
import { makeConnection, makeResource } from '../helpers/fixtures.js';

describe('verify command helpers', () => {
  it('flags undeclared auth env vars and insecure docs URLs', () => {
    const integration = makeConnection('https://api.example.com', {
      name: 'mailchimp',
      transport: {
        type: 'http',
        base_url: 'https://api.example.com',
        auth: {
          type: 'bearer',
          token: '${{ env.MAILCHIMP_TOKEN }}',
        },
      },
    });

    const findings = collectIntegrationStructuralFindings(
      'mailchimp',
      integration,
      `
transport:
  auth:
    type: bearer
    token: \${{ env.MAILCHIMP_TOKEN }}
`,
      {
        docs_url: 'http://docs.example.com',
        auth_setup: [{ env: 'OTHER_TOKEN', description: 'Wrong token' }],
      }
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MISSING_AUTH_SETUP',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'INSECURE_DOCS_URL',
          severity: 'error',
        }),
      ])
    );
  });

  it('flags duplicate non-GraphQL endpoints', () => {
    const findings = collectDuplicateEndpointFindings('linear', [
      makeResource({
        name: 'issues',
        integration: 'linear',
        api: { endpoint: '/issues', method: 'GET' },
      }),
      makeResource({
        name: 'issues_copy',
        integration: 'linear',
        api: { endpoint: '/issues', method: 'GET' },
      }),
      makeResource({
        name: 'graphql_query',
        integration: 'linear',
        api: { endpoint: '/graphql', method: 'POST' },
      }),
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'DUPLICATE_ENDPOINT',
        resource: 'issues_copy',
        severity: 'error',
      }),
    ]);
  });

  it('flags child resources that should have for_each wiring', () => {
    const findings = collectForEachDependencyFindings('github', [
      makeResource({
        name: 'repos',
        integration: 'github',
      }),
      makeResource({
        name: 'repo_hooks',
        integration: 'github',
        api: { endpoint: '/repos/${{ input.repo_id }}/hooks', method: 'GET' },
        input: {
          repo_id: { type: 'string', required: true },
        },
      }),
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'MISSING_FOR_EACH',
        field: 'repo_id',
        resource: 'repo_hooks',
        severity: 'error',
      }),
    ]);
  });

  it('asks a copy Resource for no output or primary key, since it has no columns', () => {
    const findings = collectResourceQualityFindings(
      'files',
      '/tmp/drops.yml',
      {
        spec_version: '1',
        type: 'resource',
        name: 'drops',
        integration: 'files',
        description: 'Copy the incoming folder',
        source: { kind: 'copy', path: 'incoming/**/*' },
        replication: { method: 'incremental_append', cursor: { field: 'last_modified' } },
        extract: {},
        output: {},
      } as never,
      ''
    );

    expect(findings).toEqual([]);
  });

  it('flags review markers, empty descriptions, and missing table metadata', () => {
    const findings = collectResourceQualityFindings(
      'stripe',
      '/tmp/custom-resource.txt',
      makeResource({
        name: 'charges',
        integration: 'not_stripe',
        description: '',
        output: {},
        schema: {
          columns: [{ name: 'charge_id', type: 'string' }],
        },
        extract: {
          record_path: '$',
          table: {},
        },
      }),
      '# REVIEW: needs cleanup\n'
    );

    expect(findings.map((finding) => finding.code)).toEqual([
      'REVIEW_MARKER',
      'MISSING_DESCRIPTION',
      'INTEGRATION_MISMATCH',
      'MISSING_OUTPUT',
      'MISSING_PRIMARY_KEY',
      'UNEXPECTED_EXTENSION',
    ]);
  });
});
