import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
/**
 * `bobsled extract validate` command.
 */

import * as path from 'node:path';

import type { Command } from 'commander';

import {
  getErrorMessage,
  isSourceSpec,
  isSqlTransport,
  resolveDeclaredOutputPath,
  resolveVia,
} from '../framework/core/index.js';
import {
  isLookupOnlyApiResource,
  validateWarehouseResourceForIntegration,
} from '../framework/extractor/index.js';
import { listFilterBuilders } from '../framework/query/index.js';

import { ControlLogger } from '../runtime/control.js';
import { resolveExtractIntentPlan } from '../runtime/extract-intents.js';
import { getForEachBoundInputs, normalizeForEachConfig } from '../runtime/for-each.js';

import type {
  ApiResourceSpec,
  IntegrationSpec,
  LookupOnlyApiResourceSpec,
  ResourceSpec,
  SourceSpec,
  WarehouseResourceSpec,
} from '../types/index.js';
import { getResourceIncrementalConfig } from '../runtime/filter-incremental.js';
import { isWarehouseResource } from '../runtime/warehouse-extractor.js';
import {
  CommandError,
  buildCommandContext,
  findExtractIntentsFile,
  findAllIntegrations,
  unownedProjectResources,
  findIntegrationFile,
  findResourceFiles,
  loadExtractIntentsManifestWithWarnings,
  loadIntegrationSpecWithWarnings,
  loadResourceSpec,
  parseGlobalFlags,
} from './common.js';
import { checkSemanticMetadata, normalizeSemanticCheckMode } from './semantic-check.js';

interface ValidateOptions {
  checkEnv?: boolean;
  strict?: boolean;
  format?: 'text' | 'json';
  semanticCheck?: boolean | string;
}

interface ValidationErrorDetail {
  spec: string;
  error: string;
}

interface ValidationWarningDetail {
  spec: string;
  warning: string;
}

const ENV_TEMPLATE_RE = /\$\{\{\s*(env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const INPUT_TEMPLATE_RE = /\$\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function collectTemplateMatches(
  value: unknown,
  regex: RegExp,
  captureGroup: number,
  acc = new Set<string>()
): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(regex)) {
      const captured = match[captureGroup];
      if (captured) {
        acc.add(captured);
      }
    }
    return acc;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTemplateMatches(item, regex, captureGroup, acc);
    }
    return acc;
  }

  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectTemplateMatches(entry, regex, captureGroup, acc);
    }
  }

  return acc;
}

function collectEnvReferences(value: unknown): Set<string> {
  return collectTemplateMatches(value, ENV_TEMPLATE_RE, 2);
}

function collectInputReferences(value: unknown): Set<string> {
  return collectTemplateMatches(value, INPUT_TEMPLATE_RE, 1);
}

function validateResourceIntegration(
  integrationName: string,
  resource: ResourceSpec,
  filePath: string
): void {
  if (!('integration' in resource) || resource.integration === undefined) {
    return;
  }
  if (resource.integration !== integrationName) {
    throw new CommandError(
      `Resource "${resource.name}" in ${path.basename(filePath)} declares integration "${resource.integration}" but is stored under "${integrationName}".`
    );
  }
}

function checkMissingEnvRefs(spec: IntegrationSpec | ResourceSpec): string[] {
  return [...collectEnvReferences(spec)].filter((key) => !process.env[key]);
}

function getPostgresCdcSlotName(resource: WarehouseResourceSpec): string | undefined {
  if (resource.replication.method !== 'change_tracking') {
    return undefined;
  }

  const changeTracking = resource.replication.change_tracking;
  if (
    !changeTracking ||
    typeof changeTracking !== 'object' ||
    Array.isArray(changeTracking) ||
    !('slot_name' in changeTracking)
  ) {
    return undefined;
  }

  const slotName = changeTracking['slot_name'];
  return typeof slotName === 'string' ? slotName : undefined;
}

export interface PostgresCdcSlotConflict {
  slotName: string;
  firstOwner: string;
  duplicateOwner: string;
}

export function validatePostgresCdcSlotUniqueness(
  resources: WarehouseResourceSpec[]
): PostgresCdcSlotConflict[] {
  const slotOwners = new Map<string, string>();
  const duplicates: PostgresCdcSlotConflict[] = [];

  for (const resource of resources) {
    const slotName = getPostgresCdcSlotName(resource);
    if (!slotName) {
      continue;
    }

    const priorOwner = slotOwners.get(slotName);
    if (priorOwner) {
      duplicates.push({
        slotName,
        firstOwner: priorOwner,
        duplicateOwner: resource.name,
      });
      continue;
    }

    slotOwners.set(slotName, resource.name);
  }

  return duplicates;
}

export interface InputFinding {
  field: string;
  message: string;
  severity: 'error' | 'warn';
}

export function checkInputCompleteness(
  resource: ApiResourceSpec,
  allResources: ApiResourceSpec[]
): InputFinding[] {
  const findings: InputFinding[] = [];
  const filterManagedInputs = new Set<string>();
  if (resource.extract.incremental?.strategy === 'filter') {
    const sinceArgument =
      resource.extract.incremental.since_argument ?? resource.extract.incremental.filter_argument;
    if (sinceArgument) {
      filterManagedInputs.add(sinceArgument);
    }
    if (resource.extract.incremental.until_argument) {
      filterManagedInputs.add(resource.extract.incremental.until_argument);
    }
  }

  // Validate for_each references first
  const normalizedForEach = normalizeForEachConfig(resource.extract.for_each);
  const forEach = resource.extract.for_each;
  if (forEach) {
    const parentResource = allResources.find((r) => r.name === normalizedForEach!.resource);
    if (!parentResource) {
      findings.push({
        field: normalizedForEach!.resource,
        message: `for_each references non-existent resource '${normalizedForEach!.resource}'`,
        severity: 'error',
      });
    } else {
      for (const binding of normalizedForEach!.bindings) {
        const parentShape =
          binding.source === 'input' ? parentResource.input : parentResource.output;
        if (!(binding.field in parentShape)) {
          findings.push({
            field: binding.field,
            message: `for_each binding '${binding.field}' does not exist in resource '${normalizedForEach!.resource}' ${binding.source} fields`,
            severity: 'error',
          });
          continue;
        }

        const childInput = resource.input[binding.input];
        if (!childInput) {
          findings.push({
            field: binding.input,
            message: `for_each binding destination '${binding.input}' is not a declared input of resource '${resource.name}'`,
            severity: 'error',
          });
          continue;
        }

        const parentField = parentShape[binding.field];
        if (parentField && parentField.type !== childInput.type) {
          findings.push({
            field: binding.input,
            message: `for_each binding type mismatch: '${normalizedForEach!.resource}.${binding.field}' is ${parentField.type}, but input '${resource.name}.${binding.input}' is ${childInput.type}`,
            severity: 'error',
          });
        }
      }
    }
  }

  const resourcesByName = new Map(allResources.map((candidate) => [candidate.name, candidate]));
  const ancestors = new Set<string>();
  const visited = new Set<string>([resource.name]);
  let cursor: ApiResourceSpec | undefined = resource;
  while (cursor?.extract.for_each) {
    const parentName = normalizeForEachConfig(cursor.extract.for_each)!.resource;
    if (visited.has(parentName)) {
      findings.push({
        field: parentName,
        message: `for_each dependency cycle detected while resolving '${resource.name}'`,
        severity: 'error',
      });
      break;
    }
    visited.add(parentName);
    ancestors.add(parentName);
    cursor = resourcesByName.get(parentName);
  }

  const contextualOutputNames: string[] = [];
  for (const [outputName, outputField] of Object.entries(resource.output)) {
    if (!outputField.from) continue;
    if ('input' in outputField.from) {
      const inputField = resource.input[outputField.from.input];
      if (!inputField) {
        findings.push({
          field: outputName,
          message: `contextual output '${outputName}' references undeclared input '${outputField.from.input}'`,
          severity: 'error',
        });
      } else if (inputField.type !== outputField.type) {
        findings.push({
          field: outputName,
          message: `contextual output type mismatch: input '${outputField.from.input}' is ${inputField.type}, but '${resource.name}.${outputName}' is ${outputField.type}`,
          severity: 'error',
        });
      }
      continue;
    }
    contextualOutputNames.push(outputName);
    const sourceResource = resourcesByName.get(outputField.from.resource);
    if (!sourceResource) {
      findings.push({
        field: outputName,
        message: `contextual output '${outputName}' references non-existent resource '${outputField.from.resource}'`,
        severity: 'error',
      });
      continue;
    }
    if (!ancestors.has(outputField.from.resource)) {
      findings.push({
        field: outputName,
        message: `contextual output '${outputName}' may only reference a proven for_each ancestor; '${outputField.from.resource}' is not an ancestor of '${resource.name}'`,
        severity: 'error',
      });
      continue;
    }
    const sourceField = resolveDeclaredOutputPath(sourceResource.output, outputField.from.path);
    if (!sourceField) {
      findings.push({
        field: outputName,
        message: `contextual output '${outputName}' references missing or opaque declared output path '${outputField.from.path}' on '${outputField.from.resource}'`,
        severity: 'error',
      });
      continue;
    }
    if (sourceField.type !== outputField.type) {
      findings.push({
        field: outputName,
        message: `contextual output type mismatch: '${outputField.from.resource}${outputField.from.path.slice(1)}' is ${sourceField.type}, but '${resource.name}.${outputName}' is ${outputField.type}`,
        severity: 'error',
      });
    }
  }

  const primaryKey = resource.extract.table?.primary_key ?? [];
  if (
    contextualOutputNames.length > 0 &&
    primaryKey.length > 0 &&
    !contextualOutputNames.some((name) => primaryKey.includes(name))
  ) {
    findings.push({
      field: 'extract.table.primary_key',
      message: `primary key [${primaryKey.join(', ')}] omits contextual output fields [${contextualOutputNames.join(', ')}]; global uniqueness across fan-out parents cannot be proven`,
      severity: 'warn',
    });
  }

  // Collect input references from endpoint, query_params, request_body, and tool arguments
  const endpointRefs = collectInputReferences(resource.api?.endpoint);
  const queryParamRefs = collectInputReferences(resource.api?.query_params);
  const requestBodyRefs = collectInputReferences(resource.api?.request_body);
  const toolArgRefs = collectInputReferences(resource.tool?.arguments);

  // Check each required input without a default
  for (const [fieldName, fieldDef] of Object.entries(resource.input)) {
    const hasDefault = fieldDef.default !== undefined;
    const isRequired = fieldDef.required === true;

    if (hasDefault || !isRequired) {
      continue;
    }

    if (filterManagedInputs.has(fieldName)) {
      continue;
    }

    // If for_each maps to this input, it will be populated at runtime
    if (getForEachBoundInputs(resource.extract.for_each).has(fieldName)) {
      continue;
    }

    if (endpointRefs.has(fieldName)) {
      findings.push({
        field: fieldName,
        message: `path parameter '${fieldName}' requires a value — add for_each or provide via --input`,
        severity: 'warn',
      });
    } else if (
      queryParamRefs.has(fieldName) ||
      requestBodyRefs.has(fieldName) ||
      toolArgRefs.has(fieldName)
    ) {
      findings.push({
        field: fieldName,
        message: `required parameter '${fieldName}' has no default and no for_each`,
        severity: 'warn',
      });
    }
  }

  return findings;
}

/**
 * Fail closed at the extraction boundary when cross-resource semantics are
 * invalid. Resource schemas are parsed before execution, but ancestry and
 * declared-output references require the complete integration resource set
 * and must not depend on callers having run the standalone validate command.
 */
export function assertApiResourceSemanticsForExtraction(
  resources: ApiResourceSpec[],
  allResources: ApiResourceSpec[]
): void {
  const errors = resources.flatMap((resource) =>
    checkInputCompleteness(resource, allResources)
      .filter((finding) => finding.severity === 'error')
      .map((finding) => `${resource.name}.${finding.field}: ${finding.message}`)
  );

  if (errors.length > 0) {
    throw new CommandError(
      `Resource validation failed before extraction:\n- ${errors.join('\n- ')}`
    );
  }
}

function getCompileConfigForOperator(
  compile: unknown,
  operator: string
): Record<string, unknown> | undefined {
  if (!compile || typeof compile !== 'object' || Array.isArray(compile)) {
    return undefined;
  }
  const record = compile as Record<string, unknown>;
  if (typeof record['mode'] === 'string') {
    return record;
  }
  const operatorConfig = record[operator];
  return operatorConfig && typeof operatorConfig === 'object' && !Array.isArray(operatorConfig)
    ? (operatorConfig as Record<string, unknown>)
    : undefined;
}

export function validateCompiledSourceResource(
  source: SourceSpec,
  resource: ApiResourceSpec | LookupOnlyApiResourceSpec
): InputFinding[] {
  const findings: InputFinding[] = [];
  let transportType: string | undefined;
  try {
    const transport = resolveVia(source, resource.via);
    transportType = transport.type;
    if (isSqlTransport(transport)) {
      findings.push({
        field: resource.via ?? source.default_transport ?? '',
        message: `resolveVia selects SQL transport "${transport.id}", but extractor resources must resolve to HTTP or MCP transports`,
        severity: 'error',
      });
    } else if (transport.type === 'http' && !resource.api && !resource.lookup?.api) {
      findings.push({
        field: transport.id,
        message: `resolveVia selects HTTP transport "${transport.id}" but resource does not define api`,
        severity: 'error',
      });
    } else if (
      (transport.type === 'mcp_http' || transport.type === 'mcp_stdio') &&
      !resource.tool &&
      !resource.lookup?.tool
    ) {
      findings.push({
        field: transport.id,
        message: `resolveVia selects MCP transport "${transport.id}" but resource does not define tool`,
        severity: 'error',
      });
    } else if (
      transport.type !== 'http' &&
      transport.type !== 'mcp_http' &&
      transport.type !== 'mcp_stdio'
    ) {
      const unsupportedTransport = transport as { id: string; type: string };
      findings.push({
        field: unsupportedTransport.id,
        message: `resolveVia selects unsupported transport "${unsupportedTransport.id}" (${unsupportedTransport.type})`,
        severity: 'error',
      });
    }
  } catch (error) {
    findings.push({
      field: resource.via ?? '',
      message: getErrorMessage(error),
      severity: 'error',
    });
  }

  const scaffoldMetadata = (resource as { _scaffold_metadata?: unknown })['_scaffold_metadata'];
  if (scaffoldMetadata !== undefined) {
    findings.push({
      field: '_scaffold_metadata',
      message:
        '_scaffold_metadata is generator-only metadata and should be removed before shipping',
      severity: 'warn',
    });
  }

  const knownBuilders = new Set(listFilterBuilders().map((builder) => builder.id));
  for (const [fieldName, filterSpec] of Object.entries(resource.query?.filters ?? {})) {
    for (const operator of filterSpec.operators) {
      const compileConfig = getCompileConfigForOperator(filterSpec.compile, operator);
      if (!compileConfig) {
        findings.push({
          field: fieldName,
          message: `query filter "${fieldName}" operator "${operator}" is missing compile config`,
          severity: 'error',
        });
        continue;
      }

      const mode = compileConfig['mode'];
      if (mode === 'filter_dsl') {
        const builder = compileConfig['builder'];
        if (typeof builder !== 'string' || !knownBuilders.has(builder)) {
          findings.push({
            field: fieldName,
            message: `query filter "${fieldName}" operator "${operator}" references unknown filter builder "${String(builder)}"`,
            severity: 'error',
          });
        }
      }

      if (transportType?.startsWith('mcp') && mode === 'http_query') {
        findings.push({
          field: fieldName,
          message: `query filter "${fieldName}" operator "${operator}" uses http_query compile mode on an MCP transport`,
          severity: 'error',
        });
      }
    }
  }

  const incremental = isLookupOnlyApiResource(resource)
    ? undefined
    : getResourceIncrementalConfig(resource);
  if (incremental?.strategy === 'server_filter') {
    const filterSpec = resource.query?.filters?.[incremental.cursor_field];
    if (!filterSpec) {
      findings.push({
        field: incremental.cursor_field,
        message: `server_filter incremental cursor_field "${incremental.cursor_field}" must have a matching query filter`,
        severity: 'error',
      });
    } else {
      for (const operator of ['gte', incremental.until_argument ? 'lte' : undefined]) {
        if (!operator) continue;
        if (!filterSpec.operators.includes(operator as 'gte' | 'lte')) {
          findings.push({
            field: incremental.cursor_field,
            message: `server_filter incremental requires query filter "${incremental.cursor_field}" to support "${operator}"`,
            severity: 'error',
          });
        }
      }
    }
  }

  return findings;
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate integration and resource specs')
    .argument('[target]', 'Integration name or integration/resource to validate')
    .option('--check-env', 'Verify that referenced env vars are set')
    .option('--strict', 'Treat warnings as validation failures')
    .option('--format <format>', 'Output format: text or json', 'text')
    .option(
      '--semantic-check [mode]',
      'Warn on missing semantic metadata; use --semantic-check=strict to exit 2'
    )
    .action(async (target: string | undefined, opts: ValidateOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const logger = new ControlLogger(ctx);
      const errorDetails: ValidationErrorDetail[] = [];
      const warningDetails: ValidationWarningDetail[] = [];
      const semanticCheckMode = normalizeSemanticCheckMode(opts.semanticCheck);
      let validated = 0;
      let errors = 0;
      let strictSemanticErrors = 0;
      const recordWarning = async (
        spec: string,
        warning: string,
        logMessage: string
      ): Promise<void> => {
        await logger.warn(logMessage);
        warningDetails.push({ spec, warning });
      };

      try {
        const integrations = target ? [target.split('/')[0]!] : findAllIntegrations(ctx.project);
        if (integrations.length === 0) {
          throw new CommandError(
            'No integrations found. Add a file with type: integration to the project.'
          );
        }

        for (const resourcePath of target ? [] : unownedProjectResources(ctx)) {
          const message = `The resource declares no integration. Add integration: <name>, or keep it under ${ctx.resourcesFolder || '.'}/<integration>/.`;
          await logger.error(`Resource ${resourcePath}: ${message}`);
          errorDetails.push({ spec: resourcePath, error: message });
          errors += 1;
        }

        for (const integrationName of integrations) {
          const integrationFile = findIntegrationFile(
            ctx.project,
            integrationName,
            ctx.bundledIntegrationsDir
          );
          let integrationSpec: IntegrationSpec;
          try {
            const loaded = loadIntegrationSpecWithWarnings(integrationFile);
            integrationSpec = loaded.spec;
            assertDeclaredEnvironmentReferences(integrationSpec, integrationSpec.auth_env_vars);
            for (const warning of loaded.warnings) {
              await recordWarning(integrationFile, warning, warning);
            }
            validated += 1;
          } catch (error) {
            const message = getErrorMessage(error);
            await logger.error(`Integration "${integrationName}": ${message}`);
            errorDetails.push({ spec: integrationName, error: message });
            errors += 1;
            continue;
          }

          if (opts.checkEnv) {
            const missingEnv = checkMissingEnvRefs(integrationSpec);
            if (missingEnv.length > 0) {
              const message = `Missing env vars: ${missingEnv.join(', ')}`;
              await logger.error(`Integration "${integrationName}": ${message}`);
              errorDetails.push({ spec: integrationName, error: message });
              errors += 1;
            }
          }

          const targetResource = target?.includes('/') ? target.split('/')[1] : undefined;
          const resourceFiles = findResourceFiles(ctx, integrationName);
          let foundTargetResource = false;

          const loadedResources: Array<ApiResourceSpec | LookupOnlyApiResourceSpec> = [];
          const warehouseResources: WarehouseResourceSpec[] = [];

          for (const resourceFile of resourceFiles) {
            const fileResourceName = path.basename(resourceFile, path.extname(resourceFile));
            try {
              const resourceSpec = loadResourceSpec(resourceFile);
              const resourceName = resourceSpec.name;
              if (targetResource && resourceName !== targetResource) {
                continue;
              }
              assertDeclaredEnvironmentReferences(resourceSpec, integrationSpec.auth_env_vars);
              foundTargetResource = true;
              validateResourceIntegration(integrationName, resourceSpec, resourceFile);
              if (!isWarehouseResource(resourceSpec)) {
                loadedResources.push(resourceSpec as ApiResourceSpec | LookupOnlyApiResourceSpec);
              } else {
                const warehouseResource = resourceSpec as WarehouseResourceSpec;
                const integrationErrors = validateWarehouseResourceForIntegration(
                  integrationSpec,
                  warehouseResource
                );
                if (integrationErrors.length > 0) {
                  throw new CommandError(integrationErrors.join('\n'));
                }
                warehouseResources.push(warehouseResource);
              }
              validated += 1;

              if (opts.checkEnv) {
                const missingEnv = checkMissingEnvRefs(resourceSpec);
                if (missingEnv.length > 0) {
                  const message = `Missing env vars: ${missingEnv.join(', ')}`;
                  const specLabel = `${integrationName}/${resourceName}`;
                  await recordWarning(specLabel, message, `Resource "${specLabel}": ${message}`);
                }
              }
            } catch (error) {
              const message = getErrorMessage(error);
              await logger.error(`Resource "${integrationName}/${fileResourceName}": ${message}`);
              errorDetails.push({
                spec: `${integrationName}/${fileResourceName}`,
                error: message,
              });
              errors += 1;
            }
          }

          if (targetResource && !foundTargetResource) {
            const message = `Resource "${targetResource}" not found for integration "${integrationName}"`;
            await logger.error(message);
            errorDetails.push({ spec: `${integrationName}/${targetResource}`, error: message });
            errors += 1;
            continue;
          }

          // Input completeness checks (two-pass: all resources loaded, then check)
          for (const resourceSpec of loadedResources) {
            const findings = [
              ...(isLookupOnlyApiResource(resourceSpec)
                ? []
                : checkInputCompleteness(
                    resourceSpec,
                    loadedResources.filter(
                      (candidate): candidate is ApiResourceSpec =>
                        !isLookupOnlyApiResource(candidate)
                    )
                  )),
              ...(isSourceSpec(integrationSpec)
                ? validateCompiledSourceResource(integrationSpec, resourceSpec)
                : []),
            ];
            for (const finding of findings) {
              const specLabel = `${integrationName}/${resourceSpec.name}`;
              if (finding.severity === 'error') {
                await logger.error(`Resource "${specLabel}": ${finding.message}`);
                errorDetails.push({ spec: specLabel, error: finding.message });
                errors += 1;
              } else {
                await recordWarning(
                  specLabel,
                  finding.message,
                  `Resource "${specLabel}": ${finding.message}`
                );
              }
            }
          }

          if (semanticCheckMode !== 'off') {
            for (const resourceSpec of [...loadedResources, ...warehouseResources]) {
              const specLabel = `${integrationName}/${resourceSpec.name}`;
              for (const finding of checkSemanticMetadata(resourceSpec)) {
                const message = `Resource "${specLabel}": ${finding.message}`;
                if (semanticCheckMode === 'strict') {
                  await logger.error(message);
                  errorDetails.push({ spec: specLabel, error: finding.message });
                  strictSemanticErrors += 1;
                } else {
                  await recordWarning(specLabel, finding.message, message);
                }
              }
            }
          }

          for (const duplicate of validatePostgresCdcSlotUniqueness(warehouseResources)) {
            const message =
              `Logical replication slot "${duplicate.slotName}" is already used by resource "${duplicate.firstOwner}". ` +
              'PostgreSQL CDC resources must not reuse slot_name values within the same integration.';
            await logger.error(
              `Resource "${integrationName}/${duplicate.duplicateOwner}": ${message}`
            );
            errorDetails.push({
              spec: `${integrationName}/${duplicate.duplicateOwner}`,
              error: message,
            });
            errors += 1;
          }
        }

        const extractIntentsFile = findExtractIntentsFile(ctx.project);
        if (extractIntentsFile) {
          try {
            const manifestResult = loadExtractIntentsManifestWithWarnings(extractIntentsFile);
            validated += 1;
            for (const warning of manifestResult.warnings) {
              await recordWarning(
                'extract-intents',
                `normalized key: ${warning}`,
                `extract-intents manifest: normalized key: ${warning}`
              );
            }

            for (const planName of Object.keys(manifestResult.spec.plans)) {
              try {
                const resolved = await resolveExtractIntentPlan(ctx, planName);
                for (const warning of resolved.warnings) {
                  await recordWarning(
                    `extract-intents/${planName}`,
                    warning,
                    `extract-intents/${planName}: ${warning}`
                  );
                }
                validated += 1;
              } catch (error) {
                const message = getErrorMessage(error);
                await logger.error(`extract-intents/${planName}: ${message}`);
                errorDetails.push({ spec: `extract-intents/${planName}`, error: message });
                errors += 1;
              }
            }
          } catch (error) {
            const message = getErrorMessage(error);
            await logger.error(`extract-intents: ${message}`);
            errorDetails.push({ spec: 'extract-intents', error: message });
            errors += 1;
          }
        }

        if (opts.format === 'json') {
          process.stdout.write(
            JSON.stringify(
              errorDetails.length > 0 || warningDetails.length > 0
                ? {
                    validated,
                    errors: errors + strictSemanticErrors,
                    warnings: warningDetails.length,
                    ...(errorDetails.length > 0 ? { details: errorDetails } : {}),
                    ...(warningDetails.length > 0 ? { warning_details: warningDetails } : {}),
                  }
                : { validated, errors },
              null,
              2
            ) + '\n'
          );
          if (errors > 0) {
            process.exitCode = 1;
          } else if (strictSemanticErrors > 0 || (opts.strict && warningDetails.length > 0)) {
            process.exitCode = 2;
          }
          return;
        }

        if (errors > 0) {
          throw new CommandError(
            `Validation failed: ${errors} error(s) in ${validated + errors} spec(s)`,
            1
          );
        }

        if (strictSemanticErrors > 0) {
          throw new CommandError(
            `Semantic validation failed: ${strictSemanticErrors} issue(s) in ${validated} spec(s)`,
            2
          );
        }

        if (opts.strict && warningDetails.length > 0) {
          throw new CommandError(
            `Validation failed in strict mode: ${warningDetails.length} warning(s)`,
            2
          );
        }

        await logger.info(`Validated ${validated} spec(s) successfully`);
      } finally {
        await logger.close();
      }
    });
}
