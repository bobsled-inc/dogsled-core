import * as fs from 'node:fs';

import YAML from 'yaml';
import { RelationshipExtractionSpecSchema } from '@bobsled-inc/model-spec';
import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';

import { discoverSpecsOfType } from '../parse-utils.js';
import type { RelationshipExtractionSpec } from '@bobsled-inc/model-spec';

interface RawSpecEnvelope {
  type?: unknown;
}

export interface ParsedRelationshipExtractionSpec {
  name: string;
  filePath: string;
  raw: RelationshipExtractionSpec;
}

function parseSpecFromRaw(filePath: string, raw: unknown): ParsedRelationshipExtractionSpec {
  if (!raw || typeof raw !== 'object') {
    throw new CommandError(`Invalid YAML in ${filePath}`, 2);
  }

  const rawObj = raw as RawSpecEnvelope;
  if (rawObj.type !== 'relationship_extraction') {
    throw new CommandError(
      `${filePath} is not a relationship extraction spec (type: ${String(rawObj.type)})`,
      2
    );
  }

  const parsed = RelationshipExtractionSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('relationship_extraction', filePath, parsed.error, {
        schema: RelationshipExtractionSpecSchema,
      }),
      2
    );
  }

  return { name: parsed.data.name, filePath, raw: parsed.data };
}

export function parseRelationshipExtractionSpec(
  filePath: string
): ParsedRelationshipExtractionSpec {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(
      `Failed to read relationship extraction spec ${filePath}: ${message}`,
      2
    );
  }

  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Invalid YAML in ${filePath}: ${message}`, 2);
  }
  return parseSpecFromRaw(filePath, raw);
}

export function discoverRelationshipExtractionSpecs(
  mdmDir: string
): ParsedRelationshipExtractionSpec[] {
  return discoverSpecsOfType(mdmDir, 'relationship_extraction', parseSpecFromRaw, {
    label: 'relationship extraction',
    makeError: (message) => new CommandError(message, 2),
  });
}

export function validateRelationshipExtractionOntologyRefs(
  extractionSpecs: readonly ParsedRelationshipExtractionSpec[],
  ontologyNames: ReadonlySet<string>
): void {
  const missing = extractionSpecs.filter((spec) => !ontologyNames.has(spec.raw.ontology_ref));
  if (missing.length === 0) return;
  throw new CommandError(
    'Invalid relationship extraction ontology_ref:\n' +
      missing
        .map(
          (spec) =>
            `relationship_extraction '${spec.name}' references unknown ontology_ref ` +
            `'${spec.raw.ontology_ref}'`
        )
        .join('\n'),
    2
  );
}
