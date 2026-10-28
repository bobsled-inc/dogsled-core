/**
 * Pagination strategies for extractor resources.
 */

import { isSameOrigin } from '../framework/core/index.js';

import type { ApiIntegrationSpec, HttpApiResourceSpec } from '../types/index.js';
import type { ClientResponse } from './client.js';
import { extractCursorValue, extractNumberValue, extractRecords } from './response-mapper.js';

const MAX_PAGES = 10_000;
const CYCLE_DETECTION_WINDOW = 3;
const INPUT_TEMPLATE_RE = /^\s*\$\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;

export interface PageResult {
  data: unknown;
  headers: Headers;
  status: number;
  /** Pre-extracted records when available (avoids re-extraction by caller). */
  records?: unknown[];
}

export type PageFetcher = (
  params?: Record<string, string | number | boolean>,
  url?: string
) => Promise<ClientResponse>;

export type WarnFn = (message: string) => Promise<void>;

export interface PaginateOptions {
  baseUrl?: string;
  recordLimit?: number;
}

function getDefaultPageSize(resource: HttpApiResourceSpec, paramName: string): number {
  const template = resource.api.query_params?.[paramName];
  if (template && !INPUT_TEMPLATE_RE.test(template)) {
    const numericValue = Number(template);
    return Number.isFinite(numericValue) ? numericValue : 100;
  }

  const inputMatch = typeof template === 'string' ? template.match(INPUT_TEMPLATE_RE) : null;
  if (!inputMatch?.[1]) {
    return 100;
  }

  const inputSchema = resource.input[inputMatch[1]];
  if (!inputSchema || inputSchema.default === undefined) {
    return 100;
  }

  const numericValue = Number(inputSchema.default);
  return Number.isFinite(numericValue) ? numericValue : 100;
}

/**
 * Detect pagination cycles by checking if the last N values are all identical.
 */
function isCycleDetected(recentValues: string[]): boolean {
  if (recentValues.length < CYCLE_DETECTION_WINDOW) {
    return false;
  }
  const last = recentValues[recentValues.length - 1];
  for (let i = recentValues.length - CYCLE_DETECTION_WINDOW; i < recentValues.length - 1; i++) {
    if (recentValues[i] !== last) {
      return false;
    }
  }
  return true;
}

function getHttpBaseUrl(integration: ApiIntegrationSpec): string {
  if (integration.transport.type === 'http') {
    return integration.transport.base_url;
  }
  throw new Error(`paginate() requires an HTTP integration, got "${integration.transport.type}".`);
}

function boundedPageSize(defaultPageSize: number, remainingRecords: number | undefined): number {
  return remainingRecords === undefined
    ? defaultPageSize
    : Math.max(1, Math.min(defaultPageSize, remainingRecords));
}

export async function* paginate(
  integration: ApiIntegrationSpec,
  resource: HttpApiResourceSpec,
  fetcher: PageFetcher,
  warn: WarnFn,
  options?: PaginateOptions
): AsyncGenerator<PageResult> {
  if (options?.recordLimit !== undefined) {
    if (!Number.isSafeInteger(options.recordLimit) || options.recordLimit <= 0) {
      throw new Error('paginate() recordLimit must be a positive integer.');
    }
  }

  const pagination = resource.extract?.pagination;

  if (!pagination || pagination.type === 'none') {
    const response = await fetcher();
    yield { data: response.data, headers: response.headers, status: response.status };
    return;
  }

  switch (pagination.type) {
    case 'link_header':
      yield* paginateLinkHeader(fetcher, options?.baseUrl ?? getHttpBaseUrl(integration), warn);
      break;
    case 'cursor':
      yield* paginateCursor(pagination, fetcher, warn);
      break;
    case 'offset':
      yield* paginateOffset(pagination, resource, fetcher, warn, options?.recordLimit);
      break;
    case 'page_number':
      yield* paginatePageNumber(pagination, resource, fetcher, warn, options?.recordLimit);
      break;
    case 'next_url':
      yield* paginateNextUrl(
        pagination,
        options?.baseUrl ?? getHttpBaseUrl(integration),
        fetcher,
        warn
      );
      break;
    case 'mcp_cursor':
    case 'mcp_offset':
    case 'mcp_page_number':
      throw new Error(
        `Pagination type "${pagination.type}" is only supported for MCP resources. Use paginateMcpTool() instead.`
      );
    default: {
      const _exhaustive: never = pagination;
      throw new Error(`Unknown pagination type: ${(_exhaustive as { type: string }).type}`);
    }
  }
}

function parseLinkHeader(headers: Headers): string | null {
  const header = headers.get('link');
  if (!header) {
    return null;
  }

  for (const link of header.split(',')) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

async function* paginateByUrl(
  fetcher: PageFetcher,
  baseUrl: string,
  warn: WarnFn,
  nextUrlResolver: (response: ClientResponse) => string | null
): AsyncGenerator<PageResult> {
  let response = await fetcher();
  yield { data: response.data, headers: response.headers, status: response.status };

  let pageCount = 1;
  const recentUrls: string[] = [];
  let nextUrl = nextUrlResolver(response);
  while (nextUrl) {
    const absoluteNextUrl = new URL(nextUrl, baseUrl).toString();
    if (!isSameOrigin(absoluteNextUrl, baseUrl)) {
      break;
    }
    recentUrls.push(absoluteNextUrl);
    if (isCycleDetected(recentUrls)) {
      await warn(
        `Pagination cycle detected — next URL unchanged for ${CYCLE_DETECTION_WINDOW} consecutive pages: ${absoluteNextUrl}`
      );
      break;
    }
    if (++pageCount > MAX_PAGES) {
      await warn(`Max page limit (${MAX_PAGES}) reached`);
      break;
    }
    response = await fetcher(undefined, absoluteNextUrl);
    yield { data: response.data, headers: response.headers, status: response.status };
    nextUrl = nextUrlResolver(response);
  }
}

async function* paginateLinkHeader(
  fetcher: PageFetcher,
  baseUrl: string,
  warn: WarnFn
): AsyncGenerator<PageResult> {
  yield* paginateByUrl(fetcher, baseUrl, warn, (response) => parseLinkHeader(response.headers));
}

async function* paginateCursor(
  pagination: Extract<HttpApiResourceSpec['extract']['pagination'], { type: 'cursor' }>,
  fetcher: PageFetcher,
  warn: WarnFn
): AsyncGenerator<PageResult> {
  let response = await fetcher();
  yield { data: response.data, headers: response.headers, status: response.status };

  let pageCount = 1;
  const recentCursors: string[] = [];
  let cursor = extractCursorValue(response.data, pagination.cursor_path);
  while (cursor) {
    recentCursors.push(cursor);
    if (isCycleDetected(recentCursors)) {
      await warn(
        `Pagination cycle detected — cursor value unchanged for ${CYCLE_DETECTION_WINDOW} consecutive pages: ${cursor}`
      );
      break;
    }
    if (++pageCount > MAX_PAGES) {
      await warn(`Max page limit (${MAX_PAGES}) reached`);
      break;
    }
    response = await fetcher({ [pagination.cursor_param]: cursor });
    yield { data: response.data, headers: response.headers, status: response.status };
    cursor = extractCursorValue(response.data, pagination.cursor_path);
  }
}

async function* paginateOffset(
  pagination: Extract<HttpApiResourceSpec['extract']['pagination'], { type: 'offset' }>,
  resource: HttpApiResourceSpec,
  fetcher: PageFetcher,
  warn: WarnFn,
  recordLimit?: number
): AsyncGenerator<PageResult> {
  const offsetParam = pagination.offset_param ?? 'offset';
  const limitParam = pagination.limit_param ?? 'limit';
  const defaultLimit = getDefaultPageSize(resource, limitParam);
  let remainingRecords = recordLimit;
  let limit = boundedPageSize(defaultLimit, remainingRecords);
  let offset = 0;

  const response = await fetcher({ [offsetParam]: offset, [limitParam]: limit });
  const firstRecords =
    recordLimit === undefined ? undefined : extractRecords(response.data, resource);
  yield {
    data: response.data,
    headers: response.headers,
    status: response.status,
    ...(firstRecords !== undefined ? { records: firstRecords } : {}),
  };

  const total = pagination.total_path
    ? extractNumberValue(response.data, pagination.total_path)
    : undefined;

  if (firstRecords !== undefined && recordLimit !== undefined) {
    remainingRecords = Math.max(0, recordLimit - firstRecords.length);
    if (firstRecords.length === 0 || firstRecords.length < limit || remainingRecords === 0) {
      return;
    }
  }

  offset += limit;
  let pageCount = 1;
  while (true) {
    if (total !== undefined && offset >= total) {
      break;
    }
    if (++pageCount > MAX_PAGES) {
      await warn(`Max page limit (${MAX_PAGES}) reached`);
      break;
    }

    limit = boundedPageSize(defaultLimit, remainingRecords);
    const nextResponse = await fetcher({ [offsetParam]: offset, [limitParam]: limit });
    const records = extractRecords(nextResponse.data, resource);
    if (records.length === 0) {
      break;
    }

    yield {
      data: nextResponse.data,
      headers: nextResponse.headers,
      status: nextResponse.status,
      records,
    };
    remainingRecords =
      remainingRecords === undefined ? undefined : Math.max(0, remainingRecords - records.length);
    offset += limit;

    if (records.length < limit || remainingRecords === 0) {
      break;
    }
  }
}

async function* paginatePageNumber(
  pagination: Extract<HttpApiResourceSpec['extract']['pagination'], { type: 'page_number' }>,
  resource: HttpApiResourceSpec,
  fetcher: PageFetcher,
  warn: WarnFn,
  recordLimit?: number
): AsyncGenerator<PageResult> {
  const pageParam = pagination.page_param ?? 'page';
  const perPageParam = pagination.per_page_param;
  const defaultPerPage = perPageParam ? getDefaultPageSize(resource, perPageParam) : undefined;
  let remainingRecords = recordLimit;
  let perPage =
    defaultPerPage === undefined ? undefined : boundedPageSize(defaultPerPage, remainingRecords);
  let page = pagination.start_page ?? 1;

  const response = await fetcher({
    [pageParam]: page,
    ...(perPageParam && perPage !== undefined ? { [perPageParam]: perPage } : {}),
  });
  const firstRecords =
    recordLimit === undefined ? undefined : extractRecords(response.data, resource);
  yield {
    data: response.data,
    headers: response.headers,
    status: response.status,
    ...(firstRecords !== undefined ? { records: firstRecords } : {}),
  };

  const totalPages = pagination.total_pages_path
    ? extractNumberValue(response.data, pagination.total_pages_path)
    : undefined;

  if (firstRecords !== undefined && recordLimit !== undefined) {
    remainingRecords = Math.max(0, recordLimit - firstRecords.length);
    if (
      firstRecords.length === 0 ||
      (perPage !== undefined && firstRecords.length < perPage) ||
      remainingRecords === 0
    ) {
      return;
    }
  }

  page += 1;
  let pageCount = 1;
  while (true) {
    if (totalPages !== undefined && page > totalPages) {
      break;
    }
    if (++pageCount > MAX_PAGES) {
      await warn(`Max page limit (${MAX_PAGES}) reached`);
      break;
    }

    perPage =
      defaultPerPage === undefined ? undefined : boundedPageSize(defaultPerPage, remainingRecords);
    const nextResponse = await fetcher({
      [pageParam]: page,
      ...(perPageParam && perPage !== undefined ? { [perPageParam]: perPage } : {}),
    });
    const records = extractRecords(nextResponse.data, resource);
    if (records.length === 0) {
      break;
    }

    yield {
      data: nextResponse.data,
      headers: nextResponse.headers,
      status: nextResponse.status,
      records,
    };
    remainingRecords =
      remainingRecords === undefined ? undefined : Math.max(0, remainingRecords - records.length);
    page += 1;

    if ((perPage !== undefined && records.length < perPage) || remainingRecords === 0) {
      break;
    }
  }
}

async function* paginateNextUrl(
  pagination: Extract<HttpApiResourceSpec['extract']['pagination'], { type: 'next_url' }>,
  baseUrl: string,
  fetcher: PageFetcher,
  warn: WarnFn
): AsyncGenerator<PageResult> {
  yield* paginateByUrl(fetcher, baseUrl, warn, (response) =>
    extractCursorValue(response.data, pagination.next_url_path)
  );
}
