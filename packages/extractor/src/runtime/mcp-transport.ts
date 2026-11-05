/**
 * MCP transport creation — stdio and HTTP with security hardening.
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  RESTRICTED_HEADERS,
  isPrivateHost,
  limitResponseBody,
  resolveAndValidateHost,
  RESPONSE_BODY_LIMITS,
  safeFetch,
} from '../framework/core/index.js';
import { interpolateValue } from '../framework/runtime/index.js';

import type { ApiIntegrationSpec } from '../types/index.js';

import { fetchOAuth2Token, type HostCredentialContext } from './mcp-oauth2.js';

type McpHttpTransportConfig = Extract<ApiIntegrationSpec['transport'], { type: 'mcp_http' }>;
type McpStdioTransportConfig = Extract<ApiIntegrationSpec['transport'], { type: 'mcp_stdio' }>;
type McpTransportAuth = NonNullable<McpHttpTransportConfig['auth']>;
type HeaderMap = Record<string, string>;

/** Regex matching valid HTTP header names (same as SafeHeaderNameSchema). */
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
/** Regex detecting control characters in header values (same as SafeHeaderValueSchema). */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

const APPROVED_NPX_PACKAGE = '@ergut/mcp-bigquery-server@1.0.4';
const APPROVED_UVX_PACKAGE = 'mcp-snowflake-server==0.4.0';
const SAFE_STDIO_OPTION_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ENV_TEMPLATE_RE = /^\$\{\{\s*(?:env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const MCP_RESPONSE_HEADER_TIMEOUT_MS = 30_000;

/** Env vars safe to inherit in stdio child processes. */
const ALLOWED_INHERITED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'TERM',
  'NODE_ENV',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'LC_ALL',
  'LC_CTYPE',
]);

/** Keys that must never be passed to stdio child processes, even from spec env. */
const BLOCKED_ENV_KEYS = new Set(['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS']);
const APPROVED_STDIO_ENV_KEYS: Readonly<Record<'npx' | 'uvx', ReadonlySet<string>>> = {
  npx: new Set(['GOOGLE_APPLICATION_CREDENTIALS']),
  uvx: new Set([
    'SNOWFLAKE_ACCOUNT',
    'SNOWFLAKE_USER',
    'SNOWFLAKE_PASSWORD',
    'SNOWFLAKE_WAREHOUSE',
    'SNOWFLAKE_DATABASE',
    'SNOWFLAKE_SCHEMA',
  ]),
};

// --- Post-interpolation validation helpers ---

function validateResolvedHeaderName(name: string, context: string): void {
  if (!HEADER_NAME_RE.test(name)) {
    throw new Error(
      `Resolved header name "${name}" (from ${context}) is not a valid HTTP header name.`
    );
  }
  if (RESTRICTED_HEADERS.includes(name.toLowerCase() as (typeof RESTRICTED_HEADERS)[number])) {
    throw new Error(
      `Resolved header name "${name}" (from ${context}) is a restricted HTTP header.`
    );
  }
}

function validateResolvedHeaderValue(value: string, context: string): void {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`Resolved header value for "${context}" contains control characters.`);
  }
}

// --- Transport factories ---

export async function createStreamableHttpTransport(
  transport: McpHttpTransportConfig,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  beforeRequestAttempt?: () => void,
  beforeNetworkRequest?: (signal: AbortSignal) => Promise<void>,
  onResolvedSecret?: (value: string) => void,
  declaredEnvVars: ReadonlySet<string> = new Set(),
  hostSecrets: HostCredentialContext = {}
): Promise<StreamableHTTPClientTransport> {
  signal?.throwIfAborted();
  const url = new URL(transport.url);
  if (isPrivateHost(url.hostname)) {
    throw new Error(`MCP HTTP URL "${url.hostname}" targets a private or internal host.`);
  }

  // DNS pre-resolution to mitigate DNS rebinding
  await resolveAndValidateHost(url.hostname, 'MCP HTTP URL');
  signal?.throwIfAborted();

  const headers: HeaderMap = {};

  if (transport.headers) {
    for (const [key, value] of Object.entries(transport.headers)) {
      const resolved = String(
        interpolateValue(
          value,
          { ...hostSecrets, env, declaredEnvVars },
          `transport.headers.${key}`
        )
      );
      validateResolvedHeaderName(key, `transport.headers.${key}`);
      validateResolvedHeaderValue(resolved, `transport.headers.${key}`);
      headers[key] = resolved;
    }
  }

  if (transport.auth) {
    await applyMcpAuth(
      headers,
      transport.auth,
      env,
      signal,
      beforeRequestAttempt,
      beforeNetworkRequest,
      onResolvedSecret,
      declaredEnvVars,
      hostSecrets
    );
  }
  for (const value of Object.values(headers)) onResolvedSecret?.(value);
  signal?.throwIfAborted();

  const boundedMcpFetch: typeof globalThis.fetch = async (input, init) => {
    const headerController = new AbortController();
    const requestSignal = AbortSignal.any(
      [init?.signal, signal, headerController.signal].filter(
        (candidate): candidate is AbortSignal => candidate !== undefined
      )
    );
    const timer = setTimeout(() => headerController.abort(), MCP_RESPONSE_HEADER_TIMEOUT_MS);
    let response: Response;
    try {
      await beforeNetworkRequest?.(requestSignal);
      beforeRequestAttempt?.();
      response = await safeFetch(input, { ...init, signal: requestSignal });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`MCP HTTP redirect blocked: ${response.status} ${response.statusText}`);
    }

    const isEventStream =
      response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
    return limitResponseBody(
      response,
      isEventStream ? RESPONSE_BODY_LIMITS.mcpEvent : RESPONSE_BODY_LIMITS.mcpJson,
      isEventStream ? 'MCP SSE event' : 'MCP HTTP response',
      { resetAtSseEventBoundary: isEventStream }
    );
  };

  return new StreamableHTTPClientTransport(url, {
    fetch: boundedMcpFetch,
    requestInit: {
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      redirect: 'error', // Prevent redirect-based SSRF
    },
  });
}

async function applyMcpAuth(
  headers: HeaderMap,
  auth: McpTransportAuth,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  beforeRequestAttempt?: () => void,
  beforeNetworkRequest?: (signal: AbortSignal) => Promise<void>,
  onResolvedSecret?: (value: string) => void,
  declaredEnvVars: ReadonlySet<string> = new Set(),
  hostSecrets: HostCredentialContext = {}
): Promise<void> {
  switch (auth.type) {
    case 'none':
      return;

    case 'bearer': {
      const token = String(
        interpolateValue(
          auth.token,
          { ...hostSecrets, env, declaredEnvVars },
          'transport.auth.token'
        )
      );
      validateResolvedHeaderValue(token, 'transport.auth.token');
      onResolvedSecret?.(token);
      headers['Authorization'] = `Bearer ${token}`;
      return;
    }

    case 'api-key': {
      const headerName = String(
        interpolateValue(
          auth.header,
          { ...hostSecrets, env, declaredEnvVars },
          'transport.auth.header'
        )
      );
      const key = String(
        interpolateValue(auth.key, { ...hostSecrets, env, declaredEnvVars }, 'transport.auth.key')
      );
      // Re-validate after interpolation since ${{ env.X }} may resolve to a restricted name
      validateResolvedHeaderName(headerName, 'transport.auth.header');
      validateResolvedHeaderValue(key, 'transport.auth.key');
      onResolvedSecret?.(key);
      headers[headerName] = key;
      return;
    }

    case 'oauth2': {
      const token = await fetchOAuth2Token(
        auth,
        env,
        signal,
        beforeRequestAttempt,
        beforeNetworkRequest,
        declaredEnvVars,
        hostSecrets
      );
      onResolvedSecret?.(token);
      headers['Authorization'] = `Bearer ${token}`;
      return;
    }

    default: {
      const _exhaustive: never = auth;
      throw new Error(`Unsupported MCP auth type: ${(_exhaustive as McpTransportAuth).type}`);
    }
  }
}

/**
 * Resolve env vars for stdio child process.
 * Uses allowlist approach: only safe system vars + spec-declared vars.
 */
export function resolveStdioEnv(
  transport: McpStdioTransportConfig,
  env: Record<string, string | undefined>,
  declaredEnvVars: ReadonlySet<string> = new Set(),
  hostSecrets: HostCredentialContext = {}
): Record<string, string> {
  validateStdioCommandShape(transport.command, transport.args ?? []);

  // Allowlist: only pass safe env vars to child process
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ALLOWED_INHERITED_ENV_KEYS.has(key)) {
      baseEnv[key] = value;
    }
  }

  // Spec env overrides — also filter blocklist
  if (transport.env) {
    const allowedKeys =
      transport.command === 'npx' ? APPROVED_STDIO_ENV_KEYS.npx : APPROVED_STDIO_ENV_KEYS.uvx;
    const unexpectedKey = Object.keys(transport.env).find(
      (key) => !BLOCKED_ENV_KEYS.has(key) && !allowedKeys.has(key)
    );
    if (unexpectedKey) {
      throw new Error(
        `MCP stdio env key "${unexpectedKey}" is not allowed for ${transport.command}.`
      );
    }
    const specEnv = Object.fromEntries(
      Object.entries(transport.env)
        .filter(([key]) => !BLOCKED_ENV_KEYS.has(key))
        .map(([key, value]) => [
          key,
          String(
            interpolateValue(
              value,
              { ...hostSecrets, env, declaredEnvVars },
              `transport.env.${key}`
            )
          ),
        ])
    );
    return { ...baseEnv, ...specEnv };
  }

  return baseEnv;
}

export function createStdioTransport(
  transport: McpStdioTransportConfig,
  resolvedEnv: Record<string, string> | undefined,
  interpolationEnv: Record<string, string | undefined> = resolvedEnv ?? {},
  declaredEnvVars: ReadonlySet<string> = new Set(),
  hostSecrets: HostCredentialContext = {}
): StdioClientTransport {
  const command = transport.command;
  if (command.includes('/') || command.includes('\\')) {
    throw new Error(
      `MCP stdio command "${command}" must not contain path separators. Use a bare command name.`
    );
  }
  const rawArgs = transport.args ?? [];
  validateStdioCommandShape(command, rawArgs);
  const resolvedArgs = resolveApprovedStdioArgs(
    command,
    rawArgs,
    interpolationEnv,
    declaredEnvVars,
    hostSecrets
  );
  validateStdioCommandShape(command, resolvedArgs);

  return new StdioClientTransport({
    command: transport.command,
    args: resolvedArgs,
    env: resolvedEnv,
    stderr: 'pipe',
  });
}

function resolveApprovedStdioArgs(
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  declaredEnvVars: ReadonlySet<string>,
  hostSecrets: HostCredentialContext
): string[] {
  const resolvedArgs = [...args];
  if (command !== 'npx') {
    return resolvedArgs;
  }

  resolvedArgs[3] = resolveWholeEnvTemplate(
    args[3]!,
    '--project',
    env,
    declaredEnvVars,
    hostSecrets
  );
  resolvedArgs[5] = resolveWholeEnvTemplate(
    args[5]!,
    '--location',
    env,
    declaredEnvVars,
    hostSecrets
  );
  return resolvedArgs;
}

function resolveWholeEnvTemplate(
  value: string,
  option: '--project' | '--location',
  env: Record<string, string | undefined>,
  declaredEnvVars: ReadonlySet<string>,
  hostSecrets: HostCredentialContext
): string {
  const match = value.match(ENV_TEMPLATE_RE);
  if (!match) {
    return value;
  }
  const envName = match[1]!;
  const resolved = String(
    interpolateValue(value, {
      ...hostSecrets,
      env,
      declaredEnvVars,
      allowProcessEnvFallback: false,
    })
  );
  if (resolved === undefined || resolved.length === 0) {
    throw new Error(`MCP stdio ${option} requires environment variable "${envName}".`);
  }
  return resolved;
}

/**
 * The stdio surface is intentionally a registry of exact, reviewed command
 * shapes rather than a generic executable allowlist. Interpreter flags
 * (`node -e`, `python -c`), package-runner options (`npx --package`), mutable
 * package versions, and container mounts all turn a command-name allowlist into
 * arbitrary code execution.
 */
function validateStdioCommandShape(command: string, args: readonly string[]): void {
  if (command === 'npx') {
    validateBigQueryNpxArgs(args);
    return;
  }
  if (command === 'uvx') {
    if (args.length === 1 && args[0] === APPROVED_UVX_PACKAGE) {
      return;
    }
    throw new Error(
      `MCP stdio uvx arguments are not allowed. Expected exactly: ${APPROVED_UVX_PACKAGE}`
    );
  }
  throw new Error(
    `MCP stdio command "${command}" is not allowed. Allowed commands: npx and uvx with approved pinned package arguments.`
  );
}

function validateBigQueryNpxArgs(args: readonly string[]): void {
  if (
    args.length !== 6 ||
    args[0] !== '-y' ||
    args[1] !== APPROVED_NPX_PACKAGE ||
    args[2] !== '--project' ||
    args[4] !== '--location'
  ) {
    throw new Error(
      `MCP stdio npx arguments are not allowed. Expected exactly: -y ${APPROVED_NPX_PACKAGE} --project <value> --location <value>`
    );
  }

  assertSafeStdioOptionValue(args[3]!, '--project');
  assertSafeStdioOptionValue(args[5]!, '--location');
}

function assertSafeStdioOptionValue(value: string, option: '--project' | '--location'): void {
  if (!SAFE_STDIO_OPTION_VALUE_RE.test(value) && !ENV_TEMPLATE_RE.test(value)) {
    throw new Error(
      `MCP stdio ${option} value is not allowed. Use a simple identifier or a whole env template.`
    );
  }
}
