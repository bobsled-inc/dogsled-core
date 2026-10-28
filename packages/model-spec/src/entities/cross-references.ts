/**
 * Cross-reference validation for metadata entities.
 *
 * After `loadMetadataRegistry` parses every metric / relationship / VQ file in
 * isolation, this module checks the remaining invariants that span the project
 * graph:
 *
 *   - bare metric and relationship references must be known model names
 *   - qualified metric and relationship references must be known source keys
 *   - VQ {ref} tokens must resolve to a known model or source
 *   - VQ connection (when set) must be a declared integration handle
 *
 * All errors aggregate into a single `CommandError(2)` so the user sees every
 * broken reference in one pass.
 */

import { CommandError } from '../errors.js';

import type { EntityRelationshipSpec } from './entity-relationship.js';
import type { MetricSpec } from './metric.js';
import type { RelationshipSpec } from './relationship.js';
import { extractVqSqlTokens, type VqSpec } from './vq.js';

export interface MetadataValidationContext {
  /** Names of every model in the project's `models/` DAG. */
  modelNames: ReadonlySet<string>;
  /**
   * Source registry keys from `buildSourceRegistry`, shape `<handle>.<source_name>`.
   * Used to resolve VQ `{handle.source}` tokens.
   */
  sourceKeys: ReadonlySet<string>;
  /** Integration handles declared under `<integrations_dir>`. */
  integrationHandles: ReadonlySet<string>;
}

function datasetReferenceKind(reference: string): 'model' | 'source' {
  return reference.includes('.') ? 'source' : 'model';
}

function datasetReferenceExists(reference: string, ctx: MetadataValidationContext): boolean {
  return datasetReferenceKind(reference) === 'source'
    ? ctx.sourceKeys.has(reference)
    : ctx.modelNames.has(reference);
}

function validateMetric(spec: MetricSpec, ctx: MetadataValidationContext, errors: string[]): void {
  const referenced = new Set<string>();
  if (spec.model !== undefined) referenced.add(spec.model);
  for (const m of spec.models ?? []) referenced.add(m);

  for (const name of referenced) {
    if (!datasetReferenceExists(name, ctx)) {
      errors.push(
        `metric "${spec.name}" references unknown ${datasetReferenceKind(name)} "${name}"`
      );
    }
  }
}

function validateRelationship(
  spec: RelationshipSpec,
  ctx: MetadataValidationContext,
  errors: string[]
): void {
  if (!datasetReferenceExists(spec.left_model, ctx)) {
    errors.push(
      `relationship "${spec.name}" references unknown left_model "${spec.left_model}" (${datasetReferenceKind(spec.left_model)})`
    );
  }
  if (!datasetReferenceExists(spec.right_model, ctx)) {
    errors.push(
      `relationship "${spec.name}" references unknown right_model "${spec.right_model}" (${datasetReferenceKind(spec.right_model)})`
    );
  }
}

function validateVq(spec: VqSpec, ctx: MetadataValidationContext, errors: string[]): void {
  if (spec.connection !== undefined && ctx.integrationHandles.size > 0) {
    if (!ctx.integrationHandles.has(spec.connection)) {
      errors.push(
        `VQ "${spec.name}" pins to integration "${spec.connection}" but no such handle is declared`
      );
    }
  }

  const parameterNames = new Set((spec.parameters ?? []).map((parameter) => parameter.name));
  const tokens = extractVqSqlTokens(spec.sql);
  for (const token of tokens) {
    if (token.segments.length === 1) {
      // Model reference — must be a known model name.
      const name = token.segments[0]!;
      if (parameterNames.has(name)) continue;
      if (!ctx.modelNames.has(name)) {
        errors.push(
          `VQ "${spec.name}" references unknown model token ${token.raw} (no model named "${name}")`
        );
      }
    } else if (token.segments.length === 2) {
      // Source reference — `<handle>.<source_name>`. Shape must appear in sourceKeys.
      const [handle, sourceName] = token.segments as [string, string];
      const key = `${handle}.${sourceName}`;
      if (!ctx.sourceKeys.has(key)) {
        errors.push(
          `VQ "${spec.name}" references unknown source token ${token.raw} ` +
            `(no source "${sourceName}" under integration "${handle}")`
        );
      }
    } else {
      errors.push(`VQ "${spec.name}" contains malformed token ${token.raw}`);
    }
  }
}

/**
 * Run cross-reference checks for every metadata entity in the registry. Emits
 * a single, aggregated `CommandError(2)` when at least one reference is
 * broken. Silently succeeds on empty maps — Model Spec projects without metrics /
 * relationships / VQs are legal.
 */
export function validateMetadataReferences(
  registry: {
    metrics: Map<string, MetricSpec>;
    relationships: Map<string, RelationshipSpec>;
    entityRelationships?: Map<string, EntityRelationshipSpec>;
    vqs: Map<string, VqSpec>;
  },
  ctx: MetadataValidationContext
): void {
  const errors: string[] = [];

  for (const metric of registry.metrics.values()) {
    validateMetric(metric, ctx, errors);
  }
  for (const relationship of registry.relationships.values()) {
    validateRelationship(relationship, ctx, errors);
  }
  for (const vq of registry.vqs.values()) {
    validateVq(vq, ctx, errors);
  }

  if (errors.length > 0) {
    const bullets = errors.map((e) => `  - ${e}`).join('\n');
    throw new CommandError(
      `Metadata validation failed:\n${bullets}\nFix the references above and retry.`,
      2
    );
  }
}
