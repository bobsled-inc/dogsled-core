/**
 * Metric spec — a named semantic measure layered on top of a Model Spec dataset.
 *
 * Metrics are metadata entities: they don't produce DDL, they describe how the
 * downstream (host application, BI tool, agent) should read a derived value out of one
 * or more source or derived models. The compiler parses them, validates their references, and
 * emits them as JSON alongside the SQL when `--include-metadata` is set.
 *
 * Shape mirrors the Notion sub-spec (`metrics` section) + the existing host application
 * `metric_definitions` table so the Data Estate UI can consume both without
 * translation.
 *
 * Validation that reaches beyond one file — checking that `model` / `models`
 * point at real datasets in the project — lives in
 * `src/entities/cross-references.ts`.
 */

import { z } from 'zod';

import { identifierMsg, identifierRegex } from '../compiler/shared-validators.js';
import { EntityInterchangeSchema } from '../interchange/storage.js';
import {
  AiContextSchema,
  DatasetReferenceSchema,
  OssieLogicalDataTypeSchema,
  SemanticExpressionSchema,
  SynonymsSchema,
} from './semantic-metadata.js';

export const MetricSpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('metric'),
    name: z.string().trim().min(1, 'Metric name is required').regex(identifierRegex, identifierMsg),
    description: z.string().optional(),

    /** Single-dataset metric: the source or derived model the expression uses. */
    model: DatasetReferenceSchema.optional(),

    /**
     * Multi-dataset metric: the sources or derived models the expression spans.
     *
     * At least one of `model` or `models` must be set — enforced below.
     */
    models: z.array(DatasetReferenceSchema).min(1).optional(),

    /**
     * SQL-ish expression defining the metric. Tokens in `{…}` are resolved to
     * qualified identifiers at query time; cross-reference validation checks
     * they correspond to known models or source-qualified columns.
     */
    expression: z.string().trim().min(1, 'Metric expression is required'),

    datatype: OssieLogicalDataTypeSchema.optional(),
    semantic_expression: SemanticExpressionSchema.optional(),
    ai_context: AiContextSchema.optional(),
    interchange: EntityInterchangeSchema.optional(),

    /** Optional free-form alternative names used for NL → metric resolution. */
    synonyms: SynonymsSchema.optional(),

    /** Optional tags used by the Data Estate UI for filtering. */
    tags: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine((val) => val.model !== undefined || (val.models !== undefined && val.models.length > 0), {
    message: 'Metric must declare at least one of "model" or "models"',
    path: ['model'],
  });

export type MetricSpec = z.infer<typeof MetricSpecSchema>;
