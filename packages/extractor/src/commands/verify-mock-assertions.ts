import {
  appendFinding,
  getNestedValue,
  getPaginationPageSizeParam,
  type VerifyFinding,
} from './verify-shared.js';
import type { HttpApiResourceSpec } from '../types/index.js';
import { resolveHttpRequestParameterDestination } from '../runtime/client.js';
import type { CapturedRequest } from './verify-mock-server.js';
import type { HttpApiIntegrationSpec, MockAuthMode } from './verify-mock-fixtures.js';

export type ExpectedRequest = {
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

function normalizeQueryParams(searchParams: URLSearchParams): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    if (!normalized[key]) {
      normalized[key] = [];
    }
    normalized[key].push(value);
  }

  for (const values of Object.values(normalized)) {
    values.sort();
  }

  return normalized;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      normalized[key] = normalizeJson((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }
  return value;
}

function getPaginationParamNames(resource: HttpApiResourceSpec): string[] {
  const pagination = resource.extract.pagination;
  if (!pagination || pagination.type === 'none' || pagination.type === 'link_header') {
    return [];
  }

  switch (pagination.type) {
    case 'cursor':
      return [pagination.cursor_param];
    case 'offset':
      return [
        pagination.offset_param ?? 'offset',
        getPaginationPageSizeParam(pagination) ?? 'limit',
      ];
    case 'page_number':
      return [
        pagination.page_param ?? 'page',
        getPaginationPageSizeParam(pagination) ?? 'per_page',
      ];
    case 'next_url':
      return [];
  }

  return [];
}

function stripQueryKeys(
  query: Record<string, string[]>,
  ignoredKeys: Set<string>
): Record<string, string[]> {
  return Object.fromEntries(Object.entries(query).filter(([key]) => !ignoredKeys.has(key)));
}

function stripObjectKeys(value: unknown, ignoredKeys: Set<string>): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => !ignoredKeys.has(key))
  );
}

function appendRequestContractFindings(
  integrationName: string,
  resource: HttpApiResourceSpec,
  fixtureName: string,
  firstRequest: CapturedRequest,
  expectedFirstRequest: ExpectedRequest,
  findings: VerifyFinding[]
): void {
  const ignoredKeys = new Set(getPaginationParamNames(resource));
  const expectedQuery = stripQueryKeys(
    normalizeQueryParams(new URL(expectedFirstRequest.url).searchParams),
    ignoredKeys
  );
  const actualQuery = stripQueryKeys(normalizeQueryParams(firstRequest.query), ignoredKeys);
  if (JSON.stringify(actualQuery) !== JSON.stringify(expectedQuery)) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_QUERY_MISMATCH',
      `Fixture "${fixtureName}" sent unexpected query params: expected ${JSON.stringify(expectedQuery)}, received ${JSON.stringify(actualQuery)}`,
      resource.name
    );
  }

  const actualBody = normalizeJson(stripObjectKeys(firstRequest.body, ignoredKeys));
  const expectedBody = normalizeJson(stripObjectKeys(expectedFirstRequest.body, ignoredKeys));
  if (JSON.stringify(actualBody) !== JSON.stringify(expectedBody)) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_BODY_MISMATCH',
      `Fixture "${fixtureName}" sent unexpected request body: expected ${JSON.stringify(expectedBody)}, received ${JSON.stringify(actualBody)}`,
      resource.name
    );
  }
}

function appendPaginationRoutingFindings(
  integrationName: string,
  resource: HttpApiResourceSpec,
  fixtureName: string,
  requests: CapturedRequest[],
  findings: VerifyFinding[]
): void {
  const pagination = resource.extract.pagination;
  if (!pagination || pagination.type === 'none' || requests.length < 2) {
    return;
  }

  const paramName = getPaginationParamNames(resource)[0] ?? null;
  if (!paramName) {
    return;
  }

  const secondRequest = requests[1]!;
  const destination = resolveHttpRequestParameterDestination(
    resource.api,
    resource.input,
    paramName
  );
  if (destination === 'path' || destination === 'header') return;
  const shouldBeInBody = destination === 'body';
  const hasInQuery = secondRequest.query.has(paramName);
  const hasInBody = getNestedValue(secondRequest.body, paramName) !== undefined;

  if (shouldBeInBody) {
    if (!hasInBody) {
      appendFinding(
        findings,
        integrationName,
        'error',
        'MOCK_PAGINATION_BODY_MISSING',
        `Fixture "${fixtureName}" did not send pagination param "${paramName}" in the request body`,
        resource.name
      );
    }
    if (hasInQuery) {
      appendFinding(
        findings,
        integrationName,
        'error',
        'MOCK_PAGINATION_QUERY_UNEXPECTED',
        `Fixture "${fixtureName}" sent pagination param "${paramName}" in the query string instead of the request body`,
        resource.name
      );
    }
    return;
  }

  if (!hasInQuery) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_PAGINATION_QUERY_MISSING',
      `Fixture "${fixtureName}" did not send pagination param "${paramName}" in the query string`,
      resource.name
    );
  }
  if (hasInBody) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_PAGINATION_BODY_UNEXPECTED',
      `Fixture "${fixtureName}" sent pagination param "${paramName}" in the request body instead of the query string`,
      resource.name
    );
  }
}

function appendAuthContractFindings(
  integrationName: string,
  resource: HttpApiResourceSpec,
  fixtureName: string,
  expectedAuthRequests: CapturedRequest[],
  actualAuthRequests: CapturedRequest[],
  findings: VerifyFinding[]
): void {
  if (expectedAuthRequests.length === 0) {
    return;
  }

  if (actualAuthRequests.length === 0) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_AUTH_CONTRACT_MISSING',
      `Fixture "${fixtureName}" did not execute the expected auth request flow`,
      resource.name
    );
    return;
  }

  const expected = expectedAuthRequests[0]!;
  const actual = actualAuthRequests[0]!;
  if (expected.method !== actual.method || expected.pathname !== actual.pathname) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_AUTH_CONTRACT_MISMATCH',
      `Fixture "${fixtureName}" auth request mismatch: expected ${expected.method} ${expected.pathname}, received ${actual.method} ${actual.pathname}`,
      resource.name
    );
  }

  const expectedBody = normalizeJson(expected.body);
  const actualBody = normalizeJson(actual.body);
  if (JSON.stringify(expectedBody) !== JSON.stringify(actualBody)) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_AUTH_BODY_MISMATCH',
      `Fixture "${fixtureName}" auth request body mismatch: expected ${JSON.stringify(expectedBody)}, received ${JSON.stringify(actualBody)}`,
      resource.name
    );
  }
}

export function assertMockRun(
  integrationName: string,
  _integration: HttpApiIntegrationSpec,
  resource: HttpApiResourceSpec,
  fixtureName: string,
  authMode: MockAuthMode,
  requests: CapturedRequest[],
  expectedAuthRequests: CapturedRequest[],
  protocolOutput: string[],
  expectedFirstRequest: ExpectedRequest,
  findings: VerifyFinding[]
): void {
  const resourceRequests = requests.filter((request) => request.kind === 'resource');
  const authRequests = requests.filter((request) => request.kind === 'auth');

  if (resourceRequests.length === 0) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_NO_REQUESTS',
      `Mock verification captured no requests for fixture "${fixtureName}"`,
      resource.name
    );
    return;
  }

  const firstRequest = resourceRequests[0]!;
  const expectedPath = new URL(expectedFirstRequest.url).pathname;
  if (firstRequest.method !== resource.api.method) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_METHOD_MISMATCH',
      `Fixture "${fixtureName}" used ${firstRequest.method} instead of ${resource.api.method}`,
      resource.name
    );
  }
  if (firstRequest.pathname !== expectedPath) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_PATH_MISMATCH',
      `Fixture "${fixtureName}" requested ${firstRequest.pathname} instead of ${expectedPath}`,
      resource.name
    );
  }

  appendRequestContractFindings(
    integrationName,
    resource,
    fixtureName,
    firstRequest,
    expectedFirstRequest,
    findings
  );

  if ('Authorization' in expectedFirstRequest.headers) {
    if (!firstRequest.headers['authorization']) {
      appendFinding(
        findings,
        integrationName,
        'error',
        'MOCK_AUTH_MISSING',
        `Fixture "${fixtureName}" did not send Authorization header`,
        resource.name
      );
    } else if (authMode === 'simulated') {
      appendFinding(
        findings,
        integrationName,
        'info',
        'MOCK_AUTH_SIMULATED',
        `Fixture "${fixtureName}" used simulated bearer auth for offline verification`,
        resource.name
      );
    }
  }

  appendAuthContractFindings(
    integrationName,
    resource,
    fixtureName,
    expectedAuthRequests,
    authRequests,
    findings
  );

  const schemaCount = protocolOutput.filter((line) => line.includes('"type":"SCHEMA"')).length;
  const recordCount = protocolOutput.filter((line) => line.includes('"type":"RECORD"')).length;
  const stateCount = protocolOutput.filter((line) => line.includes('"type":"STATE"')).length;
  if (schemaCount === 0 || recordCount === 0 || stateCount === 0) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_PROTOCOL_INCOMPLETE',
      `Fixture "${fixtureName}" did not emit the full SCHEMA/RECORD/STATE protocol`,
      resource.name
    );
  }

  if (
    resource.extract.pagination &&
    resource.extract.pagination.type !== 'none' &&
    resourceRequests.length < 2
  ) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MOCK_PAGINATION_INACTIVE',
      `Fixture "${fixtureName}" did not advance pagination`,
      resource.name
    );
  }

  appendPaginationRoutingFindings(
    integrationName,
    resource,
    fixtureName,
    resourceRequests,
    findings
  );
}
