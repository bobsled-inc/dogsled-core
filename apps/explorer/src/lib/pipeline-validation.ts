export interface IntegrationValidationResult {
  name: string;
  valid: boolean;
  missingVars: string[];
  resourcesFound: string[];
  unknownResources: string[];
}

export interface PipelineValidationResult {
  valid: boolean;
  destinationValid: boolean;
  destinationType: string;
  scheduleValid: boolean;
  scheduleMessage: string;
  integrations: IntegrationValidationResult[];
  errors: string[];
  warnings: string[];
}

function isIntegrationValidationResult(value: unknown): value is IntegrationValidationResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    name?: unknown;
    valid?: unknown;
    missingVars?: unknown;
    resourcesFound?: unknown;
    unknownResources?: unknown;
  };
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.valid === 'boolean' &&
    Array.isArray(candidate.missingVars) &&
    candidate.missingVars.every((entry) => typeof entry === 'string') &&
    Array.isArray(candidate.resourcesFound) &&
    candidate.resourcesFound.every((entry) => typeof entry === 'string') &&
    Array.isArray(candidate.unknownResources) &&
    candidate.unknownResources.every((entry) => typeof entry === 'string')
  );
}

export function isPipelineValidationResult(value: unknown): value is PipelineValidationResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    valid?: unknown;
    destinationValid?: unknown;
    destinationType?: unknown;
    scheduleValid?: unknown;
    scheduleMessage?: unknown;
    integrations?: unknown;
    errors?: unknown;
    warnings?: unknown;
  };
  return (
    typeof candidate.valid === 'boolean' &&
    typeof candidate.destinationValid === 'boolean' &&
    typeof candidate.destinationType === 'string' &&
    typeof candidate.scheduleValid === 'boolean' &&
    typeof candidate.scheduleMessage === 'string' &&
    Array.isArray(candidate.integrations) &&
    candidate.integrations.every(isIntegrationValidationResult) &&
    Array.isArray(candidate.errors) &&
    candidate.errors.every((entry) => typeof entry === 'string') &&
    Array.isArray(candidate.warnings) &&
    candidate.warnings.every((entry) => typeof entry === 'string')
  );
}
