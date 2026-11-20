import { collectEnvironmentReferences } from '@bobsled-inc/protocol';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { isFileCopyResource } from '../framework/extractor/index.js';
import type { HttpApiResourceSpec, IntegrationSpec, ResourceSpec } from '../types/index.js';
import type { CheckFinding } from './check-diff.js';
import { CommandError } from './common.js';
import { normalizeForEachConfig } from '../runtime/for-each.js';
import {
  buildFilterWindows,
  getFilterIncrementalConfig,
  inferCursorKindFromOutput,
} from '../runtime/filter-incremental.js';

export type Severity = 'error' | 'warn' | 'info';

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
export const ENV_TEMPLATE_RE = /\$\{\{\s*(?:env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface VerifyFinding {
  severity: Severity;
  integration: string;
  resource?: string;
  code: string;
  message: string;
  field?: string;
}

export interface VerifyIntegrationResult {
  integration: string;
  resourcesChecked: number;
  mockResourcesChecked: number;
  mockFixturesChecked: number;
  findings: VerifyFinding[];
  openApiChecked: boolean;
}

export interface VerifyOptions {
  checkEnv?: boolean;
  format?: 'text' | 'json';
  mock?: boolean;
  openapi?: string;
  severity?: Severity;
}

export function parseSeverity(value: string | undefined): Severity {
  switch (value) {
    case 'error':
    case 'warn':
    case 'info':
      return value;
    default:
      throw new CommandError(`Invalid severity "${value}". Must be one of: error, warn, info.`);
  }
}

export function severityAtOrAbove(finding: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[finding] <= SEVERITY_ORDER[threshold];
}

export function getNestedValue(value: unknown, dotPath: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  let current: unknown = value;
  for (const segment of dotPath.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function appendFinding(
  findings: VerifyFinding[],
  integration: string,
  severity: Severity,
  code: string,
  message: string,
  resource?: string,
  field?: string
): void {
  findings.push({ severity, integration, resource, code, message, field });
}

export function parseMetaFile(filePath: string): Record<string, unknown> | null {
  try {
    return (parseYaml(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown> | null) ?? null;
  } catch {
    return null;
  }
}

export function collectEnvRefs(content: string): Set<string> {
  const refs = new Set<string>();
  for (const match of content.matchAll(ENV_TEMPLATE_RE)) {
    const key = match[1];
    if (key) refs.add(key);
  }
  return refs;
}

export function getPaginationPageSizeParam(
  pagination: HttpApiResourceSpec['extract']['pagination'] | undefined
): string | null {
  if (
    !pagination ||
    pagination.type === 'none' ||
    pagination.type === 'link_header' ||
    pagination.type === 'cursor' ||
    pagination.type === 'next_url' ||
    pagination.type === 'mcp_cursor' ||
    pagination.type === 'mcp_offset' ||
    pagination.type === 'mcp_page_number'
  ) {
    return null;
  }

  if (pagination.type === 'offset') {
    return pagination.limit_param ?? 'limit';
  }

  return pagination.per_page_param ?? 'per_page';
}

export type MockFilterOverrides = {
  sinceOverride?: string;
  untilOverride?: string;
};

function formatFilterOverrideValue(
  ms: number,
  valueFormat: 'iso8601' | 'date' | 'unix_seconds' | 'unix_milliseconds'
): string {
  switch (valueFormat) {
    case 'iso8601':
      return new Date(ms).toISOString();
    case 'date':
      return new Date(ms).toISOString().slice(0, 10);
    case 'unix_seconds':
      return String(Math.floor(ms / 1000));
    case 'unix_milliseconds':
      return String(Math.floor(ms));
  }
}

export function resolveMockFilterOverrides(
  resource: HttpApiResourceSpec,
  fixtureInput: Record<string, unknown>,
  now: Date
): MockFilterOverrides {
  const filterConfig = getFilterIncrementalConfig(resource);
  if (!filterConfig) {
    return {};
  }

  const cursorKind =
    resource.extract.incremental?.cursor_type ??
    inferCursorKindFromOutput(resource, resource.extract.incremental?.cursor_field);
  if (!cursorKind || cursorKind === 'lsn') {
    return {};
  }

  const explicitSince =
    filterConfig.since_argument &&
    (typeof fixtureInput[filterConfig.since_argument] === 'string' ||
      typeof fixtureInput[filterConfig.since_argument] === 'number')
      ? String(fixtureInput[filterConfig.since_argument])
      : undefined;
  const explicitUntil =
    filterConfig.until_argument &&
    (typeof fixtureInput[filterConfig.until_argument] === 'string' ||
      typeof fixtureInput[filterConfig.until_argument] === 'number')
      ? String(fixtureInput[filterConfig.until_argument])
      : undefined;

  if (explicitSince !== undefined || explicitUntil !== undefined) {
    return {
      ...(explicitSince !== undefined ? { sinceOverride: explicitSince } : {}),
      ...(explicitUntil !== undefined ? { untilOverride: explicitUntil } : {}),
    };
  }

  if (filterConfig.window_size_seconds && filterConfig.until_argument) {
    const valueFormat = filterConfig.value_format ?? 'iso8601';
    const untilMs = now.getTime();
    const sinceMs = Math.max(0, untilMs - filterConfig.window_size_seconds * 1000);

    return {
      sinceOverride: formatFilterOverrideValue(sinceMs, valueFormat),
      untilOverride: formatFilterOverrideValue(untilMs, valueFormat),
    };
  }

  const windows = buildFilterWindows({
    config: filterConfig,
    cursorKind,
    now,
  });
  const firstWindow = windows[0];
  if (!firstWindow) {
    return {};
  }

  const sinceArgument = filterConfig.since_argument ?? filterConfig.filter_argument;
  const sinceValue = sinceArgument ? firstWindow.params[sinceArgument] : undefined;
  const untilValue = filterConfig.until_argument
    ? firstWindow.params[filterConfig.until_argument]
    : undefined;

  return {
    ...(sinceValue !== undefined ? { sinceOverride: String(sinceValue) } : {}),
    ...(untilValue !== undefined ? { untilOverride: String(untilValue) } : {}),
  };
}

/**
 * Env vars a self-describing source declares inline via `source.yml`
 * `auth_env_vars`. For `custom_api` sources this stands in for the meta.yml
 * `auth_setup` block, so referenced `${{ env.X }}` tokens validate without one.
 */
function getSourceAuthEnvVars(integrationSpec: IntegrationSpec): Set<string> {
  const refs = new Set<string>();
  const authEnvVars = (integrationSpec as { auth_env_vars?: unknown }).auth_env_vars;
  if (!Array.isArray(authEnvVars)) return refs;
  for (const entry of authEnvVars) {
    if (typeof entry === 'string') refs.add(entry);
  }
  return refs;
}

function specTransports(integrationSpec: IntegrationSpec): unknown[] {
  if ('transports' in integrationSpec) return integrationSpec.transports;
  if ('transport' in integrationSpec) return [integrationSpec.transport];
  return [];
}

/**
 * Env vars referenced ONLY by a transport's `optional_headers`. Such a header is
 * dropped when its variable is absent, so the variable is supplied by the
 * executing host per request rather than configured as a credential: it needs
 * no `auth_setup` entry and its absence is not a finding. A variable that any
 * required field also references keeps its required-credential diagnostics.
 */
export function collectOptionalOnlyEnvRefs(integrationSpec: IntegrationSpec): Set<string> {
  const optional = new Set<string>();
  const required = new Set<string>();
  for (const transport of specTransports(integrationSpec)) {
    if (typeof transport !== 'object' || transport === null) continue;
    const { optional_headers: optionalHeaders, ...rest } = transport as {
      optional_headers?: unknown;
    };
    for (const ref of collectEnvRefs(JSON.stringify(rest))) required.add(ref);
    if (typeof optionalHeaders !== 'object' || optionalHeaders === null) continue;
    for (const value of Object.values(optionalHeaders)) {
      if (typeof value !== 'string') continue;
      for (const ref of collectEnvRefs(value)) optional.add(ref);
    }
  }
  const {
    transports: _transports,
    transport: _transport,
    ...remainder
  } = integrationSpec as {
    transports?: unknown;
    transport?: unknown;
  };
  for (const ref of collectEnvRefs(JSON.stringify(remainder))) required.add(ref);
  for (const ref of required) optional.delete(ref);
  return optional;
}

export function collectIntegrationStructuralFindings(
  integrationName: string,
  integrationSpec: IntegrationSpec,
  integrationRaw: string,
  meta: Record<string, unknown> | null
): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const declaredEnvVars = new Set<string>();
  for (const envVar of getSourceAuthEnvVars(integrationSpec)) {
    declaredEnvVars.add(envVar);
  }
  const usedEnvVars = new Set([
    ...collectEnvRefs(integrationRaw),
    ...collectEnvironmentReferences(integrationSpec),
  ]);

  for (const envVar of usedEnvVars) {
    if (!declaredEnvVars.has(envVar)) {
      appendFinding(
        findings,
        integrationName,
        'error',
        'MISSING_AUTH_SETUP',
        `Integration references env var "${envVar}" but auth_env_vars does not declare it. Add it to auth_env_vars`
      );
    }
  }

  const docsUrl = meta?.['docs_url'];
  if (typeof docsUrl !== 'string') {
    appendFinding(
      findings,
      integrationName,
      'warn',
      'MISSING_DOCS_URL',
      'meta.yml is missing docs_url'
    );
  } else if (!docsUrl.startsWith('https://')) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'INSECURE_DOCS_URL',
      `docs_url must use HTTPS: ${docsUrl}`
    );
  }

  if ('transport' in integrationSpec && integrationSpec.transport.type === 'http') {
    const baseUrl = integrationSpec.transport.base_url;
    if (!baseUrl.startsWith('https://')) {
      appendFinding(
        findings,
        integrationName,
        'error',
        'INSECURE_BASE_URL',
        `transport.base_url must use HTTPS: ${baseUrl}`
      );
    }
  }

  return findings;
}

export function collectResourceQualityFindings(
  integrationName: string,
  resourceFile: string,
  resource: ResourceSpec,
  rawContent: string
): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const resourceName = resource.name;
  const output = 'output' in resource ? resource.output : undefined;
  const extract = 'extract' in resource ? resource.extract : undefined;
  const table = extract?.table;

  if (rawContent.includes('# REVIEW:')) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'REVIEW_MARKER',
      'Spec still contains a # REVIEW: annotation',
      resourceName
    );
  }

  if (!resource.description || !String(resource.description).trim()) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MISSING_DESCRIPTION',
      'Resource description must be non-empty',
      resourceName
    );
  }

  // `integration` is an optional self-description. First-class v2 resources
  // (under source.yml) omit it and bind via `via:` / source name, so only flag
  // a mismatch when the resource actually declares an integration.
  if (resource.integration !== undefined && resource.integration !== integrationName) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'INTEGRATION_MISMATCH',
      `Resource declares integration "${resource.integration}" but lives under "${integrationName}"`,
      resourceName
    );
  }

  // A copy moves files as they are, so it has no columns and no key.
  const hasColumns = !isFileCopyResource(resource);

  if (hasColumns && (!output || Object.keys(output).length === 0)) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MISSING_OUTPUT',
      'Resource must define at least one output field',
      resourceName
    );
  }

  if (hasColumns && (!table?.primary_key || table.primary_key.length === 0)) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'MISSING_PRIMARY_KEY',
      'Resource must define extract.table.primary_key',
      resourceName
    );
  }

  if (path.extname(resourceFile) !== '.yml' && path.extname(resourceFile) !== '.yaml') {
    appendFinding(
      findings,
      integrationName,
      'warn',
      'UNEXPECTED_EXTENSION',
      `Unexpected resource file extension for ${path.basename(resourceFile)}`,
      resourceName
    );
  }

  return findings;
}

export function collectDuplicateEndpointFindings(
  integrationName: string,
  resources: HttpApiResourceSpec[]
): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const seen = new Map<string, string>();

  for (const resource of resources) {
    const endpoint = resource.api.endpoint;
    const method = resource.api.method.toUpperCase();
    if (method === 'POST' && endpoint.endsWith('/graphql')) continue;

    const sortedQueryParams = resource.api.query_params
      ? Object.fromEntries(
          Object.entries(resource.api.query_params).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : undefined;
    const requestBody = resource.api.request_body as Record<string, unknown> | undefined;
    const requestQuery =
      method === 'POST' && typeof requestBody?.['query'] === 'string'
        ? requestBody['query']
        : undefined;
    const key = JSON.stringify({
      method,
      endpoint,
      queryParams: sortedQueryParams,
      requestQuery,
    });
    const first = seen.get(key);
    if (first) {
      appendFinding(
        findings,
        integrationName,
        'error',
        'DUPLICATE_ENDPOINT',
        `Resources "${first}" and "${resource.name}" hit the same effective endpoint ${method}:${endpoint}`,
        resource.name
      );
      continue;
    }
    seen.set(key, resource.name);
  }

  return findings;
}

export function collectForEachDependencyFindings(
  integrationName: string,
  resources: HttpApiResourceSpec[]
): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const resourceNames = new Set(resources.map((resource) => resource.name));

  for (const resource of resources) {
    const input = resource.input;
    const forEach = normalizeForEachConfig(resource.extract.for_each);
    const endpoint = resource.api.endpoint;
    const requiredInputs = Object.entries(input).filter(([, config]) => config.required === true);
    if (requiredInputs.length > 1) continue;

    for (const [inputName] of requiredInputs) {
      const inputPattern = `\\$\\{\\{\\s*input\\.${inputName}\\s*\\}\\}`;
      const pathParamRegex = new RegExp(inputPattern + '/.+');
      if (!pathParamRegex.test(endpoint)) continue;

      const stem = inputName.replace(/_(id|token|key)$/, '');
      const siblingCandidates = [stem, `${stem}s`, `${stem}es`];
      const hasSibling = siblingCandidates.some(
        (candidate) => resourceNames.has(candidate) && candidate !== resource.name
      );
      if (!hasSibling) continue;

      if (!forEach) {
        appendFinding(
          findings,
          integrationName,
          'error',
          'MISSING_FOR_EACH',
          `Required input "${inputName}" has a sibling parent resource but no for_each mapping`,
          resource.name,
          inputName
        );
        continue;
      }

      if (!forEach.bindings.some((binding) => binding.input === inputName)) {
        appendFinding(
          findings,
          integrationName,
          'error',
          'INVALID_FOR_EACH',
          `for_each must bind required input "${inputName}"`,
          resource.name,
          inputName
        );
      }
    }
  }

  return findings;
}

export function convertCheckFinding(integration: string, finding: CheckFinding): VerifyFinding {
  return {
    severity: finding.severity,
    integration,
    resource: finding.resource,
    code: finding.code,
    message: finding.message,
    field: finding.field,
  };
}

export function isSuppressedFinding(
  resource: ResourceSpec | undefined,
  finding: VerifyFinding
): boolean {
  if (!resource || !('verify' in resource) || !resource.verify?.suppress?.length) {
    return false;
  }

  return resource.verify.suppress.includes(finding.code);
}
