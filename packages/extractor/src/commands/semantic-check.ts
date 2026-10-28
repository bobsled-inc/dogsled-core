import { CommandError } from '@bobsled-inc/protocol';

import { inferSemanticRole } from '../model-spec/generate-source.js';

import type { ResourceSpec } from '../types/index.js';

export type SemanticCheckMode = 'off' | 'warn' | 'strict';

export interface SemanticFinding {
  field: string;
  message: string;
}

export function normalizeSemanticCheckMode(value: boolean | string | undefined): SemanticCheckMode {
  if (value === undefined || value === false || value === 'off') {
    return 'off';
  }
  if (value === true || value === 'warn') {
    return 'warn';
  }
  if (value === 'strict') {
    return 'strict';
  }
  throw new CommandError(
    `Invalid --semantic-check mode "${String(value)}". Expected "off", "warn", or "strict".`
  );
}

function isMissingText(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

export function checkSemanticMetadata(resource: ResourceSpec): SemanticFinding[] {
  const findings: SemanticFinding[] = [];

  for (const [fieldName, field] of Object.entries(resource.output)) {
    if (isMissingText(field.description)) {
      findings.push({
        field: fieldName,
        message: `output field "${fieldName}" is missing description`,
      });
    }

    if (!field.semantic_role) {
      const inferredRole = inferSemanticRole(fieldName, field.type);
      findings.push({
        field: fieldName,
        message: inferredRole
          ? `output field "${fieldName}" is missing semantic_role (inferred candidate: ${inferredRole})`
          : `output field "${fieldName}" is missing semantic_role`,
      });
    }
  }

  return findings;
}
