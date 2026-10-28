import { type Command } from 'commander';

import {
  registerRelationshipsReviewApplyCommand,
  type RelationshipsReviewApplyOptions,
} from './relationships-review-apply.js';
import {
  registerRelationshipsCompactCommand,
  type RelationshipsCompactOptions,
} from './relationships-compact.js';
import {
  registerRelationshipsReviewExportCommand,
  type RelationshipsReviewExportOptions,
} from './relationships-review-export.js';
import {
  registerRelationshipsExtractCommand,
  type RelationshipsExtractOptions,
} from './relationships-extract.js';

export interface RelationshipsCommandOptions {
  exportOptions?: RelationshipsReviewExportOptions;
  applyOptions?: RelationshipsReviewApplyOptions;
  compactOptions?: RelationshipsCompactOptions;
  extractOptions?: RelationshipsExtractOptions;
}

export function registerRelationshipsCommand(
  program: Command,
  options: RelationshipsCommandOptions = {}
): void {
  const relationships = program
    .command('relationships')
    .description('Relationship extraction, review, and compaction workflows');

  const review = relationships
    .command('review')
    .description('Review queue workflows for __entity_relationship_evidence rows');

  registerRelationshipsExtractCommand(relationships, options.extractOptions ?? {});
  registerRelationshipsReviewExportCommand(review, options.exportOptions ?? {});
  registerRelationshipsReviewApplyCommand(review, options.applyOptions ?? {});
  registerRelationshipsCompactCommand(relationships, options.compactOptions ?? {});
}
