import { BobsledRuntimeError } from '@bobsled-inc/protocol';

import { isSourceSpec, resolveVia, sanitizeUrlForError } from '../../framework/core/index.js';
import { ExtractorConfigError, ExtractorDataError } from '../errors.js';
import { QueryFanOutError } from './fan-out-contract.js';

import type { ApiResourceSpec, IntegrationSpec } from '../../types/index.js';
import type { QueryFanOutCounts, QueryFanOutLimits } from './fan-out-contract.js';

export const DEFAULT_QUERY_FAN_OUT_LIMITS: Required<QueryFanOutLimits> = {
  maxParentWorkItems: 100,
  maxTargetRows: 9_999,
  maxProviderAttempts: 100,
  maxMappedBytes: 64 * 1024 * 1024,
  maxConcurrency: 4,
  deadlineMs: 5 * 60_000,
};

const MAX_LIMITS: Required<QueryFanOutLimits> = {
  maxParentWorkItems: 10_000,
  maxTargetRows: 10_000,
  maxProviderAttempts: 10_000,
  maxMappedBytes: 256 * 1024 * 1024,
  maxConcurrency: 64,
  deadlineMs: 30 * 60_000,
};

export function emptyQueryFanOutCounts(): QueryFanOutCounts {
  return {
    parentWorkItems: 0,
    targetRows: 0,
    providerAttempts: 0,
    requestCount: 0,
    resultCount: 0,
    mappedBytes: 0,
    maxConcurrency: 0,
    durationMs: 0,
  };
}

export function resolveQueryFanOutLimits(
  limits: QueryFanOutLimits | undefined,
  target: string,
  correlationId?: string
): Required<QueryFanOutLimits> {
  const resolved = { ...DEFAULT_QUERY_FAN_OUT_LIMITS, ...(limits ?? {}) };
  for (const [name, value] of Object.entries(resolved)) {
    const maximum = MAX_LIMITS[name as keyof typeof MAX_LIMITS];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new QueryFanOutError({
        code: 'QUERY_FAN_OUT_INVALID_LIMITS',
        kind: 'validation',
        phase: 'plan',
        target,
        message: `queryResourceFanOut() ${name} must be a positive safe integer no greater than ${maximum}.`,
        counts: emptyQueryFanOutCounts(),
        correlationId,
      });
    }
  }
  return resolved;
}

export function combinedSignal(
  signal: AbortSignal | undefined,
  abort: AbortController
): AbortSignal {
  return signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
}

export async function awaitWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export function assertSupportedExecutionTransport(
  integration: IntegrationSpec,
  resource: ApiResourceSpec,
  target: string,
  counts: QueryFanOutCounts,
  correlationId?: string
): void {
  if (!isSourceSpec(integration) && !('transport' in integration)) {
    throw new QueryFanOutError({
      code: 'QUERY_FAN_OUT_UNSUPPORTED_TRANSPORT',
      kind: 'validation',
      phase: 'plan',
      target,
      resource: resource.name,
      message: `Resource "${resource.name}" does not have an API or MCP transport.`,
      counts,
      correlationId,
    });
  }
  let transport: { type: string };
  try {
    transport = isSourceSpec(integration)
      ? resolveVia(integration, resource.via)
      : integration.transport;
  } catch (error) {
    throw new QueryFanOutError({
      code: 'QUERY_FAN_OUT_UNSUPPORTED_TRANSPORT',
      kind: 'validation',
      phase: 'plan',
      target,
      resource: resource.name,
      message: `Resource "${resource.name}" does not resolve to a supported query transport.`,
      counts,
      cause: error,
      correlationId,
    });
  }
  const transportType = typeof transport?.type === 'string' ? transport.type : '';
  const supported =
    transportType === 'http' || transportType === 'mcp_http' || transportType === 'mcp_stdio';
  const resourceMatchesTransport =
    (transportType === 'http' && resource.api !== undefined) ||
    (transportType !== 'http' && resource.tool !== undefined);
  if (!supported || !resourceMatchesTransport) {
    const detail = transportType.startsWith('sql_')
      ? 'uses an unsupported SQL transport'
      : 'does not match a supported HTTP or MCP transport';
    throw new QueryFanOutError({
      code: 'QUERY_FAN_OUT_UNSUPPORTED_TRANSPORT',
      kind: 'validation',
      phase: 'plan',
      target,
      resource: resource.name,
      message: `Resource "${resource.name}" ${detail}.`,
      counts,
      correlationId,
    });
  }
}

function boundedProviderMessage(
  error: unknown,
  secrets: Record<string, string | undefined> | undefined
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redactValues = Object.values(secrets ?? {}).filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  let safe = raw
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  safe = safe.replace(/https?:\/\/[^\s"')\]]+/gi, (url) => sanitizeUrlForError(url));
  safe = safe.replace(
    /authorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^,;\s]+/gi,
    'authorization=[REDACTED]'
  );
  safe = safe.replace(/bearer\s+[^,;\s]+/gi, 'bearer [REDACTED]');
  safe = safe.replace(/api[ _-]?key\s*[:=]\s*[^,;\s]+/gi, 'api-key=[REDACTED]');
  for (const secret of redactValues) safe = safe.split(secret).join('[REDACTED]');
  return safe.slice(0, 2_048);
}

export function collectRedactionSecrets(
  integration: IntegrationSpec,
  supplied: Record<string, string | undefined> | undefined,
  additionalValues: readonly unknown[] = []
): Record<string, string | undefined> {
  const collected: Record<string, string | undefined> = { ...(supplied ?? {}) };
  let syntheticIndex = 0;
  let visited = 0;
  const visit = (
    value: unknown,
    key: string | undefined,
    depth: number,
    redactStrings = false
  ): void => {
    if (depth > 10 || visited++ > 1_000) return;
    if (typeof value === 'string') {
      for (const match of value.matchAll(
        /\$\{\{\s*(?:env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)\s*}}/g
      )) {
        const name = match[1]!;
        collected[name] ??=
          supplied?.[name] ??
          (integration.auth_env_vars?.includes(name) ? process.env[name] : undefined);
      }
      if (
        (redactStrings ||
          (key &&
            /(authorization|credential|password|secret|token|api.?key|client.?secret|request.?body)/i.test(
              key
            ))) &&
        value.length > 0 &&
        !value.includes('${{')
      ) {
        collected[`__integration_${syntheticIndex++}`] = value;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key, depth + 1, redactStrings);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, entry] of Object.entries(value)) {
        visit(entry, childKey, depth + 1, redactStrings);
      }
    }
  };
  visit(integration, undefined, 0);
  for (const value of additionalValues) visit(value, '__runtime_value', 0, true);
  return collected;
}

export function addQueryFanOutRedactionValues(
  collected: Record<string, string | undefined>,
  value: unknown
): void {
  let next = Object.keys(collected).length;
  let visited = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (depth > 10 || visited++ > 1_000) return;
    if (typeof entry === 'string' && entry.length > 0) {
      collected[`__runtime_${next++}`] = entry;
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (entry && typeof entry === 'object') {
      for (const item of Object.values(entry)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

export async function runFailFast<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (firstError === undefined) {
      const index = next++;
      if (index >= items.length) return;
      try {
        await worker(items[index]!, index);
      } catch (error) {
        if (
          firstError === undefined ||
          (isCancellationError(firstError) && !isCancellationError(error))
        ) {
          firstError = error;
        }
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
}

function isCancellationError(error: unknown): boolean {
  return error instanceof QueryFanOutError && error.kind === 'cancellation';
}

export function queryFanOutErrorFrom(
  error: unknown,
  params: Omit<
    ConstructorParameters<typeof QueryFanOutError>[0],
    'code' | 'kind' | 'message' | 'retryable' | 'providerStatus' | 'cause'
  > & { secrets?: Record<string, string | undefined> }
): QueryFanOutError {
  const nestedFanOutError = findFanOutError(error);
  const { secrets, ...errorParams } = params;
  if (nestedFanOutError) {
    return new QueryFanOutError({
      code: nestedFanOutError.code,
      kind: nestedFanOutError.kind,
      phase: nestedFanOutError.phase,
      target: nestedFanOutError.target,
      message: nestedFanOutError.message,
      counts: params.counts,
      resource: nestedFanOutError.resource ?? params.resource,
      parentResource: nestedFanOutError.parentResource ?? params.parentResource,
      binding: nestedFanOutError.binding ?? params.binding,
      parentOrdinal: nestedFanOutError.parentOrdinal ?? params.parentOrdinal,
      retryable: nestedFanOutError.retryable,
      providerStatus: nestedFanOutError.providerStatus,
      cause: nestedFanOutError,
      correlationId: nestedFanOutError.correlationId ?? params.correlationId,
    });
  }
  const runtime = error instanceof BobsledRuntimeError ? error : undefined;
  const record = error as { status?: unknown; retryable?: unknown } | null;
  const status =
    runtime?.providerStatus ?? (typeof record?.status === 'number' ? record.status : undefined);
  return new QueryFanOutError({
    ...errorParams,
    code:
      runtime?.code ??
      (error instanceof ExtractorConfigError
        ? 'QUERY_FAN_OUT_CONFIG_FAILURE'
        : error instanceof ExtractorDataError
          ? 'QUERY_FAN_OUT_DATA_FAILURE'
          : 'QUERY_FAN_OUT_PROVIDER_FAILURE'),
    kind:
      runtime?.kind ??
      (error instanceof ExtractorConfigError || error instanceof ExtractorDataError
        ? 'validation'
        : 'provider'),
    message: boundedProviderMessage(runtime?.cause ?? error, secrets),
    retryable:
      runtime?.retryable === true ||
      record?.retryable === true ||
      (status !== undefined && (status === 429 || status >= 500)),
    ...(status !== undefined ? { providerStatus: status } : {}),
    cause: error,
  });
}

function findFanOutError(error: unknown): QueryFanOutError | undefined {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof QueryFanOutError) return current;
    if (typeof current !== 'object' || current === null || seen.has(current)) return undefined;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function assertQueryFanOutInput(
  required: readonly string[],
  input: Record<string, unknown>,
  target: string,
  resource: string,
  counts: QueryFanOutCounts,
  mode: 'targeted' | 'fan_out',
  correlationId?: string
): void {
  const missing = required.filter((name) => input[name] === undefined || input[name] === null);
  if (missing.length > 0) {
    throw new QueryFanOutError({
      code: 'QUERY_FAN_OUT_MISSING_INPUT',
      kind: 'validation',
      phase: 'plan',
      target,
      resource,
      message: `${mode} query for "${resource}" is missing required input(s): ${missing.join(', ')}.`,
      counts,
      correlationId,
    });
  }
}

export function assertRequestedLimit(
  limit: number | undefined,
  target: string,
  correlationId?: string
): void {
  if (limit === undefined) return;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new QueryFanOutError({
      code: 'QUERY_FAN_OUT_INVALID_LIMIT',
      kind: 'validation',
      phase: 'plan',
      target,
      message: 'queryResourceFanOut() limit must be a positive integer no greater than 10000.',
      counts: emptyQueryFanOutCounts(),
      correlationId,
    });
  }
}
