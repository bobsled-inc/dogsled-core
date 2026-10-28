import type { HttpTransportConfig } from '../framework/core/index.js';
import type { ApiIntegrationSpec, HttpApiResourceSpec } from '../types/index.js';
import { ENV_TEMPLATE_RE, getPaginationPageSizeParam } from './verify-shared.js';

export type MockAuthMode = 'native' | 'simulated';
export type HttpApiIntegrationSpec = ApiIntegrationSpec & { transport: HttpTransportConfig };

function synthesizeInputValue(name: string, field: HttpApiResourceSpec['input'][string]): unknown {
  if (field.default !== undefined && field.default !== null) {
    return field.default;
  }
  if (field.enum && field.enum.length > 0) {
    return field.enum[0];
  }

  switch (field.type) {
    case 'string':
      return name.endsWith('_id') ? '1' : `${name}_mock`;
    case 'timestamp':
      return new Date(Date.UTC(2024, 0, 1, 12, 0, 0)).toISOString();
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
  }
}

function coerceFixtureValue(field: HttpApiResourceSpec['input'][string], value: unknown): unknown {
  if (field.type === 'array') {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  if (field.type === 'object') {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  return value;
}

function synthesizeFixtureInput(resource: HttpApiResourceSpec): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(resource.input)) {
    if (field.required || field.default !== undefined) {
      input[name] = synthesizeInputValue(name, field);
    }
  }

  if (resource.extract.pagination?.type === 'cursor') {
    const cursorParam = resource.extract.pagination.cursor_param;
    if (cursorParam in resource.input && !(cursorParam in input)) {
      input[cursorParam] = '';
    }
  }

  const pageSizeParam = getPaginationPageSizeParam(resource.extract.pagination);
  if (pageSizeParam) {
    const pageSize = input[pageSizeParam];
    if (typeof pageSize === 'number' && Number.isFinite(pageSize)) {
      input[pageSizeParam] = Math.min(pageSize, 2);
    } else if (typeof pageSize === 'string') {
      const parsed = Number(pageSize);
      if (Number.isFinite(parsed)) {
        input[pageSizeParam] = String(Math.min(parsed, 2));
      }
    }
  }

  return input;
}

function normalizeFixtureInput(
  resource: HttpApiResourceSpec,
  provided: Record<string, unknown>
): Record<string, unknown> {
  const normalized = synthesizeFixtureInput(resource);

  for (const [name, value] of Object.entries(provided)) {
    const field = resource.input[name];
    if (!field || value == null) {
      continue;
    }

    if (field.enum && !field.enum.includes(String(value))) {
      continue;
    }

    const coerced = coerceFixtureValue(field, value);
    if (coerced === undefined && (field.type === 'array' || field.type === 'object')) {
      continue;
    }

    normalized[name] = coerced;
  }

  return normalized;
}

export function listFixtures(
  resource: HttpApiResourceSpec
): Array<{ input: Record<string, unknown>; name: string }> {
  const declared = resource.test?.fixtures ?? [];
  if (declared.length > 0) {
    return declared.map((fixture) => ({
      input: normalizeFixtureInput(resource, fixture.input),
      name: fixture.name,
    }));
  }

  return [
    {
      input: synthesizeFixtureInput(resource),
      name: 'synthetic_fixture',
    },
  ];
}

function collectTemplateEnvRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(ENV_TEMPLATE_RE)) {
      if (match[1]) refs.add(match[1]);
    }
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTemplateEnvRefs(item, refs);
    return refs;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectTemplateEnvRefs(entry, refs);
    }
  }
  return refs;
}

export function buildMockEnv(
  integration: ApiIntegrationSpec,
  resource: HttpApiResourceSpec
): Record<string, string> {
  const refs = new Set<string>();
  collectTemplateEnvRefs(integration, refs);
  collectTemplateEnvRefs(resource, refs);

  const env: Record<string, string> = {};
  for (const name of refs) {
    if (name.includes('PASSWORD')) {
      env[name] = 'mock-password';
    } else if (name.includes('USERNAME')) {
      env[name] = 'mock-user';
    } else if (name.includes('SECRET')) {
      env[name] = 'mock-secret';
    } else {
      env[name] = `mock-${name.toLowerCase()}`;
    }
  }
  return env;
}

function toMockEndpoint(endpoint: string): string {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    const url = new URL(endpoint);
    return `${url.pathname}${url.search}`;
  }
  return endpoint;
}

function mockAuthConfig(integration: HttpApiIntegrationSpec): {
  authMode: MockAuthMode;
  integration: HttpApiIntegrationSpec;
  needsBaseUrlRewrite: boolean;
} {
  const auth = integration.transport.auth;
  if (auth?.type === 'oauth2') {
    return {
      authMode: 'native',
      needsBaseUrlRewrite: true,
      integration: {
        ...integration,
        transport: {
          ...integration.transport,
          auth: {
            ...auth,
            token_url: `${integration.transport.base_url}/__mock_auth/oauth2/token`,
          },
        },
      },
    };
  }

  if (auth?.type === 'custom-token') {
    return {
      authMode: 'native',
      needsBaseUrlRewrite: true,
      integration: {
        ...integration,
        transport: {
          ...integration.transport,
          auth: {
            ...auth,
            token_url: `${integration.transport.base_url}/__mock_auth/custom-token`,
            token_response_path: 'access_token',
          },
        },
      },
    };
  }

  return { authMode: 'native', integration, needsBaseUrlRewrite: false };
}

export function normalizeForMock(
  integration: HttpApiIntegrationSpec,
  resource: HttpApiResourceSpec,
  baseUrl: string
): {
  authMode: MockAuthMode;
  mockIntegration: HttpApiIntegrationSpec;
  mockResource: HttpApiResourceSpec;
} {
  const {
    authMode,
    integration: authNormalized,
    needsBaseUrlRewrite,
  } = mockAuthConfig(integration);
  const transportAuth =
    needsBaseUrlRewrite && authNormalized.transport.auth?.type === 'oauth2'
      ? {
          ...authNormalized.transport.auth,
          token_url: `${baseUrl}/__mock_auth/oauth2/token`,
        }
      : needsBaseUrlRewrite && authNormalized.transport.auth?.type === 'custom-token'
        ? {
            ...authNormalized.transport.auth,
            token_url: `${baseUrl}/__mock_auth/custom-token`,
            token_response_path: 'access_token',
          }
        : authNormalized.transport.auth;
  const mockIntegration: HttpApiIntegrationSpec = {
    ...authNormalized,
    transport: {
      ...authNormalized.transport,
      base_url: baseUrl,
      auth: transportAuth,
    },
  };

  const mockResource: HttpApiResourceSpec = structuredClone(resource);
  mockResource.api = {
    ...mockResource.api,
    endpoint: toMockEndpoint(mockResource.api.endpoint),
  };
  if (mockResource.api.auth && mockResource.api.auth.type === 'oauth2') {
    mockResource.api = {
      ...mockResource.api,
      auth: {
        ...mockResource.api.auth,
        token_url: `${baseUrl}/__mock_auth/oauth2/token`,
      },
    };
  } else if (mockResource.api.auth?.type === 'custom-token') {
    mockResource.api = {
      ...mockResource.api,
      auth: {
        ...mockResource.api.auth,
        token_url: `${baseUrl}/__mock_auth/custom-token`,
        token_response_path: 'access_token',
      },
    };
  }

  return { authMode, mockIntegration, mockResource };
}

export function isSimpleJsonPath(jsonPath: string): boolean {
  return jsonPath === '$' || /^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(jsonPath);
}
