import { describe, expect, it } from 'vitest';

import { buildCatalogManifest, getResources } from '../src/index.js';

describe('Notion health-check resource', () => {
  const validatedResources = getResources('notion').map(({ resource }) => resource);
  const usersMe = validatedResources.find(({ name }) => name === 'users_me');

  it('ships a preferred, input-free REST health check in the validated catalog', () => {
    expect(usersMe).toBeDefined();
    expect(usersMe).toMatchObject({
      name: 'users_me',
      via: 'rest',
      health_check: { preferred: true },
      api: {
        endpoint: '/v1/users/me',
        method: 'GET',
      },
      input: {},
      extract: {
        record_path: '$',
        table: { primary_key: ['id'] },
      },
    });
  });

  it('includes the resource endpoint and method in the compiled catalog', () => {
    const notion = buildCatalogManifest().sources.find(({ name }) => name === 'notion');
    const compiledUsersMe = notion?.resources.find(({ name }) => name === 'users_me');

    expect(compiledUsersMe).toBeDefined();
    expect(compiledUsersMe?.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          via: 'rest',
          api: {
            endpoint: '/v1/users/me',
            method: 'GET',
          },
        }),
      ])
    );
  });

  it('preserves the existing Notion user collection resources', () => {
    expect(validatedResources.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'blocks',
        'comments_mcp',
        'comments_rest',
        'database_items',
        'databases_mcp',
        'page_properties',
        'pages_mcp',
        'pages_rest',
        'users_mcp',
        'users_rest',
      ])
    );

    const usersRest = validatedResources.find(({ name }) => name === 'users_rest');
    const usersMcp = validatedResources.find(({ name }) => name === 'users_mcp');

    expect(usersRest).toMatchObject({
      via: 'rest',
      entity: 'users',
      api: {
        endpoint: '/v1/users',
        method: 'GET',
      },
    });
    expect(usersMcp).toMatchObject({
      via: 'mcp',
      entity: 'users',
      tool: { tool_name: 'list-all-users' },
    });
  });
});
