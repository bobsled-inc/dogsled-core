/**
 * Shared helpers for the `entity-graph review` command family: spec-backed
 * target resolution plus the batch-id / content-hash / stdin utilities used
 * by the apply, decide, and unmerge subcommands. Split out of `review.ts` to
 * respect the source-file budget.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { CommandError } from '@bobsled-inc/protocol';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { loadProjectConfig, parseGlobalFlags, resolveConfig } from '@bobsled-inc/model-spec/shared';
import { discoverResolutionSpecs } from '../compiler/identity/parser.js';

export interface ReviewTarget {
  entity: string;
  name: string;
  schema: string;
  midpoint: number;
  defaultApplyThreshold: number;
}

/** Schema/dialect overrides shared by every review subcommand. */
export interface ReviewTargetOptions {
  schema?: string;
  dialect?: SupportedDialect;
}

/** Program-level flags forwarded from the CLI entrypoint. */
export interface ReviewGlobalFlags {
  verbose?: boolean;
  quiet?: boolean;
}

/** Resolved review targets plus the effective dialect / quiet flags. */
export interface ResolvedReviewTargets {
  dialect: SupportedDialect;
  quiet: boolean;
  targets: ReviewTarget[];
}

/** Collapse spec aliases like `company_resolution` to their entity name. */
function normalizeEntityName(value: string): string {
  return value.replace(/_resolution$/, '');
}

/** Resolve review targets from on-disk Entity Graph specs and preserve spec-level overrides. */
export function resolveReviewTargets(
  entityNames: string[],
  options: ReviewTargetOptions,
  globalOptions: ReviewGlobalFlags
): ResolvedReviewTargets {
  const flags = parseGlobalFlags(globalOptions);
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);

  const resolved = resolveConfig(
    {
      dialect: options.dialect,
      schema: options.schema,
    },
    config
  );

  const entityGraphDir = path.join(cwd, resolved.entityGraphDir);
  const requested = new Set(entityNames.map((value) => value.toLowerCase()));
  const specBackedTargets: ReviewTarget[] = [];

  if (fs.existsSync(entityGraphDir)) {
    const parsedSpecs = discoverResolutionSpecs(entityGraphDir);
    for (const parsed of parsedSpecs) {
      const entity = normalizeEntityName(parsed.raw.name);
      specBackedTargets.push({
        entity,
        name: parsed.raw.name,
        schema: parsed.raw.outputs?.target_schema ?? resolved.schema,
        midpoint: ((parsed.raw.thresholds.auto_merge ?? 1) + parsed.raw.thresholds.review) / 2,
        defaultApplyThreshold: parsed.raw.agent_policy?.auto_apply_threshold ?? 0.75,
      });
    }
  }

  if (requested.size === 0) {
    return { dialect: resolved.dialect, quiet: flags.quiet, targets: specBackedTargets };
  }

  const targets = specBackedTargets.filter(
    (target) =>
      requested.has(target.entity.toLowerCase()) || requested.has(target.name.toLowerCase())
  );

  if (targets.length > 0) {
    return { dialect: resolved.dialect, quiet: flags.quiet, targets };
  }

  if (specBackedTargets.length > 0) {
    const message = `No resolution specs found matching: ${entityNames.join(', ')}`;
    throw new CommandError(message, 2, {
      valid: false,
      errorCode: 'RESOLUTION_SPEC_NOT_FOUND',
      errors: [{ path: 'entity', message }],
    });
  }

  const message = `No resolution specs found in ${resolved.entityGraphDir}/. Review commands require a matching resolution spec.`;
  throw new CommandError(message, 2, {
    valid: false,
    errorCode: 'NO_RESOLUTION_SPECS',
    errors: [{ path: resolved.entityGraphDir, message }],
  });
}

export function buildDecisionBatchId(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry === undefined ? null : entry)).join(',')}]`;
  }
  if (value != null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function buildContentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}
