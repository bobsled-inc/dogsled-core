import { MetricSpecSchema, RelationshipSpecSchema, VqSpecSchema } from '../entities/index.js';

import { finishEdit, loadEditableDocument } from './common.js';
import { findEditTarget } from './find-spec-file.js';
import { applyPatch } from './yaml-document.js';

import type { EditFileResult, EditOptions, EditResult } from './types.js';
import type { z } from 'zod';

export type MetricPatch = Partial<{
  description: string;
  expression: string;
  model: string;
  models: string[];
  synonyms: string[];
  tags: string[];
}>;

export type RelationshipPatch = Partial<{
  description: string;
  join_type: string;
  relationship_type: string;
  tags: string[];
}>;

export type VqPatch = Partial<{ description: string; nlq: string; sql: string; tags: string[] }>;

export interface UpdateMetricOptions extends EditOptions {
  metricName: string;
  patch: MetricPatch;
}

export interface UpdateRelationshipOptions extends EditOptions {
  relationshipName: string;
  patch: RelationshipPatch;
}

export interface UpdateVqOptions extends EditOptions {
  vqName: string;
  patch: VqPatch;
}

type MetadataPatch = MetricPatch | RelationshipPatch | VqPatch;

export function updateMetric(opts: UpdateMetricOptions): EditResult<EditFileResult> {
  return updateMetadata(opts, 'metric', opts.metricName, opts.patch, MetricSpecSchema);
}

export function updateRelationship(opts: UpdateRelationshipOptions): EditResult<EditFileResult> {
  return updateMetadata(
    opts,
    'relationship',
    opts.relationshipName,
    opts.patch,
    RelationshipSpecSchema
  );
}

export function updateVq(opts: UpdateVqOptions): EditResult<EditFileResult> {
  return updateMetadata(opts, 'vq', opts.vqName, opts.patch, VqSpecSchema);
}

function updateMetadata(
  opts: EditOptions,
  entityType: 'metric' | 'relationship' | 'vq',
  entityName: string,
  patch: MetadataPatch,
  schema: z.ZodType<unknown>
): EditResult<EditFileResult> {
  const found = findEditTarget(opts, entityType, entityName);
  if (!found.ok) return found;
  const doc = loadEditableDocument(found.data);
  if (!doc.ok) return doc;
  applyPatch(doc.data, [], patch);
  return finishEdit(opts, found.data, doc.data, schema);
}
