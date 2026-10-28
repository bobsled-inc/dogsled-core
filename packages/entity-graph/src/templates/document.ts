/**
 * Document entity-resolution template.
 *
 * Emitted by the explicit `entity-graph scaffold document` workflow.
 * Documents resolve deterministically on `document_id` (content_hash-derived);
 * chunks are NOT entities — they're content rows queried by FK from
 * `__document_mentions.chunk_id`.
 *
 * Clustering is explicitly disabled: entity-graph clustering at chunk scale
 * is O(n²) and would blow up the 10M-chunk fixture. Documents have 1:1
 * deterministic identity, so clustering is unnecessary.
 *
 * Inputs are validated against `IDENTIFIER_PATTERN` before YAML
 * interpolation.
 */

import { CommandError } from '@bobsled-inc/protocol';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string, slot: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new CommandError(
      `Invalid ${slot} '${value}': must match ${IDENTIFIER_PATTERN.source}`,
      2
    );
  }
  return value;
}

export interface DocumentTemplateOptions {
  resourceName: string;
  /** Override the `recency` survivorship column (default: extracted_at). */
  recencyColumn?: string;
}

export function renderDocumentResolutionSpec(options: DocumentTemplateOptions): string {
  const resourceName = assertIdentifier(options.resourceName, 'resourceName');
  const recencyColumn = assertIdentifier(options.recencyColumn ?? 'extracted_at', 'recencyColumn');
  return `spec_version: '0.2'
name: ${resourceName}_document_resolution
type: resolution
description: Auto-generated document entity resolution for ${resourceName}.

inputs:
  - ref: ${resourceName}.${resourceName}__documents
    role: internal
    trust_tier: silver
    id_fields: [document_id]

# Documents resolve deterministically on document_id (a content-hash-derived
# stable identity from the chunker). No fuzzy scoring needed.
deterministic_rules:
  - name: by_document_id
    conditions:
      - field: document_id
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0

scoring:
  method: weighted_features
  features:
    - field: document_id
      algorithm: exact
      weight: 1.0

thresholds:
  auto_merge: 1.0
  review: 1.0
  auto_reject: 0.0

# Survivorship — most-recent-extraction wins on content fields.
survivorship:
  content:
    strategy: recency
    on: ${recencyColumn}
`;
}

export const DOCUMENT_TEMPLATE_VERSION = '1';
