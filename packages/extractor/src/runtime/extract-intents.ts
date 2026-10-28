import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import YAML from 'yaml';

import { CommandError } from '@bobsled-inc/protocol';

import {
  assertPathContained,
  findExtractIntentsFile,
  findIntegrationFile,
  loadExtractIntentsManifestWithWarnings,
  integrationSpecWarningMessages,
  loadIntegrationSpecWithWarnings,
  loadNamedResource,
  type CommandContext,
} from '../commands/common.js';
import { SEED_BINDING_RE } from '../schemas/extract-intents.js';
import { isFileStorageResource, isLookupOnlyApiResource } from '../framework/extractor/index.js';
import { isWarehouseSource, isWarehouseResource } from './warehouse-extractor.js';

import type {
  ApiIntegrationSpec,
  ApiResourceSpec,
  BillableResourceBilling,
  ExtractIntentPlan,
  ExtractIntentStep,
  ExtractIntentsManifest,
} from '../types/index.js';

export type EstimateConfidence = 'exact' | 'upper_bound' | 'unknown';

export interface SeedRowInput {
  seedRow: Record<string, unknown>;
  input: Record<string, unknown>;
}

export interface LoadedSeedRows {
  filePath: string;
  fields: string[];
  rows: Record<string, unknown>[];
}

export interface LoadedExtractIntentStep {
  step: ExtractIntentStep;
  integration: ApiIntegrationSpec;
  resource: ApiResourceSpec & { billing: BillableResourceBilling };
  seed: LoadedSeedRows;
  inputs: SeedRowInput[];
  estimated_requests: number;
  estimated_credits: number;
  estimate_confidence: EstimateConfidence;
  seed_rows_total: number;
  seed_rows_executed: number;
}

export interface LoadedExtractIntentPlan {
  manifestPath: string;
  manifest: ExtractIntentsManifest;
  planName: string;
  plan: ExtractIntentPlan;
  warnings: string[];
  steps: LoadedExtractIntentStep[];
  total_estimated_requests: number;
  total_estimated_credits: number;
  estimate_confidence: EstimateConfidence;
}

function getSeedBindingField(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.match(SEED_BINDING_RE)?.[1];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfidence(
  current: EstimateConfidence,
  next: EstimateConfidence
): EstimateConfidence {
  if (current === 'unknown' || next === 'unknown') {
    return 'unknown';
  }
  if (current === 'upper_bound' || next === 'upper_bound') {
    return 'upper_bound';
  }
  return 'exact';
}

function estimateConfidenceForModel(
  model: BillableResourceBilling['estimation']['model']
): EstimateConfidence {
  switch (model) {
    case 'per_request':
    case 'per_input_row':
      return 'exact';
    case 'per_match':
    case 'upper_bound':
      return 'upper_bound';
    default: {
      const _exhaustive: never = model;
      return 'unknown';
    }
  }
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && content[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      field = '';
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }

  return rows;
}

async function readCsvSeedFile(filePath: string): Promise<LoadedSeedRows> {
  const content = await fs.readFile(filePath, 'utf-8');
  const rows = parseCsvRows(content);
  if (rows.length === 0) {
    return { filePath, fields: [], rows: [] };
  }

  const headers = rows[0]!.map((header) => header.replace(/^\uFEFF/, '').trim());
  const dataRows: Record<string, unknown>[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index]!;
    if (values.length > headers.length) {
      throw new CommandError(
        `Seed file "${filePath}" row ${index + 1} has ${values.length} values but only ${headers.length} headers.`
      );
    }

    const record: Record<string, unknown> = {};
    for (let valueIndex = 0; valueIndex < headers.length; valueIndex += 1) {
      const header = headers[valueIndex];
      if (!header) {
        continue;
      }
      record[header] = values[valueIndex] ?? '';
    }
    dataRows.push(record);
  }

  return { filePath, fields: headers, rows: dataRows };
}

async function readJsonlSeedFile(filePath: string): Promise<LoadedSeedRows> {
  const content = await fs.readFile(filePath, 'utf-8');
  const rows: Record<string, unknown>[] = [];
  const fields = new Set<string>();

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid JSON';
      throw new CommandError(`Seed file "${filePath}" line ${index + 1}: ${message}`);
    }

    if (!isPlainObject(parsed)) {
      throw new CommandError(`Seed file "${filePath}" line ${index + 1} must be a JSON object.`);
    }

    Object.keys(parsed).forEach((field) => fields.add(field));
    rows.push(parsed);
  }

  return { filePath, fields: [...fields].sort(), rows };
}

async function readYamlSeedFile(filePath: string): Promise<LoadedSeedRows> {
  const content = await fs.readFile(filePath, 'utf-8');
  let parsed: unknown;

  try {
    parsed = YAML.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid YAML';
    throw new CommandError(`Seed file "${filePath}": ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new CommandError(`Seed file "${filePath}" must contain a YAML list of objects.`);
  }

  const rows: Record<string, unknown>[] = [];
  const fields = new Set<string>();
  for (const [index, item] of parsed.entries()) {
    if (!isPlainObject(item)) {
      throw new CommandError(`Seed file "${filePath}" item ${index + 1} must be an object.`);
    }
    Object.keys(item).forEach((field) => fields.add(field));
    rows.push(item);
  }

  return { filePath, fields: [...fields].sort(), rows };
}

export async function loadSeedRows(
  projectRoot: string,
  seed: ExtractIntentPlan['seeds'][string]
): Promise<LoadedSeedRows> {
  assertPathContained(projectRoot, seed.path, 'Seed path');
  const filePath = path.resolve(projectRoot, seed.path);

  switch (seed.format) {
    case 'csv':
      return readCsvSeedFile(filePath);
    case 'jsonl':
      return readJsonlSeedFile(filePath);
    case 'yaml':
      return readYamlSeedFile(filePath);
    default:
      throw new CommandError(`Unsupported seed format "${seed.format}"`);
  }
}

function validateStepResourceInputs(
  step: ExtractIntentStep,
  resource: ApiResourceSpec,
  seed: LoadedSeedRows
): void {
  for (const inputKey of Object.keys(step.input)) {
    if (!(inputKey in resource.input)) {
      throw new CommandError(
        `Plan step "${step.id}" maps input "${inputKey}" which is not declared on ${step.integration}/${step.resource}.`
      );
    }

    const boundSeedField = getSeedBindingField(step.input[inputKey]);
    if (boundSeedField && !seed.fields.includes(boundSeedField)) {
      throw new CommandError(
        `Plan step "${step.id}" references seed field "${boundSeedField}" which does not exist in seed "${step.seed}".`
      );
    }
  }

  const missingRequiredInputs = Object.entries(resource.input)
    .filter(([, field]) => field.required === true && field.default === undefined)
    .map(([fieldName]) => fieldName)
    .filter((fieldName) => !(fieldName in step.input));

  if (missingRequiredInputs.length > 0) {
    throw new CommandError(
      `Plan step "${step.id}" is missing required resource inputs: ${missingRequiredInputs.join(', ')}.`
    );
  }
}

function expandPlanStepInputs(
  step: ExtractIntentStep,
  rows: Record<string, unknown>[]
): SeedRowInput[] {
  return rows.map((seedRow, index) => {
    const input: Record<string, unknown> = {};
    for (const [inputKey, inputValue] of Object.entries(step.input)) {
      const boundSeedField = getSeedBindingField(inputValue);
      if (!boundSeedField) {
        input[inputKey] = inputValue;
        continue;
      }

      if (!(boundSeedField in seedRow)) {
        throw new CommandError(
          `Plan step "${step.id}" row ${index + 1} is missing seed field "${boundSeedField}".`
        );
      }

      input[inputKey] = seedRow[boundSeedField];
    }

    return { seedRow, input };
  });
}

function buildStepEstimate(
  billing: BillableResourceBilling,
  executedRows: number
): Pick<
  LoadedExtractIntentStep,
  'estimated_requests' | 'estimated_credits' | 'estimate_confidence'
> {
  const estimate_confidence = estimateConfidenceForModel(billing.estimation.model);

  return {
    estimated_requests: executedRows,
    estimated_credits: executedRows * billing.estimation.amount,
    estimate_confidence,
  };
}

export function ensureBillableResource(
  resource: ApiResourceSpec,
  integrationName: string
): asserts resource is ApiResourceSpec & { billing: BillableResourceBilling } {
  if (!resource.billing) {
    throw new CommandError(
      `Resource "${integrationName}/${resource.name}" is not billable. Use regular extract commands instead of --plan.`
    );
  }

  if (resource.billing.authorization.requires_plan !== true) {
    throw new CommandError(
      `Billable resource "${integrationName}/${resource.name}" must declare billing.authorization.requires_plan: true.`
    );
  }
}

export function isBillableResource(resource: { billing?: unknown }): resource is {
  billing: BillableResourceBilling;
} {
  return !!resource.billing;
}

export function billablePlanUsage(): string {
  return 'Use "dogsled extract estimate --plan <name>" before "dogsled extract run --plan <name>".';
}

export async function resolveExtractIntentPlan(
  ctx: CommandContext,
  planName: string
): Promise<LoadedExtractIntentPlan> {
  const manifestPath = findExtractIntentsFile(ctx.project);
  if (!manifestPath) {
    throw new CommandError(
      `Plan "${planName}" requires an extract intents manifest (a file with type: extract-intents).`
    );
  }

  const manifestResult = loadExtractIntentsManifestWithWarnings(manifestPath);
  const manifest = manifestResult.spec;
  const warnings = new Set(
    manifestResult.warnings.map((warning) => `extract-intents manifest: normalized key: ${warning}`)
  );
  const plan = manifest.plans[planName];
  if (!plan) {
    throw new CommandError(`Plan "${planName}" not found in ${path.basename(manifestPath)}.`);
  }

  const seedCache = new Map<string, LoadedSeedRows>();
  const steps: LoadedExtractIntentStep[] = [];
  let totalEstimatedRequests = 0;
  let totalEstimatedCredits = 0;
  let estimateConfidence: EstimateConfidence = 'exact';

  for (const step of plan.steps) {
    const integrationFile = findIntegrationFile(
      ctx.project,
      step.integration,
      ctx.bundledIntegrationsDir
    );
    const integrationResult = loadIntegrationSpecWithWarnings(integrationFile);
    const integration = integrationResult.spec;
    for (const warning of integrationSpecWarningMessages(
      step.integration,
      integrationResult.warnings
    )) {
      warnings.add(warning);
    }
    if (isWarehouseSource(integration)) {
      throw new CommandError(
        `Plan step "${step.id}" targets ${step.integration}/${step.resource}, but extract plans only support API resources.`
      );
    }
    const apiIntegration = integration as ApiIntegrationSpec;

    const resource = loadNamedResource(ctx, step.integration, step.resource);
    if (isWarehouseResource(resource) || isFileStorageResource(resource)) {
      throw new CommandError(
        `Plan step "${step.id}" targets ${step.integration}/${step.resource}, but extract plans only support API resources.`
      );
    }
    if (isLookupOnlyApiResource(resource)) {
      throw new CommandError(
        `Plan step "${step.id}" targets ${step.integration}/${step.resource}, but that Resource only supports lookup.`
      );
    }

    ensureBillableResource(resource, step.integration);

    const seedConfig = plan.seeds[step.seed];
    if (!seedConfig) {
      throw new CommandError(`Plan step "${step.id}" references unknown seed "${step.seed}".`);
    }
    let loadedSeed = seedCache.get(step.seed);
    if (!loadedSeed) {
      loadedSeed = await loadSeedRows(ctx.cwd, seedConfig);
      seedCache.set(step.seed, loadedSeed);
    }

    validateStepResourceInputs(step, resource, loadedSeed);

    const seed_rows_total = loadedSeed.rows.length;
    const seed_rows_executed = Math.min(seed_rows_total, step.limits.max_input_rows);
    const inputs = expandPlanStepInputs(step, loadedSeed.rows.slice(0, seed_rows_executed));
    const estimate = buildStepEstimate(resource.billing, seed_rows_executed);

    totalEstimatedRequests += estimate.estimated_requests;
    totalEstimatedCredits += estimate.estimated_credits;
    estimateConfidence = mergeConfidence(estimateConfidence, estimate.estimate_confidence);

    steps.push({
      step,
      integration: apiIntegration,
      resource,
      seed: loadedSeed,
      inputs,
      seed_rows_total,
      seed_rows_executed,
      ...estimate,
    });
  }

  return {
    manifestPath,
    manifest,
    planName,
    plan,
    warnings: [...warnings],
    steps,
    total_estimated_requests: totalEstimatedRequests,
    total_estimated_credits: totalEstimatedCredits,
    estimate_confidence: estimateConfidence,
  };
}
