import { describe, expect, it } from 'vitest';

import {
  buildApiRequest,
  mergeApiRequest,
  resolveApiRequestTokenPrefix,
  interpolateString,
  interpolateUrl,
  mapTemplateReferences,
  type ApiRequestInputFieldDefinition,
  type ApiRequestInterpolationReference,
  type InterpolationContext,
} from '../src/index.js';

describe('API request planner', () => {
  it('resolves OAuth and custom-token prefixes with extraction-compatible semantics', () => {
    expect(
      resolveApiRequestTokenPrefix({
        mode: 'oauth2',
        configuredPrefix: 'Token',
        providerTokenType: 'Bearer',
      })
    ).toBe('Token ');
    expect(resolveApiRequestTokenPrefix({ mode: 'oauth2', providerTokenType: 'Token' })).toBe(
      'Token '
    );
    expect(resolveApiRequestTokenPrefix({ mode: 'custom-token', configuredPrefix: 'Token' })).toBe(
      'Token'
    );
    expect(resolveApiRequestTokenPrefix({ mode: 'custom-token' })).toBe('Bearer ');
  });

  it('merges transport and operation fields before interpolation', () => {
    const planned = buildApiRequest({
      api: mergeApiRequest(
        {
          base_url: 'https://api.example.test/v1',
          headers: { 'X-Transport': 'transport' },
          timeout_ms: 5_000,
          auth: { type: 'none' },
        },
        {
          endpoint: '/items/${{ input.id }}',
          method: 'POST',
          headers: { 'X-Operation': '${{ input.label }}' },
          query_params: { q: '${{ input.label }}' },
          request_body: { id: '${{ input.id }}' },
        }
      ),
      inputSchema: {
        id: { type: 'string', required: true },
        label: { type: 'string', default: 'default' },
      },
      providedInput: { id: 'a/b' },
      context: { allowProcessEnvFallback: false },
      inputMode: 'strict',
    });

    expect(planned).toMatchObject({
      url: 'https://api.example.test/v1/items/a%2Fb?q=default',
      method: 'POST',
      headers: {
        'X-Transport': 'transport',
        'X-Operation': 'default',
        'Content-Type': 'application/json',
      },
      body: { id: 'a/b' },
      timeout_ms: 5_000,
      auth: { type: 'none' },
      input: { id: 'a/b', label: 'default' },
    });
  });

  it('reports each resolved reference and its request location without values', () => {
    const references: ApiRequestInterpolationReference[] = [];
    const planned = buildApiRequest({
      api: mergeApiRequest(
        {
          base_url: 'https://api.example.test/v1',
          headers: { 'X-Tenant': '${{ input.tenant }}' },
          timeout_ms: 5_000,
          auth: { type: 'bearer', token: '${{ secrets.TOKEN }}' },
        },
        {
          endpoint: '/items/${{ input.id }}?mode=${{ input.mode }}',
          method: 'POST',
          query_params: { q: '${{ input.label }}' },
          request_body: { note: '${{ input.note }}', all: '${{ input }}' },
        }
      ),
      inputSchema: {
        id: { type: 'string', required: true },
        mode: { type: 'string', required: true },
        tenant: { type: 'string', required: true },
        label: { type: 'string' },
        note: { type: 'string' },
      },
      providedInput: { id: 'a/b', mode: 'fast', tenant: 'acme', label: 'x', note: 'n' },
      context: {
        allowProcessEnvFallback: false,
        secrets: { TOKEN: 'secret-value' },
        declaredEnvVars: new Set(['TOKEN']),
        onReference: (reference) => references.push(reference),
      },
      inputMode: 'strict',
    });

    expect(planned.url).toBe('https://api.example.test/v1/items/a%2Fb%3Fmode=fast?q=x');
    expect(references).toEqual(
      expect.arrayContaining([
        { source: 'input', key: 'tenant', path: 'headers.X-Tenant' },
        { source: 'input', key: 'note', path: 'request_body.note' },
        { source: 'input', path: 'request_body.all' },
        { source: 'input', key: 'id', path: 'api.endpoint' },
        { source: 'input', key: 'mode', path: 'api.endpoint' },
        { source: 'input', key: 'label', path: 'query_params.q', parameter: 'q' },
        { source: 'secrets', key: 'TOKEN', path: 'auth.token' },
      ])
    );
    expect(JSON.stringify(references)).not.toMatch(/a\/b|fast|acme|secret-value/);
  });

  it('reports only an absolute endpoint query string as the query', () => {
    const references: ApiRequestInterpolationReference[] = [];
    const planned = buildApiRequest({
      api: mergeApiRequest(
        {
          base_url: 'https://api.example.test',
          headers: {},
          timeout_ms: 5_000,
          auth: { type: 'none' },
        },
        {
          endpoint: 'https://api.example.test/items/${{ input.id }}?mode=${{ input.mode }}',
          method: 'GET',
        }
      ),
      inputSchema: {
        id: { type: 'string', required: true },
        mode: { type: 'string', required: true },
      },
      providedInput: { id: '7', mode: 'fast' },
      context: {
        allowProcessEnvFallback: false,
        onReference: (reference) => references.push(reference),
      },
      inputMode: 'strict',
    });

    expect(planned.url).toBe('https://api.example.test/items/7?mode=fast');
    expect(references).toEqual([
      { source: 'input', key: 'id', path: 'api.endpoint' },
      { source: 'input', key: 'mode', path: 'api.endpoint.query', parameter: 'mode' },
    ]);
  });

  it('reports nothing for a query parameter or optional header that is not sent', () => {
    const references: ApiRequestInterpolationReference[] = [];
    const planned = buildApiRequest({
      api: {
        ...mergeApiRequest(
          {
            base_url: 'https://api.example.test',
            headers: {},
            optional_headers: {
              'X-Proof': '${{ input.proof }}:${{ env.PROOF }}',
              'X-Overridden': '${{ input.shadowed }}:${{ env.PRESENT }}',
            },
            timeout_ms: 5_000,
            auth: { type: 'none' },
          },
          {
            endpoint: '/items',
            method: 'GET',
            headers: { 'x-overridden': '${{ input.declared }}' },
            query_params: {
              partial: '${{ input.present }}-${{ input.optional }}',
              empty: '${{ input.blank }}',
              sent: '${{ input.present }}',
            },
          }
        ),
      },
      inputSchema: {
        present: { type: 'string', required: true },
        optional: { type: 'string' },
        blank: { type: 'string', required: true },
        proof: { type: 'string', required: true },
        shadowed: { type: 'string', required: true },
        declared: { type: 'string', required: true },
      },
      providedInput: { present: 'p', blank: '', proof: 'x', shadowed: 's', declared: 'd' },
      context: {
        allowProcessEnvFallback: false,
        env: { PRESENT: 'yes' },
        declaredEnvVars: new Set(['PRESENT', 'PROOF']),
        onReference: (reference) => references.push(reference),
      },
      skipMissingInputQueryParams: true,
      inputMode: 'strict',
    });

    expect(planned.url).toBe('https://api.example.test/items?sent=p');
    expect(planned.headers).toEqual({ 'x-overridden': 'd' });
    expect(references).toEqual([
      { source: 'input', key: 'present', path: 'query_params.sent', parameter: 'sent' },
      { source: 'input', key: 'declared', path: 'headers.x-overridden' },
    ]);
  });

  it('reports where an absolute endpoint sends each reference and drops what is never sent', () => {
    const references: ApiRequestInterpolationReference[] = [];
    const planned = buildApiRequest({
      api: mergeApiRequest(
        {
          base_url: 'https://${{ input.tenant }}.example.test',
          headers: {},
          timeout_ms: 5_000,
          auth: { type: 'none' },
        },
        {
          endpoint:
            'https://${{ input.tenant }}.example.test/items/${{ input.id }}?q=${{ input.q }}#${{ input.frag }}',
          method: 'GET',
        }
      ),
      inputSchema: {
        tenant: { type: 'string', required: true },
        id: { type: 'string', required: true },
        q: { type: 'string', required: true },
        frag: { type: 'string', required: true },
      },
      providedInput: { tenant: 'acme', id: '7', q: 'x', frag: 'f' },
      context: {
        allowProcessEnvFallback: false,
        onReference: (reference) => references.push(reference),
      },
      inputMode: 'strict',
    });

    expect(planned.url).toBe('https://acme.example.test/items/7?q=x#f');
    expect(references).toEqual([
      { source: 'input', key: 'tenant', path: 'api.endpoint.origin' },
      { source: 'input', key: 'id', path: 'api.endpoint' },
      { source: 'input', key: 'q', path: 'api.endpoint.query', parameter: 'q' },
    ]);
  });

  it('reports base URL references only when a relative endpoint uses the base URL', () => {
    const references: ApiRequestInterpolationReference[] = [];
    buildApiRequest({
      api: mergeApiRequest(
        {
          base_url: 'https://${{ input.tenant }}.example.test',
          headers: {},
          timeout_ms: 5_000,
          auth: { type: 'none' },
        },
        { endpoint: '/items', method: 'GET' }
      ),
      inputSchema: { tenant: { type: 'string', required: true } },
      providedInput: { tenant: 'acme' },
      context: {
        allowProcessEnvFallback: false,
        onReference: (reference) => references.push(reference),
      },
      inputMode: 'strict',
    });

    expect(references).toEqual([{ source: 'input', key: 'tenant', path: 'api.base_url.origin' }]);
  });

  it.each([['api-key', { type: 'api-key', header: 'X-API-Key', key: 'k' }, 'X-API-Key']])(
    'reports nothing for a declared header that %s auth overwrites',
    (_case, auth, header) => {
      const references: ApiRequestInterpolationReference[] = [];
      buildApiRequest({
        api: mergeApiRequest(
          {
            base_url: 'https://api.example.test',
            headers: {},
            timeout_ms: 5_000,
            auth: auth as never,
          },
          {
            endpoint: '/items',
            method: 'GET',
            headers: { [header]: '${{ input.shadowed }}', 'X-Kept': '${{ input.kept }}' },
          }
        ),
        inputSchema: {
          shadowed: { type: 'string', required: true },
          kept: { type: 'string', required: true },
        },
        providedInput: { shadowed: 's', kept: 'k' },
        context: {
          allowProcessEnvFallback: false,
          onReference: (reference) => references.push(reference),
        },
        inputMode: 'strict',
      });

      expect(references).toEqual([{ source: 'input', key: 'kept', path: 'headers.X-Kept' }]);
    }
  );

  it('reports nothing for a query parameter that api-key auth replaces', () => {
    const references: ApiRequestInterpolationReference[] = [];
    buildApiRequest({
      api: mergeApiRequest(
        {
          base_url: 'https://api.example.test',
          headers: {},
          timeout_ms: 5_000,
          auth: { type: 'api-key', query_param: 'token', key: 'secret-key' } as never,
        },
        {
          endpoint:
            'https://api.example.test/items?token=${{ input.inline }}&keep=${{ input.kept }}',
          method: 'GET',
          query_params: { token: '${{ input.configured }}', page: '${{ input.page }}' },
        }
      ),
      inputSchema: {
        inline: { type: 'string', required: true },
        kept: { type: 'string', required: true },
        configured: { type: 'string', required: true },
        page: { type: 'string', required: true },
      },
      providedInput: { inline: 'i', kept: 'k', configured: 'c', page: '2' },
      context: {
        allowProcessEnvFallback: false,
        onReference: (reference) => references.push(reference),
      },
      inputMode: 'strict',
    });

    expect(references).toEqual([
      { source: 'input', key: 'kept', path: 'api.endpoint.query', parameter: 'keep' },
      { source: 'input', key: 'page', path: 'query_params.page', parameter: 'page' },
    ]);
  });

  it('reports only the declared header that survives a case-insensitive collision', () => {
    const references: ApiRequestInterpolationReference[] = [];
    const planned = buildApiRequest({
      api: mergeApiRequest(
        {
          base_url: 'https://api.example.test',
          headers: { 'X-Trace': '${{ input.first }}' },
          timeout_ms: 5_000,
          auth: { type: 'none' },
        },
        { endpoint: '/items', method: 'GET', headers: { 'x-trace': '${{ input.second }}' } }
      ),
      inputSchema: {
        first: { type: 'string', required: true },
        second: { type: 'string', required: true },
      },
      providedInput: { first: 'a', second: 'b' },
      context: {
        allowProcessEnvFallback: false,
        onReference: (reference) => references.push(reference),
      },
      inputMode: 'strict',
    });

    expect(planned.headers).toEqual({ 'x-trace': 'b' });
    expect(references).toEqual([{ source: 'input', key: 'second', path: 'headers.x-trace' }]);
  });

  it('reports nothing for a base URL fragment, which is never sent', () => {
    const references: ApiRequestInterpolationReference[] = [];
    const planned = buildApiRequest({
      api: mergeApiRequest(
        {
          base_url: 'https://${{ input.tenant }}.example.test/v1#${{ input.token }}',
          headers: {},
          timeout_ms: 5_000,
          auth: { type: 'none' },
        },
        { endpoint: '/items', method: 'GET' }
      ),
      inputSchema: {
        tenant: { type: 'string', required: true },
        token: { type: 'string', required: true },
      },
      providedInput: { tenant: 'acme', token: 'secret' },
      context: {
        allowProcessEnvFallback: false,
        onReference: (reference) => references.push(reference),
      },
      inputMode: 'strict',
    });

    expect(planned.url).toBe('https://acme.example.test/v1/items#secret');
    expect(references).toEqual([{ source: 'input', key: 'tenant', path: 'api.base_url.origin' }]);
  });

  it('still rejects a malformed template split across URL parts', () => {
    expect(() =>
      buildApiRequest({
        api: mergeApiRequest(
          {
            base_url: 'https://api.example.test',
            headers: {},
            timeout_ms: 5_000,
            auth: { type: 'none' },
          },
          { endpoint: 'https://api.example.test/items/${{ input?x }}', method: 'GET' }
        ),
        inputSchema: {},
        providedInput: {},
        context: { allowProcessEnvFallback: false },
        inputMode: 'strict',
      })
    ).toThrow('Unresolved template in api.endpoint');
  });

  it('classifies each URL reference by where its unencoded value lands', () => {
    const references: ApiRequestInterpolationReference[] = [];
    const url = interpolateUrl(
      'https://${{ input.host }}.example.com/items/${{ input.id }}?q=${{ input.q }}',
      {
        input: { host: 'evil/a', id: '7', q: 'x#y' },
        onReference: (reference) => references.push(reference),
      },
      'webhook.url',
      interpolateString
    );

    expect(url).toBe('https://evil/a.example.com/items/7?q=x#y');
    expect(references).toEqual([
      { source: 'input', key: 'host', path: 'webhook.url.unclassified' },
      { source: 'input', key: 'id', path: 'webhook.url' },
      { source: 'input', key: 'q', path: 'webhook.url.unclassified' },
    ]);
  });

  it('reports a host input as origin, or unclassified when its value bends the authority', () => {
    const references: ApiRequestInterpolationReference[] = [];
    const url = interpolateUrl(
      'https://${{ input.redirect }}trusted.example/items/${{ input.id }}',
      {
        input: { redirect: '/@evil.example/', id: '7' },
        onReference: (reference) => references.push(reference),
      },
      'webhook.url',
      interpolateString
    );

    expect(new URL(url).hostname).toBe('evil.example');
    expect(references).toEqual([
      { source: 'input', key: 'redirect', path: 'webhook.url.unclassified' },
      { source: 'input', key: 'id', path: 'webhook.url' },
    ]);

    references.length = 0;
    interpolateUrl(
      'https://${{ input.user }}trusted.example/items',
      { input: { user: 'evil.example@' }, onReference: (reference) => references.push(reference) },
      'webhook.url',
      interpolateString
    );
    expect(references).toEqual([{ source: 'input', key: 'user', path: 'webhook.url.origin' }]);
  });

  it('rewrites template references without resolving them', () => {
    expect(
      mapTemplateReferences(
        '/items/${{ input.id }}/${{ secrets.KEY }}/${{ mapped }}',
        ({ source, key }) => (key === undefined ? `<${source}>` : `<${source}:${key}>`)
      )
    ).toBe('/items/<input:id>/<secrets:KEY>/<mapped>');
  });

  it('omits missing optional input fields from request bodies', () => {
    const api = mergeApiRequest(
      {
        base_url: 'https://api.example.test',
        auth: { type: 'none' },
      },
      {
        endpoint: '/search',
        method: 'POST',
        request_body: {
          query: '${{ input.query }}',
          nested: { query: '${{ input.query }}' },
          filter: { property: 'object', value: 'page' },
        },
      }
    );

    expect(
      buildApiRequest({
        api,
        inputSchema: { query: { type: 'string' } },
        context: { allowProcessEnvFallback: false },
        inputMode: 'strict',
      }).body
    ).toEqual({ nested: {}, filter: { property: 'object', value: 'page' } });

    expect(
      buildApiRequest({
        api,
        inputSchema: { query: { type: 'string' } },
        providedInput: { query: 'Roadmap' },
        context: { allowProcessEnvFallback: false },
        inputMode: 'strict',
      }).body
    ).toEqual({
      query: 'Roadmap',
      nested: { query: 'Roadmap' },
      filter: { property: 'object', value: 'page' },
    });
  });

  it('keeps missing inputs in arrays, embedded strings, and non-input namespaces strict', () => {
    const build = (
      requestBody: unknown,
      context: Omit<InterpolationContext, 'input'> = { allowProcessEnvFallback: false },
      inputSchema: Record<string, ApiRequestInputFieldDefinition> = { query: { type: 'string' } }
    ) =>
      buildApiRequest({
        api: mergeApiRequest(
          { base_url: 'https://api.example.test', auth: { type: 'none' } },
          { endpoint: '/search', method: 'POST', request_body: requestBody }
        ),
        inputSchema,
        context,
        inputMode: 'strict',
      });

    expect(() => build({ queries: ['${{ input.query }}'] })).toThrow('Missing input.query');
    expect(() => build({ query: 'prefix ${{ input.query }}' })).toThrow('Missing input.query');
    expect(() =>
      build({ query: '${{ input.query }}' }, undefined, {
        query: { type: 'string', required: true },
      })
    ).toThrow('Missing required input input.query');
    expect(() => build({ query: '${{ mapped.query }}' }, { mapped: {} })).toThrow(
      'Missing mapped.query'
    );
    expect(() =>
      build(
        { query: '${{ secrets.NOTION_API_TOKEN }}' },
        { secrets: {}, declaredEnvVars: new Set(['NOTION_API_TOKEN']) }
      )
    ).toThrow('Missing secrets.NOTION_API_TOKEN');
    expect(() =>
      build(
        { query: '${{ env.NOTION_API_TOKEN }}' },
        { env: {}, declaredEnvVars: new Set(['NOTION_API_TOKEN']) }
      )
    ).toThrow('Missing env.NOTION_API_TOKEN');
  });

  it('rejects unknown strict inputs before constructing a request', () => {
    expect(() =>
      buildApiRequest({
        api: mergeApiRequest(
          { base_url: 'https://api.example.test', auth: { type: 'none' } },
          { endpoint: '/items', method: 'GET' }
        ),
        inputSchema: { id: { type: 'string' } },
        providedInput: { extra: 'value' },
        inputMode: 'strict',
      })
    ).toThrow('Unknown input');
  });
});

describe('optional transport headers', () => {
  const transport = {
    base_url: 'https://api.example.test',
    headers: { Accept: 'application/json' },
    optional_headers: {
      'x-acting-user': '${{ env.ACTING_USER }}',
      'x-tenant-hint': '${{ secrets.TENANT_HINT }}',
    },
    auth: { type: 'none' },
  };
  const operation = { endpoint: '/items', method: 'GET' as const };
  const plan = (context: Omit<InterpolationContext, 'input'>) =>
    buildApiRequest({
      api: mergeApiRequest(transport, operation),
      inputSchema: {},
      context: {
        ...context,
        declaredEnvVars: new Set(['ACTING_USER', 'TENANT_HINT']),
        allowProcessEnvFallback: false,
      },
      inputMode: 'strict',
    });

  it('sends an optional header only when its variable resolves to a non-empty value', () => {
    expect(plan({ env: { ACTING_USER: 'assertion-1' } }).headers).toEqual({
      Accept: 'application/json',
      'x-acting-user': 'assertion-1',
    });
    expect(plan({ env: { ACTING_USER: '' } }).headers).toEqual({ Accept: 'application/json' });
    expect(plan({}).headers).toEqual({ Accept: 'application/json' });
  });

  it('keeps declared headers strict while optional ones are absent', () => {
    const strict = mergeApiRequest(
      { ...transport, headers: { 'x-required': '${{ env.REQUIRED }}' } },
      operation
    );
    expect(() =>
      buildApiRequest({
        api: strict,
        inputSchema: {},
        context: {
          env: { ACTING_USER: 'assertion-1' },
          declaredEnvVars: new Set(['ACTING_USER', 'TENANT_HINT', 'REQUIRED']),
          allowProcessEnvFallback: false,
        },
        inputMode: 'strict',
      })
    ).toThrow(/REQUIRED/);
  });

  it('lets a declared header override an optional header of the same name', () => {
    const planned = buildApiRequest({
      api: mergeApiRequest(transport, {
        ...operation,
        headers: { 'X-Acting-User': 'operation-pinned' },
      }),
      inputSchema: {},
      context: {
        env: { ACTING_USER: 'assertion-1' },
        declaredEnvVars: new Set(['ACTING_USER', 'TENANT_HINT', 'REQUIRED']),
        allowProcessEnvFallback: false,
      },
      inputMode: 'strict',
    });
    expect(planned.headers).toEqual({
      Accept: 'application/json',
      'X-Acting-User': 'operation-pinned',
    });
  });

  it('omits a composite optional header when any env or secrets reference is empty', () => {
    const composite = mergeApiRequest(
      {
        ...transport,
        optional_headers: { 'x-acting': 'Bearer ${{ secrets.TOKEN }}' },
      },
      operation
    );
    const build = (secrets: Record<string, string>) =>
      buildApiRequest({
        api: composite,
        inputSchema: {},
        context: { secrets, declaredEnvVars: new Set(['TOKEN']), allowProcessEnvFallback: false },
        inputMode: 'strict',
      }).headers;
    expect(build({ TOKEN: 't' })).toEqual({ Accept: 'application/json', 'x-acting': 'Bearer t' });
    expect(build({ TOKEN: '' })).toEqual({ Accept: 'application/json' });
    expect(build({})).toEqual({ Accept: 'application/json' });
  });

  it('keeps missing input references in an optional header strict', () => {
    const inputBacked = mergeApiRequest(
      { ...transport, optional_headers: { 'x-scope': '${{ input.scope }}' } },
      operation
    );
    expect(() =>
      buildApiRequest({
        api: inputBacked,
        inputSchema: {},
        context: { allowProcessEnvFallback: false },
        inputMode: 'strict',
      })
    ).toThrow(/scope/);
  });

  it('still rejects an optional header value carrying a control character', () => {
    expect(() => plan({ env: { ACTING_USER: 'a\r\nx-injected: 1' } })).toThrow(/control character/);
  });
});
