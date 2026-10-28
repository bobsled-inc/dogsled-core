import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';
import { collectYamlFiles } from '@bobsled-inc/model-spec';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';
import type { ResolvedEntityRelationshipSpec } from '../relationship/types.js';
import { ObjectSpecSchema } from './schema.js';
import type { ParsedObjectSpec, ResolvedObjectSpec } from './types.js';

interface TypeTaggedYaml {
  type?: unknown;
}

function hasTypeTag(value: unknown): value is TypeTaggedYaml {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function parseSpecFromRaw(filePath: string, raw: unknown): ParsedObjectSpec {
  if (!hasTypeTag(raw)) {
    throw new Error(`Invalid YAML in ${filePath}`);
  }

  if (raw.type !== 'object') {
    throw new Error(`${filePath} is not an object spec (type: ${String(raw.type)})`);
  }

  const parsed = ObjectSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      formatSpecValidationMessage('object', filePath, parsed.error, {
        schema: ObjectSpecSchema,
      })
    );
  }

  return {
    name: parsed.data.name,
    filePath,
    raw: parsed.data,
  };
}

export function parseObjectSpec(filePath: string): ParsedObjectSpec {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw: unknown = YAML.parse(content);
  return parseSpecFromRaw(filePath, raw);
}

export function discoverObjectSpecs(entityGraphDir: string): ParsedObjectSpec[] {
  const specs: ParsedObjectSpec[] = [];
  if (!fs.existsSync(entityGraphDir)) return specs;

  const yamlFiles = collectYamlFiles(entityGraphDir);
  for (const filePath of yamlFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw: unknown = YAML.parse(content);
      if (!hasTypeTag(raw) || raw.type !== 'object') {
        continue;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse object spec ${filePath}: ${msg}`);
    }

    specs.push(parseObjectSpec(filePath));
  }

  return specs;
}

function relationRefCandidates(parsed: ParsedObjectSpec, relationRef: string): string[] {
  const refBase = path
    .basename(relationRef)
    .replace(/\.(entity-relationship|relationship)\.ya?ml$/, '');
  const resolvedRef = path.resolve(path.dirname(parsed.filePath), relationRef);
  return [relationRef, refBase, resolvedRef];
}

export function resolveObjectSpec(
  parsed: ParsedObjectSpec,
  relationships: readonly ResolvedEntityRelationshipSpec[],
  relationshipFilePaths: ReadonlyMap<string, string> = new Map()
): ResolvedObjectSpec {
  const relationshipByName = new Map(relationships.map((spec) => [spec.name, spec]));
  const relationshipByPath = new Map<string, ResolvedEntityRelationshipSpec>();
  for (const relationship of relationships) {
    const filePath = relationshipFilePaths.get(relationship.name);
    if (filePath) {
      relationshipByPath.set(path.resolve(filePath), relationship);
    }
  }

  const links = parsed.raw.links.map((link) => {
    const candidates = relationRefCandidates(parsed, link.relation_ref);
    const relationship =
      candidates.map((candidate) => relationshipByName.get(candidate)).find(Boolean) ??
      candidates.map((candidate) => relationshipByPath.get(candidate)).find(Boolean);
    if (!relationship) {
      throw new Error(
        `Invalid object spec ${parsed.filePath}: unknown relation_ref ${link.relation_ref}`
      );
    }
    return {
      relationRef: link.relation_ref,
      relationName: relationship.name,
      direction: link.direction,
    };
  });

  const actions = parsed.raw.actions.map((action) => ({
    actionRef: action.action_ref,
    label: action.label,
  }));

  return {
    name: parsed.raw.name,
    identityResolutionRef: parsed.raw.identity.resolution_ref,
    links,
    actions,
  };
}
