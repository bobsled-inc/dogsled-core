import { describe, expect, it } from 'vitest';

import {
  buildCatalogManifest,
  catalogForEachParent,
  CATALOG_MANIFEST_JSON_SCHEMA,
  CATALOG_MANIFEST_SCHEMA_VERSION,
  getResource,
  getSource,
  type CatalogResource,
  type CatalogSource,
} from '../src/index.js';

describe('buildCatalogManifest', () => {
  const manifest = buildCatalogManifest();

  it('resolves for_each parents to canonical entity names (incl. mcp variants)', () => {
    // Single-transport HTTP: runs fans out over sessions.
    const langsmith = manifest.sources.find((s) => s.name === 'langsmith');
    expect(langsmith?.resources.find((r) => r.name === 'runs')?.for_each_parent).toBe('sessions');
    // Multi-transport: the mcp variant's `for_each.resource: pages_mcp` resolves
    // to the canonical entity `pages` so catalog consumers can match by name.
    const notion = manifest.sources.find((s) => s.name === 'notion');
    expect(notion?.resources.find((r) => r.name === 'comments')?.for_each_parent).toBe('pages');
    expect(notion?.resources.find((r) => r.name === 'blocks')?.for_each_parent).toBe('pages');
  });

  it('exposes catalogForEachParent for bundled-catalog manifest consumers', () => {
    expect(catalogForEachParent('langsmith', 'runs')).toBe('sessions');
    expect(catalogForEachParent('notion', 'blocks')).toBe('pages');
    // Parent resources and unknown source/resource pairs return undefined.
    expect(catalogForEachParent('langsmith', 'sessions')).toBeUndefined();
    expect(catalogForEachParent('does_not_exist', 'runs')).toBeUndefined();
  });

  it('keeps Notion REST child resources bound to the REST pages variant', () => {
    expect(getResource('notion', 'blocks').resource.extract.for_each).toMatchObject({
      resource: 'pages_rest',
      field: 'id',
      input: 'block_id',
    });
    expect(getResource('notion', 'comments_rest').resource.extract.for_each).toMatchObject({
      resource: 'pages_rest',
      field: 'id',
      input: 'block_id',
    });
  });

  it('stamps the schema version', () => {
    expect(manifest.schema_version).toBe(CATALOG_MANIFEST_SCHEMA_VERSION);
  });

  it('emits a non-empty source list', () => {
    expect(manifest.sources.length).toBeGreaterThan(0);
    expect(manifest.summary.source_count).toBe(manifest.sources.length);
  });

  it('summary counts agree with source list', () => {
    const totalResources = manifest.sources.reduce((sum, s) => sum + s.resource_count, 0);
    expect(manifest.summary.resource_count).toBe(totalResources);
  });

  it('sources are sorted by name', () => {
    const names = manifest.sources.map((s) => s.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it('every source declares its default_transport in transports[]', () => {
    for (const source of manifest.sources) {
      expect(source.transports).toContain(source.default_transport);
    }
  });

  it('every api source exposes a non-empty base_url; mcp/db sources omit it', () => {
    for (const source of manifest.sources) {
      if (source.source_type === 'api') {
        expect(source.base_url).toBeDefined();
        expect(source.base_url?.length).toBeGreaterThan(0);
      } else {
        expect(source.base_url).toBeUndefined();
      }
    }
  });

  it('every source declares its env vars via auth_setup or auth_env_vars', () => {
    for (const source of manifest.sources) {
      // A source must document its required env vars one of two ways: a
      // meta.yml auth_setup block, or (for self-describing custom_api sources)
      // an inline source.yml auth_env_vars list.
      const authEnvVars = source.auth_env_vars ?? [];
      const authSetup = source.auth_setup ?? [];
      expect(authSetup.length + authEnvVars.length).toBeGreaterThan(0);
      for (const entry of authSetup) {
        expect(entry.env.length).toBeGreaterThan(0);
        expect(entry.description.length).toBeGreaterThan(0);
      }
      for (const envVar of authEnvVars) {
        expect(envVar.length).toBeGreaterThan(0);
      }
    }
  });

  it('every transport config uses only keys the exported JSON Schema declares', () => {
    // The schema closes transport_config with additionalProperties: false, so a
    // field the walker emits but the schema omits makes strict consumers
    // reject the whole manifest.
    const declared = new Set(
      Object.keys(CATALOG_MANIFEST_JSON_SCHEMA.$defs.transport_config.properties)
    );
    for (const source of manifest.sources) {
      for (const transport of source.transport_configs) {
        for (const key of Object.keys(transport)) {
          expect(declared, `${source.name}.${transport.id}.${key}`).toContain(key);
        }
      }
    }
  });

  it('every resource declares its default_transport in transports[]', () => {
    for (const source of manifest.sources) {
      for (const resource of source.resources) {
        expect(resource.transports).toContain(resource.default_transport);
        expect(resource.variants.map((v) => v.via).sort()).toEqual(
          resource.transports.slice().sort()
        );
      }
    }
  });

  it('every resource variant declares at least one column', () => {
    for (const source of manifest.sources) {
      for (const resource of source.resources) {
        for (const variant of resource.variants) {
          expect(variant.columns.length).toBeGreaterThan(0);
        }
      }
    }
  });

  describe('linear source', () => {
    const linear: CatalogSource | undefined = manifest.sources.find((s) => s.name === 'linear');

    it('is present', () => {
      expect(linear).toBeDefined();
    });

    it('exposes its canonical base_url', () => {
      expect(linear?.base_url).toBe('https://api.linear.app');
    });

    it('exposes the expected resources', () => {
      if (!linear) return;
      const names = linear.resources.map((r) => r.name).sort();
      // Spot-check resources we know are committed today; we only assert a
      // subset so adding a new resource to Linear doesn't break this test.
      expect(names).toEqual(expect.arrayContaining(['issues', 'cycles', 'teams', 'users']));
    });

    it('issues resource ships both graphql and mcp transports', () => {
      const issues = linear?.resources.find((r) => r.name === 'issues');
      expect(issues).toBeDefined();
      // Builder emits transports[] in sorted order; assert without mutating
      // the shared manifest array.
      expect(issues?.transports).toEqual(['graphql', 'mcp']);
    });

    it('issues resource has primary_key [id]', () => {
      const issues = linear?.resources.find((r) => r.name === 'issues');
      expect(issues?.primary_key).toEqual(['id']);
    });

    it('issues resource declares incremental cursor strategy', () => {
      const issues = linear?.resources.find((r) => r.name === 'issues');
      expect(issues?.incremental?.strategy).toBe('cursor');
    });

    it('issues variants surface api endpoint and tool_name correctly', () => {
      const issues: CatalogResource | undefined = linear?.resources.find(
        (r) => r.name === 'issues'
      );
      const graphqlVariant = issues?.variants.find((v) => v.via === 'graphql');
      const mcpVariant = issues?.variants.find((v) => v.via === 'mcp');
      expect(graphqlVariant?.api?.endpoint).toBe('/graphql');
      expect(graphqlVariant?.api?.method).toBe('POST');
      expect(mcpVariant?.tool?.tool_name).toBeDefined();
    });
  });

  describe('stripe source', () => {
    const stripe = manifest.sources.find((s) => s.name === 'stripe');

    it('is present', () => {
      expect(stripe).toBeDefined();
    });

    it('exposes the expected resources', () => {
      if (!stripe) return;
      const names = stripe.resources.map((r) => r.name).sort();
      expect(names).toEqual(
        expect.arrayContaining(['customers', 'charges', 'invoices', 'subscriptions'])
      );
    });

    it('customers resource has a `created` column described as a unix timestamp', () => {
      const customers = stripe?.resources.find((r) => r.name === 'customers');
      const created = customers?.variants[0]?.columns.find((c) => c.name === 'created');
      expect(created?.type).toBe('integer');
      expect(created?.description).toMatch(/timestamp/i);
    });
  });

  describe('posthog source', () => {
    const posthog = manifest.sources.find((s) => s.name === 'posthog');

    it('events resource declares bounded server-filter incremental extraction', () => {
      const events = posthog?.resources.find((resource) => resource.name === 'events');
      expect(events?.incremental).toEqual({
        strategy: 'server_filter',
        cursor_field: 'timestamp',
      });
      expect(events?.for_each_parent).toBe('projects');
    });
  });

  describe('bobsled_api source', () => {
    const provider = manifest.sources.find((s) => s.name === 'bobsled_api');

    it('uses the custom token exchange and exposes shares', () => {
      expect(provider).toMatchObject({
        auth_setup: [
          { env: 'BOBSLED_API_HOST' },
          { env: 'BOBSLED_CLIENT_ID' },
          { env: 'BOBSLED_SERVICE_ACCOUNT_EMAIL' },
          { env: 'BOBSLED_SERVICE_ACCOUNT_SECRET' },
        ],
        base_url: 'https://${{ env.BOBSLED_API_HOST }}',
        default_transport: 'default',
        name: 'bobsled_api',
      });
      const transportConfig = provider?.transport_configs.find(
        (candidate) => candidate.id === 'default'
      );
      expect(transportConfig).toMatchObject({
        auth: {
          token_response_path: 'data.token',
          token_url: 'https://${{ env.BOBSLED_API_HOST }}/api/v1/auth/generateToken/',
          type: 'custom-token',
        },
        base_url: 'https://${{ env.BOBSLED_API_HOST }}',
        headers: {
          'sled-client-id': '${{ env.BOBSLED_CLIENT_ID }}',
        },
      });
      const shares = provider?.resources.find((resource) => resource.name === 'shares');
      expect(shares).toMatchObject({
        health_check: { preferred: true },
        input: {
          page_size: { default: 100, required: true },
          share_status: { default: 'active', required: true },
        },
      });
      const sharesApi = shares?.variants.find((variant) => variant.via === 'default')?.api;
      expect(sharesApi).toMatchObject({
        query_params: {
          pageSize: '${{ input.page_size }}',
          shareStatus: '${{ input.share_status }}',
        },
      });
      const transport = getSource('bobsled_api').spec.transports.find(
        (candidate) => candidate.id === 'default'
      );
      expect(transport?.auth).toMatchObject({
        token_response_path: 'data.token',
        token_url: 'https://${{ env.BOBSLED_API_HOST }}/api/v1/auth/generateToken/',
        type: 'custom-token',
      });
      expect(getResource('bobsled_api', 'shares').resource.api).toMatchObject({
        endpoint: '/api/v1/shares/',
        method: 'GET',
        query_params: {
          pageSize: '${{ input.page_size }}',
          shareStatus: '${{ input.share_status }}',
        },
      });
      expect(provider?.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'shares',
            variants: expect.arrayContaining([
              expect.objectContaining({
                api: expect.objectContaining({ endpoint: '/api/v1/shares/', method: 'GET' }),
              }),
            ]),
          }),
        ])
      );
    });
  });
});
