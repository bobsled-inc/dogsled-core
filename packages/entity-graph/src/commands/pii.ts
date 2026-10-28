import { basename } from 'node:path';
import { Command, Option } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import { quoteIdentifier, type SqlQueryRow, type SupportedDialect } from '@bobsled-inc/model-spec';
import { loadProjectConfig } from '@bobsled-inc/model-spec/shared';
import { updateSourceColumn } from '@bobsled-inc/model-spec/edit';

import {
  createLlmPiiDetector,
  createLocalPiiDetector,
  createRegexPiiDetector,
  type FieldPiiVerdict,
  type FieldSamples,
  type PiiDetector,
} from '../runtime/pii/detector.js';
import { loadEntityGraphProjectContext } from '../runtime/project-context.js';
import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';
import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';

import type { ResolvedInput } from '../compiler/identity/types.js';
import type { PlatformConfig } from '@bobsled-inc/ai';

type PiiBackend = 'llm' | 'local' | 'regex';

interface PiiScanOptions {
  entity?: string;
  backend?: PiiBackend;
  localEndpoint?: string;
  sampleSize?: number;
  runner?: string;
  integration?: string;
  dialect?: string;
  schema?: string;
  apply?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

interface ApplyResult {
  source_ref: string;
  field: string;
  status: 'applied' | 'skipped' | 'error';
  file_path?: string;
  error?: string;
}

function outputFormat(options: PiiScanOptions): EntityGraphOutputFormat {
  return resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'text',
  });
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CommandError('--sample-size must be a positive integer.', 2);
  }
  return parsed;
}

function sourceNameParts(sourceRef: string): { connection: string; sourceName: string } {
  const dot = sourceRef.indexOf('.');
  if (dot < 0) {
    return { connection: '', sourceName: sourceRef };
  }
  return { connection: sourceRef.slice(0, dot), sourceName: sourceRef.slice(dot + 1) };
}

function candidateFields(input: ResolvedInput): string[] {
  const metadataFields = input.sourceFieldMetadata ? Object.keys(input.sourceFieldMetadata) : [];
  return metadataFields.length > 0 ? metadataFields : (input.sourceColumns ?? []);
}

function sampleQuery(
  input: ResolvedInput,
  field: string,
  limit: number,
  dialect: SupportedDialect
): string {
  return [
    `SELECT ${quoteIdentifier(field, dialect)} AS ${quoteIdentifier('value', dialect)}`,
    `FROM ${input.fqTableName}`,
    `WHERE ${quoteIdentifier(field, dialect)} IS NOT NULL`,
    `LIMIT ${limit}`,
  ].join('\n');
}

function readSampleValues(rows: SqlQueryRow[]): string[] {
  return rows
    .map((row) => {
      const entry = Object.entries(row).find(([key]) => key.toLowerCase() === 'value');
      return entry?.[1];
    })
    .filter((value): value is NonNullable<typeof value> => value !== null && value !== undefined)
    .map((value) => String(value));
}

function asAiProjectConfig(config: unknown): { platform?: PlatformConfig } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const platform = (config as { platform?: unknown }).platform;
  return platform && typeof platform === 'object' && !Array.isArray(platform)
    ? { platform: platform as PlatformConfig }
    : {};
}

async function collectSamples(options: {
  inputs: ResolvedInput[];
  query?: (sql: string) => Promise<SqlQueryRow[]>;
  sampleSize: number;
  dialect: SupportedDialect;
}): Promise<FieldSamples> {
  const fields: FieldSamples['fields'] = [];
  for (const input of options.inputs) {
    for (const field of candidateFields(input)) {
      let samples: string[] = [];
      if (options.query) {
        try {
          samples = readSampleValues(
            await options.query(sampleQuery(input, field, options.sampleSize, options.dialect))
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new CommandError(`Failed to sample ${input.ref}.${field}: ${message}`, 1);
        }
      }
      fields.push({ sourceRef: input.ref, field, samples });
    }
  }
  return { fields };
}

function detectorFor(options: {
  backend: PiiBackend;
  localEndpoint?: string;
  projectConfig: { platform?: PlatformConfig };
  projectKey: string;
}): PiiDetector {
  switch (options.backend) {
    case 'regex':
      return createRegexPiiDetector();
    case 'local':
      return createLocalPiiDetector(options.localEndpoint ?? 'http://localhost:8734/detect');
    case 'llm':
      return createLlmPiiDetector({
        projectConfig: options.projectConfig,
        projectKey: options.projectKey,
        env: process.env,
      });
  }
}

function piiVerdicts(verdicts: FieldPiiVerdict[]): FieldPiiVerdict[] {
  return verdicts.filter((verdict) => verdict.pii);
}

export function applyPiiScanPatches(
  projectDir: string,
  verdicts: FieldPiiVerdict[]
): ApplyResult[] {
  return piiVerdicts(verdicts).map((verdict) => {
    const { connection, sourceName } = sourceNameParts(verdict.source_ref);
    const result = updateSourceColumn({
      projectDir,
      sourceName,
      connection,
      columnName: verdict.field,
      patch: { pii: true },
    });
    if (!result.ok) {
      return {
        source_ref: verdict.source_ref,
        field: verdict.field,
        status: 'error',
        error: result.error,
      };
    }
    return {
      source_ref: verdict.source_ref,
      field: verdict.field,
      status: 'applied',
      file_path: result.data.filePath,
    };
  });
}

function renderText(payload: {
  verdicts: FieldPiiVerdict[];
  applied: ApplyResult[];
  policy_redact_fields: string[];
}): string {
  const lines = ['PII scan suggestions'];
  for (const verdict of piiVerdicts(payload.verdicts)) {
    lines.push(
      `- ${verdict.source_ref}.${verdict.field}: ${verdict.classification} (${verdict.suggested_masking})`
    );
  }
  if (payload.policy_redact_fields.length > 0) {
    lines.push(`Policy redact fields: ${payload.policy_redact_fields.join(', ')}`);
  }
  if (payload.applied.length > 0) {
    lines.push(`Applied patches: ${payload.applied.length}`);
  }
  return lines.join('\n');
}

async function scanHandler(options: PiiScanOptions): Promise<void> {
  const cwd = process.cwd();
  const project = loadProjectConfig(cwd);
  const aiProjectConfig = asAiProjectConfig(project.config);
  const context = await loadEntityGraphProjectContext({
    cwd,
    entityNames: options.entity ? [options.entity] : undefined,
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
  });
  const runnerHandle = await resolveEntityGraphRunner({
    cwd,
    runnerPath: options.runner,
    integration: context.integration,
    allowLocalRunnerFallback: true,
  });
  const sampleSize = options.sampleSize ?? 50;
  try {
    const samples = await collectSamples({
      inputs: context.specs.flatMap((spec) => spec.inputs),
      sampleSize,
      dialect: context.dialect,
      ...(runnerHandle?.runner.query
        ? { query: runnerHandle.runner.query.bind(runnerHandle.runner) }
        : {}),
    });
    const detector = detectorFor({
      backend: options.backend ?? 'llm',
      localEndpoint: options.localEndpoint,
      projectConfig: { platform: aiProjectConfig.platform },
      projectKey: basename(cwd),
    });
    const verdicts = await detector.detect(samples);
    const applied = options.apply ? applyPiiScanPatches(cwd, verdicts) : [];
    const positive = piiVerdicts(verdicts);
    const payload = {
      command: 'pii.scan',
      status: applied.some((result) => result.status === 'error') ? 'partial' : 'ok',
      backend: options.backend ?? 'llm',
      sample_size: sampleSize,
      bms_patches: positive.map((verdict) => ({
        source_ref: verdict.source_ref,
        field: verdict.field,
        patch: { pii: true },
      })),
      policy_redact_fields: Array.from(new Set(positive.map((verdict) => verdict.field))).sort(),
      treatments: positive.map((verdict) => ({
        source_ref: verdict.source_ref,
        field: verdict.field,
        classification: verdict.classification,
        masking: verdict.suggested_masking,
        confidence: verdict.confidence,
      })),
      verdicts,
      applied,
    };
    const format = outputFormat(options);
    // --quiet suppresses the human text report; structured output still emits.
    if (format !== 'text' || !options.quiet) {
      emitEntityGraphPayload(payload, format, () => renderText(payload));
    }
    if (applied.some((result) => result.status === 'error')) {
      process.exitCode = 1;
    }
  } finally {
    await runnerHandle?.close();
  }
}

export function registerPiiCommand(program: Command): void {
  const pii = program.command('pii').description('PII detection and policy suggestion commands');

  pii
    .command('scan')
    .description('Sample entity graph inputs and suggest PII annotations')
    .option('--entity <name>', 'Entity name to scan')
    .addOption(
      new Option('--backend <backend>', 'PII detector backend').choices(['llm', 'local', 'regex'])
    )
    .option('--local-endpoint <url>', 'Local detector POST /detect endpoint')
    .option('--sample-size <n>', 'Rows to sample per field', positiveInt)
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--apply', 'Apply suggested Model Spec pii: true source-column patches')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Emit output as JSON')
    .option('--yaml', 'Emit output as YAML')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .option('--schema <name>', 'Target schema name')
    .option('--integration <handle>', 'Integration handle to resolve warehouse runner')
    .option('--dialect <name>', 'SQL dialect when no integration is configured')
    .action(async (opts: PiiScanOptions) => {
      await scanHandler(opts);
    });
}
