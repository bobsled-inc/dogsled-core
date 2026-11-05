import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  entryFilePath,
  findNamedEntry,
  resolveProjectIndex,
  type ProjectIndex,
} from '@bobsled-inc/project-index';

import YAML from 'yaml';
import {
  ExtractorClient,
  ExtractorDataError,
  buildApiIntegrationSpec,
  extractJsonPath,
  mapFields,
} from '@bobsled-inc/extractor';
import { buildOperationRequest, mergeIntegrationOperation } from '@bobsled-inc/extractor/runtime';
import type { HttpTransportConfig } from '@bobsled-inc/extractor/core';
import { isSourceSpec, isSqlTransport, resolveVia } from '@bobsled-inc/extractor/core';
import { IntegrationSpecSchema } from '@bobsled-inc/extractor/extractor';
import { getIntegrationsDir } from '@bobsled-inc/integrations';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';

import type { ApiIntegrationSpec, IntegrationSpec } from '@bobsled-inc/extractor/extractor';
import type { InterpolationMappedValues } from '@bobsled-inc/extractor/runtime';

import type { Action } from '../action-registry.js';
import type { ActionResult, ExecuteOptions } from '../action-executor.js';
import { resolveActionProjectRoot } from '../action-paths.js';
import { createReferenceCollector, describeActionRequest } from '../action-preview-request.js';
import { classifyTransportError, toActionResultError } from './shared.js';

interface ApiClientLike {
  request(options: {
    operation: {
      api: Record<string, unknown>;
      input: Record<string, unknown>;
    };
    input?: Record<string, unknown>;
    context?: {
      mapped?: InterpolationMappedValues;
    };
    signal?: AbortSignal;
    responseBodyLimitBytes?: number;
  }): Promise<{
    data: unknown;
    headers: Headers;
    status: number;
  }>;
  close?(): Promise<void>;
}

type HttpApiActionIntegration = Omit<ApiIntegrationSpec, 'transport'> & {
  transport: HttpTransportConfig;
};

const MAX_INTEGRATION_SPEC_SIZE = 1_024 * 1_024;

function createValidationFailureResult(params: {
  action: Action;
  attemptedAt: string;
  startedAt: number;
  message: string;
}): ActionResult {
  return {
    status: 'failed',
    action: params.action.qualifiedName,
    transport: params.action.transport,
    attempted_at: params.attemptedAt,
    duration_ms: Date.now() - params.startedAt,
    error: {
      code: 'validation_error',
      message: params.message,
      retryable: false,
    },
  };
}

export interface ApiTransportDeps {
  createClient?: (
    integration: HttpApiActionIntegration,
    options?: {
      secrets?: Record<string, string | undefined>;
      declaredSecretNames?: readonly string[];
      env?: Record<string, string | undefined>;
      onResolvedSecret?: (value: string) => void;
    }
  ) => ApiClientLike;
  loadIntegration?: (name: string) => HttpApiActionIntegration;
  buildRequest?: typeof buildOperationRequest;
}

const MAX_ACTION_TIMEOUT_MS = 60_000;
const MAX_ACTION_RESPONSE_BYTES = 1024 * 1024;

function resolveHttpIntegration(
  action: Action,
  options: ExecuteOptions | undefined,
  deps: ApiTransportDeps | undefined
): HttpApiActionIntegration {
  const configured = options?.resolvedIntegration;
  const integration: IntegrationSpec =
    configured ??
    (
      deps?.loadIntegration ??
      ((name: string) => loadApiIntegration(name, options?.projectRoot, options?.index))
    )(action.spec.transport === 'api' ? action.spec.integration : '');

  if (action.spec.transport !== 'api') {
    throw new Error(`Action "${action.qualifiedName}" is not an API action.`);
  }
  if (integration.name !== action.spec.integration) {
    throw new Error(
      `Resolved Integration "${integration.name}" does not match Action Integration "${action.spec.integration}".`
    );
  }

  if (isSourceSpec(integration)) {
    const transport = resolveVia(integration);
    if (isSqlTransport(transport) || transport.type !== 'http') {
      throw new Error(
        `Integration "${integration.name}" does not use the HTTP transport required for API actions.`
      );
    }
    return buildApiIntegrationSpec(integration, transport) as HttpApiActionIntegration;
  }

  if (!('transport' in integration) || integration.transport.type !== 'http') {
    throw new Error(
      `Integration "${integration.name}" does not use the HTTP transport required for API actions.`
    );
  }
  return integration as HttpApiActionIntegration;
}

function actionRequestSignal(options: ExecuteOptions | undefined): AbortSignal | undefined {
  const timeoutMs = options?.limits?.timeoutMs;
  if (timeoutMs === undefined) return options?.signal;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_ACTION_TIMEOUT_MS) {
    throw new ExtractorDataError(
      `Action timeoutMs must be between 1 and ${MAX_ACTION_TIMEOUT_MS}.`
    );
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = options?.signal;
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

function actionResponseLimit(options: ExecuteOptions | undefined): number | undefined {
  const maxBytes = options?.limits?.maxResponseBytes;
  if (maxBytes === undefined) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ACTION_RESPONSE_BYTES) {
    throw new ExtractorDataError(
      `Action maxResponseBytes must be between 1 and ${MAX_ACTION_RESPONSE_BYTES}.`
    );
  }
  return maxBytes;
}

function extractTargetRecordId(data: unknown, resultPath: string): string | undefined {
  const value = extractJsonPath(data, resultPath);
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const candidate of ['id', 'Id']) {
      if (typeof record[candidate] === 'string' || typeof record[candidate] === 'number') {
        return String(record[candidate]);
      }
    }
  }

  return undefined;
}

/**
 * The project integration whose declared `name` matches, wherever it lives,
 * else the bundled integration of that name.
 */
function readApiIntegration(
  name: string,
  project: ProjectIndex
): { filePath: string; raw: unknown } {
  const local = findNamedEntry(project, 'integration', name);
  if (local) return { filePath: entryFilePath(project, local), raw: local.document };

  const bundledFile = join(getIntegrationsDir(), name, 'integration.yml');
  if (!existsSync(bundledFile)) {
    throw new Error(`Integration "${name}" not found in local or bundled integrations.`);
  }
  const stats = statSync(bundledFile);
  if (stats.size > MAX_INTEGRATION_SPEC_SIZE) {
    throw new Error(`Integration spec ${bundledFile} exceeds maximum size of 1 MB`);
  }
  return { filePath: bundledFile, raw: YAML.parse(readFileSync(bundledFile, 'utf-8')) as unknown };
}

function loadApiIntegration(
  name: string,
  projectRoot?: string,
  index?: ProjectIndex
): HttpApiActionIntegration {
  const project = resolveProjectIndex(projectRoot ?? resolveActionProjectRoot(), index);
  const { filePath, raw } = readApiIntegration(name, project);
  const parsed = IntegrationSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      formatSpecValidationMessage('integration', filePath, parsed.error, {
        schema: IntegrationSpecSchema,
      })
    );
  }

  const integration = parsed.data;
  if (!('transport' in integration) || integration.transport.type !== 'http') {
    throw new Error(
      `Integration "${name}" does not use the HTTP transport required for API actions.`
    );
  }

  return integration as HttpApiActionIntegration;
}

/** Executes an API-backed action by validating inputs, mapping fields, and issuing the request. */
export async function executeApiAction(
  action: Action,
  inputs: Record<string, unknown>,
  options?: ExecuteOptions,
  deps?: ApiTransportDeps
): Promise<ActionResult> {
  const attemptedAt = new Date().toISOString();
  const startedAt = Date.now();

  if (action.spec.transport !== 'api') {
    return {
      status: 'failed',
      action: action.qualifiedName,
      transport: action.transport,
      attempted_at: attemptedAt,
      duration_ms: Date.now() - startedAt,
      error: {
        code: 'unknown',
        message: `Action "${action.qualifiedName}" is not an API action.`,
        retryable: false,
      },
    };
  }

  let mapped: InterpolationMappedValues;
  let integration: HttpApiActionIntegration | undefined;
  const sentValues = new Set<string>();
  try {
    options?.signal?.throwIfAborted();
    integration = resolveHttpIntegration(action, options, deps);
    try {
      mapped = mapFields(action.spec.field_mapping, inputs);
    } catch (error) {
      if (error instanceof ExtractorDataError) {
        return {
          status: 'failed',
          action: action.qualifiedName,
          transport: action.transport,
          attempted_at: attemptedAt,
          duration_ms: Date.now() - startedAt,
          error: {
            code: 'validation_error',
            message: error.message,
            retryable: false,
          },
        };
      }
      throw error;
    }
    const buildRequest = deps?.buildRequest ?? buildOperationRequest;
    const mergedApi = mergeIntegrationOperation(integration, action.spec.api);

    let previewRequest: Awaited<ReturnType<typeof buildOperationRequest>>;
    const collector = createReferenceCollector();
    try {
      const requestSecrets = options?.secrets ?? process.env;
      previewRequest = await buildRequest({
        api: mergedApi,
        inputSchema: action.spec.input,
        providedInput: inputs,
        context: {
          mapped,
          env: requestSecrets,
          declaredEnvVars: new Set(integration.auth_env_vars),
          secrets: requestSecrets,
          declaredSecretNames: options?.secrets === undefined ? [] : options.declaredSecretNames,
          trustedCredentialNames: new Set(
            options?.secrets === undefined ? [] : options.declaredSecretNames
          ),
          onReference: collector.onReference,
        },
        skipDnsValidation: true,
      });
    } catch (error) {
      return createValidationFailureResult({
        action,
        attemptedAt,
        startedAt,
        message: error instanceof Error ? error.message : String(error),
      });
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
          integration: action.spec.integration,
          operation: action.spec.activate.operation,
          target_host: new URL(previewRequest.url).hostname,
          input_fields: Object.keys(inputs),
          effect: action.description,
          request: describeActionRequest({
            method: mergedApi.method,
            endpoint: action.spec.api.endpoint,
            baseUrl: mergedApi.base_url,
            references: collector.references,
            fieldMapping: action.spec.field_mapping,
            inputs,
          }),
        },
      };
    }

    const createClient =
      deps?.createClient ??
      ((resolvedIntegration: ApiIntegrationSpec, clientOptions) =>
        new ExtractorClient({ integration: resolvedIntegration, ...clientOptions }));
    const client = createClient(integration, {
      ...(options?.secrets !== undefined && {
        secrets: options.secrets,
        env: options.secrets,
        declaredSecretNames: options.declaredSecretNames,
      }),
      onResolvedSecret: (value) => sentValues.add(value),
    });
    let response: Awaited<ReturnType<ApiClientLike['request']>>;
    try {
      const signal = actionRequestSignal(options);
      const responseBodyLimitBytes = actionResponseLimit(options);
      response = await client.request({
        operation: {
          api: action.spec.api,
          input: action.spec.input,
        },
        input: inputs,
        context: {
          mapped,
        },
        ...(signal !== undefined ? { signal } : {}),
        ...(responseBodyLimitBytes !== undefined ? { responseBodyLimitBytes } : {}),
      });
    } finally {
      await client.close?.();
    }

    return {
      status: 'success',
      action: action.qualifiedName,
      transport: action.transport,
      target_record_id: extractTargetRecordId(response.data, action.spec.activate.result_path),
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
    const normalized =
      error instanceof ExtractorDataError
        ? { code: 'validation_error' as const, message: error.message, retryable: false as const }
        : classifyTransportError(error, /API request failed: (\d{3})/);
    return {
      status: 'failed',
      action: action.qualifiedName,
      transport: action.transport,
      attempted_at: attemptedAt,
      duration_ms: Date.now() - startedAt,
      error: toActionResultError(normalized, options, integration?.auth_env_vars, sentValues),
    };
  }
}
