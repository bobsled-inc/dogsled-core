import { indexProjectFiles, ProjectIndexError } from '@bobsled-inc/project-index';
import { CommandError } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import {
  findIndexedIntegration,
  loadIndexedIntegrations,
} from '../../../src/fs/indexed-integrations.js';

const bigquery = (name: string) =>
  `spec_version: '1'\ntype: integration\nname: ${name}\nsource_type: bigquery\nconnection:\n  project_id: acme-data\n  default_location: US\nauth:\n  type: adc\n`;
const apiIntegration = (name: string) =>
  `spec_version: '2'\ntype: integration\nname: ${name}\nsource_type: custom_api\n`;

describe('loadIndexedIntegrations', () => {
  it('keys warehouse integrations by name wherever they live, sorted by name', () => {
    const index = indexProjectFiles([
      { path: 'warehouses/prod/connection.yml', content: bigquery('warehouse') },
      { path: 'integrations/analytics.yml', content: bigquery('analytics') },
    ]);

    const loaded = loadIndexedIntegrations(index);

    expect([...loaded.keys()]).toEqual(['analytics', 'warehouse']);
    expect(loaded.get('warehouse')).toMatchObject({
      handle: 'warehouse',
      path: 'warehouses/prod/connection.yml',
      integration: { name: 'warehouse', source_type: 'bigquery' },
    });
  });

  it('refuses an index that stopped at a limit instead of dropping integrations', () => {
    const index = indexProjectFiles(
      [
        { path: 'integrations/alpha.yml', content: bigquery('alpha') },
        { path: 'integrations/zulu.yml', content: bigquery('zulu') },
      ],
      { maxFiles: 1 }
    );

    expect(() => loadIndexedIntegrations(index)).toThrow(
      /more than 1 YAML, JSON, and Markdown files/
    );
    expect(() => findIndexedIntegration(index, 'alpha')).toThrow(ProjectIndexError);
  });

  it('leaves API and extraction-only integrations to the extractor', () => {
    const index = indexProjectFiles([
      { path: 'integrations/warehouse.yml', content: bigquery('warehouse') },
      { path: 'crm/hubspot.yml', content: apiIntegration('hubspot') },
      {
        path: 'crm/local-api.yml',
        content:
          "spec_version: '1'\ntype: integration\nname: local_api\ntransport:\n  type: http\n  base_url: https://api.example.com\n  auth: { type: none }\n",
      },
      {
        path: 'storage/landing.yml',
        content: "spec_version: '1'\ntype: integration\nname: landing\nsource_type: s3\n",
      },
    ]);

    expect([...loadIndexedIntegrations(index).keys()]).toEqual(['warehouse']);
  });

  it('reports two integrations that share a name with both paths, whatever their shape', () => {
    const warehouses = indexProjectFiles([
      { path: 'a/warehouse.yml', content: bigquery('warehouse') },
      { path: 'b/warehouse.yml', content: bigquery('warehouse') },
    ]);
    expect(() => loadIndexedIntegrations(warehouses)).toThrow(ProjectIndexError);
    expect(() => loadIndexedIntegrations(warehouses)).toThrow(
      'Duplicate integration name "warehouse" in a/warehouse.yml and b/warehouse.yml.'
    );

    const mixed = indexProjectFiles([
      { path: 'integrations/crm.yml', content: bigquery('crm') },
      { path: 'crm/api.yml', content: apiIntegration('crm') },
    ]);
    expect(() => loadIndexedIntegrations(mixed)).toThrow(
      'Duplicate integration name "crm" in crm/api.yml and integrations/crm.yml.'
    );
  });

  it('reports an invalid warehouse integration with its path and exit code 2', () => {
    const index = indexProjectFiles([
      {
        path: 'warehouses/broken.yml',
        content: "spec_version: '1'\ntype: integration\nname: broken\nsource_type: bigquery\n",
      },
    ]);

    let caught: unknown;
    try {
      loadIndexedIntegrations(index);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).exitCode).toBe(2);
    expect((caught as Error).message).toContain('warehouses/broken.yml');
  });
});

describe('findIndexedIntegration', () => {
  it('finds an integration by name wherever it lives, or returns undefined', () => {
    const index = indexProjectFiles([
      { path: 'warehouses/prod/connection.yml', content: bigquery('warehouse') },
    ]);

    expect(findIndexedIntegration(index, 'warehouse')).toMatchObject({
      handle: 'warehouse',
      path: 'warehouses/prod/connection.yml',
    });
    expect(findIndexedIntegration(index, 'missing')).toBeUndefined();
  });

  it('explains why a same-named API integration cannot serve as a warehouse', () => {
    const index = indexProjectFiles([{ path: 'crm/api.yml', content: apiIntegration('crm') }]);

    expect(() => findIndexedIntegration(index, 'crm')).toThrow(CommandError);
    expect(() => findIndexedIntegration(index, 'crm')).toThrow(/crm\/api\.yml/);
  });
});
