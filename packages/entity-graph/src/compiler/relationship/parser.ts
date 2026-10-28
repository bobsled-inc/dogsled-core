import * as fs from 'node:fs';

import YAML from 'yaml';
import { collectYamlFiles, EntityRelationshipSpecSchema } from '@bobsled-inc/model-spec';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';

import type { ParsedEntityRelationshipSpec, ResolvedEntityRelationshipSpec } from './types.js';

export function parseEntityRelationshipSpec(filePath: string): ParsedEntityRelationshipSpec {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw: unknown = YAML.parse(content);

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid YAML in ${filePath}`);
  }

  const rawObj = raw as Record<string, unknown>;
  if (rawObj.type !== 'entity_relationship') {
    throw new Error(
      `${filePath} is not an entity relationship spec (type: ${String(rawObj.type)})`
    );
  }

  const parsed = EntityRelationshipSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      formatSpecValidationMessage('entity_relationship', filePath, parsed.error, {
        schema: EntityRelationshipSpecSchema,
      })
    );
  }

  return {
    name: parsed.data.name,
    filePath,
    raw: parsed.data,
  };
}

export function discoverEntityRelationshipSpecs(
  entityGraphDir: string
): ParsedEntityRelationshipSpec[] {
  const specs: ParsedEntityRelationshipSpec[] = [];
  if (!fs.existsSync(entityGraphDir)) return specs;

  const yamlFiles = collectYamlFiles(entityGraphDir);
  for (const filePath of yamlFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw: unknown = YAML.parse(content);
      if (
        !raw ||
        typeof raw !== 'object' ||
        (raw as Record<string, unknown>).type !== 'entity_relationship'
      ) {
        continue;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse entity relationship spec ${filePath}: ${msg}`);
    }

    specs.push(parseEntityRelationshipSpec(filePath));
  }

  return specs;
}

export function resolveEntityRelationshipSpec(
  parsed: ParsedEntityRelationshipSpec,
  targetSchema: string
): ResolvedEntityRelationshipSpec {
  const raw = parsed.raw;
  return {
    name: raw.name,
    description: raw.description,
    leftEntity: raw.left_entity,
    rightEntity: raw.right_entity,
    joinColumns: raw.join_columns,
    joinType: raw.join_type,
    relationshipType: raw.relationship_type,
    confidenceScoring: raw.confidence_scoring,
    review: raw.review,
    tags: raw.tags,
    targetSchema,
  };
}
