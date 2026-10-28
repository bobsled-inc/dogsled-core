import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
import * as fs from 'node:fs';
import * as path from 'node:path';

import chalk from 'chalk';

import { parseOpenApiSpec } from '../runtime/openapi-mapper.js';
import { isWarehouseResource, isWarehouseSource } from '../runtime/warehouse-extractor.js';

import type { ApiIntegrationSpec, HttpApiResourceSpec } from '../types/index.js';
import {
  CommandError,
  findIntegrationFile,
  findResourceFiles,
  isMcpIntegration,
  loadIntegrationSpecWithWarnings,
  loadResourceSpecWithWarnings,
  resolveOpenApiSource,
  type CommandContext,
} from './common.js';
import { diffIntegration } from './check-diff.js';
import { checkInputCompleteness } from './validate.js';
import {
  appendFinding,
  collectDuplicateEndpointFindings,
  collectEnvRefs,
  collectOptionalOnlyEnvRefs,
  collectForEachDependencyFindings,
  collectIntegrationStructuralFindings,
  collectResourceQualityFindings,
  convertCheckFinding,
  isSuppressedFinding,
  parseMetaFile,
  severityAtOrAbove,
  type Severity,
  type VerifyFinding,
  type VerifyIntegrationResult,
  type VerifyOptions,
} from './verify-shared.js';
import { runMockVerification } from './verify-mock.js';

export async function verifyIntegration(
  ctx: CommandContext,
  integrationName: string,
  resourceName: string | undefined,
  opts: VerifyOptions
): Promise<VerifyIntegrationResult> {
  const findings: VerifyFinding[] = [];
  let resourcesChecked = 0;
  let mockFixturesChecked = 0;
  let mockResourcesChecked = 0;
  let openApiChecked = false;

  const integrationFile = findIntegrationFile(
    ctx.project,
    integrationName,
    ctx.bundledIntegrationsDir
  );
  const integrationRaw = fs.readFileSync(integrationFile, 'utf8');
  const integrationResult = loadIntegrationSpecWithWarnings(integrationFile);
  const integrationSpec = integrationResult.spec;
  for (const warning of integrationResult.warnings) {
    appendFinding(findings, integrationName, 'info', 'NORMALIZE_WARNING', warning);
  }

  const integrationDir = path.dirname(integrationFile);
  const meta = parseMetaFile(path.join(integrationDir, 'meta.yml'));
  findings.push(
    ...collectIntegrationStructuralFindings(integrationName, integrationSpec, integrationRaw, meta)
  );

  const resourceFiles = findResourceFiles(ctx, integrationName);
  if (resourceFiles.length === 0) {
    appendFinding(
      findings,
      integrationName,
      'error',
      'NO_RESOURCES',
      'No resources found for integration'
    );
    return {
      integration: integrationName,
      resourcesChecked,
      mockResourcesChecked,
      mockFixturesChecked,
      findings,
      openApiChecked,
    };
  }

  const apiResources: HttpApiResourceSpec[] = [];
  const resourcesByName = new Map<string, HttpApiResourceSpec>();
  const resourceEnvRefs = new Map<string, Set<string>>();
  let matchedTargetResource = resourceName === undefined;

  for (const resourceFile of resourceFiles) {
    const resourceRaw = fs.readFileSync(resourceFile, 'utf8');
    try {
      const resourceResult = loadResourceSpecWithWarnings(resourceFile);
      const resourceSpec = resourceResult.spec;
      if (resourceName) {
        const fileStem = path.basename(resourceFile, path.extname(resourceFile));
        if (fileStem !== resourceName && resourceSpec.name !== resourceName) {
          continue;
        }
        matchedTargetResource = true;
      }

      assertDeclaredEnvironmentReferences(resourceSpec, integrationSpec.auth_env_vars);
      resourcesChecked += 1;
      resourceEnvRefs.set(resourceSpec.name, collectEnvRefs(resourceRaw));
      for (const warning of resourceResult.warnings) {
        appendFinding(
          findings,
          integrationName,
          'info',
          'NORMALIZE_WARNING',
          warning,
          resourceSpec.name
        );
      }

      findings.push(
        ...collectResourceQualityFindings(integrationName, resourceFile, resourceSpec, resourceRaw)
      );

      if (!isWarehouseResource(resourceSpec) && resourceSpec.api) {
        apiResources.push(resourceSpec as HttpApiResourceSpec);
        resourcesByName.set(resourceSpec.name, resourceSpec as HttpApiResourceSpec);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown resource validation error';
      const currentResourceName = path.basename(resourceFile, path.extname(resourceFile));
      appendFinding(
        findings,
        integrationName,
        'error',
        'RESOURCE_INVALID',
        message,
        currentResourceName
      );
    }
  }

  if (opts.mock) {
    const mockResult = await runMockVerification(
      integrationName,
      integrationSpec as ApiIntegrationSpec,
      apiResources
    );
    findings.push(...mockResult.findings);
    mockResourcesChecked = mockResult.resourcesChecked;
    mockFixturesChecked = mockResult.fixturesChecked;
  }

  if (!matchedTargetResource && resourceName) {
    throw new CommandError(
      `Resource "${resourceName}" not found for integration "${integrationName}".`
    );
  }

  findings.push(...collectDuplicateEndpointFindings(integrationName, apiResources));
  findings.push(...collectForEachDependencyFindings(integrationName, apiResources));

  for (const resource of apiResources) {
    const completenessFindings = checkInputCompleteness(resource, apiResources);
    for (const finding of completenessFindings) {
      appendFinding(
        findings,
        integrationName,
        finding.severity,
        'INPUT_COMPLETENESS',
        finding.message,
        resource.name,
        finding.field
      );
    }
  }

  if (opts.checkEnv) {
    const optionalEnvVars = collectOptionalOnlyEnvRefs(integrationSpec);
    for (const envVar of collectEnvRefs(integrationRaw)) {
      if (optionalEnvVars.has(envVar)) continue;
      if (!process.env[envVar]) {
        appendFinding(
          findings,
          integrationName,
          'warn',
          'MISSING_ENV',
          `Environment variable "${envVar}" is not set`
        );
      }
    }

    for (const resource of apiResources) {
      for (const envVar of resourceEnvRefs.get(resource.name) ?? []) {
        if (!process.env[envVar]) {
          appendFinding(
            findings,
            integrationName,
            'warn',
            'MISSING_ENV',
            `Environment variable "${envVar}" is not set`,
            resource.name
          );
        }
      }
    }
  }

  const openApiSource =
    (opts.openapi ? resolveOpenApiSource(opts.openapi, integrationDir) : undefined) ??
    (typeof meta?.['openapi_url'] === 'string'
      ? resolveOpenApiSource(meta['openapi_url'] as string, integrationDir)
      : undefined);

  if (isWarehouseSource(integrationSpec)) {
    appendFinding(
      findings,
      integrationName,
      'info',
      'OPENAPI_SKIPPED',
      'OpenAPI drift check skipped for warehouse/database integrations'
    );
  } else if (isMcpIntegration(integrationSpec as ApiIntegrationSpec)) {
    appendFinding(
      findings,
      integrationName,
      'info',
      'OPENAPI_SKIPPED',
      'OpenAPI drift check skipped for MCP integrations'
    );
  } else if (!openApiSource) {
    appendFinding(
      findings,
      integrationName,
      'info',
      'OPENAPI_SKIPPED',
      'No openapi_url configured in meta.yml'
    );
  } else {
    try {
      const openApiDoc = await parseOpenApiSpec(openApiSource);
      openApiChecked = true;
      findings.push(
        ...diffIntegration(integrationSpec as ApiIntegrationSpec, apiResources, openApiDoc).map(
          (finding) => convertCheckFinding(integrationName, finding)
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load OpenAPI spec';
      appendFinding(
        findings,
        integrationName,
        'warn',
        'OPENAPI_UNAVAILABLE',
        `Unable to run OpenAPI drift check: ${message}`
      );
    }
  }

  const filteredFindings = findings.filter((finding) =>
    finding.resource ? !isSuppressedFinding(resourcesByName.get(finding.resource), finding) : true
  );

  return {
    integration: integrationName,
    resourcesChecked,
    mockResourcesChecked,
    mockFixturesChecked,
    findings: filteredFindings,
    openApiChecked,
  };
}

export function formatSummary(results: VerifyIntegrationResult[], threshold: Severity): string {
  const lines: string[] = ['', chalk.bold('Verification Results'), ''];
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const result of results) {
    const findings = result.findings.filter((finding) =>
      severityAtOrAbove(finding.severity, threshold)
    );
    const errors = findings.filter((finding) => finding.severity === 'error').length;
    const warnings = findings.filter((finding) => finding.severity === 'warn').length;
    totalErrors += errors;
    totalWarnings += warnings;

    const status =
      errors > 0 ? chalk.red('FAIL') : warnings > 0 ? chalk.yellow('WARN') : chalk.green('PASS');
    const openApiLabel = result.openApiChecked ? 'openapi' : 'no-openapi';
    lines.push(
      `  ${status}  ${result.integration}  (${result.resourcesChecked} resources, ${result.mockResourcesChecked} mock resources, ${result.mockFixturesChecked} mock fixtures, ${errors} errors, ${warnings} warnings, ${openApiLabel})`
    );

    if (results.length === 1 && findings.length > 0) {
      for (const finding of findings) {
        const target = finding.resource
          ? `${finding.resource}${finding.field ? `.${finding.field}` : ''}`
          : '(integration)';
        lines.push(
          `         ${finding.severity.toUpperCase()} ${finding.code} ${target} — ${finding.message}`
        );
      }
    }
  }

  lines.push('');
  lines.push(
    `  ${results.length} integration(s), ${totalErrors} error(s), ${totalWarnings} warning(s)`
  );
  lines.push('');
  return lines.join('\n');
}
