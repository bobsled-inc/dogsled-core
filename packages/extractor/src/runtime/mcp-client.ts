import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PROTOCOL_VERSION } from '@bobsled-inc/protocol';
import { getErrorMessage } from '../framework/core/index.js';
import { interpolateValue, resolveOperationInput } from '../framework/runtime/index.js';

import { setNestedValue } from '../commands/extract-utils.js';
import type { ApiIntegrationSpec, ApiResourceSpec } from '../types/index.js';
import {
  ExtractorConfigError,
  classifyMcpError,
  isConnectionError,
  toExtractorMcpRuntimeError,
  toExtractorRuntimeError,
  withRetry,
} from './errors.js';
import { extractJsonPath } from './response-mapper.js';
import { RateLimiter } from './rate-limiter.js';
import {
  createStreamableHttpTransport,
  createStdioTransport,
  resolveStdioEnv,
} from './mcp-transport.js';
import { waitForCaller } from './wait-for-caller.js';

import type { LogMessage } from '@bobsled-inc/protocol';

// Re-export for consumers that imported from this module
export { clearOAuth2TokenCache } from './mcp-oauth2.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOOL_ERROR_CHARS = 2_048;

/** Regex detecting control characters in tool argument values. */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
/** Prototype pollution blocklist — shared with setNestedValue in extract-utils.ts. */
const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type McpTransport =
  | StreamableHTTPClientTransport
  | InstanceType<typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport>;
type McpOperationSpecLike = {
  input: ApiResourceSpec['input'];
  tool: NonNullable<ApiResourceSpec['tool']>;
};

export interface RuntimeClient {
  connect(): Promise<void>;
  close(): Promise<void>;
}

export interface McpClientOptions {
  integration: ApiIntegrationSpec;
  cliInputs?: Record<string, unknown>;
  secrets?: Record<string, string | undefined>;
  declaredSecretNames?: readonly string[];
  env?: Record<string, string | undefined>;
  /** @internal Shared by bounded graph execution to preserve integration-wide rate limits. */
  rateLimiter?: RateLimiter;
  /** @internal Counts MCP HTTP lifecycle and tool requests as aggregate attempts. */
  beforeRequestAttempt?: () => void;
  /** @internal Enables caller-owned cancellation for non-pooled query clients. */
  connectWithCallerSignal?: boolean;
  /** @internal Registers resolved authentication values for safe error redaction. */
  onResolvedSecret?: (value: string) => void;
}

export interface McpCallToolOptions {
  operation: McpOperationSpecLike;
  input?: Record<string, unknown>;
  argumentOverrides?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called immediately before each MCP tool-call attempt. */
  beforeRequestAttempt?: () => void;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
  };
}

export class McpExtractorClient implements RuntimeClient {
  private readonly integration: ApiIntegrationSpec;
  private readonly cliInputs: Record<string, unknown>;
  private readonly secrets: Record<string, string | undefined>;
  private readonly declaredSecretNames: readonly string[];
  private readonly env: Record<string, string | undefined>;
  private readonly rateLimiter: RateLimiter | null;
  private readonly maxRetries: number;
  private readonly beforeRequestAttempt?: () => void;
  private readonly connectWithCallerSignal: boolean;
  private readonly onResolvedSecret?: (value: string) => void;

  /** Resolved env captured at construction time for consistent reconnection. */
  private readonly resolvedStdioEnv: Record<string, string> | undefined;

  private client: Client;
  private transport: McpTransport | null = null;
  private connectPromise: Promise<void> | null = null;
  private consecutiveFailures = 0;

  constructor(options: McpClientOptions) {
    if (options.integration.transport.type === 'http') {
      throw new Error(
        `Integration "${options.integration.name}" uses HTTP transport. Use ExtractorClient instead.`
      );
    }

    this.integration = options.integration;
    this.cliInputs = options.cliInputs ?? {};
    this.secrets = options.secrets ?? process.env;
    this.declaredSecretNames =
      options.secrets === undefined ? [] : (options.declaredSecretNames ?? []);
    this.env = options.env ?? process.env;
    this.beforeRequestAttempt = options.beforeRequestAttempt;
    this.connectWithCallerSignal = options.connectWithCallerSignal ?? false;
    this.onResolvedSecret = options.onResolvedSecret;
    this.client = new Client({
      name: '@bobsled-inc/extractor',
      version: '0.0.1',
    });

    // Rate limiter from transport config
    const transport = this.integration.transport;
    const rateLimitConfig = 'rate_limit' in transport ? transport.rate_limit : undefined;
    this.rateLimiter =
      options.rateLimiter ??
      (rateLimitConfig
        ? new RateLimiter({
            requestsPerSecond: rateLimitConfig.requests_per_second,
            burst: rateLimitConfig.burst,
          })
        : null);

    // Retry config from transport
    const retryConfig = 'retry' in transport ? transport.retry : undefined;
    this.maxRetries = retryConfig?.max_retries ?? 3;

    // Pre-resolve stdio env at construction time for consistent reconnection
    if (transport.type === 'mcp_stdio' && transport.env) {
      this.resolvedStdioEnv = resolveStdioEnv(
        transport,
        this.env,
        new Set(this.integration.auth_env_vars),
        { secrets: this.secrets, declaredSecretNames: this.declaredSecretNames }
      );
    }
  }

  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.transport) {
      return;
    }

    // Connection establishment is shared by every worker using this pooled
    // client. A caller may stop waiting, but its signal must not tear down the
    // shared producer and fail unrelated workers.
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect(this.connectWithCallerSignal ? signal : undefined);
      void this.connectPromise.catch(() => undefined);
    }
    await waitForCaller(this.connectPromise, signal);
  }

  private async doConnect(signal?: AbortSignal): Promise<void> {
    const transport = await this.createTransport(signal);
    try {
      await this.client.connect(transport, { signal });
      this.transport = transport;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  async close(): Promise<void> {
    // Wait for any in-flight connect() before checking transport state,
    // otherwise close() can return while doConnect() is still running.
    if (this.connectPromise) {
      await this.connectPromise.catch(() => undefined);
    }

    if (!this.transport) {
      return;
    }

    if (this.transport instanceof StreamableHTTPClientTransport) {
      await this.transport.terminateSession().catch(() => undefined);
    }

    // Close via the SDK Client so pending requests are cleanly rejected
    await this.client.close().catch(() => undefined);
    this.transport = null;
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.connect();
    const result = await this.client.listTools();
    return (result.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: (tool as { outputSchema?: unknown }).outputSchema,
      annotations: (tool as { annotations?: McpToolInfo['annotations'] }).annotations,
    }));
  }

  /**
   * Call an MCP tool with built-in retry, rate limiting, and reconnection.
   *
   * Retry lives here (not in extract.ts) so that prefetch calls in
   * mcp-pagination.ts also get retry coverage.
   */
  async callTool(options: McpCallToolOptions): Promise<unknown> {
    try {
      return await this.callToolWithRetry(options);
    } catch (error) {
      throw toExtractorMcpRuntimeError(error, options.signal);
    }
  }

  private async callToolWithRetry(options: McpCallToolOptions): Promise<unknown> {
    options.signal?.throwIfAborted();
    return withRetry(
      async () => {
        options.signal?.throwIfAborted();
        try {
          // Streamable HTTP applies the shared limiter immediately before each
          // actual network fetch. Stdio has one logical attempt per tool call.
          if (this.rateLimiter && this.integration.transport.type === 'mcp_stdio') {
            await this.rateLimiter.acquire(options.signal);
          }

          await this.connect(options.signal);
          options.signal?.throwIfAborted();

          const args = this.resolveToolArguments(options);
          const timeoutMs =
            options.timeoutMs ?? this.integration.transport.timeout_ms ?? DEFAULT_TIMEOUT_MS;

          if (
            this.integration.transport.type === 'mcp_stdio' ||
            this.beforeRequestAttempt === undefined
          ) {
            options.beforeRequestAttempt?.();
          }
          const result = await this.client.callTool(
            {
              name: options.operation.tool.tool_name,
              arguments: args,
            },
            undefined,
            { timeout: timeoutMs, signal: options.signal }
          );

          let data = extractToolResult(result);

          // Apply after_response unwrap hooks from the integration spec
          const afterResponseHooks = this.integration.hooks?.after_response;
          if (afterResponseHooks) {
            for (const hook of afterResponseHooks) {
              data = extractJsonPath(data, hook.unwrap);
            }
          }

          // Reset failure counter on success
          this.consecutiveFailures = 0;
          return data;
        } catch (err) {
          options.signal?.throwIfAborted();
          this.consecutiveFailures += 1;

          if ((err as { retryable?: unknown } | null)?.retryable === false) throw err;

          // On connection/transport errors, recreate client for next retry
          if (isConnectionError(err)) {
            await this.resetClient();
          }

          // Classify and re-throw for withRetry to handle
          const classified = classifyMcpError(err);
          throw classified;
        }
      },
      {
        maxRetries: this.maxRetries,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        signal: options.signal,
      }
    );
  }

  /**
   * Reset the client and transport for reconnection.
   * Recreates the SDK Client instance since it may enter terminal state after close().
   */
  private async resetClient(): Promise<void> {
    await this.close();
    this.transport = null;
    this.connectPromise = null;
    this.client = new Client({
      name: '@bobsled-inc/extractor',
      version: '0.0.1',
    });
  }

  private async createTransport(signal?: AbortSignal): Promise<McpTransport> {
    switch (this.integration.transport.type) {
      case 'mcp_http':
        return await createStreamableHttpTransport(
          this.integration.transport,
          this.env,
          signal,
          this.beforeRequestAttempt,
          this.rateLimiter
            ? async (requestSignal) => await this.rateLimiter!.acquire(requestSignal)
            : undefined,
          this.onResolvedSecret,
          new Set(this.integration.auth_env_vars),
          { secrets: this.secrets, declaredSecretNames: this.declaredSecretNames }
        );
      case 'mcp_stdio':
        return createStdioTransport(
          this.integration.transport,
          this.resolvedStdioEnv,
          this.env,
          new Set(this.integration.auth_env_vars),
          { secrets: this.secrets, declaredSecretNames: this.declaredSecretNames }
        );
      default:
        throw new Error(
          `Unsupported transport type for MCP client: ${this.integration.transport.type}`
        );
    }
  }

  resolveInput(
    schema: McpOperationSpecLike['input'],
    provided: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return resolveOperationInput({ schema, provided: { ...this.cliInputs, ...provided } });
  }

  private resolveToolArguments(options: McpCallToolOptions): Record<string, unknown> | undefined {
    const resolvedInput = this.resolveInput(options.operation.input, options.input);

    const context = {
      env: this.env,
      declaredEnvVars: new Set(this.integration.auth_env_vars),
      input: resolvedInput,
      secrets: this.secrets,
      declaredSecretNames: this.declaredSecretNames,
    };

    let baseArguments: unknown;
    try {
      baseArguments = options.operation.tool.arguments
        ? interpolateValue(options.operation.tool.arguments, context, 'tool.arguments')
        : undefined;
      registerResolvedArgumentSecrets(baseArguments, this.onResolvedSecret);
    } catch (err) {
      // Interpolation failures (missing env/secret vars) are config errors — fail fast, don't retry.
      throw new ExtractorConfigError(
        `Failed to interpolate tool arguments: ${getErrorMessage(err)}`
      );
    }

    const mergedArguments = cloneToolArguments(resolvedInput);
    mergeToolArguments(mergedArguments, baseArguments);
    for (const [path, value] of Object.entries(options.argumentOverrides ?? {})) {
      setNestedValue(mergedArguments, path, value);
    }

    validateToolArgumentValues(mergedArguments);
    return mergedArguments;
  }
}

// --- Tool argument validation ---

const MAX_RESOLVED_ARGUMENT_DEPTH = 10;
const MAX_RESOLVED_ARGUMENT_VALUES = 1_000;

/**
 * Register resolved tool-argument values with the caller's redaction policy.
 * Tool arguments may contain credentials interpolated from env/secrets even
 * when the transport itself has no auth header. Keep traversal bounded because
 * this value originates in a catalog definition supplied by the host.
 */
function registerResolvedArgumentSecrets(
  value: unknown,
  onResolvedSecret: ((value: string) => void) | undefined,
  state: { seen: Set<object>; visited: number } = { seen: new Set(), visited: 0 },
  depth = 0
): void {
  if (
    !onResolvedSecret ||
    depth > MAX_RESOLVED_ARGUMENT_DEPTH ||
    state.visited >= MAX_RESOLVED_ARGUMENT_VALUES
  ) {
    return;
  }
  state.visited += 1;
  if (typeof value === 'string') {
    if (value.length > 0) onResolvedSecret(value);
    return;
  }
  if (!value || typeof value !== 'object' || state.seen.has(value)) return;
  state.seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      registerResolvedArgumentSecrets(item, onResolvedSecret, state, depth + 1);
      if (state.visited >= MAX_RESOLVED_ARGUMENT_VALUES) return;
    }
    return;
  }

  for (const item of Object.values(value)) {
    registerResolvedArgumentSecrets(item, onResolvedSecret, state, depth + 1);
    if (state.visited >= MAX_RESOLVED_ARGUMENT_VALUES) return;
  }
}

/** Recursively check that no string values in tool arguments contain control characters. */
function validateToolArgumentValues(args: Record<string, unknown>, path = 'tool.arguments'): void {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && CONTROL_CHAR_RE.test(value)) {
      throw new ExtractorConfigError(`Tool argument "${path}.${key}" contains control characters`);
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      validateToolArgumentValues(value as Record<string, unknown>, `${path}.${key}`);
    }
  }
}

// --- Tool result helpers ---

function cloneToolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return structuredClone(value) as Record<string, unknown>;
}

function mergeToolArguments(target: Record<string, unknown>, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (BLOCKED_PROTO_KEYS.has(key)) continue; // Prototype pollution guard

    if (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      mergeToolArguments(target[key] as Record<string, unknown>, entry);
      continue;
    }

    target[key] = structuredClone(entry);
  }
}

function extractToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const record = result as Record<string, unknown>;
  if (record['isError'] === true) {
    const cause = new Error(renderToolError(record));
    throw toExtractorRuntimeError({
      kind: 'provider',
      code: 'EXTRACTOR_MCP_TOOL_ERROR',
      operation: 'extractor.mcp.call_tool',
      retryable: false,
      cause,
    });
  }

  if (record['structuredContent'] !== undefined) {
    return record['structuredContent'];
  }

  const content = Array.isArray(record['content']) ? record['content'] : [];
  const parsed = content
    .map((item) => parseToolContentItem(item))
    .filter((item) => item !== undefined);

  if (parsed.length === 0) {
    return null;
  }
  if (parsed.length === 1) {
    return parsed[0];
  }
  return parsed;
}

function renderToolError(result: Record<string, unknown>): string {
  const content = Array.isArray(result['content']) ? result['content'] : [];
  let rendered = '';
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const text = (item as Record<string, unknown>)['text'];
    if (typeof text !== 'string') continue;
    const separator = rendered.length === 0 ? '' : '\n';
    const remaining = MAX_TOOL_ERROR_CHARS - rendered.length - separator.length;
    if (remaining <= 0) break;
    rendered += separator + text.slice(0, remaining);
  }
  if (rendered.length > 0) return rendered;

  return `MCP tool failed: ${getErrorMessage(result)}`.slice(0, MAX_TOOL_ERROR_CHARS);
}

function parseToolContentItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  if (record['type'] === 'text' && typeof record['text'] === 'string') {
    return parseJsonLike(record['text']);
  }

  if (
    record['type'] === 'resource' &&
    record['resource'] &&
    typeof record['resource'] === 'object'
  ) {
    const resource = record['resource'] as Record<string, unknown>;
    if (typeof resource['text'] === 'string') {
      return parseJsonLike(resource['text']);
    }
  }

  // Warn on dropped content items (e.g. image) so operators can debug
  const itemType = typeof record['type'] === 'string' ? record['type'] : 'unknown';
  if (itemType !== 'text' && itemType !== 'resource') {
    process.stderr.write(
      JSON.stringify({
        _v: PROTOCOL_VERSION,
        type: 'LOG',
        level: 'warn',
        message: `MCP content item of type "${itemType}" was dropped (only text and resource types are supported)`,
        time: new Date().toISOString(),
      } satisfies LogMessage) + '\n'
    );
  }

  return undefined;
}

function parseJsonLike(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}
