import { resolveOperationInput } from '@bobsled-inc/extractor/runtime';
import type { ProjectIndex } from '@bobsled-inc/project-index';
import { CommandError } from '@bobsled-inc/protocol';

import { executeApiAction } from './transports/api.js';
import { executeWebhookAction } from './transports/webhook.js';

import type { Action } from './action-registry.js';
import type { IntegrationSpec } from '@bobsled-inc/extractor/extractor';
import type { CustomTokenStore } from '@bobsled-inc/extractor/runtime';

export type ActionErrorCode =
  | 'validation_error'
  | 'auth_error'
  | 'permission_denied'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'server_error'
  | 'network_error'
  | 'unknown';

export interface ActionResult {
  status: 'success' | 'failed' | 'skipped';
  action: string;
  transport: Action['transport'];
  target_record_id?: string;
  attempted_at: string;
  duration_ms: number;
  preview?: ActionPreview;
  error?: {
    code: ActionErrorCode;
    message: string;
    retryable: boolean;
    /** HTTP status of the provider response, when the failure came from one. */
    provider_status?: number;
    /**
     * Error prose from a JSON 4xx provider response, at most 300 characters, with
     * credentials and URL query strings redacted. Present even with `safeErrors`.
     */
    provider_message?: string;
  };
}

export interface ActionPreview {
  action: string;
  integration?: string;
  operation: string;
  target_host: string;
  input_fields: string[];
  effect: string;
  /** Where the dry run would send each input. Carries no input or secret values. */
  request?: ActionPreviewRequest;
}

/** A request location a template sends an input to. `other` is any location Dogsled does not classify. */
export type ActionInputLocation =
  | 'auth'
  | 'base_url'
  | 'body'
  | 'header'
  | 'origin'
  | 'other'
  | 'path'
  | 'query';

export interface ActionPreviewRequest {
  method: string;
  /**
   * The pathname the request is sent to, with each input reference as `{name}`
   * and every other reference as `{source.name}`: a relative endpoint appended to
   * the base URL's pathname, or an absolute endpoint's own pathname, normalized
   * as URL parsing does. Absent when it cannot be known without values, and for
   * webhook actions.
   */
  path_template?: string;
  /** The locations each input reaches through a template, in first-use order. Unreferenced inputs are absent. */
  input_locations: Record<string, ActionInputLocation[]>;
  /** Locations that receive the whole input object through `${{ input }}` or `${{ mapped }}`. */
  whole_input_locations: ActionInputLocation[];
}

export interface ActionExecutionLimits {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ExecuteOptions {
  dryRun?: boolean;
  /** Project whose integrations an API action may use; found from the working directory when omitted. */
  projectRoot?: string;
  /** Prebuilt index of `projectRoot`, so an execution does not rescan the project. */
  index?: ProjectIndex;
  resolvedIntegration?: IntegrationSpec;
  secrets?: Record<string, string | undefined>;
  declaredSecretNames?: readonly string[];
  signal?: AbortSignal;
  limits?: ActionExecutionLimits;
  /** Replace transport details with a stable message for server responses. */
  safeErrors?: boolean;
  /** Host store that shares minted custom tokens across workers. */
  customTokenStore?: CustomTokenStore;
}

export type ValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string };

function assertNeverTransport(value: never): never {
  throw new CommandError(`Unknown transport: ${String(value)}`);
}

/** Validates user-provided inputs against an action's declared input schema. */
export function validateInputs(action: Action, inputs: Record<string, unknown>): ValidationResult {
  try {
    return {
      success: true,
      data: resolveOperationInput({
        schema: action.inputs,
        provided: inputs,
      }),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Executes an action after validating inputs and routing to the matching transport. */
export async function executeAction(
  action: Action,
  inputs: Record<string, unknown>,
  options?: ExecuteOptions
): Promise<ActionResult> {
  const validationResult = validateInputs(action, inputs);
  if (!validationResult.success) {
    return {
      status: 'failed',
      action: action.qualifiedName,
      transport: action.transport,
      attempted_at: new Date().toISOString(),
      duration_ms: 0,
      error: {
        code: 'validation_error',
        message: validationResult.error,
        retryable: false,
      },
    };
  }

  switch (action.transport) {
    case 'api':
      return executeApiAction(action, validationResult.data, options);
    case 'webhook':
      return executeWebhookAction(action, validationResult.data, options);
    default:
      return assertNeverTransport(action.transport);
  }
}
