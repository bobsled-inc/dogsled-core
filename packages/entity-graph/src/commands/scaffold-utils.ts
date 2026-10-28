import * as fs from 'node:fs';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';
import {
  loadProjectConfig,
  resolveConfig,
  resolvePathWithinDir,
  validateScaffoldName,
} from '@bobsled-inc/model-spec/shared';

export interface EntityGraphScaffoldPaths {
  cwd: string;
  entityGraphDir: string;
  entityGraphDirName: string;
}

export interface WrittenScaffoldFile {
  path: string;
  kind: string;
  created: boolean;
}

export function resolveEntityGraphScaffoldPaths(cwd = process.cwd()): EntityGraphScaffoldPaths {
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig({}, config);
  return {
    cwd,
    entityGraphDir: path.join(cwd, resolved.entityGraphDir),
    entityGraphDirName: resolved.entityGraphDir,
  };
}

function writeNewFile(filePath: string, content: string, kind: string): WrittenScaffoldFile {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = content.endsWith('\n') ? content : `${content}\n`;
  try {
    const fd = fs.openSync(filePath, 'wx');
    try {
      fs.writeFileSync(fd, body, 'utf-8');
    } finally {
      fs.closeSync(fd);
    }
    return { path: filePath, kind, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { path: filePath, kind, created: false };
    }
    throw err;
  }
}

export function buildStarterResolutionYaml(entity: string): string {
  const safeEntity = validateScaffoldName(entity, 'Entity name');
  return [
    `spec_version: '0.2'`,
    `name: ${safeEntity}_resolution`,
    `type: resolution`,
    `description: Resolve ${safeEntity} records across source systems.`,
    ``,
    `inputs:`,
    `  - ref: source.primary_${safeEntity}`,
    `    role: internal`,
    `    id_fields: [id]`,
    `  - ref: source.secondary_${safeEntity}`,
    `    role: provider`,
    `    id_fields: [id]`,
    ``,
    `standardize:`,
    `  - field: name`,
    `    transforms: [lowercase, collapse_whitespace]`,
    ``,
    `blocking:`,
    `  rules:`,
    `    - name: exact_name`,
    `      key: standardized_name`,
    ``,
    `scoring:`,
    `  method: weighted_features`,
    `  features:`,
    `    - field: standardized_name`,
    `      algorithm: jaro_winkler`,
    `      weight: 1.0`,
    ``,
    `thresholds:`,
    `  auto_merge: 0.95`,
    `  review: 0.6`,
    `  auto_reject: 0.4`,
  ].join('\n');
}

export function writeStarterResolutionSpec(
  paths: EntityGraphScaffoldPaths,
  entity: string
): WrittenScaffoldFile {
  const safeEntity = validateScaffoldName(entity, 'Entity name');
  const filePath = resolvePathWithinDir(
    paths.entityGraphDir,
    `${safeEntity}_resolution.yml`,
    'Resolution scaffold path'
  );
  return writeNewFile(filePath, buildStarterResolutionYaml(safeEntity), 'resolution');
}

export function writeStarterOntology(
  paths: EntityGraphScaffoldPaths,
  entity = 'company'
): WrittenScaffoldFile {
  const safeEntity = validateScaffoldName(entity, 'Entity name');
  const filePath = resolvePathWithinDir(
    paths.entityGraphDir,
    'relationship_ontology.yml',
    'Relationship ontology scaffold path'
  );
  return writeNewFile(
    filePath,
    [
      `spec_version: '0.2'`,
      `type: relationship_ontology`,
      `name: default_relationships`,
      `relations:`,
      `  - relation_type: related_to`,
      `    description: A generic relationship between two resolved entities.`,
      `    left_entity: ${safeEntity}`,
      `    right_entity: ${safeEntity}`,
      `    direction: symmetric`,
      `    cardinality: many_to_many`,
      `    aliases: []`,
      `    exclusive_with: []`,
      `    temporal: stateful`,
      `    review_thresholds:`,
      `      auto_confirm: 0.92`,
      `      review: 0.55`,
      `      auto_reject: 0.3`,
    ].join('\n'),
    'relationship_ontology'
  );
}

export function writeStarterMentionExtraction(
  paths: EntityGraphScaffoldPaths,
  entity: string
): WrittenScaffoldFile {
  const safeEntity = validateScaffoldName(entity, 'Entity name');
  const filePath = resolvePathWithinDir(
    paths.entityGraphDir,
    `${safeEntity}_mention_extraction.yml`,
    'Mention extraction scaffold path'
  );
  return writeNewFile(
    filePath,
    [
      `spec_version: '0.2'`,
      `type: mention_extraction`,
      `name: ${safeEntity}_mentions`,
      `entity_types: [${safeEntity}]`,
      `ontology_ref: default_relationships`,
      `candidate_retrieval:`,
      `  strategy: hybrid`,
      `  k: 10`,
      `  min_similarity: 0.55`,
      `extraction_role: mention_disambiguation_v1`,
    ].join('\n'),
    'mention_extraction'
  );
}

export function writeStarterRelationshipExtraction(
  paths: EntityGraphScaffoldPaths,
  entity: string
): WrittenScaffoldFile {
  const safeEntity = validateScaffoldName(entity, 'Entity name');
  const filePath = resolvePathWithinDir(
    paths.entityGraphDir,
    `${safeEntity}_relationship_extraction.yml`,
    'Relationship extraction scaffold path'
  );
  return writeNewFile(
    filePath,
    [
      `spec_version: '0.2'`,
      `type: relationship_extraction`,
      `name: ${safeEntity}_relationships`,
      `ontology_ref: default_relationships`,
      `chunk_filter:`,
      `  has_resolved_mentions_min: 2`,
      `candidate_pair_rules:`,
      `  max_pairs_per_chunk: 8`,
      `  same_chunk_only: true`,
      `extraction:`,
      `  role: relationship_extraction_v1`,
      `  prompt_version: v1`,
      `  constrained_decoding: true`,
      `  require_span_evidence: true`,
      `review:`,
      `  use_ontology_thresholds: true`,
    ].join('\n'),
    'relationship_extraction'
  );
}

export function assertNoExistingCreated(files: readonly WrittenScaffoldFile[]): void {
  const conflicts = files.filter((file) => !file.created);
  if (conflicts.length === 0) return;
  throw new CommandError(
    `Scaffold already exists: ${conflicts.map((file) => file.path).join(', ')}`,
    2
  );
}
