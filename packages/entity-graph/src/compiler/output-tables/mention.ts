/**
 * `__document_mentions` table contract.
 *
 * `mention_id` PK includes `span_end` to prevent overlap collisions.
 */

import type { OutputTableDef } from './index.js';

export const MENTION_OUTPUT_TABLES = (
  [
    {
      suffix: '__document_mentions',
      stage: 'semantic',
      ddlStrategy: 'create_if_not_exists',
      visibility: 'public',
      columns: [
        { name: 'mention_id', type: 'STRING' },
        { name: 'chunk_id', type: 'STRING' },
        { name: 'document_version_id', type: 'STRING' },
        { name: 'document_id', type: 'STRING' },
        { name: 'entity_type', type: 'STRING' },
        { name: 'entity_name', type: 'STRING' },
        { name: 'confidence', type: 'FLOAT' },
        { name: 'span_start', type: 'INTEGER' },
        { name: 'span_end', type: 'INTEGER' },
        { name: 'resolved_entity_id', type: 'STRING', nullable: true },
        { name: 'resolution_method', type: 'STRING' },
        { name: 'resolution_confidence', type: 'FLOAT' },
        { name: 'superseded_at', type: 'TIMESTAMP', nullable: true },
        { name: 'extracted_at', type: 'TIMESTAMP' },
        { name: 'extraction_role', type: 'STRING' },
        { name: 'notes', type: 'STRING', nullable: true },
      ],
    },
  ] as const satisfies readonly OutputTableDef[]
).slice();

export const MENTION_QUALITY_VIEW_TABLES = (
  [
    {
      suffix: '__document_mentions__quality',
      stage: 'semantic',
      kind: 'view',
      ddlStrategy: 'create_or_replace',
      visibility: 'public',
      columns: [
        { name: 'mention_id', type: 'STRING' },
        { name: 'mention_confidence', type: 'FLOAT' },
        { name: 'freshness_age_seconds', type: 'INTEGER' },
        { name: 'source_diversity', type: 'INTEGER' },
        { name: 'profile_coverage', type: 'FLOAT' },
      ],
    },
  ] as const satisfies readonly OutputTableDef[]
).slice();
