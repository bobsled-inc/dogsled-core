import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getIntegrationsDir,
  getResourcePath,
  listIntegrationDirs,
  listResourceFiles,
  readYamlFile,
} from '../src/loader.js';

const CATALOG_SCAN_TIMEOUT_MS = 30_000;

function walkYamlFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkYamlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.yml')) {
      files.push(path);
    }
  }
  return files;
}

describe('source catalog migration invariants', () => {
  it('uses sources/source.yml instead of stale integrations/integration.yml', () => {
    const sourceRoot = getIntegrationsDir();
    expect(sourceRoot.endsWith('/sources')).toBe(true);
    expect(existsSync(join(sourceRoot, '..', 'integrations'))).toBe(false);
    expect(walkYamlFiles(sourceRoot).some((file) => file.endsWith('/integration.yml'))).toBe(false);
  });

  it('declares v2 source specs with valid default transports', () => {
    for (const sourceName of listIntegrationDirs()) {
      const source = readYamlFile(join(getIntegrationsDir(), sourceName, 'source.yml')) as Record<
        string,
        unknown
      >;
      expect(source['spec_version']).toBe('2');
      expect(source['type']).toBe('source');
      const transportIds = new Set(
        ((source['transports'] as Array<Record<string, unknown>>) ?? []).map((transport) =>
          String(transport['id'])
        )
      );
      expect(transportIds.has(String(source['default_transport']))).toBe(true);
    }
  });

  it('keeps Linear GraphQL as the default transport', () => {
    const source = readYamlFile(join(getIntegrationsDir(), 'linear', 'source.yml')) as Record<
      string,
      unknown
    >;
    expect(source['default_transport']).toBe('graphql');
  });

  it('declares explicit multi-transport variants for merged Linear and Notion entities', () => {
    const expectations = [
      {
        sourceName: 'linear',
        defaultTransport: 'graphql',
        transportIds: ['graphql', 'mcp'],
        sharedEntities: [
          'comments',
          'cycles',
          'documents',
          'issues',
          'labels',
          'project_labels',
          'projects',
          'teams',
          'users',
          'workflow_states',
        ],
        suffixes: ['graphql', 'mcp'],
      },
      {
        sourceName: 'notion',
        defaultTransport: 'rest',
        transportIds: ['rest', 'mcp'],
        sharedEntities: ['pages', 'comments', 'users'],
        suffixes: ['rest', 'mcp'],
      },
    ];

    for (const expectation of expectations) {
      const source = readYamlFile(
        join(getIntegrationsDir(), expectation.sourceName, 'source.yml')
      ) as Record<string, unknown>;
      expect(source['default_transport']).toBe(expectation.defaultTransport);
      expect(
        ((source['transports'] as Array<Record<string, unknown>>) ?? []).map((transport) =>
          String(transport['id'])
        )
      ).toEqual(expect.arrayContaining(expectation.transportIds));

      for (const entity of expectation.sharedEntities) {
        for (const suffix of expectation.suffixes) {
          const resourceName = `${entity}_${suffix}`;
          const resource = readYamlFile(
            getResourcePath(expectation.sourceName, resourceName)
          ) as Record<string, unknown>;
          expect(resource['name']).toBe(resourceName);
          expect(resource['via']).toBe(suffix);
          expect(resource['entity']).toBe(entity);
        }
      }
    }
  });

  it('discovers nested MCP resources by resource.name', () => {
    expect(listResourceFiles('linear')).toContain('issues_mcp');
    expect(getResourcePath('linear', 'issues_mcp')).toContain('/resources/issues/mcp.yml');
  });

  it('keeps Linear MCP resources wired to MCP-native arguments', () => {
    const cycles = readYamlFile(getResourcePath('linear', 'cycles_mcp')) as Record<string, unknown>;
    const cyclesForEach = (cycles['extract'] as Record<string, unknown>)['for_each'] as Record<
      string,
      unknown
    >;
    expect(cyclesForEach['resource']).toBe('teams_mcp');
    expect(cyclesForEach['input']).toBe('teamId');

    const issues = readYamlFile(getResourcePath('linear', 'issues_mcp')) as Record<string, unknown>;
    const pagination = (issues['extract'] as Record<string, unknown>)['pagination'] as Record<
      string,
      unknown
    >;
    expect(pagination['cursor_argument']).toBe('cursor');
    expect(Object.keys((issues['input'] as Record<string, unknown>) ?? {})).toEqual(
      expect.arrayContaining(['limit', 'team', 'updatedAt', 'priority'])
    );

    const comments = readYamlFile(getResourcePath('linear', 'comments_mcp')) as Record<
      string,
      unknown
    >;
    const commentsPagination = (comments['extract'] as Record<string, unknown>)[
      'pagination'
    ] as Record<string, unknown>;
    expect(commentsPagination['type']).toBe('mcp_cursor');
    expect(commentsPagination['cursor_argument']).toBe('cursor');
  });

  it(
    'does not leave resource-level integration or spec_version fields',
    () => {
      for (const sourceName of listIntegrationDirs()) {
        for (const resourceName of listResourceFiles(sourceName)) {
          const resource = readYamlFile(getResourcePath(sourceName, resourceName)) as Record<
            string,
            unknown
          >;
          expect(resource['integration']).toBeUndefined();
          expect(resource['spec_version']).toBeUndefined();
        }
      }
    },
    CATALOG_SCAN_TIMEOUT_MS
  );

  it('does not leave action-level spec_version fields in the v2 catalog', () => {
    for (const file of walkYamlFiles(getIntegrationsDir()).filter((entry) =>
      entry.includes('/actions/')
    )) {
      const action = readYamlFile(file) as Record<string, unknown>;
      expect(action['spec_version'], file).toBeUndefined();
    }
  });

  it('adds compile blocks for query filter bindings', () => {
    const modes = new Set(['http_query', 'direct_arg', 'filter_dsl']);
    for (const sourceName of listIntegrationDirs()) {
      for (const resourceName of listResourceFiles(sourceName)) {
        const resource = readYamlFile(getResourcePath(sourceName, resourceName)) as Record<
          string,
          unknown
        >;
        const filters = (resource['query'] as Record<string, unknown> | undefined)?.['filters'];
        if (!filters || typeof filters !== 'object') continue;

        for (const [fieldName, filter] of Object.entries(filters as Record<string, unknown>)) {
          if (!filter || typeof filter !== 'object') continue;
          const bind = (filter as Record<string, unknown>)['bind'] as
            Record<string, unknown> | undefined;
          const compile = (filter as Record<string, unknown>)['compile'] as
            Record<string, Record<string, unknown>> | undefined;
          for (const operator of Object.keys(bind ?? {})) {
            const compiled = compile?.[operator];
            expect(
              compiled,
              `${sourceName}/${resourceName} query filter ${fieldName}.${operator} needs compile metadata`
            ).toBeDefined();
            expect(modes.has(String(compiled?.['mode']))).toBe(true);
          }
        }
      }
    }
  });
});
