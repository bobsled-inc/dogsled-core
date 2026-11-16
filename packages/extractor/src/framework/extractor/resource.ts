import { AuthEnvVarsSchema } from '@bobsled-inc/protocol';
import { z } from 'zod';

import {
  ApiConfigSchema,
  BigQueryAuthSchema,
  BigQueryChangeTrackingSchema,
  BigQueryConnectionSchema,
  CursorTypeSchema,
  DatabaseAuthSchema,
  DeltaChangeTrackingSchema,
  DeltaConnectionSchema,
  IcebergAuthSchema,
  IcebergConnectionSchema,
  McpToolConfigSchema,
  MysqlConnectionSchema,
  MysqlSslConfigSchema,
  OperationSpecSchema,
  OperationTestSchema,
  OutputFieldSchema,
  PostgresChangeTrackingSchema,
  WarehouseOutputFieldSchema,
  PostgresConnectionSchema,
  PostgresSslConfigSchema,
  RedshiftConnectionSchema,
  RedshiftSslConfigSchema,
  ReplicationConfigSchema,
  ReplicationMethodSchema,
  SnowflakeAuthSchema,
  SnowflakeChangeTrackingSchema,
  SnowflakeConnectionSchema,
  SourceConfigSchema,
  SourceSchema,
  SpecNameSchema,
  validateContextualOutputSupport,
  StorageAuthSchema,
  InputFieldSchema,
  TransportConfigSchema,
} from '../core/index.js';
import {
  GcsFileStorageIntegrationSpecSchema,
  LocalFileStorageIntegrationSpecSchema,
  S3FileStorageIntegrationSpecSchema,
  SftpFileStorageIntegrationSpecSchema,
  VercelBlobFileStorageIntegrationSpecSchema,
} from './file-storage-integration.js';
export * from './file-storage-integration.js';
import { FileResourceSpecSchema } from './file-resource.js';
export { FileResourceSpecSchema, isFileStorageResource } from './file-resource.js';
import { LoadBlockSchema, ResourceLoadBlockSchema } from './load-block.js';
import { createLookupOnlyApiResourceSpecSchema } from './lookup-only-resource.js';
export {
  LoadBlockSchema,
  LoadDefaultsSchema,
  LoadOverridesSchema,
  ResourceLoadBlockSchema,
} from './load-block.js';
import { ForEachConfigSchema } from './for-each-config.js';
import { PaginationSchema } from './pagination.js';
import { RecordFiltersSchema, validateRecordFilters } from './record-filter.js';
import { validateNonEmptyColumns } from './resource-validation.js';
import {
  QueryFilterFieldSchema,
  QueryOperatorSchema,
  QuerySearchSchema,
  QuerySpecSchema,
} from './query-spec.js';
import { StopWhenSchema, validateExtractStopWhen } from './stop-when.js';
import { WhereSchema, validateExtractWhere } from './where.js';
import { ClickHouseIntegrationSpecSchema } from './clickhouse-integration.js';
import { IntegrationSpecBase } from './integration-base.js';
export {
  ClickHouseIntegrationSpecSchema,
  type ClickHouseIntegrationSpec,
} from './clickhouse-integration.js';

const HooksSchema = z
  .object({
    before_request: z
      .array(
        z
          .object({
            set: z.string(),
            value: z.string(),
          })
          .strict()
      )
      .optional(),
    after_response: z
      .array(
        z
          .object({
            unwrap: z.string(),
          })
          .strict()
      )
      .optional(),
    on_error: z
      .array(
        z
          .object({
            match: z.string(),
            action: z.enum(['retry', 'skip', 'fail']),
            delay_ms: z.number().positive().optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

/** API integration (existing shape). Accepts source_type: 'api' or omitted for backward compat. */
const ApiIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('api').optional(),
    transport: TransportConfigSchema,
    auth_env_vars: AuthEnvVarsSchema,
    hooks: HooksSchema.optional(),
  })
  .strict();

const SnowflakeIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('snowflake'),
    connection: SnowflakeConnectionSchema,
    auth: SnowflakeAuthSchema,
  })
  .strict();

const BigQueryIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('bigquery'),
    connection: BigQueryConnectionSchema,
    auth: BigQueryAuthSchema,
  })
  .strict();

const PostgresIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('postgres'),
    connection: PostgresConnectionSchema,
    auth: DatabaseAuthSchema,
    ssl: PostgresSslConfigSchema.optional(),
  })
  .strict();

const RedshiftIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('redshift'),
    connection: RedshiftConnectionSchema,
    auth: DatabaseAuthSchema,
    ssl: RedshiftSslConfigSchema.optional(),
  })
  .strict();

const MysqlIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('mysql'),
    connection: MysqlConnectionSchema,
    auth: DatabaseAuthSchema,
    ssl: MysqlSslConfigSchema.optional(),
  })
  .strict();

const IcebergIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('iceberg'),
    connection: IcebergConnectionSchema,
    auth: IcebergAuthSchema.optional(),
    storage: StorageAuthSchema.optional(),
  })
  .strict();

const DeltaIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('delta'),
    connection: DeltaConnectionSchema,
    storage: StorageAuthSchema,
  })
  .strict();

/**
 * Unified IntegrationSpecSchema.
 *
 * Uses z.union (not discriminatedUnion) because the API variant allows
 * source_type to be absent for backward compatibility.
 */
export const IntegrationSpecSchema = z.union([
  SourceSchema,
  SnowflakeIntegrationSpecSchema,
  BigQueryIntegrationSpecSchema,
  PostgresIntegrationSpecSchema,
  RedshiftIntegrationSpecSchema,
  MysqlIntegrationSpecSchema,
  ClickHouseIntegrationSpecSchema,
  IcebergIntegrationSpecSchema,
  DeltaIntegrationSpecSchema,
  S3FileStorageIntegrationSpecSchema,
  GcsFileStorageIntegrationSpecSchema,
  SftpFileStorageIntegrationSpecSchema,
  LocalFileStorageIntegrationSpecSchema,
  VercelBlobFileStorageIntegrationSpecSchema,
  // API variant last — it's the fallback for specs without source_type
  ApiIntegrationSpecSchema,
]);

type IntegrationSpec = z.infer<typeof IntegrationSpecSchema>;

function validateOperationTarget(
  value: { api?: unknown; tool?: unknown },
  ctx: z.RefinementCtx,
  pathPrefix: string[] = []
): void {
  if (!value.api && !value.tool) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must define either "api" or "tool"',
      path: pathPrefix,
    });
  }

  if (value.api && value.tool) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Cannot define both "api" and "tool"',
      path: pathPrefix,
    });
  }
}

const LookupSpecSchema = z
  .object({
    description: z.string(),
    api: ApiConfigSchema.optional(),
    tool: McpToolConfigSchema.optional(),
    input: z.record(z.string(), InputFieldSchema),
    output: z.record(z.string(), OutputFieldSchema).optional(),
    extract: z
      .object({
        record_path: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateOperationTarget(value, ctx);
  });

const TableConfigSchema = z
  .object({
    primary_key: z.array(z.string()).optional(),
    trust_tier: z.enum(['bronze', 'silver', 'gold']).optional(),
    load_strategy: z.enum(['append', 'merge', 'full_refresh']).optional(),
    partition_by: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'partition_by must be a valid column identifier')
      .optional(),
  })
  .strict();

const CursorIncrementalConfigSchema = z
  .object({
    cursor_field: z.string(),
    cursor_param: z.string(),
    cursor_type: CursorTypeSchema.optional(),
    strategy: z.literal('cursor').default('cursor').optional(),
  })
  .strict();

const FilterIncrementalBaseFields = {
  cursor_field: z.string(),
  cursor_param: z.string().optional(),
  cursor_type: CursorTypeSchema.optional(),
  since_argument: z.string().optional(),
  until_argument: z.string().optional(),
  filter_argument: z.string().optional(),
  value_format: z.enum(['iso8601', 'date', 'unix_seconds', 'unix_milliseconds']).default('iso8601'),
  lookback_seconds: z.number().int().nonnegative().default(0).optional(),
  initial_lookback_seconds: z.number().int().nonnegative().optional(),
  window_size_seconds: z.number().int().positive().optional(),
} as const;

function validateFilterIncrementalConfig(strategy: 'filter' | 'server_filter') {
  return (
    value: {
      since_argument?: string;
      filter_argument?: string;
      window_size_seconds?: number;
      until_argument?: string;
    },
    ctx: z.RefinementCtx
  ) => {
    if (!value.since_argument && !value.filter_argument) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${strategy} incremental config requires since_argument or filter_argument`,
        path: ['since_argument'],
      });
    }

    if (value.window_size_seconds !== undefined && !value.until_argument) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${strategy} incremental config requires until_argument when window_size_seconds is set`,
        path: ['until_argument'],
      });
    }
  };
}

const FilterIncrementalConfigSchema = z
  .object({
    ...FilterIncrementalBaseFields,
    strategy: z.literal('filter'),
  })
  .strict()
  .superRefine(validateFilterIncrementalConfig('filter'));

const ServerFilterIncrementalConfigSchema = z
  .object({
    ...FilterIncrementalBaseFields,
    strategy: z.literal('server_filter'),
  })
  .strict()
  .superRefine(validateFilterIncrementalConfig('server_filter'));

const FullRefreshIncrementalConfigSchema = z
  .object({
    strategy: z.literal('full_refresh'),
    cursor_field: z.string().optional(),
    cursor_param: z.string().optional(),
    cursor_type: CursorTypeSchema.optional(),
  })
  .strict();

const IncrementalConfigSchema = z.union([
  FullRefreshIncrementalConfigSchema,
  ServerFilterIncrementalConfigSchema,
  CursorIncrementalConfigSchema,
  FilterIncrementalConfigSchema,
]);

const VerifyConfigSchema = z
  .object({
    suppress: z.array(z.string().min(1)).min(1),
  })
  .strict();

const BillingSchema = z
  .object({
    mode: z.literal('billable'),
    ownership: z.literal('third_party'),
    unit: z.enum(['request', 'record', 'match', 'credit']),
    estimation: z
      .object({
        model: z.enum(['per_request', 'per_input_row', 'per_match', 'upper_bound']),
        amount: z.number().positive(),
        currency: z.string().min(1),
        notes: z.string().optional(),
      })
      .strict(),
    authorization: z
      .object({
        requires_plan: z.literal(true),
      })
      .strict(),
  })
  .strict();

function isPostgresChangeTrackingConfig(changeTracking: unknown): changeTracking is {
  plugin?: 'pgoutput';
  slot_name: string;
  publication_name: string;
} {
  return (
    !!changeTracking &&
    typeof changeTracking === 'object' &&
    !Array.isArray(changeTracking) &&
    'slot_name' in changeTracking &&
    'publication_name' in changeTracking
  );
}

function addIssue(ctx: z.RefinementCtx, path: string[], message: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    path,
  });
}

const ExtractConfigSchema = z
  .object({
    record_path: z.string(),
    pagination: PaginationSchema.optional(),
    /** Opt-out flag: set to false for resources that intentionally have no pagination
     *  (e.g. bounded lists). Suppresses structural validation warnings. */
    paginated: z.literal(false).optional(),
    incremental: IncrementalConfigSchema.optional(),
    table: TableConfigSchema.optional(),
    for_each: ForEachConfigSchema.optional(),
    record_filters: RecordFiltersSchema.optional(),
    where: WhereSchema.optional(),
    stop_when: StopWhenSchema.optional(),
    schema_contract: z
      .enum(['evolve', 'freeze', 'discard_row', 'discard_value'])
      .default('evolve')
      .optional(),
  })
  .strict();

const HealthCheckConfigSchema = z
  .object({
    preferred: z.boolean().optional(),
  })
  .strict();

export const QUERY_SCALAR_FIELD_TYPES = new Set([
  'string',
  'integer',
  'number',
  'boolean',
  'timestamp',
]);

export function isQueryBindInputCompatible(outputType: string, inputType: string): boolean {
  return (
    outputType === inputType ||
    (outputType === 'integer' && inputType === 'number') ||
    (outputType === 'timestamp' && inputType === 'string')
  );
}

function isQueryInBindInputCompatible(
  outputType: string,
  inputField: z.infer<typeof InputFieldSchema>
): boolean {
  if (inputField.type !== 'array' || !inputField.items) {
    return false;
  }
  return isQueryBindInputCompatible(outputType, inputField.items.type);
}

function isEnumLiteralCompatible(outputType: string, literal: string | number | boolean): boolean {
  switch (outputType) {
    case 'string':
    case 'timestamp':
      return typeof literal === 'string';
    case 'integer':
      return typeof literal === 'number' && Number.isSafeInteger(literal);
    case 'number':
      return typeof literal === 'number' && Number.isFinite(literal);
    case 'boolean':
      return typeof literal === 'boolean';
    default:
      return false;
  }
}

function validateQueryBindings(
  value: {
    api?: unknown;
    input: Record<string, z.infer<typeof InputFieldSchema>>;
    output: Record<string, z.infer<typeof OutputFieldSchema>>;
    query?: z.infer<typeof QuerySpecSchema>;
  },
  ctx: z.RefinementCtx
): void {
  if (!value.query) {
    return;
  }

  const usedBindingInputs = new Map<string, string>();

  for (const [fieldName, fieldQuery] of Object.entries(value.query.filters ?? {})) {
    const outputField = value.output[fieldName];
    if (!outputField) {
      addIssue(
        ctx,
        ['query', 'filters', fieldName],
        `query filter "${fieldName}" must reference an output field`
      );
      continue;
    }

    if (!QUERY_SCALAR_FIELD_TYPES.has(outputField.type)) {
      addIssue(
        ctx,
        ['query', 'filters', fieldName],
        `query filter "${fieldName}" must reference a scalar output field`
      );
    } else if (fieldQuery.enum) {
      fieldQuery.enum.forEach((literal, index) => {
        if (!isEnumLiteralCompatible(outputField.type, literal)) {
          addIssue(
            ctx,
            ['query', 'filters', fieldName, 'enum', String(index)],
            `query filter "${fieldName}" enum[${index}] (${JSON.stringify(literal)}) does not match output type "${outputField.type}"`
          );
        }
      });
    }

    for (const operator of fieldQuery.operators) {
      const binding = fieldQuery.bind[operator];
      if (!binding) {
        continue;
      }

      const inputField = value.input[binding.input];
      if (!inputField) {
        addIssue(
          ctx,
          ['query', 'filters', fieldName, 'bind', operator, 'input'],
          `query filter bind input "${binding.input}" must reference a resource input`
        );
        continue;
      }

      if (inputField.required === true) {
        addIssue(
          ctx,
          ['query', 'filters', fieldName, 'bind', operator, 'input'],
          `query filter bind input "${binding.input}" must not be required`
        );
      }

      const compatible =
        operator === 'in'
          ? isQueryInBindInputCompatible(outputField.type, inputField)
          : isQueryBindInputCompatible(outputField.type, inputField.type);

      if (QUERY_SCALAR_FIELD_TYPES.has(outputField.type) && !compatible) {
        addIssue(
          ctx,
          ['query', 'filters', fieldName, 'bind', operator, 'input'],
          `query filter bind input "${binding.input}" type "${inputField.type}" is not compatible with output type "${outputField.type}"`
        );
      }

      const existingUse = usedBindingInputs.get(binding.input);
      if (existingUse) {
        addIssue(
          ctx,
          ['query', 'filters', fieldName, 'bind', operator, 'input'],
          `query bind input "${binding.input}" is already used by ${existingUse}`
        );
      } else {
        usedBindingInputs.set(binding.input, `query.filters.${fieldName}.${operator}`);
      }
    }
  }

  const searchInput = value.query.search?.bind.input;
  if (!searchInput) {
    return;
  }

  const searchField = value.input[searchInput];
  if (!searchField) {
    addIssue(
      ctx,
      ['query', 'search', 'bind', 'input'],
      `query search bind input "${searchInput}" must reference a resource input`
    );
    return;
  }

  if (searchField.required === true) {
    addIssue(
      ctx,
      ['query', 'search', 'bind', 'input'],
      `query search bind input "${searchInput}" must not be required`
    );
  }

  if (searchField.type !== 'string') {
    addIssue(
      ctx,
      ['query', 'search', 'bind', 'input'],
      `query search bind input "${searchInput}" must reference a string input`
    );
  }

  const existingUse = usedBindingInputs.get(searchInput);
  if (existingUse) {
    addIssue(
      ctx,
      ['query', 'search', 'bind', 'input'],
      `query bind input "${searchInput}" is already used by ${existingUse}`
    );
    return;
  }

  usedBindingInputs.set(searchInput, 'query.search');
}
/** API resource spec — existing shape with api + extract blocks. */
const ApiResourceSpecSchema = OperationSpecSchema.extend({
  spec_version: z.literal('1').optional(),
  type: z.literal('resource'),
  name: SpecNameSchema,
  integration: SpecNameSchema.optional(),
  via: SpecNameSchema.optional(),
  entity: SpecNameSchema.optional(),
  /**
   * Optional target handle for resource-level routing.
   * Resolution order: resource.target > extractor.yml.default_target > CLI flag > error.
   */
  target: SpecNameSchema.optional(),
  api: ApiConfigSchema.optional(),
  tool: McpToolConfigSchema.optional(),
  scaffold: z
    .object({
      read_only: z.boolean().optional(),
    })
    .strict()
    .optional(),
  _scaffold_metadata: z.unknown().optional(),
  extract: ExtractConfigSchema,
  incremental: IncrementalConfigSchema.optional(),
  lookup: LookupSpecSchema.optional(),
  query: QuerySpecSchema.optional(),
  billing: BillingSchema.optional(),
  verify: VerifyConfigSchema.optional(),
  test: OperationTestSchema.optional(),
  health_check: HealthCheckConfigSchema.optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    validateOperationTarget(value, ctx);
    validateContextualOutputSupport(value.output, value.extract.for_each !== undefined, ctx);
    if (value.via && value.integration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'first-class resources use "via"; remove legacy "integration"',
        path: ['integration'],
      });
    }

    if (value.via && value.spec_version) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'first-class resources must not declare legacy "spec_version"',
        path: ['spec_version'],
      });
    }

    if (value.incremental && value.extract.incremental) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'incremental must be defined at the top level or extract.incremental, not both',
        path: ['incremental'],
      });
    }

    const incremental = value.incremental ?? value.extract.incremental;
    const incrementalCursorField =
      incremental && 'cursor_field' in incremental && typeof incremental.cursor_field === 'string'
        ? incremental.cursor_field
        : undefined;
    if (incrementalCursorField && !(incrementalCursorField in value.output)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `incremental.cursor_field "${incrementalCursorField}" must reference an output field`,
        path: value.incremental
          ? ['incremental', 'cursor_field']
          : ['extract', 'incremental', 'cursor_field'],
      });
    }

    for (const key of value.extract.table?.primary_key ?? []) {
      if (!(key in value.output)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `extract.table.primary_key value "${key}" must reference an output field`,
          path: ['extract', 'table', 'primary_key'],
        });
      }
    }

    const partitionBy = value.extract.table?.partition_by;
    if (partitionBy) {
      const outputField = value.output?.[partitionBy];
      if (!outputField) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `partition_by column '${partitionBy}' must exist in output`,
          path: ['extract', 'table', 'partition_by'],
        });
      } else if (outputField.type !== 'timestamp') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `partition_by column '${partitionBy}' must be a timestamp output field`,
          path: ['extract', 'table', 'partition_by'],
        });
      }
    }

    validateQueryBindings(value, ctx);
    validateRecordFilters(value, ctx);
    validateExtractWhere(value, ctx);
    validateExtractStopWhen(value, ctx);

    // for_each.where uses the parent resource's output schema, which isn't in
    // scope from a single resource's validation pass. We only sanity-check that
    // the predicate shape itself is well-formed (each entry has a `field` plus
    // exactly one operator) — Zod already enforced this via the union, so no
    // further work is needed here. Cross-resource type checking happens at
    // runtime where the parent records are materialized.
  });

const LookupOnlyApiResourceSpecSchema = createLookupOnlyApiResourceSpecSchema(
  LookupSpecSchema,
  BillingSchema
);

/** DW/DB resource spec — uses source + replication blocks instead of api + extract. */
const WarehouseResourceSpecSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('resource'),
    name: SpecNameSchema,
    /**
     * Optional self-description. The actual binding (which integration this
     * resource belongs to) comes from CLI `--integration` or pipeline.source.
     * The pipeline loader cross-checks this against the active binding when set.
     */
    integration: SpecNameSchema.optional(),
    target: SpecNameSchema.optional(),
    description: z.string().optional(),
    source: SourceConfigSchema,
    replication: ReplicationConfigSchema,
    output: z.record(z.string(), WarehouseOutputFieldSchema),
    verify: VerifyConfigSchema.optional(),
    extract: z
      .object({
        table: TableConfigSchema.optional(),
      })
      .strict()
      .optional(),
    /**
     * Carried over from V2 transform: load defaults and overrides. Loader-side
     * consumers read this; the warehouse extractor runtime ignores it.
     */
    load: ResourceLoadBlockSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateNonEmptyColumns(value.output, value.name, ['output'], ctx);

    // Validate cursor_field references an output field when present
    if (value.replication.cursor_field && !(value.replication.cursor_field in value.output)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `replication.cursor_field "${value.replication.cursor_field}" must reference an output field`,
        path: ['replication', 'cursor_field'],
      });
    }

    // Validate primary_key references output fields when present
    for (const key of value.replication.primary_key ?? []) {
      if (!(key in value.output)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `replication.primary_key value "${key}" must reference an output field`,
          path: ['replication', 'primary_key'],
        });
      }
    }

    // Validate incremental methods require cursor_field
    const method = value.replication.method;
    if (
      (method === 'incremental_append' || method === 'incremental_merge') &&
      !value.replication.cursor_field
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `replication.cursor_field is required for method "${method}"`,
        path: ['replication', 'cursor_field'],
      });
    }

    // Validate change_tracking requires the method
    if (value.replication.change_tracking && method !== 'change_tracking') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'change_tracking config is only valid when method is "change_tracking"',
        path: ['replication', 'change_tracking'],
      });
    }

    // Validate extract.table.primary_key references output fields when present
    for (const key of value.extract?.table?.primary_key ?? []) {
      if (!(key in value.output)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `extract.table.primary_key value "${key}" must reference an output field`,
          path: ['extract', 'table', 'primary_key'],
        });
      }
    }

    // Validate incremental_merge requires primary_key
    if (
      method === 'incremental_merge' &&
      (!value.replication.primary_key || value.replication.primary_key.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'replication.primary_key is required for method "incremental_merge"',
        path: ['replication', 'primary_key'],
      });
    }

    // Validate partition_by references a timestamp output field
    const partitionBy = value.extract?.table?.partition_by;
    if (partitionBy) {
      const outputField = value.output[partitionBy];
      if (!outputField) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `partition_by column '${partitionBy}' must exist in output`,
          path: ['extract', 'table', 'partition_by'],
        });
      } else if (outputField.type !== 'timestamp') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `partition_by column '${partitionBy}' must be a timestamp output field`,
          path: ['extract', 'table', 'partition_by'],
        });
      }
    }

    // Validate change_tracking requires change_tracking config
    if (method === 'change_tracking' && !value.replication.change_tracking) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'replication.change_tracking config is required for method "change_tracking"',
        path: ['replication', 'change_tracking'],
      });
    }

    const postgresCdc = isPostgresChangeTrackingConfig(value.replication.change_tracking)
      ? value.replication.change_tracking
      : undefined;

    if (!postgresCdc) {
      return;
    }

    if (value.source.sql) {
      addIssue(
        ctx,
        ['source', 'sql'],
        'PostgreSQL change_tracking resources must use source.table, not source.sql'
      );
    }

    if (!value.source.table) {
      addIssue(
        ctx,
        ['source', 'table'],
        'PostgreSQL change_tracking resources must declare source.table'
      );
    }

    if (!value.replication.primary_key || value.replication.primary_key.length === 0) {
      addIssue(
        ctx,
        ['replication', 'primary_key'],
        'PostgreSQL change_tracking resources must declare replication.primary_key'
      );
    }

    if (!('_change_type' in value.output)) {
      addIssue(
        ctx,
        ['output', '_change_type'],
        'PostgreSQL change_tracking resources must declare an _change_type output field'
      );
    } else if (value.output['_change_type']?.type !== 'string') {
      addIssue(
        ctx,
        ['output', '_change_type', 'type'],
        'PostgreSQL change_tracking _change_type output must be type "string"'
      );
    }

    if (value.output['_commit_lsn']?.type && value.output['_commit_lsn'].type !== 'string') {
      addIssue(
        ctx,
        ['output', '_commit_lsn', 'type'],
        'PostgreSQL change_tracking _commit_lsn output must be type "string"'
      );
    }

    if (
      value.output['_transaction_id']?.type &&
      value.output['_transaction_id'].type !== 'integer'
    ) {
      addIssue(
        ctx,
        ['output', '_transaction_id', 'type'],
        'PostgreSQL change_tracking _transaction_id output must be type "integer"'
      );
    }

    if (
      value.output['_commit_timestamp']?.type &&
      value.output['_commit_timestamp'].type !== 'timestamp'
    ) {
      addIssue(
        ctx,
        ['output', '_commit_timestamp', 'type'],
        'PostgreSQL change_tracking _commit_timestamp output must be type "timestamp"'
      );
    }

    if (value.extract?.table?.load_strategy !== 'append') {
      addIssue(
        ctx,
        ['extract', 'table', 'load_strategy'],
        'PostgreSQL change_tracking resources must set extract.table.load_strategy to "append"'
      );
    }
  });

type WarehouseResourceSpec = z.infer<typeof WarehouseResourceSpecSchema>;

export function validateWarehouseResourceForIntegration(
  integration: IntegrationSpec,
  resource: WarehouseResourceSpec
): string[] {
  const errors: string[] = [];
  const sourceType = 'source_type' in integration ? integration.source_type : undefined;

  const changeTracking = resource.replication.change_tracking;
  const method = resource.replication.method;

  if (sourceType === 'postgres' && method === 'change_tracking') {
    if (!isPostgresChangeTrackingConfig(changeTracking)) {
      errors.push(
        'PostgreSQL change_tracking resources must use slot_name/publication_name (pgoutput) configuration'
      );
    }
    return errors;
  }

  if (isPostgresChangeTrackingConfig(changeTracking)) {
    errors.push(
      `change_tracking config with slot_name/publication_name is only valid for PostgreSQL resources (got ${sourceType ?? 'undefined'})`
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Three-block warehouse resource spec (V2): extract / load / schema
// ---------------------------------------------------------------------------

const ResourceSchemaBlockSchema = z
  .object({
    primary_key: z.array(z.string()).optional(),
    columns: z.record(z.string(), WarehouseOutputFieldSchema),
  })
  .strict();

/**
 * V2 replication config — same as ReplicationConfigSchema but without `primary_key`
 * (which moves to `schema.primary_key` in the three-block shape) and without the
 * `incremental_merge requires primary_key` refine (validated at the top level instead).
 */
const ReplicationConfigV2Schema = z
  .object({
    method: ReplicationMethodSchema.describe('Replication strategy'),
    cursor_field: z.string().optional().describe('Column used for incremental cursor'),
    cursor_type: CursorTypeSchema.optional().describe('Data type of the cursor column'),
    change_tracking: z
      .union([
        SnowflakeChangeTrackingSchema,
        BigQueryChangeTrackingSchema,
        PostgresChangeTrackingSchema,
        DeltaChangeTrackingSchema,
      ])
      .optional()
      .describe('Change tracking configuration (Snowflake, BigQuery, or Delta)'),
  })
  .strict();

const WarehouseExtractBlockSchema = z
  .object({
    /**
     * Optional self-description: which source integration this resource was
     * authored against. Not load-bearing — the actual binding comes from the
     * pipeline (bobsled.yml `pipeline.source`) or CLI `--integration` flag. When
     * present, the pipeline loader cross-checks against the active binding and
     * fails on mismatch. When absent, no check runs.
     *
     * Could be renamed to `extract.source` for clarity, but the V2 schema
     * already has a `source` key for the table/dataset config, so this field
     * keeps the legacy name to avoid a namespace collision.
     */
    integration: SpecNameSchema.optional(),
    source: SourceConfigSchema,
    replication: ReplicationConfigV2Schema,
    trust_tier: z.enum(['bronze', 'silver', 'gold']).optional(),
  })
  .strict();

/** Three-block warehouse resource: extract + load + schema. */
const WarehouseResourceV2SpecSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('resource'),
    name: SpecNameSchema,
    description: z.string().optional(),
    extract: WarehouseExtractBlockSchema,
    load: ResourceLoadBlockSchema.optional(),
    schema: ResourceSchemaBlockSchema,
    verify: VerifyConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateNonEmptyColumns(value.schema.columns, value.name, ['schema', 'columns'], ctx);

    // Validate cursor_field references a column when present
    if (
      value.extract.replication.cursor_field &&
      !(value.extract.replication.cursor_field in value.schema.columns)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `extract.replication.cursor_field "${value.extract.replication.cursor_field}" must reference a schema column`,
        path: ['extract', 'replication', 'cursor_field'],
      });
    }

    // Validate primary_key references schema columns when present
    for (const key of value.schema.primary_key ?? []) {
      if (!(key in value.schema.columns)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `schema.primary_key value "${key}" must reference a schema column`,
          path: ['schema', 'primary_key'],
        });
      }
    }

    // Validate incremental_merge requires primary_key
    const method = value.extract.replication.method;
    if (
      method === 'incremental_merge' &&
      (!value.schema.primary_key || value.schema.primary_key.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'schema.primary_key is required when extract.replication.method is "incremental_merge"',
        path: ['schema', 'primary_key'],
      });
    }

    // Validate change_tracking requires the method
    if (value.extract.replication.change_tracking && method !== 'change_tracking') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'change_tracking config is only valid when method is "change_tracking"',
        path: ['extract', 'replication', 'change_tracking'],
      });
    }

    // Validate change_tracking requires change_tracking config
    if (method === 'change_tracking' && !value.extract.replication.change_tracking) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'extract.replication.change_tracking config is required for method "change_tracking"',
        path: ['extract', 'replication', 'change_tracking'],
      });
    }

    // Validate incremental methods require cursor_field
    if (
      (method === 'incremental_append' || method === 'incremental_merge') &&
      !value.extract.replication.cursor_field
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `extract.replication.cursor_field is required for method "${method}"`,
        path: ['extract', 'replication', 'cursor_field'],
      });
    }
  });

export { WarehouseResourceV2SpecSchema };

/**
 * Unified ResourceSpecSchema.
 *
 * Parses all three resource variants: V2 three-block, API, and V1 warehouse.
 * V2 resources are automatically normalized to V1-compatible shape via `.transform()`
 * so downstream callers can continue using the established field paths.
 */
export const ResourceSpecSchema = z.union([
  WarehouseResourceV2SpecSchema.transform((v2): z.infer<typeof WarehouseResourceSpecSchema> => {
    // Normalize V2 three-block shape to V1-compatible shape at parse time
    const replication = {
      ...v2.extract.replication,
      ...(v2.schema.primary_key ? { primary_key: v2.schema.primary_key } : {}),
    };
    return {
      spec_version: v2.spec_version,
      type: v2.type,
      name: v2.name,
      description: v2.description,
      integration: v2.extract.integration, // V1 expects top-level `integration`
      source: v2.extract.source,
      replication,
      output: v2.schema.columns,
      extract: {
        table: {
          ...(v2.schema.primary_key ? { primary_key: v2.schema.primary_key } : {}),
          ...(v2.extract.trust_tier ? { trust_tier: v2.extract.trust_tier } : {}),
          ...(v2.load?.defaults?.load_strategy
            ? { load_strategy: v2.load.defaults.load_strategy }
            : {}),
        },
      },
      // V2 load block no longer carries integration — it's only defaults+overrides.
      // The destination binding comes from extractor.yml.default_load,
      // CLI --load-integration, or bobsled.yml pipeline.destination.
      // Preserve the full load block so loader-side consumers can read
      // overrides + defaults beyond just load_strategy.
      ...(v2.load ? { load: v2.load } : {}),
      verify: v2.verify,
    } as z.infer<typeof WarehouseResourceSpecSchema>;
  }),
  LookupOnlyApiResourceSpecSchema,
  ApiResourceSpecSchema,
  FileResourceSpecSchema,
  WarehouseResourceSpecSchema,
]);

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type Hooks = z.infer<typeof HooksSchema>;
export type ResourceSpec = z.infer<typeof ResourceSpecSchema>;
export type BillableResourceBilling = z.infer<typeof BillingSchema>;
export type WarehouseResourceV2Spec = z.infer<typeof WarehouseResourceV2SpecSchema>;
export type LoadBlock = z.infer<typeof LoadBlockSchema>;
export type ResourceLoadBlock = z.infer<typeof ResourceLoadBlockSchema>;
export type QueryOperator = z.infer<typeof QueryOperatorSchema>;
export type QueryFilterFieldSpec = z.infer<typeof QueryFilterFieldSchema>;
export type QuerySearchSpec = z.infer<typeof QuerySearchSchema>;
export type QuerySpec = z.infer<typeof QuerySpecSchema>;

// Narrowed integration types
export type ApiIntegrationSpec = z.infer<typeof ApiIntegrationSpecSchema>;
export type SnowflakeIntegrationSpec = z.infer<typeof SnowflakeIntegrationSpecSchema>;
export type BigQueryIntegrationSpec = z.infer<typeof BigQueryIntegrationSpecSchema>;
export type PostgresIntegrationSpec = z.infer<typeof PostgresIntegrationSpecSchema>;
export type RedshiftIntegrationSpec = z.infer<typeof RedshiftIntegrationSpecSchema>;
export type MysqlIntegrationSpec = z.infer<typeof MysqlIntegrationSpecSchema>;
export type IcebergIntegrationSpec = z.infer<typeof IcebergIntegrationSpecSchema>;
export type DeltaIntegrationSpec = z.infer<typeof DeltaIntegrationSpecSchema>;
export type SourceSpec = z.infer<typeof SourceSchema>;

// Narrowed resource types
export type ApiResourceSpec = z.infer<typeof ApiResourceSpecSchema>;
export type LookupOnlyApiResourceSpec = z.infer<typeof LookupOnlyApiResourceSpecSchema>;
export type { FileResourceSpec } from './file-resource.js';
/** ApiResourceSpec narrowed to HTTP resources (api block guaranteed present). */
export type HttpApiResourceSpec = ApiResourceSpec & { api: NonNullable<ApiResourceSpec['api']> };
export type { IntegrationSpec, WarehouseResourceSpec };
export {
  getResourceCapabilities,
  isLookupOnlyApiResource,
  type ResourceCapabilities,
} from './resource-capabilities.js';
