import {
  queryResource,
  type QueryResourceOptions,
  type QueryResourceResult,
} from '@bobsled-inc/extractor';
import { vi } from 'vitest';

type QueryResourceImpl = typeof queryResource;
type IntegrationSpec = QueryResourceOptions['integration'];
type ResourceSpec = QueryResourceOptions['resource'];
type SpyRecord = Record<string, unknown>;

export interface QueryHttpSpyPage {
  records: SpyRecord[];
  nextCursor?: string | null;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
}

export interface QueryHttpSpyOptions {
  baseUrl?: string;
  endpoint?: string;
  integrationName?: string;
  resourceName?: string;
  pages?: QueryHttpSpyPage[];
  defaultDelayMs?: number;
  gateResponses?: boolean;
}

export interface QueryHttpSpyRequest {
  url: URL;
  method: string;
}

export interface QueryHttpSpyHarness {
  integration: IntegrationSpec;
  resource: ResourceSpec;
  integrationSpecLoader: () => { integration: IntegrationSpec; resource: ResourceSpec };
  queryResourceImpl: QueryResourceImpl;
  readonly providerCallCount: number;
  readonly requestCount: number;
  readonly requests: QueryHttpSpyRequest[];
  waitForRequestCount: (count: number, timeoutMs?: number) => Promise<void>;
  releaseNextResponse: () => void;
  releaseAllResponses: () => void;
  restore: () => void;
}

interface PendingGate {
  release: () => void;
}

interface RequestWaiter {
  count: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1';
const DEFAULT_ENDPOINT = '/issues';
const DEFAULT_PAGES: QueryHttpSpyPage[] = [
  {
    records: [{ id: 1, title: 'first issue', state: 'open' }],
    nextCursor: null,
  },
];

let activeSpyOwner: symbol | undefined;

export function createQueryResourceHttpSpy(options: QueryHttpSpyOptions = {}): QueryHttpSpyHarness {
  if (activeSpyOwner !== undefined) {
    throw new Error('A query HTTP spy is already active. Restore it before creating another.');
  }

  const owner = Symbol('query-http-spy');
  activeSpyOwner = owner;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const integrationName = options.integrationName ?? 'spy_api';
  const resourceName = options.resourceName ?? 'issues';
  const pages = options.pages ?? DEFAULT_PAGES;
  const requests: QueryHttpSpyRequest[] = [];
  const providerCalls: QueryResourceOptions[] = [];
  const pendingGates: PendingGate[] = [];
  const waiters: RequestWaiter[] = [];
  const cursorToPageIndex = buildCursorPageIndex(pages);
  const previousAllowPrivateHosts = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
  let restored = false;

  process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = '1';

  const integration: IntegrationSpec = {
    spec_version: '1',
    name: integrationName,
    type: 'integration',
    transport: {
      type: 'http',
      base_url: baseUrl,
      auth: { type: 'none' },
    },
  };

  const resource: ResourceSpec = {
    spec_version: '1',
    name: resourceName,
    type: 'resource',
    integration: integrationName,
    description: 'Queryable HTTP spy resource',
    api: {
      endpoint,
      method: 'GET',
      query_params: {
        state: '${{ input.state }}',
      },
    },
    input: {
      state: {
        type: 'string',
        default: 'open',
        enum: ['open', 'closed', 'all'],
      },
    },
    output: {
      id: { type: 'integer', path: '$.id' },
      title: { type: 'string', path: '$.title' },
      state: { type: 'string', path: '$.state' },
    },
    extract: {
      record_path: '$.data',
      pagination: {
        type: 'cursor',
        cursor_path: '$.next_cursor',
        cursor_param: 'cursor',
      },
      table: {
        primary_key: ['id'],
      },
    },
    query: {
      filters: {
        state: {
          operators: ['eq'],
          enum: ['open', 'closed'],
          bind: {
            eq: { input: 'state' },
          },
        },
      },
    },
  };

  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      requests.push({
        url,
        method: requestMethod(input, init),
      });
      notifyWaiters(waiters, requests.length);

      const page = resolvePage(pages, cursorToPageIndex, url);
      await waitForResponseGate(page, options, pendingGates);

      const status = page.status ?? 200;
      const body =
        status === 204 || status === 205 || status === 304
          ? null
          : JSON.stringify(page.body ?? defaultBody(page));
      return new Response(body, {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...(page.headers ?? {}),
        },
      });
    });

  const queryResourceImpl = (async (
    queryOptions: QueryResourceOptions
  ): Promise<QueryResourceResult<Record<string, unknown>>> => {
    providerCalls.push(queryOptions);
    return queryResource(queryOptions);
  }) as QueryResourceImpl;

  return {
    integration,
    resource,
    integrationSpecLoader: () => ({ integration, resource }),
    queryResourceImpl,
    get providerCallCount() {
      return providerCalls.length;
    },
    get requestCount() {
      return requests.length;
    },
    get requests() {
      return requests;
    },
    waitForRequestCount: (count: number, timeoutMs = 500) =>
      waitForRequestCount(waiters, requests.length, count, timeoutMs),
    releaseNextResponse: () => {
      const gate = pendingGates.shift();
      if (!gate) {
        throw new Error('No pending HTTP spy response to release.');
      }
      gate.release();
    },
    releaseAllResponses: () => {
      while (pendingGates.length > 0) {
        pendingGates.shift()?.release();
      }
    },
    restore: () => {
      if (restored) {
        return;
      }
      restored = true;
      if (activeSpyOwner === owner) {
        activeSpyOwner = undefined;
      }
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error('HTTP spy restored before request count was reached.'));
      }
      while (pendingGates.length > 0) {
        pendingGates.shift()?.release();
      }
      fetchSpy.mockRestore();
      restoreAllowPrivateHosts(previousAllowPrivateHosts);
    },
  };
}

function buildCursorPageIndex(pages: QueryHttpSpyPage[]): Map<string, number> {
  const cursorToPageIndex = new Map<string, number>();
  for (let index = 1; index < pages.length; index += 1) {
    const previousCursor = pages[index - 1]?.nextCursor;
    if (previousCursor) {
      cursorToPageIndex.set(previousCursor, index);
    }
  }
  return cursorToPageIndex;
}

function resolvePage(
  pages: QueryHttpSpyPage[],
  cursorToPageIndex: Map<string, number>,
  url: URL
): QueryHttpSpyPage {
  const cursor = url.searchParams.get('cursor');
  if (!cursor) {
    return pages[0] ?? { records: [], nextCursor: null };
  }

  const pageIndex = cursorToPageIndex.get(cursor);
  if (pageIndex === undefined) {
    throw new Error(`HTTP spy received unknown cursor "${cursor}".`);
  }
  return pages[pageIndex] ?? { records: [], nextCursor: null };
}

function defaultBody(page: QueryHttpSpyPage): Record<string, unknown> {
  return {
    data: page.records,
    next_cursor: page.nextCursor ?? null,
  };
}

async function waitForResponseGate(
  page: QueryHttpSpyPage,
  options: QueryHttpSpyOptions,
  pendingGates: PendingGate[]
): Promise<void> {
  if (options.gateResponses) {
    await new Promise<void>((resolve) => {
      pendingGates.push({ release: resolve });
    });
  }

  const delayMs = page.delayMs ?? options.defaultDelayMs ?? 0;
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

function waitForRequestCount(
  waiters: RequestWaiter[],
  currentCount: number,
  count: number,
  timeoutMs: number
): Promise<void> {
  if (currentCount >= count) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const waiter: RequestWaiter = {
      count,
      resolve,
      reject,
      timeout: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for ${count} HTTP spy request(s).`));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });
}

function notifyWaiters(waiters: RequestWaiter[], requestCount: number): void {
  for (const waiter of [...waiters]) {
    if (requestCount < waiter.count) {
      continue;
    }

    const index = waiters.indexOf(waiter);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
    clearTimeout(waiter.timeout);
    waiter.resolve();
  }
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(String(input));
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method) {
    return init.method;
  }
  if (input instanceof Request) {
    return input.method;
  }
  return 'GET';
}

function restoreAllowPrivateHosts(previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    return;
  }
  process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = previousValue;
}
