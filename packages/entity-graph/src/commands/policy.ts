import { type Command, Option } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import { out, parseGlobalFlags } from '@bobsled-inc/model-spec/shared';

import {
  discoverPolicyFiles,
  validatePolicyFiles,
  loadPolicySpec,
  loadPolicySpecFromFile,
} from '../compiler/policy/parser.js';
import {
  checkTrustGate,
  resolvePiiRedactFields,
  checkApprovalGate,
} from '../compiler/policy/enforce.js';
import { loadEntityGraphProjectContext } from '../runtime/project-context.js';
import type { ResolvedResolutionSpec } from '../compiler/identity/types.js';

function resolveSpecDir(options: { specDir?: string }): string {
  return options.specDir ?? process.cwd();
}

const DECISION_SOURCE_VALUES = ['human', 'agent', 'system'] as const;
type DecisionSource = (typeof DECISION_SOURCE_VALUES)[number];

interface PolicyValidateOptions {
  specDir?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

interface PolicyShowOptions {
  specDir?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

interface PolicyEvalOptions {
  entityId?: string;
  trustScore?: number;
  decisionSource?: string;
  policyFile?: string;
  specDir?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

export function collectAutoDetectedPiiFields(specs: ResolvedResolutionSpec[]): string[] {
  const fields = new Set<string>();
  for (const spec of specs) {
    for (const input of spec.inputs) {
      for (const [field, metadata] of Object.entries(input.sourceFieldMetadata ?? {})) {
        if (metadata.pii === true) {
          fields.add(field);
          fields.add(`standardized_${field}`);
        }
      }
    }
  }
  return [...fields].sort();
}

async function loadAutoDetectedPiiFields(): Promise<string[]> {
  try {
    const context = await loadEntityGraphProjectContext({ cwd: process.cwd() });
    return collectAutoDetectedPiiFields(context.specs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.warn(`Could not auto-detect PII fields: ${message}`);
    return [];
  }
}

async function validateHandler(options: PolicyValidateOptions): Promise<void> {
  const specDir = resolveSpecDir(options);
  const { valid, errors } = validatePolicyFiles(specDir);

  if (errors.length > 0) {
    if (options.json) {
      out.json({
        command: 'policy.validate',
        status: 'invalid',
        errors: errors.map(({ filePath, message }) => ({
          filePath,
          code: 'validation_error',
          message,
        })),
      });
      process.exitCode = 2;
      return;
    }
    for (const error of errors) {
      out.error(`${error.filePath}: ${error.message}`);
    }
    process.exitCode = 2;
    return;
  }

  if (valid.length === 0) {
    if (options.json) {
      out.json({
        command: 'policy.validate',
        status: 'not_found',
        files: [],
        message: `No *.policy.yml files found in ${specDir}`,
      });
      return;
    }
    out.warn(`No *.policy.yml files found in ${specDir}`);
    return;
  }

  if (options.json) {
    out.json(valid.map(({ filePath, spec }) => ({ filePath, name: spec.name, status: 'valid' })));
  } else {
    for (const { filePath, spec } of valid) {
      out.success(`${spec.name} (${filePath}) — valid`);
    }
  }
}

async function showHandler(options: PolicyShowOptions): Promise<void> {
  const specDir = resolveSpecDir(options);
  const files = discoverPolicyFiles(specDir);

  if (files.length === 0) {
    throw new CommandError(`No *.policy.yml files found in ${specDir}`, 2);
  }

  const results = files.map((filePath) => {
    const spec = loadPolicySpecFromFile(filePath);
    return { filePath, spec };
  });

  if (options.json) {
    out.json(results);
  } else {
    for (const { filePath, spec } of results) {
      out.info(`\n--- ${filePath} ---`);
      out.info(`name: ${spec.name}`);
      if (spec.activation_gates?.min_entity_trust_score !== undefined) {
        out.info(
          `activation_gates.min_entity_trust_score: ${spec.activation_gates.min_entity_trust_score}`
        );
      }
      const redactFields = spec.review_export?.redact_fields_for_agent_review ?? [];
      if (redactFields.length > 0) {
        out.info(`review_export.redact_fields_for_agent_review: ${redactFields.join(', ')}`);
      }
      const approvalGates = spec.approval_gates?.require_human_approval_for ?? [];
      if (approvalGates.length > 0) {
        out.info(`approval_gates.require_human_approval_for: ${approvalGates.join(', ')}`);
      }
    }
  }
}

async function evalHandler(options: PolicyEvalOptions): Promise<void> {
  const specDir = resolveSpecDir(options);

  const policy = options.policyFile
    ? loadPolicySpecFromFile(options.policyFile)
    : loadPolicySpec(specDir)?.spec;
  if (!policy) {
    throw new CommandError(`No *.policy.yml files found in ${specDir}`, 2);
  }
  const results: Record<string, unknown>[] = [];

  if (options.entityId !== undefined && options.trustScore !== undefined) {
    if (!Number.isFinite(options.trustScore) || options.trustScore < 0 || options.trustScore > 1) {
      throw new CommandError('--trust-score must be a finite number between 0 and 1', 2);
    }
    const trustResult = checkTrustGate(policy, options.entityId, options.trustScore);
    results.push({
      check: 'trust_gate',
      entity_id: options.entityId,
      entity_trust_score: options.trustScore,
      threshold: trustResult.threshold,
      passed: trustResult.passed,
    });
  }

  if (options.decisionSource !== undefined) {
    if (!(DECISION_SOURCE_VALUES as readonly string[]).includes(options.decisionSource)) {
      throw new CommandError(
        `--decision-source must be one of: ${DECISION_SOURCE_VALUES.join(', ')} (got: ${options.decisionSource})`,
        2
      );
    }
    const source = options.decisionSource as DecisionSource;
    const approvalResult = checkApprovalGate(policy, source);
    results.push({
      check: 'approval_gate',
      decision_source: source,
      blocked: approvalResult.blocked,
      reason: approvalResult.reason,
    });
  }

  const autoDetectedPiiFields = await loadAutoDetectedPiiFields();
  const piiFields = resolvePiiRedactFields(policy, autoDetectedPiiFields);
  results.push({
    check: 'pii_redact_fields',
    fields: piiFields,
    auto_detected_fields: autoDetectedPiiFields,
  });

  if (options.json) {
    out.json(results);
  } else {
    for (const result of results) {
      out.info(JSON.stringify(result, null, 2));
    }
  }
}

export function registerPolicyCommand(program: Command): void {
  const policy = program.command('policy').description('Entity graph policy management');

  policy
    .command('validate')
    .description('Validate policy spec files in the spec directory')
    .option('--spec-dir <path>', 'Spec directory containing *.policy.yml files')
    .option('--json', 'Emit output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(async (opts: PolicyValidateOptions) => {
      const flags = parseGlobalFlags(opts);
      await validateHandler({ ...opts, ...flags });
    });

  policy
    .command('show')
    .description('Show effective policy configuration')
    .option('--spec-dir <path>', 'Spec directory containing *.policy.yml files')
    .option('--json', 'Emit output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(async (opts: PolicyShowOptions) => {
      const flags = parseGlobalFlags(opts);
      await showHandler({ ...opts, ...flags });
    });

  policy
    .command('eval')
    .description('Evaluate policy gates for a given entity or decision source')
    .option('--entity-id <id>', 'Entity ID to evaluate trust gate for')
    .option('--trust-score <score>', 'Entity trust score (0-1)', parseFloat)
    .addOption(
      new Option(
        '--decision-source <source>',
        'Decision source to check approval gate for'
      ).choices([...DECISION_SOURCE_VALUES])
    )
    .option('--policy-file <path>', 'Explicit path to a policy YAML file')
    .option('--spec-dir <path>', 'Spec directory containing *.policy.yml files')
    .option('--json', 'Emit output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(async (opts: PolicyEvalOptions) => {
      const flags = parseGlobalFlags(opts);
      await evalHandler({ ...opts, ...flags });
    });
}
