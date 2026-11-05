import {
  isPrivateHost,
  readResponseTextWithLimit,
  resolveAndValidateHost,
  RESPONSE_BODY_LIMITS,
  safeFetch,
  SafeHeaderValueSchema,
} from '@bobsled-inc/extractor/core';
import {
  InterpolationError,
  interpolateString,
  interpolateValue,
} from '@bobsled-inc/extractor/runtime';
import { interpolateUrl } from '@bobsled-inc/api-resource';
import { ZodError } from 'zod';

import type { Action } from '../action-registry.js';
import type { ActionResult, ExecuteOptions } from '../action-executor.js';
import { createReferenceCollector, describeActionRequest } from '../action-preview-request.js';
import {
  classifyTransportError,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  mapStatusToError,
  toActionResultError,
} from './shared.js';

export interface WebhookTransportDeps {
  fetch?: typeof globalThis.fetch;
  checkHost?: typeof isPrivateHost;
  resolveHost?: typeof resolveAndValidateHost;
  timeoutMs?: number;
}

const OPTIONAL_BODY_TOKEN_RE = /^\s*\$\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;
const WEBHOOK_VALIDATION_ERROR_PREFIXES = [
  'Action timeoutMs',
  'Undeclared environment variable:',
  'Request to private/internal host',
  'Webhook URL must use HTTPS',
] as const;

type InterpolatedBodyResult = { omitted: true } | { omitted: false; value: unknown };

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function classifyWebhookValidationError(error: unknown):
  | {
      code: 'validation_error';
      message: string;
      retryable: false;
    }
  | undefined {
  if (error instanceof ZodError) {
    return {
      code: 'validation_error',
      message: formatZodError(error),
      retryable: false,
    };
  }

  if (error instanceof InterpolationError) {
    return {
      code: 'validation_error',
      message: error.message,
      retryable: false,
    };
  }

  if (error instanceof TypeError && error.message === 'Invalid URL') {
    return {
      code: 'validation_error',
      message: 'Webhook URL is invalid after interpolation',
      retryable: false,
    };
  }

  if (
    error instanceof Error &&
    WEBHOOK_VALIDATION_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix))
  ) {
    return {
      code: 'validation_error',
      message: error.message,
      retryable: false,
    };
  }

  return undefined;
}

function interpolateWebhookBody(
  template: unknown,
  context: {
    input: Record<string, unknown>;
    env: Record<string, string | undefined>;
    secrets: Record<string, string | undefined>;
  },
  path: string
): InterpolatedBodyResult {
  if (typeof template === 'string') {
    try {
      return {
        omitted: false,
        value: interpolateValue(template, context, path),
      };
    } catch (error) {
      const wholeToken = template.match(OPTIONAL_BODY_TOKEN_RE);
      if (
        error instanceof InterpolationError &&
        wholeToken &&
        error.source === 'input' &&
        error.key === wholeToken[1]
      ) {
        return { omitted: true };
      }
      throw error;
    }
  }

  if (Array.isArray(template)) {
    const values: unknown[] = [];
    for (const [index, value] of template.entries()) {
      const result = interpolateWebhookBody(value, context, `${path}[${index}]`);
      if (!result.omitted) {
        values.push(result.value);
      }
    }
    if (template.length > 0 && values.length === 0) {
      return { omitted: true };
    }
    return {
      omitted: false,
      value: values,
    };
  }

  if (template && typeof template === 'object') {
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(template)) {
      const result = interpolateWebhookBody(child, context, `${path}.${key}`);
      if (!result.omitted) {
        value[key] = result.value;
      }
    }
    if (Object.keys(template).length > 0 && Object.keys(value).length === 0) {
      return { omitted: true };
    }
    return {
      omitted: false,
      value,
    };
  }

  return {
    omitted: false,
    value: template,
  };
}

async function readClientErrorBody(response: Response): Promise<string | undefined> {
  if (response.status < 400 || response.status > 499) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  try {
    return await readResponseTextWithLimit(
      response,
      RESPONSE_BODY_LIMITS.error,
      'Webhook error response'
    );
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
}

function interpolatedHeaderValues(
  templates: Record<string, string>,
  headers: Record<string, string>
): string[] {
  return Object.entries(headers)
    .filter(([key, value]) => templates[key] !== undefined && templates[key] !== value)
    .map(([, value]) => value);
}

/** Executes a webhook-backed action with interpolation, timeout, and SSRF protections. */
export async function executeWebhookAction(
  action: Action,
  inputs: Record<string, unknown>,
  options?: ExecuteOptions,
  deps?: WebhookTransportDeps
): Promise<ActionResult> {
  const attemptedAt = new Date().toISOString();
  const startedAt = Date.now();

  if (action.spec.transport !== 'webhook') {
    return {
      status: 'failed',
      action: action.qualifiedName,
      transport: action.transport,
      attempted_at: attemptedAt,
      duration_ms: Date.now() - startedAt,
      error: {
        code: 'unknown',
        message: `Action "${action.qualifiedName}" is not a webhook action.`,
        retryable: false,
      },
    };
  }

  try {
    options?.signal?.throwIfAborted();
    const requestSecrets = options?.secrets ?? process.env;
    const collector = createReferenceCollector();
    const context = {
      input: inputs,
      env: requestSecrets,
      declaredEnvVars: new Set(action.spec.auth_env_vars),
      secrets: requestSecrets,
      declaredSecretNames: options?.secrets === undefined ? [] : options.declaredSecretNames,
      trustedCredentialNames: new Set(
        options?.secrets === undefined ? [] : options.declaredSecretNames
      ),
      onReference: collector.onReference,
    };

    const url = interpolateUrl(action.spec.webhook.url, context, 'webhook.url', interpolateString);
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`Webhook URL must use HTTPS; received ${parsedUrl.protocol}`);
    }

    const checkHost = deps?.checkHost ?? isPrivateHost;
    if (checkHost(parsedUrl.hostname)) {
      throw new Error(`Request to private/internal host "${parsedUrl.hostname}" is blocked`);
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(action.spec.webhook.headers)) {
      const resolvedValue = interpolateString(value, context, `webhook.headers.${key}`);
      headers[key] = SafeHeaderValueSchema.parse(resolvedValue);
    }

    const bodyResult =
      action.spec.webhook.request_body === undefined
        ? undefined
        : interpolateWebhookBody(action.spec.webhook.request_body, context, 'webhook.request_body');
    const body = bodyResult?.omitted ? undefined : bodyResult?.value;

    if (
      body !== undefined &&
      !Object.keys(headers).some((header) => header.toLowerCase() === 'content-type')
    ) {
      headers['Content-Type'] = 'application/json';
    }

    if (options?.dryRun) {
      return {
        status: 'skipped',
        action: action.qualifiedName,
        transport: action.transport,
        attempted_at: attemptedAt,
        duration_ms: Date.now() - startedAt,
        preview: {
          action: action.qualifiedName,
          operation: action.spec.webhook.method,
          target_host: parsedUrl.hostname,
          input_fields: Object.keys(inputs),
          effect: action.description,
          request: describeActionRequest({
            method: action.spec.webhook.method,
            references: collector.references,
            inputs,
          }),
        },
      };
    }

    const requestedTimeoutMs = options?.limits?.timeoutMs;
    if (
      requestedTimeoutMs !== undefined &&
      (!Number.isSafeInteger(requestedTimeoutMs) ||
        requestedTimeoutMs <= 0 ||
        requestedTimeoutMs > 60_000)
    ) {
      throw new Error('Action timeoutMs must be between 1 and 60000.');
    }
    const resolveHost = deps?.resolveHost ?? resolveAndValidateHost;
    await resolveHost(parsedUrl.hostname, 'Webhook URL');

    const fetchFn = deps?.fetch ?? safeFetch;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      requestedTimeoutMs ?? deps?.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS
    );
    const signal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let response: Response;
    let providerBody: string | undefined;
    try {
      response = await fetchFn(url, {
        method: action.spec.webhook.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal,
      });
      providerBody = await readClientErrorBody(response);
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        status: 'failed',
        action: action.qualifiedName,
        transport: action.transport,
        attempted_at: attemptedAt,
        duration_ms: Date.now() - startedAt,
        error: toActionResultError(
          {
            ...mapStatusToError(response.status),
            message: `Webhook request failed: ${response.status} ${response.statusText}`,
            providerStatus: response.status,
            ...(providerBody !== undefined ? { providerBody } : {}),
          },
          options,
          action.spec.auth_env_vars,
          interpolatedHeaderValues(action.spec.webhook.headers, headers)
        ),
      };
    }

    return {
      status: 'success',
      action: action.qualifiedName,
      transport: action.transport,
      attempted_at: attemptedAt,
      duration_ms: Date.now() - startedAt,
    };
  } catch (error) {
    if (options?.signal?.aborted) {
      return {
        status: 'failed',
        action: action.qualifiedName,
        transport: action.transport,
        attempted_at: attemptedAt,
        duration_ms: Date.now() - startedAt,
        error: { code: 'cancelled', message: 'Action was cancelled.', retryable: false },
      };
    }
    const normalized = classifyWebhookValidationError(error) ?? classifyTransportError(error);
    return {
      status: 'failed',
      action: action.qualifiedName,
      transport: action.transport,
      attempted_at: attemptedAt,
      duration_ms: Date.now() - startedAt,
      error: toActionResultError(normalized, options, action.spec.auth_env_vars),
    };
  }
}
