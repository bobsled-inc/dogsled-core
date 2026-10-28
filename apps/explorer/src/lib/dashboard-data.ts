export interface DashboardIntegrationSummary {
  name: string;
  display_name: string;
  category: string;
  resource_count: number;
  integration_type: string;
}

export interface DashboardModelSummary {
  name: string;
  martCount: number;
}

export interface DashboardIntegrationsResponse {
  integrations?: DashboardIntegrationSummary[];
}

export interface DashboardModelsResponse {
  packages?: DashboardModelSummary[];
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

export function isDashboardIntegrationSummary(
  value: unknown
): value is DashboardIntegrationSummary {
  if (!isObject(value)) {
    return false;
  }

  const entry = value as Partial<DashboardIntegrationSummary>;
  return (
    typeof entry.name === 'string' &&
    typeof entry.display_name === 'string' &&
    typeof entry.category === 'string' &&
    Number.isFinite(entry.resource_count) &&
    typeof entry.integration_type === 'string'
  );
}

export function isDashboardModelSummary(value: unknown): value is DashboardModelSummary {
  if (!isObject(value)) {
    return false;
  }

  const entry = value as Partial<DashboardModelSummary>;
  return typeof entry.name === 'string' && Number.isFinite(entry.martCount);
}

export function parseDashboardIntegrationsResponse(
  value: unknown
): DashboardIntegrationSummary[] | null {
  if (!isObject(value)) {
    return null;
  }

  const integrations = (value as DashboardIntegrationsResponse).integrations;
  return Array.isArray(integrations) && integrations.every(isDashboardIntegrationSummary)
    ? integrations
    : null;
}

export function parseDashboardModelsResponse(value: unknown): DashboardModelSummary[] | null {
  if (!isObject(value)) {
    return null;
  }

  const packages = (value as DashboardModelsResponse).packages;
  return Array.isArray(packages) && packages.every(isDashboardModelSummary) ? packages : null;
}
