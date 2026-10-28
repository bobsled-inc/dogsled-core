import { extractCursorValue, extractNumberValue, extractRecords } from './response-mapper.js';
import type { PageResult, WarnFn } from './pagination.js';

import type { ApiResourceSpec as ResourceSpec } from '../types/index.js';

const MAX_PAGES = 10_000;

export type McpPageFetcher = (argumentOverrides?: Record<string, unknown>) => Promise<unknown>;

export async function* paginateMcpTool(
  resource: ResourceSpec,
  fetcher: McpPageFetcher,
  warn: WarnFn,
  options: { prefetchCursor?: boolean } = {}
): AsyncGenerator<PageResult> {
  const pagination = resource.extract.pagination;

  if (!pagination || pagination.type === 'none') {
    yield { data: await fetcher(), headers: new Headers(), status: 200 };
    return;
  }

  switch (pagination.type) {
    case 'mcp_cursor':
      yield* paginateMcpCursor(
        pagination,
        resource,
        fetcher,
        warn,
        options.prefetchCursor !== false
      );
      return;
    case 'mcp_offset':
      yield* paginateMcpOffset(pagination, resource, fetcher, warn);
      return;
    case 'mcp_page_number':
      yield* paginateMcpPageNumber(pagination, resource, fetcher, warn);
      return;
    case 'link_header':
    case 'cursor':
    case 'offset':
    case 'page_number':
    case 'next_url':
      throw new Error(
        `Pagination type "${pagination.type}" is not supported for MCP resources. Use "mcp_cursor", "mcp_offset", "mcp_page_number", or omit pagination.`
      );
    default: {
      const _exhaustive: never = pagination;
      throw new Error(`Unknown pagination type: ${(_exhaustive as { type: string }).type}`);
    }
  }
}

async function* paginateMcpCursor(
  pagination: Extract<ResourceSpec['extract']['pagination'], { type: 'mcp_cursor' }>,
  resource: ResourceSpec,
  fetcher: McpPageFetcher,
  warn: WarnFn,
  prefetch: boolean
): AsyncGenerator<PageResult> {
  let prefetchPromise: Promise<unknown | null> | null = null;

  let data = await fetcher();
  let cursor = extractCursorValue(data, pagination.cursor_path);

  if (cursor && prefetch) {
    // Prefetch is single-attempt: catch errors and return null so the main
    // path can retry via the retried fetcher when the result is consumed.
    prefetchPromise = fetcher({ [pagination.cursor_argument]: cursor }).catch(() => null);
  }

  yield { data, headers: new Headers(), status: 200 };

  let pageCount = 1;
  while (cursor) {
    if (++pageCount > MAX_PAGES) {
      await warn(`Max page limit (${MAX_PAGES}) reached`);
      break;
    }

    // If prefetch succeeded, use it; if it failed (null), fall back to a fresh fetch
    const prefetched = prefetchPromise ? await prefetchPromise : null;
    data = prefetched ?? (await fetcher({ [pagination.cursor_argument]: cursor }));
    prefetchPromise = null;

    cursor = extractCursorValue(data, pagination.cursor_path);
    if (cursor && prefetch) {
      prefetchPromise = fetcher({ [pagination.cursor_argument]: cursor }).catch(() => null);
    }

    yield { data, headers: new Headers(), status: 200 };
  }
}

async function* paginateMcpOffset(
  pagination: Extract<ResourceSpec['extract']['pagination'], { type: 'mcp_offset' }>,
  resource: ResourceSpec,
  fetcher: McpPageFetcher,
  warn: WarnFn
): AsyncGenerator<PageResult> {
  const offsetArg = pagination.offset_argument;
  const limitArg = pagination.limit_argument;
  const limit = pagination.limit_value;
  let offset = 0;

  const data = await fetcher({ [offsetArg]: offset, [limitArg]: limit });
  yield { data, headers: new Headers(), status: 200 };

  const total = pagination.total_path ? extractNumberValue(data, pagination.total_path) : undefined;

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

    const nextData = await fetcher({ [offsetArg]: offset, [limitArg]: limit });
    const records = extractRecords(nextData, resource);
    if (records.length === 0) {
      break;
    }

    yield { data: nextData, headers: new Headers(), status: 200, records };
    offset += limit;

    if (records.length < limit) {
      break;
    }
  }
}

async function* paginateMcpPageNumber(
  pagination: Extract<ResourceSpec['extract']['pagination'], { type: 'mcp_page_number' }>,
  resource: ResourceSpec,
  fetcher: McpPageFetcher,
  warn: WarnFn
): AsyncGenerator<PageResult> {
  const pageArg = pagination.page_argument;
  const perPageArg = pagination.per_page_argument;
  const perPage = pagination.per_page_value;
  let currentPage = pagination.start_page;

  const data = await fetcher({ [pageArg]: currentPage, [perPageArg]: perPage });
  yield { data, headers: new Headers(), status: 200 };

  const totalPages = pagination.total_pages_path
    ? extractNumberValue(data, pagination.total_pages_path)
    : undefined;

  currentPage += 1;
  let pageCount = 1;
  while (true) {
    if (totalPages !== undefined && currentPage > totalPages) {
      break;
    }
    if (++pageCount > MAX_PAGES) {
      await warn(`Max page limit (${MAX_PAGES}) reached`);
      break;
    }

    const nextData = await fetcher({ [pageArg]: currentPage, [perPageArg]: perPage });
    const records = extractRecords(nextData, resource);
    if (records.length === 0) {
      break;
    }

    yield { data: nextData, headers: new Headers(), status: 200, records };
    currentPage += 1;

    if (records.length < perPage) {
      break;
    }
  }
}
