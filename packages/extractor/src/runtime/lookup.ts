/**
 * Programmatic lookup for extractor resources.
 */

import { ExtractorClient } from './client.js';
import { McpExtractorClient } from './mcp-client.js';
import { extractRecords, mapOutput, withOutputContext } from './response-mapper.js';
import { buildApiIntegrationSpec } from './api-integration-spec.js';
import { ExtractorConfigError } from './errors.js';
import {
  hasFanOutOutputOrigin,
  isSourceSpec,
  isSqlTransport,
  resolveVia,
  type OutputFieldDefinition,
} from '../framework/core/index.js';
import type { AuthorizeBillableResource } from './billable-authorization.js';
import type { CustomTokenStore } from '../framework/runtime/index.js';
import {
  EMPTY_FAN_OUT_CONTEXT,
  buildTargetedFanOutContext,
  normalizeForEachConfig,
  type FanOutContext,
} from './for-each.js';
import type { JsonObject } from '@bobsled-inc/protocol';

import type {
  ApiIntegrationSpec,
  ApiResourceSpec,
  IntegrationSpec,
  LookupOnlyApiResourceSpec,
  ResourceSpec,
} from '../types/index.js';

const DEFAULT_MAX_RECORDS = 1;
const HARD_MAX_RECORDS = 1;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const HARD_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_MAX_NETWORK_REQUESTS = 3;
const HARD_MAX_NETWORK_REQUESTS = 3;

type LookupResourceSpec = (ApiResourceSpec | LookupOnlyApiResourceSpec) & {
  lookup: NonNullable<ApiResourceSpec['lookup']>;
};

export interface LookupResourceLimits {
  maxRecords?: number;
  maxResultBytes?: number;
  maxNetworkRequests?: number;
}

export interface LookupResourceOptions {
  integration: IntegrationSpec;
  resource: ResourceSpec;
  input?: Record<string, unknown>;
  secrets?: Record<string, string | undefined>;
  declaredSecretNames?: readonly string[];
  signal?: AbortSignal;
  limits?: LookupResourceLimits;
  authorizeBillable?: AuthorizeBillableResource;
  /** Host store that shares minted custom tokens across workers. */
  customTokenStore?: CustomTokenStore;
}

export async function lookupResource(params: LookupResourceOptions): Promise<JsonObject[]> {
  params.signal?.throwIfAborted();
  const { input } = params;
  const resource = asLookupResource(params.resource);
  const integration = resolveLookupIntegration(params.integration, resource);
  const limits = resolveLookupLimits(params.limits);
  const beforeRequestAttempt = createNetworkRequestGuard(limits.maxNetworkRequests);
  const output = resource.lookup.output ?? resource.output;
  const fanOutContext = resolveLookupFanOutContext(resource, input ?? {}, output);

  if (resource.billing) {
    const approved = await params.authorizeBillable?.({
      operation: 'lookup',
      resource,
      billing: resource.billing,
      maxNetworkRequests: limits.maxNetworkRequests,
    });
    if (approved !== true) {
      throw new ExtractorConfigError(
        `Resource "${resource.name}" is billable and requires explicit authorization before lookup.`
      );
    }
  }

  const isMcp =
    integration.transport.type === 'mcp_http' || integration.transport.type === 'mcp_stdio';

  if (isMcp) {
    const lookupTool = resource.lookup.tool;
    if (!lookupTool) {
      throw new Error(`MCP resource "${resource.name}" lookup must define a "tool" block.`);
    }

    const client = new McpExtractorClient({
      integration,
      ...(params.secrets !== undefined
        ? {
            secrets: params.secrets,
            env: params.secrets,
            declaredSecretNames: params.declaredSecretNames,
          }
        : {}),
    });
    try {
      await client.connect(params.signal);
      const data = await client.callTool({
        operation: {
          input: resource.lookup.input,
          tool: lookupTool,
        },
        input,
        beforeRequestAttempt,
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      });

      const recordPath = resource.lookup.extract?.record_path ?? '$';
      const records = extractRecords(data, recordPath).map((raw) =>
        mapOutput(withOutputContext(raw, input), output, undefined, fanOutContext)
      );
      assertLookupResultWithinLimits(records, limits);
      return records;
    } finally {
      await client.close();
    }
  }

  // HTTP lookup
  if (!resource.lookup.api) {
    throw new Error(
      `Resource "${resource.name}" lookup must define an "api" block for HTTP integrations.`
    );
  }

  const client = new ExtractorClient({
    integration,
    ...(params.secrets !== undefined
      ? {
          secrets: params.secrets,
          env: params.secrets,
          declaredSecretNames: params.declaredSecretNames,
        }
      : {}),
    ...(params.customTokenStore ? { customTokenStore: params.customTokenStore } : {}),
  });

  try {
    const response = await client.request({
      operation: {
        api: resource.lookup.api,
        input: resource.lookup.input,
      },
      input,
      beforeRequestAttempt,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });

    const recordPath = resource.lookup.extract?.record_path ?? '$';
    const records = extractRecords(response.data, recordPath).map((raw) =>
      mapOutput(withOutputContext(raw, input), output, undefined, fanOutContext)
    );
    assertLookupResultWithinLimits(records, limits);
    return records;
  } finally {
    await client.close();
  }
}

function resolveLookupFanOutContext(
  resource: LookupResourceSpec,
  input: Record<string, unknown>,
  output: Record<string, OutputFieldDefinition>
): FanOutContext {
  if (!hasFanOutOutputOrigin(output)) return EMPTY_FAN_OUT_CONTEXT;
  if (!('extract' in resource) || !resource.extract) {
    throw new ExtractorConfigError(
      `lookupResource() cannot resolve contextual outputs for lookup-only resource "${resource.name}".`
    );
  }
  const forEach = normalizeForEachConfig(resource.extract.for_each);
  if (!forEach) {
    throw new ExtractorConfigError(
      `lookupResource() cannot resolve contextual outputs for "${resource.name}" without extract.for_each.`
    );
  }
  try {
    return buildTargetedFanOutContext(resource, forEach, input, output);
  } catch (error) {
    throw new ExtractorConfigError(
      `lookupResource() cannot prove fan-out context for "${resource.name}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function asLookupResource(resource: ResourceSpec): LookupResourceSpec {
  if (!('lookup' in resource) || !resource.lookup) {
    throw new ExtractorConfigError(
      `Resource "${resource.name}" does not define a lookup operation.`
    );
  }
  if ('source' in resource && resource.source !== undefined) {
    throw new ExtractorConfigError('lookupResource() only supports API and MCP Resources.');
  }
  return resource as LookupResourceSpec;
}

function resolveLookupIntegration(
  integration: IntegrationSpec,
  resource: LookupResourceSpec
): ApiIntegrationSpec {
  if (isSourceSpec(integration)) {
    const transport = resolveVia(integration, resource.via);
    if (isSqlTransport(transport)) {
      throw new ExtractorConfigError(
        `lookupResource() cannot use SQL transport for Resource "${resource.name}".`
      );
    }
    return buildApiIntegrationSpec(integration, transport);
  }

  if (!('transport' in integration)) {
    throw new ExtractorConfigError('lookupResource() only supports API and MCP Integrations.');
  }
  if (
    integration.transport.type !== 'http' &&
    integration.transport.type !== 'mcp_http' &&
    integration.transport.type !== 'mcp_stdio'
  ) {
    throw new ExtractorConfigError('lookupResource() only supports API and MCP Integrations.');
  }
  return integration as ApiIntegrationSpec;
}

function resolveLookupLimits(
  limits: LookupResourceLimits | undefined
): Required<LookupResourceLimits> {
  const maxRecords = limits?.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxResultBytes = limits?.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const maxNetworkRequests = limits?.maxNetworkRequests ?? DEFAULT_MAX_NETWORK_REQUESTS;
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0 || maxRecords > HARD_MAX_RECORDS) {
    throw new ExtractorConfigError(`lookupResource() maxRecords must be 1.`);
  }
  if (
    !Number.isSafeInteger(maxResultBytes) ||
    maxResultBytes <= 0 ||
    maxResultBytes > HARD_MAX_RESULT_BYTES
  ) {
    throw new ExtractorConfigError(
      `lookupResource() maxResultBytes must be between 1 and ${HARD_MAX_RESULT_BYTES}.`
    );
  }
  if (
    !Number.isSafeInteger(maxNetworkRequests) ||
    maxNetworkRequests <= 0 ||
    maxNetworkRequests > HARD_MAX_NETWORK_REQUESTS
  ) {
    throw new ExtractorConfigError(
      `lookupResource() maxNetworkRequests must be between 1 and ${HARD_MAX_NETWORK_REQUESTS}.`
    );
  }
  return { maxRecords, maxResultBytes, maxNetworkRequests };
}

function createNetworkRequestGuard(maxNetworkRequests: number): () => void {
  let networkRequests = 0;
  return () => {
    if (networkRequests >= maxNetworkRequests) {
      throw new ExtractorConfigError(
        `lookupResource() exceeded the network request limit of ${maxNetworkRequests}.`
      );
    }
    networkRequests += 1;
  };
}

function assertLookupResultWithinLimits(
  records: JsonObject[],
  limits: Required<LookupResourceLimits>
): void {
  if (records.length > limits.maxRecords) {
    throw new ExtractorConfigError(
      `lookupResource() response exceeds the record limit of ${limits.maxRecords}.`
    );
  }
  const resultBytes = Buffer.byteLength(JSON.stringify(records), 'utf8');
  if (resultBytes > limits.maxResultBytes) {
    throw new ExtractorConfigError(
      `lookupResource() response exceeds the result-size limit of ${limits.maxResultBytes} bytes.`
    );
  }
}
