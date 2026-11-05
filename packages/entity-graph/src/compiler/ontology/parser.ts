import { scanProject } from '@bobsled-inc/project-index';
import { loadOntologyCatalog } from '@bobsled-inc/model-spec/ontology';
import { resolveCustomerOntologyReference } from './customer-reference.js';
import * as fs from 'node:fs';

import YAML from 'yaml';
import { RelationshipOntologySpecSchema } from '@bobsled-inc/model-spec';
import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';

import { discoverSpecsOfType } from '../parse-utils.js';
import type { ParsedRelationshipOntologySpec, ResolvedRelationshipOntology } from './types.js';

interface RelationshipOntologyEnvelope {
  type?: unknown;
}

function parseSpecFromRaw(filePath: string, raw: unknown): ParsedRelationshipOntologySpec {
  if (!raw || typeof raw !== 'object') {
    throw new CommandError(`Invalid YAML in ${filePath}`, 2);
  }

  const rawObj = raw as RelationshipOntologyEnvelope;
  if (rawObj.type !== 'relationship_ontology') {
    throw new CommandError(
      `${filePath} is not a relationship ontology spec (type: ${String(rawObj.type)})`,
      2
    );
  }

  const parsed = RelationshipOntologySpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('relationship_ontology', filePath, parsed.error, {
        schema: RelationshipOntologySpecSchema,
      }),
      2
    );
  }

  return { name: parsed.data.name, filePath, raw: parsed.data };
}

export function parseRelationshipOntologySpec(filePath: string): ParsedRelationshipOntologySpec {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Failed to read ${filePath}: ${message}`, 2);
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

export function discoverRelationshipOntologySpecs(
  mdmDir: string,
  projectRoot: string = mdmDir
): ParsedRelationshipOntologySpec[] {
  const specs = discoverSpecsOfType(mdmDir, 'relationship_ontology', parseSpecFromRaw, {
    label: 'relationship ontology',
    makeError: (message) => new CommandError(message, 2),
  });
  if (specs.some((spec) => spec.raw.relations.some((relation) => relation.ontology_ref))) {
    const catalog = loadOntologyCatalog(scanProject(projectRoot));
    for (const spec of specs) spec.customerOntologyCatalog = catalog;
  }
  return specs;
}

export function resolveRelationshipOntologySpec(
  parsed: ParsedRelationshipOntologySpec
): ResolvedRelationshipOntology {
  const relations = parsed.raw.relations.map((relation) => {
    if (!relation.ontology_ref) return relation;
    if (!parsed.customerOntologyCatalog) {
      throw new CommandError('Resolve customer ontology references with the project catalog.', 2);
    }
    const shared = resolveCustomerOntologyReference(
      parsed.customerOntologyCatalog,
      relation.ontology_ref,
      relation.cardinality
    );
    if (relation.description && relation.description !== shared.description) {
      throw new CommandError(
        'Local relationship description conflicts with the customer ontology.',
        2
      );
    }
    return { ...relation, description: shared.description };
  });
  const entityTypes = new Set<string>();
  for (const relation of relations) {
    entityTypes.add(relation.left_entity);
    entityTypes.add(relation.right_entity);
  }

  return {
    name: parsed.raw.name,
    ontologyVersion: `${parsed.raw.name}@${parsed.raw.spec_version}${parsed.customerOntologyCatalog ? `:${parsed.customerOntologyCatalog.version}` : ''}`,
    relations,
    relationTypes: parsed.raw.relations.map((relation) => relation.relation_type),
    entityTypes: [...entityTypes].sort(),
  };
}
