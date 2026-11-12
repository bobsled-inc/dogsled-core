import { InterchangeSchema } from '../interchange/storage.js';
import {
  AiContextSchema,
  SemanticFieldMetadataSchema,
  SynonymsSchema,
} from '../entities/semantic-metadata.js';
/**
 * Zod schemas for source and transform spec files.
 *
 * Validates YAML specs used by `dogsled model compile` to generate
 * warehouse DDL from declarative definitions.
 */

import { z } from 'zod';
import { ExpectSpecSchema } from './schemas-expectations.js';
export { ExpectSpecSchema, type ExpectSpec } from './schemas-expectations.js';
import {
  RecurseSpecSchema,
  HierarchySpecSchema,
  MODEL_SPEC_RESERVED_COLUMN_PREFIX,
  RECURSE_ALIAS_PRIOR,
} from './schemas-recursion.js';
export {
  RecurseSpecSchema,
  HierarchySpecSchema,
  MODEL_SPEC_RESERVED_COLUMN_PREFIX,
  RECURSE_ALIAS_PRIOR,
  RECURSE_ALIAS_SOURCE,
  RECURSE_INTERNAL_DEPTH,
  RECURSE_INTERNAL_PATH,
  RECURSE_MAX_DEPTH_LIMIT,
  type RecurseSpec,
  type HierarchySpec,
} from './schemas-recursion.js';
import { FieldMetadataSchema, SemanticRoleSchema } from '@bobsled-inc/protocol';
import { MODEL_SPEC_ERROR_CODES, modelSpecHint } from './error-hints.js';
import { databaseIdentifierSchema, identifierMsg, identifierRegex } from './shared-validators.js';
import { ReadModeSchema } from './read-mode.js';
import {
  ExecutionConfigSchema,
  PublishConfigSchema,
  getExecutionEngine,
  getPublishTarget,
  getPublishTargetDatabase,
  getPublishTargetSchema,
  type ExecutionConfig,
  type PublishConfig,
} from './publish-execution.js';
import { dangerousExprRegex, dangerousExprMsg, TrustTierSchema } from './schemas-shared.js';
export { isDangerousRawSql } from './schemas-shared.js';

/**
 * Wraps `z.literal(expected)` with a fix-suggesting error message when the
 * caller passed a legacy / migrated literal. `legacyHints` maps the old value
 * to the message we surface (already includes its own [CODE] prefix).
 */
function literalWithLegacyHints(
  expected: string,
  legacyHints: Record<string, string>
): z.ZodLiteral<string> {
  return z.literal(expected, {
    error: (issue) => {
      const received = issue.input;
      if (typeof received === 'string' && received in legacyHints) {
        return legacyHints[received]!;
      }
      return undefined;
    },
  }) as unknown as z.ZodLiteral<string>;
}

export { SemanticRoleSchema, dangerousExprRegex, dangerousExprMsg, TrustTierSchema };
export type { TrustTier } from './schemas-shared.js';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Optionally qualified identifier: `column`, `ref.column`, or `connection.source.column` (for group_by with joins). */
const qualifiedIdentifierRegex = /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/;
const qualifiedIdentifierMsg =
  'Must be a valid identifier, optionally dot-qualified (e.g., model_name.column)';

/** Dotted identifier for table names: schema.table or project.dataset.table. */
const dottedIdentifierRegex =
  /^(?:[a-zA-Z_]\w*|"(?:[^"\\\r\n]|"")*"|`(?:[^`\\\r\n]|``)*`)(?:\.(?:[a-zA-Z_]\w*|"(?:[^"\\\r\n]|"")*"|`(?:[^`\\\r\n]|``)*`))+$/;
const dottedIdentifierMsg = 'Must be a dotted identifier (e.g. schema.table_name)';

/** Valid SQL type name pattern (with optional precision). */
const sqlTypeRegex =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*(?:\s*\(\s*\d+\s*(?:,\s*\d+)?\s*\))?$/;

/** Lighter regex for hooks — hooks need CALL/EXEC but still block destructive DDL and semicolons. */
const dangerousHookRegex = /;|^\s*(DROP|ALTER|TRUNCATE|DELETE|GRANT|REVOKE)\b/i;
const dangerousHookMsg = 'Hook must not contain semicolons or destructive DDL statements';

const CanaryModeSchema = z.enum(['delta', 'range', 'monotonic', 'row_count']);

const PromotionTestSchema = z.object({
  type: z.enum(['backtest', 'canary', 'semantic_rule']),
  query: z.string().optional(),
  expected: z.union([z.number(), z.boolean(), z.string()]).optional(),
  mode: CanaryModeSchema.optional(),
  rule: z.string().optional(),
  columns: z.array(z.string()).optional(),
});

export const TrustConfigSchema = z.object({
  promotion_tests: z.array(PromotionTestSchema).optional(),
  demotion_triggers: z
    .array(z.enum(['source_schema_change', 'test_failure', 'canary_failure']))
    .optional(),
});

export type TrustConfig = z.infer<typeof TrustConfigSchema>;

// ---------------------------------------------------------------------------
// Field metadata
// ---------------------------------------------------------------------------

export type SemanticRole = z.infer<typeof SemanticRoleSchema>;

const {
  name: _name,
  type: _type,
  ...FieldMetadataOptionalFieldsSchema
} = FieldMetadataSchema.shape;

// ---------------------------------------------------------------------------
// Source spec
// ---------------------------------------------------------------------------

/**
 * `VECTOR` is a first-class Model Spec column type for embedding columns; the
 * compiler maps it per-dialect (Snowflake `VECTOR(FLOAT,N)`, BigQuery
 * `ARRAY<FLOAT64>`, DuckDB `FLOAT[N]`, pgvector `vector(N)`) at DDL time.
 * Matches codegen's normalization (uppercase only, no trim) so a typo like
 * ' VECTOR ' fails validation rather than falling through as raw SQL.
 */
function refineVectorDimension(
  data: { type: string; dimension?: number; embedded_from?: unknown },
  ctx: z.RefinementCtx
): void {
  const isVector = data.type.toUpperCase() === 'VECTOR';
  const issue = (path: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  if (isVector && data.dimension === undefined) {
    issue('dimension', 'VECTOR columns require a positive integer dimension');
  }
  if (!isVector && data.dimension !== undefined) {
    issue('dimension', 'dimension is only valid for VECTOR columns');
  }
  if (!isVector && data.embedded_from !== undefined) {
    issue('embedded_from', 'embedded_from is only valid for VECTOR columns');
  }
}

const SourceColumnSchema = z
  .object({
    name: z.string().min(1, 'Column name is required'),
    type: z.string().min(1, 'Column type is required'),
    dimension: z.number().int().positive().optional(),
    primary_key: z.boolean().optional(),
    ...FieldMetadataOptionalFieldsSchema,
    ...SemanticFieldMetadataSchema.shape,
  })
  .superRefine(refineVectorDimension);

const SourceQualitySchema = z.object({
  freshness: z.object({ max_age: z.string() }).optional(),
  row_count: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .optional(),
});

const MaxAgeSchema = z.string().regex(/^\d+(s|m|h|d)$/, 'max_age must match <N><s|m|h|d>');
const ApiResourceFilterSchema = z.record(z.string(), z.unknown());
const DestinationOverrideSchema = z
  .object({ schema: z.string().min(1).regex(identifierRegex, identifierMsg) })
  .strict();
const SourceModeSchema = z.preprocess(
  (value) => (value === 'cache' ? 'lazy' : value),
  z.enum(['extract', 'lazy', 'live'])
);
export const RefreshStrategySchema = z
  .object({
    strategy: z.enum(['merge', 'append', 'full_refresh']),
    cursor_field: z
      .string()
      .min(1, 'cursor_field is required')
      .regex(identifierRegex, identifierMsg)
      .optional(),
    primary_key: z
      .union([
        z.string().min(1, 'primary_key is required').regex(identifierRegex, identifierMsg),
        z
          .array(
            z
              .string()
              .min(1, 'primary_key entries are required')
              .regex(identifierRegex, identifierMsg)
          )
          .min(1),
      ])
      .optional(),
  })
  .strict()
  .superRefine((refresh, ctx) => {
    if (refresh.strategy === 'merge') {
      if (!refresh.cursor_field) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cursor_field'],
          message: 'refresh.strategy merge requires cursor_field',
        });
      }
      if (!refresh.primary_key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['primary_key'],
          message: 'refresh.strategy merge requires primary_key',
        });
      }
    }
    if (refresh.strategy === 'append' && !refresh.cursor_field) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor_field'],
        message: 'refresh.strategy append requires cursor_field',
      });
    }
    if (refresh.strategy === 'full_refresh') {
      if (refresh.cursor_field !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cursor_field'],
          message: 'refresh.strategy full_refresh must not include cursor_field',
        });
      }
      if (refresh.primary_key !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['primary_key'],
          message: 'refresh.strategy full_refresh must not include primary_key',
        });
      }
    }
  });

const BaseSourceFields = {
  interchange: InterchangeSchema.optional(),
  spec_version: z.literal('0.2'),
  name: z.string().min(1, 'Source name is required').regex(identifierRegex, identifierMsg),
  type: z.literal('source'),
  description: z.string().optional(),
  ai_context: AiContextSchema.optional(),
  synonyms: SynonymsSchema.optional(),
  trust_tier: TrustTierSchema.default('bronze'),
  quality: SourceQualitySchema.optional(),
  schema: z
    .object({ columns: z.array(SourceColumnSchema).min(1, 'At least one column is required') })
    .superRefine((schema, ctx) => {
      // embedded_from.column must reference a declared column.
      const names = new Set(schema.columns.map((c) => c.name));
      schema.columns.forEach((c, i) => {
        if (c.embedded_from && !names.has(c.embedded_from.column)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['columns', i, 'embedded_from', 'column'],
            message: `embedded_from.column "${c.embedded_from.column}" must reference a declared column`,
          });
        }
      });
    }),
} as const;

export const WarehouseTableSourceSchema = z
  .object({
    ...BaseSourceFields,
    source_type: z.literal('warehouse_table'),
    connection: z.string().min(1, 'Connection name is required'),
    table: z
      .string()
      .min(1, 'Table name is required')
      .regex(dottedIdentifierRegex, dottedIdentifierMsg),
  })
  .strict();

export const ApiResourceSourceSchema = z
  .object({
    ...BaseSourceFields,
    source_type: z.literal('api_resource'),
    integration: z.string().min(1),
    resource: z.string().min(1),
    connection: z.string().min(1, 'Connection name is required'),
    filter: ApiResourceFilterSchema.optional(),
    max_age: MaxAgeSchema.optional(),
    mode: SourceModeSchema.optional(),
    refresh: RefreshStrategySchema.optional(),
    destination: DestinationOverrideSchema.optional(),
  })
  .strict();

export const SourceSpecSchema = z.discriminatedUnion('source_type', [
  WarehouseTableSourceSchema,
  ApiResourceSourceSchema,
]);

export type SourceSpec = z.infer<typeof SourceSpecSchema>;
export type WarehouseTableSourceSpec = z.infer<typeof WarehouseTableSourceSchema>;
export type ApiResourceSourceSpec = z.infer<typeof ApiResourceSourceSchema>;
export type SourceDestinationOverride = z.infer<typeof DestinationOverrideSchema>;
export type SourceMode = z.infer<typeof SourceModeSchema>;
export type RefreshStrategy = z.infer<typeof RefreshStrategySchema>;

// ---------------------------------------------------------------------------
// Materialization types
// ---------------------------------------------------------------------------

export const MaterializationTypeSchema = z.enum([
  'view',
  'table',
  'incremental',
  'ephemeral',
  'dynamic_table',
  'materialized_view',
  'snapshot',
]);

export type MaterializationType = z.infer<typeof MaterializationTypeSchema>;

export const OnSchemaChangeSchema = z.enum(['fail', 'full_refresh']);
export type OnSchemaChange = z.infer<typeof OnSchemaChangeSchema>;

const snowflakeTargetLagRegex = /^DOWNSTREAM$|^\d+\s+(second|minute|hour|day)s?$/i;
const snowflakeWarehouseRegex = /^[a-zA-Z_][\w$]*$/;
const bigQueryMaxStalenessRegex =
  /^(\d+\s+(minute|hour|day)s?|INTERVAL\s+"(\d+)"\s+(MINUTE|HOUR|DAY))$/i;

function durationToMinutes(value: string): number | undefined {
  const friendly = value.trim().match(/^(\d+)\s+(second|minute|hour|day)s?$/i);
  if (friendly) {
    const [, amountStr, unitRaw] = friendly;
    if (!amountStr || !unitRaw) return undefined;
    const amount = Number(amountStr);
    const unit = unitRaw.toLowerCase();
    if (unit === 'second') return amount / 60;
    if (unit === 'minute') return amount;
    if (unit === 'hour') return amount * 60;
    return amount * 24 * 60;
  }

  const typed = value.trim().match(/^INTERVAL\s+"(\d+)"\s+(MINUTE|HOUR|DAY)$/i);
  if (!typed) return undefined;
  const [, amountStr, unitRaw] = typed;
  if (!amountStr || !unitRaw) return undefined;
  const amount = Number(amountStr);
  const unit = unitRaw.toLowerCase();
  if (unit === 'minute') return amount;
  if (unit === 'hour') return amount * 60;
  return amount * 24 * 60;
}

/**
 * Sentinel field for `target_schema` / `target_database` nested inside a
 * materialization block. These belong at the **model top level** (peers of
 * `materialization:`), not inside it. Silently stripping was the prod
 * footgun — see MISPLACED_TARGET_SCHEMA.
 */
function misplacedTargetField(name: 'target_schema' | 'target_database'): z.ZodType<undefined> {
  return z
    .never({
      error: () =>
        modelSpecHint(
          MODEL_SPEC_ERROR_CODES.MISPLACED_TARGET_SCHEMA,
          `${name} is a top-level model field (peer of materialization:), not a key inside materialization. Move it up one level.`
        ),
    })
    .optional() as unknown as z.ZodType<undefined>;
}

const DynamicTableMaterializationSchema = z
  .object({
    type: z.literal('dynamic_table'),
    target_schema: misplacedTargetField('target_schema'),
    target_database: misplacedTargetField('target_database'),
    target_lag: z
      .string()
      .regex(snowflakeTargetLagRegex, 'target_lag must be DOWNSTREAM or a duration like "1 hour"')
      .optional(),
    warehouse: z
      .string()
      .regex(snowflakeWarehouseRegex, 'warehouse must be a valid Snowflake identifier')
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.target_lag || value.target_lag.toUpperCase() === 'DOWNSTREAM') return;
    const minutes = durationToMinutes(value.target_lag);
    if (minutes !== undefined && minutes < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'target_lag must be at least 60 seconds',
        path: ['target_lag'],
      });
    }
  });

const MaterializedViewMaterializationSchema = z
  .object({
    type: z.literal('materialized_view'),
    target_schema: misplacedTargetField('target_schema'),
    target_database: misplacedTargetField('target_database'),
    max_staleness: z
      .string()
      .regex(
        bigQueryMaxStalenessRegex,
        'max_staleness must be a duration like "1 hour" or BigQuery INTERVAL "1" HOUR'
      )
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.max_staleness) return;
    const minutes = durationToMinutes(value.max_staleness);
    if (minutes === undefined || minutes < 30 || minutes > 3 * 24 * 60) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'max_staleness must be between 30 minutes and 3 days',
        path: ['max_staleness'],
      });
    }
  });

// ---------------------------------------------------------------------------
// Data tests
// ---------------------------------------------------------------------------

const DataTestSchema = z.object({
  type: z.enum(['not_null', 'unique', 'accepted_values', 'custom']),
  column: z.string().regex(identifierRegex, identifierMsg).optional(),
  values: z.array(z.union([z.string(), z.number()])).optional(),
  sql: z
    .string()
    .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
    .optional(),
});

export type DataTest = z.infer<typeof DataTestSchema>;

// ---------------------------------------------------------------------------
// Transform spec
// ---------------------------------------------------------------------------

const JoinSchema = z.object({
  ref: z.string().min(1, 'Join ref is required'),
  type: z.enum(['left', 'inner', 'cross', 'full']),
  read_mode: ReadModeSchema,
  on: z
    .string()
    .min(1, 'Join condition is required')
    .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg),
  description: z.string().optional(),
  pre_aggregate: z
    .object({
      group_by: z
        .array(z.string().regex(identifierRegex, identifierMsg))
        .min(1, 'At least one group_by column is required'),
      columns: z
        .array(
          z.object({
            name: z.string().min(1).regex(identifierRegex, identifierMsg),
            expr: z
              .string()
              .min(1)
              .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg),
          })
        )
        .min(1, 'At least one aggregate column is required'),
    })
    .optional(),
});

export type JoinDef = z.infer<typeof JoinSchema>;

const TransformColumnSchema = z
  .object({
    name: z.string().min(1, 'Column name is required').regex(identifierRegex, identifierMsg),
    expr: z
      .string()
      .min(1, 'Column expression is required')
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg),
    type: z.string().optional(),
    dimension: z.number().int().positive().optional(),
    primary_key: z.boolean().optional(),
    not_null: z.boolean().optional(),
    ...FieldMetadataOptionalFieldsSchema,
    ...SemanticFieldMetadataSchema.shape,
  })
  .superRefine((data, ctx) => {
    refineVectorDimension(
      { type: data.type ?? '', dimension: data.dimension, embedded_from: data.embedded_from },
      ctx
    );
  });

/**
 * `DerivedColumnSchema` is the column shape for `transform.derived_columns`.
 * It diverges from `TransformColumnSchema` (no `primary_key`/`not_null`, no
 * full FieldMetadata) but still needs `dimension` + `embedded_from` so that
 * silver/gold marts can re-declare embedding provenance on a re-projected
 * vector column.
 */
const DerivedColumnSchema = z
  .object({
    name: z.string().min(1, 'Column name is required').regex(identifierRegex, identifierMsg),
    expr: z
      .string()
      .min(1, 'Expression is required')
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg),
    description: z.string().optional(),
    synonyms: SynonymsSchema.optional(),
    type: z.string().optional(),
    dimension: z.number().int().positive().optional(),
    embedded_from: FieldMetadataSchema.shape.embedded_from,
  })
  .superRefine((data, ctx) => {
    refineVectorDimension(
      { type: data.type ?? '', dimension: data.dimension, embedded_from: data.embedded_from },
      ctx
    );
  });

export type DerivedColumn = z.infer<typeof DerivedColumnSchema>;

const flattenPathRegex = /^[\w.*[\]]+$/;
const flattenPathMsg = 'Path must contain only letters, digits, underscores, dots, brackets';

/**
 * Auto-generated source/join aliases follow the pattern t0, t1, t2, ...
 * Flatten aliases must not collide with these to prevent silent semantic errors.
 */
const autoAliasRegex = /^t\d+$/i;

const FlattenJsonStepSchema = z
  .object({
    column: z
      .string()
      .min(1, 'Column is required')
      .regex(identifierRegex, identifierMsg)
      .optional(),
    input: z
      .string()
      .min(1, 'Input expression is required')
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
      .optional(),
    path: z.string().regex(flattenPathRegex, flattenPathMsg).optional(),
    alias: z.string().regex(identifierRegex, identifierMsg).optional(),
    outer: z.boolean().optional(),
  })
  .refine((data) => data.column !== undefined || data.input !== undefined, {
    message: 'Either column or input is required',
    path: ['column'],
  })
  .refine((data) => !(data.column !== undefined && data.input !== undefined), {
    message: 'Set either column or input, not both',
    path: ['input'],
  })
  .refine((data) => !data.alias || !autoAliasRegex.test(data.alias), {
    message: 'Alias must not be t0, t1, t2, etc. — these are auto-generated source aliases',
    path: ['alias'],
  });

const FlattenJsonSchema = z.union([FlattenJsonStepSchema, z.array(FlattenJsonStepSchema).min(1)]);

const aggregateFunctions = [
  'sum',
  'count',
  'avg',
  'min',
  'max',
  'listagg',
  'array_agg',
  'string_agg',
  'group_concat',
  'median',
  'stddev',
  'variance',
  'any_value',
  'approx_count_distinct',
  'count_if',
  'hll_count.merge',
] as const;

const PivotSchema = z.object({
  column: z.string().min(1, 'Pivot column is required').regex(identifierRegex, identifierMsg),
  values: z.array(z.union([z.string(), z.number()])).min(1),
  aggregate: z
    .string()
    .min(1, 'Aggregate function is required')
    .refine(
      (v) => aggregateFunctions.includes(v.toLowerCase() as (typeof aggregateFunctions)[number]),
      { message: `Aggregate must be one of: ${aggregateFunctions.join(', ')}` }
    ),
  value_column: z.string().min(1, 'Value column is required').regex(identifierRegex, identifierMsg),
});

const SetOperationSchema = z
  .enum(['union_all', 'union', 'intersect', 'except', 'minus'])
  .optional()
  .default('union_all');

const UnpivotSchema = z.object({
  columns: z
    .array(z.string().min(1).regex(identifierRegex, identifierMsg))
    .min(1, 'At least one column to unpivot is required'),
  exclude: z.array(z.string().min(1).regex(identifierRegex, identifierMsg)).optional(),
  field_name: z.string().regex(identifierRegex, identifierMsg).default('field_name'),
  value_name: z.string().regex(identifierRegex, identifierMsg).default('value'),
  cast_to: z.string().regex(sqlTypeRegex, 'cast_to must be a valid SQL type name').optional(),
});

const UnionBranchSchema = z
  .object({
    ref: z.string().min(1, 'Union branch ref is required'),
    read_mode: ReadModeSchema,
    filter: z
      .string()
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
      .optional(),
    include_all_columns: z.boolean().optional(),
    exclude_columns: z.array(z.string().min(1).regex(identifierRegex, identifierMsg)).optional(),
    columns: z
      .array(
        z.object({
          name: z.string().min(1).regex(identifierRegex, identifierMsg),
          expr: z
            .string()
            .min(1)
            .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg),
        })
      )
      .min(1, 'union branch columns cannot be empty')
      .optional(),
    operation: SetOperationSchema,
  })
  .superRefine((branch, ctx) => {
    if (
      branch.exclude_columns &&
      branch.exclude_columns.length > 0 &&
      !branch.include_all_columns
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'union branch: exclude_columns requires include_all_columns: true',
        path: ['exclude_columns'],
      });
    }
  });

const OrderByItemSchema = z.object({
  column: z.string().min(1).regex(identifierRegex, identifierMsg),
  direction: z.enum(['asc', 'desc']).optional(),
  /**
   * Explicit null placement. Omitted, each target applies its own default,
   * which is not consistent across dialects, so a model that depends on where
   * nulls land must say so.
   */
  nulls: z.enum(['first', 'last']).optional(),
});

// `publish` + `execution` config schemas/accessors live in a sibling module to
// keep this file under the source-size budget; re-exported here (imported at the
// top) so existing importers of `./schemas.js` keep resolving these symbols.
export {
  ExecutionConfigSchema,
  PublishConfigSchema,
  getExecutionEngine,
  getPublishTarget,
  getPublishTargetDatabase,
  getPublishTargetSchema,
  type ExecutionConfig,
  type PublishConfig,
};

export const DedupeSpecSchema = z
  .object({
    keys: z
      .array(z.string().min(1).regex(identifierRegex, identifierMsg))
      .min(1, 'dedupe.keys cannot be empty'),
    strategy: z.enum(['keep_first', 'keep_last']).default('keep_first'),
    order_by: z
      .array(
        z.object({
          column: z.string().min(1).regex(identifierRegex, identifierMsg),
          direction: z.enum(['asc', 'desc']).default('asc'),
          nulls: z.enum(['first', 'last']).optional(),
        })
      )
      .min(1)
      .optional(),
  })
  .strict()
  .superRefine((dedupe, ctx) => {
    if (dedupe.strategy === 'keep_last' && !dedupe.order_by?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['order_by'],
        message: 'dedupe.strategy keep_last requires order_by',
      });
    }
  });

export type DedupeSpec = z.infer<typeof DedupeSpecSchema>;

export const TransformSpecSchema = z
  .object({
    model_kind: z.literal('derived').optional(),
    interchange: InterchangeSchema.optional(),
    spec_version: z.literal('0.2'),
    name: z.string().min(1, 'Model name is required').regex(identifierRegex, identifierMsg),
    type: literalWithLegacyHints('model', {
      transform: modelSpecHint(
        MODEL_SPEC_ERROR_CODES.LEGACY_TYPE_LITERAL,
        `type: 'transform' was removed — use type: model. Model files now declare their materialization via materialization.type (view | table | incremental | …).`
      ),
      view: modelSpecHint(
        MODEL_SPEC_ERROR_CODES.LEGACY_TYPE_LITERAL,
        `type: 'view' is a materialization, not a spec type — set type: model and move 'view' under materialization.type.`
      ),
      table: modelSpecHint(
        MODEL_SPEC_ERROR_CODES.LEGACY_TYPE_LITERAL,
        `type: 'table' is a materialization, not a spec type — set type: model and move 'table' under materialization.type.`
      ),
      incremental: modelSpecHint(
        MODEL_SPEC_ERROR_CODES.LEGACY_TYPE_LITERAL,
        `type: 'incremental' is a materialization, not a spec type — set type: model and move 'incremental' under materialization.type.`
      ),
    }),
    description: z.string().min(1, 'Description is required'),
    ai_context: AiContextSchema.optional(),
    synonyms: SynonymsSchema.optional(),
    grain: z.union([
      z.string().regex(identifierRegex, identifierMsg),
      z.array(z.string().regex(identifierRegex, identifierMsg)),
    ]),
    tags: z.array(z.string()).optional(),
    owner: z.string().optional(),
    publish: PublishConfigSchema.optional(),
    execution: ExecutionConfigSchema.optional(),
    trust_tier: TrustTierSchema.default('bronze'),
    trust_config: TrustConfigSchema.optional(),
    variables: z
      .record(
        z.string().regex(identifierRegex, identifierMsg),
        z.union([z.number(), z.string(), z.boolean()])
      )
      .optional(),
    source: z.object({
      ref: z.string().min(1, 'Source ref is required'),
      filter: z
        .string()
        .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
        .optional(),
      read_mode: ReadModeSchema,
    }),
    joins: z.array(JoinSchema).optional().default([]),
    include_all_columns: z.boolean().optional(),
    exclude_columns: z.array(z.string().min(1).regex(identifierRegex, identifierMsg)).optional(),
    columns: z.array(TransformColumnSchema).default([]),
    distinct: z.boolean().optional(),
    group_by: z
      .array(z.string().regex(qualifiedIdentifierRegex, qualifiedIdentifierMsg))
      .optional(),
    where: z
      .string()
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
      .optional(),
    having: z
      .string()
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
      .optional(),
    qualify: z
      .string()
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
      .optional(),
    dedupe: DedupeSpecSchema.optional(),
    order_by: z.array(OrderByItemSchema).optional(),
    windows: z
      .array(
        z.object({
          name: z.string().min(1).regex(identifierRegex, identifierMsg),
          partition_by: z
            .array(
              z
                .string()
                .min(1)
                .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
            )
            .optional(),
          order_by: z.array(OrderByItemSchema).optional(),
          frame: z
            .string()
            .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
            .optional(),
        })
      )
      .optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    derived_columns: z.array(DerivedColumnSchema).optional(),
    flatten_json: FlattenJsonSchema.optional(),
    pivot: PivotSchema.optional(),
    unpivot: UnpivotSchema.optional(),
    union: z.array(UnionBranchSchema).optional(),
    recurse: RecurseSpecSchema.optional(),
    hierarchy: HierarchySpecSchema.optional(),
    materialization: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('view'),
        target_schema: misplacedTargetField('target_schema'),
        target_database: misplacedTargetField('target_database'),
      }),
      z.object({
        type: z.literal('table'),
        target_schema: misplacedTargetField('target_schema'),
        target_database: misplacedTargetField('target_database'),
      }),
      z.object({
        type: z.literal('incremental'),
        target_schema: misplacedTargetField('target_schema'),
        target_database: misplacedTargetField('target_database'),
        strategy: z.enum(['merge', 'delete_insert', 'append']).default('merge'),
        unique_key: z
          .union([
            z.string().regex(identifierRegex, identifierMsg),
            z.array(z.string().regex(identifierRegex, identifierMsg)),
          ])
          .optional(),
        incremental_filter: z
          .string()
          .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
          .optional(),
        cursor_field: z.string().regex(identifierRegex, identifierMsg).optional(),
        on_schema_change: OnSchemaChangeSchema.default('fail'),
      }),
      z.object({
        type: z.literal('ephemeral'),
        target_schema: misplacedTargetField('target_schema'),
        target_database: misplacedTargetField('target_database'),
      }),
      DynamicTableMaterializationSchema,
      MaterializedViewMaterializationSchema,
      z.object({
        type: z.literal('snapshot'),
        target_schema: misplacedTargetField('target_schema'),
        target_database: misplacedTargetField('target_database'),
        unique_key: z.union([
          z.string().regex(identifierRegex, identifierMsg),
          z.array(z.string().regex(identifierRegex, identifierMsg)),
        ]),
        tracked_columns: z.array(z.string().regex(identifierRegex, identifierMsg)).optional(),
        valid_from_column: z.string().regex(identifierRegex, identifierMsg).optional(),
        valid_to_column: z.string().regex(identifierRegex, identifierMsg).optional(),
        on_schema_change: z.literal('fail').default('fail'),
      }),
    ]),
    // Per-model schema/database override (optional — defaults to global --schema)
    target_schema: z.string().min(1).regex(identifierRegex, identifierMsg).optional(),
    target_database: databaseIdentifierSchema.optional(),
    pre_hook: z
      .array(z.string().refine((v) => !dangerousHookRegex.test(v), dangerousHookMsg))
      .optional(),
    post_hook: z
      .array(z.string().refine((v) => !dangerousHookRegex.test(v), dangerousHookMsg))
      .optional(),
    tests: z.array(DataTestSchema).optional(),
    expect: z.array(ExpectSpecSchema).optional().default([]),
  })
  .superRefine((data, ctx) => {
    // At least one column required unless include_all_columns is true
    if (!data.include_all_columns && data.columns.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one column is required (or set include_all_columns: true)',
        path: ['columns'],
      });
    }

    // exclude_columns requires include_all_columns
    if (data.exclude_columns && data.exclude_columns.length > 0 && !data.include_all_columns) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exclude_columns requires include_all_columns: true',
        path: ['exclude_columns'],
      });
    }

    // Names the compiler generates must stay its own.
    const reserved = (name: unknown): boolean =>
      typeof name === 'string' &&
      name.toLocaleLowerCase().startsWith(MODEL_SPEC_RESERVED_COLUMN_PREFIX);
    const reservedIssue = (path: (string | number)[], name: string): void => {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message:
          `"${name}" uses the reserved "${MODEL_SPEC_RESERVED_COLUMN_PREFIX}" prefix, which the ` +
          `compiler generates columns under (recursion depth and path, hoisted qualify ` +
          `predicates). Declaring one produces a duplicate alias — pick another name.`,
      });
    };
    for (const [index, column] of data.columns.entries()) {
      if (reserved(column.name)) reservedIssue(['columns', index, 'name'], column.name);
    }
    for (const [index, column] of (data.derived_columns ?? []).entries()) {
      if (reserved(column.name)) reservedIssue(['derived_columns', index, 'name'], column.name);
    }
    for (const [index, window] of (data.windows ?? []).entries()) {
      if (reserved(window.name)) reservedIssue(['windows', index, 'name'], window.name);
    }
    for (const [index, column] of (data.recurse?.step.columns ?? []).entries()) {
      if (reserved(column.name)) {
        reservedIssue(['recurse', 'step', 'columns', index, 'name'], column.name);
      }
    }
    if (data.recurse?.cycle?.emit && reserved(data.recurse.cycle.emit)) {
      reservedIssue(['recurse', 'cycle', 'emit'], data.recurse.cycle.emit);
    }
    for (const [slot, name] of Object.entries(data.hierarchy?.emit ?? {})) {
      if (reserved(name)) reservedIssue(['hierarchy', 'emit', slot], name as string);
    }

    // Recursion validation
    const recursionKind = data.recurse ? 'recurse' : data.hierarchy ? 'hierarchy' : undefined;
    if (data.recurse && data.hierarchy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hierarchy'],
        message: '"recurse" and "hierarchy" are mutually exclusive — hierarchy compiles to recurse',
      });
    }
    if (recursionKind) {
      const materializationType = data.materialization.type;
      if (materializationType !== 'view' && materializationType !== 'table') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['materialization', 'type'],
          message:
            `${recursionKind} supports materialization view or table, not "${materializationType}". ` +
            `Ephemeral cannot carry WITH RECURSIVE into a folding CTE, and an incremental ` +
            `fixpoint over changed rows has no defined semantics yet.`,
        });
      }
      // Clauses that reshape the FROM clause or run after aggregation cannot be
      // composed with the recursive CTE in one model; a downstream model reads
      // the closure and applies them there.
      for (const field of [
        'group_by',
        'having',
        'qualify',
        'dedupe',
        'distinct',
        'pivot',
        'unpivot',
        'union',
        'flatten_json',
        'derived_columns',
        'include_all_columns',
      ] as const) {
        if (data[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `"${field}" cannot be combined with ${recursionKind} — read the result from a downstream model and apply it there`,
          });
        }
      }
    }
    if (data.recurse) {
      const outputNames = data.columns.map((c) => c.name.toLocaleLowerCase());
      const stepNames = data.recurse.step.columns.map((c) => c.name.toLocaleLowerCase());
      const missing = outputNames.filter((n) => !stepNames.includes(n));
      const extra = stepNames.filter((n) => !outputNames.includes(n));
      if (missing.length > 0 || extra.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recurse', 'step', 'columns'],
          message:
            `recurse.step.columns must name exactly the model's columns. ` +
            (missing.length > 0 ? `Missing: ${missing.join(', ')}. ` : '') +
            (extra.length > 0 ? `Unknown: ${extra.join(', ')}.` : ''),
        });
      }
      const referencesPrior = data.recurse.step.columns.some((c) =>
        new RegExp(`\\b${RECURSE_ALIAS_PRIOR}\\s*\\.`, 'i').test(c.expr)
      );
      if (!referencesPrior) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recurse', 'step', 'columns'],
          message: `No step column references "${RECURSE_ALIAS_PRIOR}." — without it the step never reads the previous iteration, so this is a join, not a recursion`,
        });
      }
      const cycle = data.recurse.cycle;
      if (cycle && !outputNames.includes(cycle.on.toLocaleLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recurse', 'cycle', 'on'],
          message: `recurse.cycle.on "${cycle.on}" is not one of the model's columns`,
        });
      }
      if (cycle?.emit && outputNames.includes(cycle.emit.toLocaleLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recurse', 'cycle', 'emit'],
          message: `recurse.cycle.emit "${cycle.emit}" collides with an existing column`,
        });
      }
    }
    if (data.hierarchy) {
      const outputNames = new Set(data.columns.map((c) => c.name.toLocaleLowerCase()));
      for (const [slot, name] of Object.entries(data.hierarchy.emit ?? {})) {
        if (typeof name === 'string' && outputNames.has(name.toLocaleLowerCase())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['hierarchy', 'emit', slot],
            message: `hierarchy.emit.${slot} "${name}" collides with an existing column`,
          });
        }
      }
      if (data.hierarchy.emit?.cycle === undefined && data.hierarchy.seed === 'all_nodes') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hierarchy', 'emit', 'cycle'],
          message:
            'seed: all_nodes starts a walk at every row, which is only worth its cost for a cycle audit — declare emit.cycle, or use seed: roots',
        });
      }
    }

    // offset requires limit
    if (data.offset !== undefined && data.limit === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'offset requires limit to be set',
        path: ['offset'],
      });
    }

    // pivot and unpivot are mutually exclusive
    if (data.pivot && data.unpivot) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A model cannot have both pivot and unpivot',
        path: ['unpivot'],
      });
    }

    if (data.materialization.type === 'incremental') {
      const strategy = data.materialization.strategy ?? 'merge';
      if (
        (strategy === 'merge' || strategy === 'delete_insert') &&
        !data.materialization.unique_key
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unique_key is required for incremental strategy "${strategy}"`,
          path: ['materialization', 'unique_key'],
        });
      }
      // P0: Append without incremental_filter is silent data duplication — reject as error
      if (strategy === 'append' && !data.materialization.incremental_filter) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'incremental_filter is required for append strategy — without it, all rows will be duplicated on every run',
          path: ['materialization', 'incremental_filter'],
        });
      }
    }

    if (data.materialization.type === 'snapshot') {
      const trackedCols = data.materialization.tracked_columns;
      if (trackedCols && trackedCols.length > 0) {
        const uniqueKeys = Array.isArray(data.materialization.unique_key)
          ? data.materialization.unique_key
          : [data.materialization.unique_key];
        const keySet = new Set(uniqueKeys.map((k) => k.toLowerCase()));
        for (const col of trackedCols) {
          if (keySet.has(col.toLowerCase())) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `tracked_columns must not overlap with unique_key — "${col}" appears in both`,
              path: ['materialization', 'tracked_columns'],
            });
          }
        }
      }
    }

    // Reject duplicate window names (case-insensitive)
    if (data.windows && data.windows.length > 0) {
      const seen = new Set<string>();
      for (const [index, win] of data.windows.entries()) {
        const key = win.name.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate window name "${win.name}"`,
            path: ['windows', index, 'name'],
          });
          continue;
        }
        seen.add(key);
      }
    }

    // Validate grain identifiers match the identifier regex (already done at schema level).
    // Cross-validation against column names is intentionally NOT done here because:
    // - Grain may refer to columns from the source that aren't renamed in the model
    // - Grain describes the business key semantics, not always exact column aliases
    // - The `validate` CLI command handles deeper cross-referencing with warnings
  });

export type TransformSpec = z.infer<typeof TransformSpecSchema>;

// ---------------------------------------------------------------------------
// Seed spec (`type: seed`)
// ---------------------------------------------------------------------------

export const SeedSpecSchema = z.object({
  spec_version: z.literal('0.2'),
  name: z.string().min(1).regex(identifierRegex, identifierMsg),
  type: z.literal('seed'),
  description: z.string().optional(),
  payload: z.object({
    format: z.literal('csv'),
    path: z.string().min(1),
    delimiter: z.enum([',', '|', '\t']).default(','),
  }),
  schema: z.object({
    columns: z
      .array(
        z
          .object({
            name: z.string().min(1).regex(identifierRegex, identifierMsg),
            type: z.string().min(1),
            primary_key: z.boolean().optional(),
            description: z.string().optional(),
          })
          // VECTOR seeds would need dialect-aware INSERT-value serialization
          // (CSV cells are strings; `quoteLiteral` would emit them as quoted
          // strings, not vector literals). Fail loud until that's wired.
          .refine((data) => data.type.toUpperCase() !== 'VECTOR', {
            path: ['type'],
            message:
              'VECTOR is not supported in seed specs yet — INSERT-value serialization is not wired up. Seed as JSON/string and cast in a downstream model, or populate via the embedder.',
          })
      )
      .min(1),
  }),
  materialization: z
    .object({
      type: z.literal('table'),
      target_schema: z.string().regex(identifierRegex, identifierMsg).optional(),
      on_conflict: z.enum(['replace', 'skip']).default('replace'),
    })
    .default({ type: 'table', on_conflict: 'replace' }),
  validation: z
    .object({
      max_rows: z.number().int().positive().optional(),
      required_columns: z.array(z.string()).optional(),
      unique_columns: z.array(z.string()).optional(),
    })
    .optional(),
});

export type SeedSpec = z.infer<typeof SeedSpecSchema>;

// ---------------------------------------------------------------------------
// Resolution spec (`type: resolution`) — defined in schemas-resolution.ts
// ---------------------------------------------------------------------------

export { ResolutionSpecSchema } from './schemas-resolution.js';
export type { ResolutionSpec } from './schemas-resolution.js';

// ---------------------------------------------------------------------------
// Compile result
// ---------------------------------------------------------------------------

export type CompileResult =
  | { ok: true; sql: string; modelName: string; warnings?: string[] }
  | { ok: false; error: string; modelName?: string };
