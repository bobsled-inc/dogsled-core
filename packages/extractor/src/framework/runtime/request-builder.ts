import { buildApiRequest } from '@bobsled-inc/api-resource';
import type { InputFieldDefinition } from '../core/fields.js';
import { isPrivateHost, resolveAndValidateHost } from '../core/index.js';
import type { HttpRequest } from './http-client.js';
import type { InterpolationContext } from './interpolate.js';
import type { ResolvedApiConfig } from './merge-integration.js';

/** Compatibility export retained for MCP and extractor callers. */
export { resolveOperationInput } from '@bobsled-inc/api-resource';
export { appendQueryParams } from '@bobsled-inc/api-resource';

/**
 * Build the first request for a normal API extraction operation.
 *
 * The pure input/interpolation/URL construction is shared with the
 * catalog-only probe. Extractor-specific DNS and private-host policy remains
 * here because the probe's injected executor owns that policy.
 */
export async function buildOperationRequest(params: {
  api: ResolvedApiConfig;
  inputSchema: Record<string, InputFieldDefinition>;
  providedInput?: Record<string, unknown>;
  context?: Omit<InterpolationContext, 'input'>;
  skipDnsValidation?: boolean;
}): Promise<HttpRequest & { input: Record<string, unknown> }> {
  const planned = buildApiRequest({
    api: params.api,
    inputSchema: params.inputSchema,
    providedInput: params.providedInput,
    context: params.context,
    skipMissingInputQueryParams: true,
    inputMode: 'coerce',
  });

  const resolvedHostname = new URL(planned.url).hostname;
  if (isPrivateHost(resolvedHostname)) {
    throw new Error(`Request to private/internal host "${resolvedHostname}" is blocked`);
  }
  if (!params.skipDnsValidation) {
    await resolveAndValidateHost(resolvedHostname, 'Request URL');
  }

  return {
    url: planned.url,
    method: planned.method,
    ...(planned.response_format ? { response_format: planned.response_format } : {}),
    headers: planned.headers,
    body: planned.body,
    timeout_ms: planned.timeout_ms,
    auth: planned.auth,
    interpolationContext: planned.interpolationContext,
    input: planned.input,
  };
}
