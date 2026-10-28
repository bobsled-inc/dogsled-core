import { listQueryResources, loadQueryableResourceSpecs } from './catalog.js';

import type { QueryOperator } from '@bobsled-inc/extractor/extractor';

export const QUERY_ENUM_ALIGNMENT_SCHEMA_VERSION = 1;

export type QueryEnumAlignmentFindingSeverity = 'error' | 'warning';

export type QueryEnumAlignmentFindingCode =
  | 'duplicate_query_enum_literal'
  | 'query_enum_literal_not_string_for_provider_enum'
  | 'query_enum_literal_not_in_provider_input_enum'
  | 'query_enum_without_provider_input_enum';

export interface QueryEnumAlignmentBoundInput {
  operator: QueryOperator;
  input: string;
  providerEnum?: string[];
}

export interface QueryEnumAlignmentCheck {
  integration: string;
  resource: string;
  field: string;
  enum: Array<string | number | boolean>;
  boundInputs: QueryEnumAlignmentBoundInput[];
  providerBacked: boolean;
}

export interface QueryEnumAlignmentFinding {
  severity: QueryEnumAlignmentFindingSeverity;
  code: QueryEnumAlignmentFindingCode;
  integration: string;
  resource: string;
  field: string;
  operator?: QueryOperator;
  input?: string;
  literal?: string | number | boolean;
  message: string;
}

export interface QueryEnumAlignmentFixtureCoverage {
  positiveFixtures: number;
  providerRejectionFixtures: number;
  note: string;
}

export interface QueryEnumAlignmentSummary {
  queryResourcesChecked: number;
  queryEnumFiltersChecked: number;
  providerBackedEnumFilters: number;
  manualEnumFilters: number;
  errors: number;
  warnings: number;
}

export interface QueryEnumAlignmentReport {
  schemaVersion: typeof QUERY_ENUM_ALIGNMENT_SCHEMA_VERSION;
  summary: QueryEnumAlignmentSummary;
  fixtureCoverage: QueryEnumAlignmentFixtureCoverage;
  checks: QueryEnumAlignmentCheck[];
  findings: QueryEnumAlignmentFinding[];
}

interface QueryEnumAlignmentResourceInput {
  type?: string;
  enum?: string[];
  items?: QueryEnumAlignmentResourceInput;
}

interface QueryEnumAlignmentFilter {
  operators: QueryOperator[];
  enum?: Array<string | number | boolean>;
  bind: Partial<
    Record<
      QueryOperator,
      {
        input: string;
      }
    >
  >;
}

interface QueryEnumAlignmentResource {
  input: Record<string, QueryEnumAlignmentResourceInput | undefined>;
  query?: {
    filters?: Record<string, QueryEnumAlignmentFilter | undefined>;
  };
  test?: {
    fixtures?: Array<{
      expect?: Record<string, unknown>;
    }>;
  };
}

export function auditQueryEnumAlignment(): QueryEnumAlignmentReport {
  const checks: QueryEnumAlignmentCheck[] = [];
  const findings: QueryEnumAlignmentFinding[] = [];
  const fixtureCoverage: QueryEnumAlignmentFixtureCoverage = {
    positiveFixtures: 0,
    providerRejectionFixtures: 0,
    note: 'No first-class provider-rejection fixture schema exists yet; this guard enforces static provider input enum subset checks and should be extended when recorded rejection fixtures are added.',
  };

  const queryResources = listQueryResources();
  for (const summary of queryResources) {
    const loaded = loadQueryableResourceSpecs(summary.integration, summary.resource);
    if (!loaded) {
      continue;
    }

    const analysis = analyzeQueryEnumAlignmentResource({
      integration: summary.integration,
      resource: summary.resource,
      spec: loaded.resource,
    });
    checks.push(...analysis.checks);
    findings.push(...analysis.findings);
    fixtureCoverage.positiveFixtures += countPositiveFixtures(loaded.resource);
    fixtureCoverage.providerRejectionFixtures += countProviderRejectionFixtures(loaded.resource);
  }

  checks.sort(compareChecks);
  findings.sort(compareFindings);

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  const providerBackedEnumFilters = checks.filter((check) => check.providerBacked).length;

  return {
    schemaVersion: QUERY_ENUM_ALIGNMENT_SCHEMA_VERSION,
    summary: {
      queryResourcesChecked: queryResources.length,
      queryEnumFiltersChecked: checks.length,
      providerBackedEnumFilters,
      manualEnumFilters: checks.length - providerBackedEnumFilters,
      errors,
      warnings,
    },
    fixtureCoverage,
    checks,
    findings,
  };
}

export function analyzeQueryEnumAlignmentResource(params: {
  integration: string;
  resource: string;
  spec: QueryEnumAlignmentResource;
}): Pick<QueryEnumAlignmentReport, 'checks' | 'findings'> {
  const checks: QueryEnumAlignmentCheck[] = [];
  const findings: QueryEnumAlignmentFinding[] = [];

  for (const [fieldName, filter] of Object.entries(params.spec.query?.filters ?? {})) {
    if (!filter?.enum) {
      continue;
    }

    const boundInputs = collectBoundInputs(filter, params.spec);
    const providerBacked = boundInputs.some((input) => input.providerEnum !== undefined);

    checks.push({
      integration: params.integration,
      resource: params.resource,
      field: fieldName,
      enum: [...filter.enum],
      boundInputs,
      providerBacked,
    });

    for (const finding of findDuplicateEnumLiterals(params, fieldName, filter.enum)) {
      findings.push(finding);
    }

    if (!providerBacked) {
      findings.push({
        severity: 'warning',
        code: 'query_enum_without_provider_input_enum',
        integration: params.integration,
        resource: params.resource,
        field: fieldName,
        message: `${params.integration}.${params.resource}.${fieldName} declares a query enum, but none of its bound provider inputs declare an enum; static validation cannot prove provider acceptance without rejection fixtures.`,
      });
      continue;
    }

    for (const boundInput of boundInputs) {
      if (!boundInput.providerEnum) {
        continue;
      }

      for (const literal of filter.enum) {
        if (typeof literal !== 'string') {
          findings.push({
            severity: 'error',
            code: 'query_enum_literal_not_string_for_provider_enum',
            integration: params.integration,
            resource: params.resource,
            field: fieldName,
            operator: boundInput.operator,
            input: boundInput.input,
            literal,
            message: `${params.integration}.${params.resource}.${fieldName} enum literal ${formatLiteral(literal)} is not a string, but bound input "${boundInput.input}" declares a string provider enum.`,
          });
          continue;
        }

        if (!boundInput.providerEnum.includes(literal)) {
          findings.push({
            severity: 'error',
            code: 'query_enum_literal_not_in_provider_input_enum',
            integration: params.integration,
            resource: params.resource,
            field: fieldName,
            operator: boundInput.operator,
            input: boundInput.input,
            literal,
            message: `${params.integration}.${params.resource}.${fieldName} enum literal ${formatLiteral(literal)} is not accepted by bound input "${boundInput.input}".`,
          });
        }
      }
    }
  }

  return { checks, findings };
}

export function renderQueryEnumAlignmentReport(
  report: QueryEnumAlignmentReport = auditQueryEnumAlignment()
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function collectBoundInputs(
  filter: QueryEnumAlignmentFilter | undefined,
  spec: QueryEnumAlignmentResource
): QueryEnumAlignmentBoundInput[] {
  if (!filter) {
    return [];
  }

  const boundInputs: QueryEnumAlignmentBoundInput[] = [];
  for (const operator of filter.operators) {
    const binding = filter.bind[operator];
    if (!binding) {
      continue;
    }

    const inputField = spec.input[binding.input];
    const providerEnum = providerEnumForInput(operator, inputField);
    boundInputs.push({
      operator,
      input: binding.input,
      ...(providerEnum ? { providerEnum } : {}),
    });
  }

  return boundInputs.sort(
    (left, right) =>
      left.operator.localeCompare(right.operator) || left.input.localeCompare(right.input)
  );
}

function providerEnumForInput(
  operator: QueryOperator,
  inputField: QueryEnumAlignmentResourceInput | undefined
): string[] | undefined {
  if (!inputField) return undefined;
  if (operator === 'in' && inputField.type === 'array') {
    return inputField.items?.enum ? [...inputField.items.enum] : undefined;
  }
  return inputField.enum ? [...inputField.enum] : undefined;
}

function findDuplicateEnumLiterals(
  params: { integration: string; resource: string },
  fieldName: string,
  enumValues: Array<string | number | boolean>
): QueryEnumAlignmentFinding[] {
  const seen = new Set<string>();
  const findings: QueryEnumAlignmentFinding[] = [];

  for (const literal of enumValues) {
    const key = formatLiteral(literal);
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }

    findings.push({
      severity: 'error',
      code: 'duplicate_query_enum_literal',
      integration: params.integration,
      resource: params.resource,
      field: fieldName,
      literal,
      message: `${params.integration}.${params.resource}.${fieldName} declares duplicate query enum literal ${key}.`,
    });
  }

  return findings;
}

function countPositiveFixtures(spec: QueryEnumAlignmentResource): number {
  return (spec.test?.fixtures?.length ?? 0) - countProviderRejectionFixtures(spec);
}

function countProviderRejectionFixtures(spec: QueryEnumAlignmentResource): number {
  return (
    spec.test?.fixtures?.filter((fixture) => {
      const expected = fixture.expect;
      if (!expected) {
        return false;
      }

      const status = expected['status'] ?? expected['status_code'] ?? expected['http_status'];
      return (
        expected['error'] === true ||
        expected['provider_rejection'] === true ||
        (typeof status === 'number' && status >= 400)
      );
    }).length ?? 0
  );
}

function compareChecks(left: QueryEnumAlignmentCheck, right: QueryEnumAlignmentCheck): number {
  return (
    left.integration.localeCompare(right.integration) ||
    left.resource.localeCompare(right.resource) ||
    left.field.localeCompare(right.field)
  );
}

function compareFindings(
  left: QueryEnumAlignmentFinding,
  right: QueryEnumAlignmentFinding
): number {
  return (
    left.severity.localeCompare(right.severity) ||
    left.integration.localeCompare(right.integration) ||
    left.resource.localeCompare(right.resource) ||
    left.field.localeCompare(right.field) ||
    (left.operator ?? '').localeCompare(right.operator ?? '') ||
    (left.input ?? '').localeCompare(right.input ?? '') ||
    left.code.localeCompare(right.code) ||
    formatLiteral(left.literal ?? '').localeCompare(formatLiteral(right.literal ?? ''))
  );
}

function formatLiteral(literal: string | number | boolean): string {
  return JSON.stringify(literal);
}
