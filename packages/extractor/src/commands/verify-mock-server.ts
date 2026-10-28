import * as http from 'node:http';

import type { HttpApiResourceSpec, ResourceSpec } from '../types/index.js';
import { parseJsonPathTokens, resolveArrayIndex } from '../framework/core/json-path.js';
import { getNestedValue } from './verify-shared.js';

export type CapturedRequest = {
  body: unknown;
  headers: http.IncomingHttpHeaders;
  kind: 'auth' | 'resource';
  method: string;
  pathname: string;
  query: URLSearchParams;
};

const MAX_MOCK_PAGE_SIZE = 2;

const INPUT_TEMPLATE_RE = /\$\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function jsonPathSegments(jsonPath: string): string[] | null {
  if (jsonPath === '$') return [];
  if (!jsonPath.startsWith('$.')) return null;

  const segments = jsonPath.slice(2).split('.').filter(Boolean);
  return segments.every((segment) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) ? segments : null;
}

function setValueAtJsonPath(
  target: Record<string, unknown>,
  jsonPath: string,
  value: unknown
): boolean {
  const tokens = parseJsonPathTokens(jsonPath);
  if (!tokens || tokens.length === 0) {
    return false;
  }

  let current: unknown = target;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]!;
    const nextToken = tokens[index + 1]!;

    if (token.type === 'prop') {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return false;
      }

      const object = current as Record<string, unknown>;
      const existing = object[token.value];
      if (nextToken.type === 'index') {
        if (!Array.isArray(existing)) {
          return false;
        }
        current = existing;
        continue;
      }

      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        object[token.value] = {};
      }
      current = object[token.value];
      continue;
    }

    if (!Array.isArray(current)) {
      return false;
    }

    const resolvedIndex = resolveArrayIndex(token.value, current.length);
    if (resolvedIndex < 0 || resolvedIndex >= current.length) {
      return false;
    }

    const existing = current[resolvedIndex];
    if (nextToken.type === 'prop') {
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        current[resolvedIndex] = {};
      }
      current = current[resolvedIndex];
      continue;
    }

    return false;
  }

  const lastToken = tokens[tokens.length - 1]!;
  if (lastToken.type === 'prop') {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return false;
    }
    (current as Record<string, unknown>)[lastToken.value] = value;
    return true;
  }

  if (!Array.isArray(current)) {
    return false;
  }

  const resolvedIndex = resolveArrayIndex(lastToken.value, current.length);
  if (resolvedIndex < 0 || resolvedIndex >= current.length) {
    return false;
  }

  current[resolvedIndex] = value;
  return true;
}

function wrapRecords(recordPath: string, records: Record<string, unknown>[]): unknown {
  if (recordPath === '$') {
    return records;
  }

  const segments = jsonPathSegments(recordPath);
  if (!segments) return null;

  const root: Record<string, unknown> = {};
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = records;
  return root;
}

function sampleScalar(type: ResourceSpec['output'][string]['type'], seed: number): unknown {
  switch (type) {
    case 'string':
      return `mock_${seed}`;
    case 'integer':
      return seed;
    case 'number':
      return seed + 0.5;
    case 'boolean':
      return seed % 2 === 0;
    case 'timestamp':
      return new Date(Date.UTC(2024, 0, Math.min(seed, 28), 12, 0, 0)).toISOString();
    case 'array':
      return [`mock_${seed}`];
    case 'object':
      return { mock: seed };
    default:
      return `mock_${seed}`;
  }
}

function buildMockRecord(resource: HttpApiResourceSpec, seed: number): Record<string, unknown> {
  const raw: Record<string, unknown> = {};

  for (const [fieldName, fieldSpec] of Object.entries(resource.output)) {
    const pathValue = fieldSpec.path ?? fieldSpec.paths?.[0];
    const value = fieldName === 'id' ? `mock_id_${seed}` : sampleScalar(fieldSpec.type, seed);
    if (!pathValue || !setValueAtJsonPath(raw, pathValue, value)) {
      raw[fieldName] = value;
    }
  }

  const cursorField = resource.extract.incremental?.cursor_field;
  if (cursorField) {
    const cursorPath = resource.output[cursorField]?.path;
    const cursorType = resource.output[cursorField]?.type;
    const cursorValue = sampleScalar(cursorType ?? 'string', seed);
    if (cursorPath && setValueAtJsonPath(raw, cursorPath, cursorValue)) {
      return raw;
    }
    raw[cursorField] = cursorValue;
  }

  return raw;
}

function resolveExpectedPath(endpoint: string, input: Record<string, unknown>): string | null {
  const rendered = endpoint.replace(INPUT_TEMPLATE_RE, (_full, key: string) => {
    const value = input[key];
    return value == null ? `missing-${key}` : encodeURIComponent(String(value));
  });
  try {
    const url =
      rendered.startsWith('http://') || rendered.startsWith('https://')
        ? new URL(rendered)
        : new URL(rendered, 'http://mock.local');
    return url.pathname;
  } catch {
    return null;
  }
}

async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  const contentType = req.headers['content-type'] ?? '';
  if (String(contentType).includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function createPaginationPayload(
  resource: HttpApiResourceSpec,
  pageIndex: number,
  baseUrl: string,
  pathname: string,
  pageSize: number
): { body: unknown; headers?: Record<string, string> } {
  const pagination = resource.extract.pagination;
  const recordPath = resource.extract.record_path ?? '$';
  const recordCount =
    pagination?.type === 'offset' || pagination?.type === 'page_number'
      ? pageIndex === 0
        ? pageSize
        : pageIndex === 1
          ? 1
          : 0
      : pageIndex === 0
        ? 2
        : 1;
  const records = Array.from({ length: recordCount }, (_, index) =>
    buildMockRecord(resource, pageIndex * 100 + index + 1)
  );
  const wrapped = wrapRecords(recordPath, records);
  if (wrapped == null) {
    return { body: records };
  }

  const body = typeof wrapped === 'object' && wrapped !== null ? structuredClone(wrapped) : wrapped;
  if (!pagination || pagination.type === 'none') {
    return { body };
  }

  switch (pagination.type) {
    case 'link_header':
      return pageIndex === 0
        ? {
            body,
            headers: {
              Link: `<${baseUrl}${pathname}?__mock_page=2>; rel="next"`,
            },
          }
        : { body };
    case 'cursor':
      if (pageIndex === 0 && typeof body === 'object' && body !== null) {
        setValueAtJsonPath(
          body as Record<string, unknown>,
          pagination.cursor_path,
          'mock-cursor-2'
        );
      }
      return { body };
    case 'next_url':
      if (pageIndex === 0 && typeof body === 'object' && body !== null) {
        setValueAtJsonPath(
          body as Record<string, unknown>,
          pagination.next_url_path,
          `${baseUrl}${pathname}?__mock_page=2`
        );
      }
      return { body };
    case 'offset':
      if (pageIndex === 0 && pagination.total_path && typeof body === 'object' && body !== null) {
        setValueAtJsonPath(body as Record<string, unknown>, pagination.total_path, pageSize + 1);
      }
      return { body };
    case 'page_number':
      if (
        pageIndex === 0 &&
        pagination.total_pages_path &&
        typeof body === 'object' &&
        body !== null
      ) {
        setValueAtJsonPath(body as Record<string, unknown>, pagination.total_pages_path, 2);
      }
      return { body };
    default:
      return { body };
  }
}

export function clampMockPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return MAX_MOCK_PAGE_SIZE;
  }
  return Math.min(pageSize, MAX_MOCK_PAGE_SIZE);
}

function pageIndexFromRequest(resource: HttpApiResourceSpec, request: CapturedRequest): number {
  const pagination = resource.extract.pagination;
  if (!pagination || pagination.type === 'none') return 0;

  switch (pagination.type) {
    case 'link_header':
    case 'next_url':
      return request.query.get('__mock_page') === '2' ? 1 : 0;
    case 'cursor':
      return (() => {
        const queryValue = request.query.get(pagination.cursor_param);
        const bodyValue = getNestedValue(request.body, pagination.cursor_param);
        const hasCursorValue =
          (queryValue != null && queryValue !== '') ||
          (bodyValue != null && String(bodyValue) !== '');
        return hasCursorValue ? 1 : 0;
      })();
    case 'offset': {
      const offsetParam = pagination.offset_param ?? 'offset';
      const offsetValue =
        request.query.get(offsetParam) ?? String(getNestedValue(request.body, offsetParam) ?? '0');
      return Number(offsetValue) > 0 ? 1 : 0;
    }
    case 'page_number': {
      const pageParam = pagination.page_param ?? 'page';
      const pageValue =
        request.query.get(pageParam) ?? String(getNestedValue(request.body, pageParam) ?? '1');
      const parsedPage = Number(pageValue);
      const startPage = pagination.start_page ?? 1;
      if (!Number.isFinite(parsedPage)) {
        return 0;
      }
      return Math.max(0, parsedPage - startPage);
    }
    default:
      return 0;
  }
}

export async function createMockServer(
  resource: HttpApiResourceSpec,
  fixtureInput: Record<string, unknown>,
  baseUrlRef: { current: string },
  requests: CapturedRequest[]
): Promise<http.Server> {
  const expectedPath = resolveExpectedPath(resource.api.endpoint, fixtureInput) ?? '/';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readRequestBody(req);

    if (url.pathname === '/__mock_auth/oauth2/token') {
      requests.push({
        body,
        headers: req.headers,
        kind: 'auth',
        method: req.method ?? 'POST',
        pathname: url.pathname,
        query: url.searchParams,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'mock-oauth-token',
          expires_in: 3600,
          refresh_token: 'mock-rotated-refresh-token',
          token_type: 'Bearer',
        })
      );
      return;
    }

    if (url.pathname === '/__mock_auth/custom-token') {
      requests.push({
        body,
        headers: req.headers,
        kind: 'auth',
        method: req.method ?? 'POST',
        pathname: url.pathname,
        query: url.searchParams,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'mock-custom-token' }));
      return;
    }

    requests.push({
      body,
      headers: req.headers,
      kind: 'resource',
      method: req.method ?? 'GET',
      pathname: url.pathname,
      query: url.searchParams,
    });

    if (url.pathname !== expectedPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'unexpected_path', expectedPath, receivedPath: url.pathname })
      );
      return;
    }

    const pageIndex = pageIndexFromRequest(resource, requests[requests.length - 1]!);
    const pageSize = clampMockPageSize(
      resource.extract.pagination?.type === 'offset'
        ? Number(
            requests[requests.length - 1]!.query.get(
              resource.extract.pagination.limit_param ?? 'limit'
            ) ??
              getNestedValue(body, resource.extract.pagination.limit_param ?? 'limit') ??
              100
          )
        : resource.extract.pagination?.type === 'page_number'
          ? Number(
              requests[requests.length - 1]!.query.get(
                resource.extract.pagination.per_page_param ?? 'per_page'
              ) ??
                getNestedValue(body, resource.extract.pagination.per_page_param ?? 'per_page') ??
                100
            )
          : MAX_MOCK_PAGE_SIZE
    );

    const response = createPaginationPayload(
      resource,
      pageIndex,
      baseUrlRef.current,
      expectedPath,
      pageSize
    );
    const isJsonl = resource.api.response_format === 'jsonl';
    const responseBody = isJsonl
      ? Array.isArray(response.body)
        ? response.body.map((record) => JSON.stringify(record)).join('\n')
        : JSON.stringify(response.body)
      : JSON.stringify(response.body);
    res.writeHead(200, {
      'Content-Type': isJsonl ? 'application/jsonl' : 'application/json',
      ...(response.headers ?? {}),
    });
    res.end(responseBody);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve mock server address');
  }
  baseUrlRef.current = `http://127.0.0.1:${address.port}`;
  return server;
}
