import { z } from 'zod';

import { AbsoluteHttpsUrlSchema, CursorTypeSchema } from './shared.js';

const ENV_TEMPLATE_ONLY_RE = /^\s*\$\{\{\s*env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}\s*$/;

// ---------------------------------------------------------------------------
// Dual-shape field validation helper
// ---------------------------------------------------------------------------

interface DualFieldPair {
  newField: string;
  legacyField: string;
  required: boolean;
}

/**
 * Validate dual-shape field pairs for mutual exclusivity and required-ness.
 * Intended for use inside `.superRefine` callbacks.
 */
function validateDualShapeFields(
  val: Record<string, unknown>,
  ctx: z.RefinementCtx,
  pairs: DualFieldPair[]
): void {
  for (const { newField, legacyField, required } of pairs) {
    const hasNew = val[newField] !== undefined;
    const hasLegacy = val[legacyField] !== undefined;

    if (hasNew && hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cannot set both "${newField}" and "${legacyField}"; use one or the other.`,
        path: [newField],
      });
    }

    if (required && !hasNew && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Either "${newField}" or "${legacyField}" must be set.`,
        path: [newField],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Source type enum
// ---------------------------------------------------------------------------

export const SourceTypeValues = [
  'api',
  'snowflake',
  'bigquery',
  'postgres',
  'redshift',
  'mysql',
  'clickhouse',
  'iceberg',
  'delta',
  's3',
  'gcs',
  'sftp',
  'local',
] as const;
export const SourceTypeSchema = z.enum(SourceTypeValues);
export type SourceType = z.infer<typeof SourceTypeSchema>;

// ---------------------------------------------------------------------------
// Connection schemas
// ---------------------------------------------------------------------------

export const SnowflakeConnectionSchema = z
  .object({
    account_identifier: z
      .string()
      .optional()
      .describe('Snowflake account identifier (use ${{ env.X }} interpolation)'),
    account_identifier_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the Snowflake account identifier'),
    warehouse: z
      .string()
      .optional()
      .describe('Snowflake warehouse name (use ${{ env.X }} interpolation)'),
    warehouse_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the Snowflake warehouse name'),
    warehouses: z
      .record(z.string().min(1), z.string().min(1))
      .optional()
      .describe('Named selectable Snowflake warehouses (selector id -> physical warehouse name)'),
    user: z.string().optional().describe('Snowflake username (use ${{ env.X }} interpolation)'),
    user_env: z.string().optional().describe('[DEPRECATED] Env var holding the Snowflake username'),
    database: z
      .string()
      .optional()
      .describe(
        'Optional default database name (used when a resource does not qualify its source)'
      ),
    schema: z
      .string()
      .optional()
      .describe('Optional default schema name (used when a resource does not qualify its source)'),
    role: z.string().describe('Snowflake role to assume — session-wide permission boundary'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'account_identifier', legacyField: 'account_identifier_env', required: true },
      { newField: 'warehouse', legacyField: 'warehouse_env', required: true },
      { newField: 'user', legacyField: 'user_env', required: false },
    ]);
    if (val.warehouses === undefined) return;
    const values = Object.values(val.warehouses);
    if (values.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'warehouses must declare at least one entry when set.',
        path: ['warehouses'],
      });
    }
    const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `warehouses must not repeat warehouse names: ${[...new Set(duplicates)].join(', ')}.`,
        path: ['warehouses'],
      });
    }
    if (
      typeof val.warehouse === 'string' &&
      !ENV_TEMPLATE_ONLY_RE.test(val.warehouse) &&
      !values.includes(val.warehouse)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Default warehouse "${val.warehouse}" must be one of the declared ` +
          `warehouses values: ${values.join(', ')}.`,
        path: ['warehouse'],
      });
    }
  });

export const BigQueryConnectionSchema = z
  .object({
    project_ids: z.array(z.string()).min(1).describe('GCP project IDs to extract from'),
    billing_project_id: z.string().describe('GCP project used for billing'),
    default_location: z.string().optional().describe('Default BigQuery dataset location'),
  })
  .strict();

/** Shared operational fields for PG-compatible connection schemas. */
const pgOperationalFields = {
  max_connections: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Maximum pool connections'),
  statement_timeout_ms: z
    .number()
    .int()
    .positive()
    .max(86_400_000)
    .optional()
    .describe('Statement timeout in milliseconds (max 24h)'),
};

export const PostgresConnectionSchema = z
  .object({
    host_env: z.string().describe('Env var holding the PostgreSQL host'),
    port: z.number().int().positive().max(65535).describe('PostgreSQL port'),
    database: z.string().describe('Database name'),
    schema: z.string().optional().describe('Default schema for unqualified table names'),
    ...pgOperationalFields,
  })
  .strict();

export const RedshiftConnectionSchema = z
  .object({
    host_env: z.string().describe('Env var holding the Redshift cluster endpoint'),
    port: z.number().int().positive().max(65535).describe('Redshift port'),
    database: z.string().describe('Database name'),
    schema: z.string().optional().describe('Default schema for unqualified table names'),
    ...pgOperationalFields,
  })
  .strict();

export const MysqlConnectionSchema = z
  .object({
    host_env: z.string().describe('Env var holding the MySQL host'),
    port: z.number().int().positive().max(65535).describe('MySQL port'),
    database: z.string().describe('Database name'),
    statement_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(86_400_000)
      .optional()
      .describe('Statement timeout in milliseconds (max 24h)'),
  })
  .strict();

export const ClickHouseConnectionSchema = z
  .object({
    host_env: z.string().describe('Env var holding the ClickHouse host'),
    port: z
      .number()
      .int()
      .positive()
      .max(65535)
      .default(8123)
      .describe('ClickHouse HTTP interface port (8123 plain, 8443 for TLS / ClickHouse Cloud)'),
    database: z.string().describe('Database name'),
    statement_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(86_400_000)
      .optional()
      .describe('Statement timeout in milliseconds (max 24h)'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Auth schemas
// ---------------------------------------------------------------------------

export const SnowflakePatAuthSchema = z
  .object({
    type: z.literal('pat'),
    token: z
      .string()
      .optional()
      .describe('Snowflake personal access token (use ${{ env.X }} interpolation)'),
    token_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the Snowflake personal access token'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'token', legacyField: 'token_env', required: true },
    ]);
  });

export const SnowflakeOAuthSchema = z
  .object({
    type: z.literal('oauth'),
    client_id: z.string().optional().describe('OAuth client ID (use ${{ env.X }} interpolation)'),
    client_id_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the OAuth client ID'),
    client_secret: z
      .string()
      .optional()
      .describe('OAuth client secret (use ${{ env.X }} interpolation)'),
    client_secret_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the OAuth client secret'),
    token_url: AbsoluteHttpsUrlSchema.describe('OAuth token endpoint URL'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'client_id', legacyField: 'client_id_env', required: true },
      { newField: 'client_secret', legacyField: 'client_secret_env', required: true },
    ]);
  });

export const SnowflakeRsaKeyAuthSchema = z
  .object({
    type: z.literal('rsa_key'),
    private_key_path: z
      .string()
      .optional()
      .describe('Path to a PKCS#8 RSA private key file (use ${{ env.X }} interpolation)'),
    private_key_path_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the absolute path to a PKCS#8 RSA private key file'),
    private_key_passphrase: z
      .string()
      .optional()
      .describe('Passphrase for the private key (use ${{ env.X }} interpolation)'),
    private_key_passphrase_env: z
      .string()
      .optional()
      .describe(
        '[DEPRECATED] Env var holding the passphrase for the private key (omit for unencrypted keys)'
      ),
    // Username lives on the connection (connection.user/user_env) so both rsa_key and oauth
    // auth reuse it — and so the loader has a single place to look for the SDK username.
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'private_key_path', legacyField: 'private_key_path_env', required: true },
      {
        newField: 'private_key_passphrase',
        legacyField: 'private_key_passphrase_env',
        required: false,
      },
    ]);
  });

/**
 * Workload identity federation over the Snowflake SQL REST API. The
 * host application wrapping Dogsled
 * mints a short-lived identity token externally and passes it in; the
 * extractor sends it as `Authorization: Bearer WIF.<provider>.<token>`. No
 * username, key material, or secret is needed: Snowflake maps the token
 * subject to a user through that user's `WORKLOAD_IDENTITY` property.
 *
 * `provider` selects the bearer prefix. AWS is not offered because the AWS
 * flow presents a signed STS request rather than a bearer token. The token is
 * static for the run: an extraction that outlasts the token TTL fails, so keep
 * long-running extracts on `rsa_key` or `pat`.
 */
export const SnowflakeWorkloadIdentityProviderSchema = z.enum(['OIDC', 'GCP', 'AZURE']);

export const SnowflakeWorkloadIdentityAuthSchema = z
  .object({
    type: z.literal('workload_identity'),
    provider: SnowflakeWorkloadIdentityProviderSchema.default('OIDC').describe(
      'Identity provider that issued the token: OIDC (default), GCP, or AZURE'
    ),
    token: z
      .string()
      .min(1)
      .describe('Pre-minted workload identity token (use ${{ env.X }} interpolation)'),
  })
  .strict();

export const SnowflakeAuthSchema = z.discriminatedUnion('type', [
  SnowflakePatAuthSchema,
  SnowflakeOAuthSchema,
  SnowflakeRsaKeyAuthSchema,
  SnowflakeWorkloadIdentityAuthSchema,
]);

export const BigQueryAdcAuthSchema = z
  .object({
    type: z.literal('adc'),
  })
  .strict();

export const BigQueryWifAuthSchema = z
  .object({
    type: z.literal('wif'),
    service_account_email_env: z.string().describe('Env var holding the GCP service account email'),
  })
  .strict();

export const BigQueryServiceAccountAuthSchema = z
  .object({
    type: z.literal('service_account'),
    credentials: z
      .string()
      .optional()
      .describe('Path to GCP service account JSON key file (use ${{ env.X }} interpolation)'),
    credentials_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the path to GCP service account JSON key file'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'credentials', legacyField: 'credentials_env', required: true },
    ]);
  });

/**
 * Pre-minted OAuth 2.0 access-token auth. The host application
 * impersonates a per-account service account via Workload Identity Federation and mints a short-lived token externally and
 * passes it in — no GCP key material, no ambient ADC. Mirrors the loader's
 * `credentials_access_token` / `credentials_token_command` destination auth so
 * a host-managed warehouse can be both read FROM and written TO with the
 * same impersonation flow.
 *
 * `access_token` is the static token (always present as a fallback). When
 * `token_command` is set it takes precedence: it is run per-fetch to obtain a
 * fresh `{"access_token","expires_at"}` JSON, so an extraction that outlasts
 * the ~1h token TTL keeps authenticating. Both fields support `${{ env.X }}`
 * interpolation and are resolved before the client sees them.
 */
export const BigQueryAccessTokenAuthSchema = z
  .object({
    type: z.literal('access_token'),
    access_token: z
      .string()
      .describe('Pre-minted short-lived OAuth 2.0 access token (use ${{ env.X }} interpolation)'),
    token_command: z
      .string()
      .regex(
        ENV_TEMPLATE_ONLY_RE,
        'token_command must be an exact ${{ env.VARIABLE }} reference; raw shell commands are not allowed in source YAML'
      )
      .optional()
      .describe(
        'Environment-variable reference whose value is a trusted command that prints fresh ' +
          '{"access_token","expires_at"} JSON on stdout, run per-fetch for mid-run token refresh. ' +
          'Raw commands in source YAML are rejected. Takes precedence over the static access_token.'
      ),
  })
  .strict();

export const BigQueryAuthSchema = z.discriminatedUnion('type', [
  BigQueryAdcAuthSchema,
  BigQueryWifAuthSchema,
  BigQueryServiceAccountAuthSchema,
  BigQueryAccessTokenAuthSchema,
]);

export const DatabasePasswordAuthSchema = z
  .object({
    type: z.literal('password'),
    username_env: z.string().describe('Env var holding the database username'),
    password_env: z.string().describe('Env var holding the database password'),
  })
  .strict();

export const DatabaseIamAuthSchema = z
  .object({
    type: z.literal('iam'),
    username_env: z.string().describe('Env var holding the IAM database username'),
  })
  .strict();

export const DatabaseAuthSchema = z.discriminatedUnion('type', [
  DatabasePasswordAuthSchema,
  DatabaseIamAuthSchema,
]);

/** ClickHouse currently supports password authentication in the extractor. */
export const ClickHouseAuthSchema = DatabasePasswordAuthSchema;

// ---------------------------------------------------------------------------
// SSL configuration
// ---------------------------------------------------------------------------

export const PostgresSslModeValues = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
] as const;

export const MysqlSslModeValues = ['disable', 'require', 'verify-ca', 'verify-identity'] as const;

export const PostgresSslConfigSchema = z
  .object({
    mode: z.enum(PostgresSslModeValues).describe('PostgreSQL SSL connection mode'),
    ca_cert_env: z.string().optional().describe('Env var holding PEM-encoded CA certificate'),
  })
  .strict();

export const RedshiftSslConfigSchema = z
  .object({
    mode: z.enum(PostgresSslModeValues).describe('Redshift SSL connection mode'),
    ca_cert_env: z.string().optional().describe('Env var holding PEM-encoded CA certificate'),
  })
  .strict();

export const MysqlSslConfigSchema = z
  .object({
    mode: z.enum(MysqlSslModeValues).describe('MySQL SSL connection mode'),
    ca_cert_env: z.string().optional().describe('Env var holding PEM-encoded CA certificate'),
  })
  .strict();

export const ClickHouseSslModeValues = ['disable', 'require'] as const;

export const ClickHouseSslConfigSchema = z
  .object({
    mode: z
      .enum(ClickHouseSslModeValues)
      .describe('disable = http, require = https verified against the system CA or ca_cert_env'),
    ca_cert_env: z.string().optional().describe('Env var holding PEM-encoded CA certificate'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Storage auth for lakehouse formats (S3, GCS)
// ---------------------------------------------------------------------------

export const AwsCredentialsStorageAuthSchema = z
  .object({
    type: z.literal('aws_credentials'),
    access_key_id_env: z.string().describe('Env var holding the AWS access key ID'),
    secret_access_key_env: z.string().describe('Env var holding the AWS secret access key'),
    session_token_env: z.string().optional().describe('Env var holding the AWS session token'),
    region: z.string().describe('AWS region'),
  })
  .strict();

export const AwsIamStorageAuthSchema = z
  .object({
    type: z.literal('aws_iam'),
    region: z.string().describe('AWS region (uses instance metadata for credentials)'),
  })
  .strict();

export const GcpHmacStorageAuthSchema = z
  .object({
    type: z.literal('gcp_hmac'),
    access_key_id_env: z.string().describe('Env var holding the GCS HMAC access key'),
    secret_access_key_env: z.string().describe('Env var holding the GCS HMAC secret key'),
  })
  .strict();

export const GcpServiceAccountStorageAuthSchema = z
  .object({
    type: z.literal('gcp_service_account'),
    service_account_key_env: z
      .string()
      .describe('Env var holding the GCP service account JSON key'),
  })
  .strict();

export const StorageAuthSchema = z.discriminatedUnion('type', [
  AwsCredentialsStorageAuthSchema,
  AwsIamStorageAuthSchema,
  GcpHmacStorageAuthSchema,
  GcpServiceAccountStorageAuthSchema,
]);

// ---------------------------------------------------------------------------
// Iceberg connection and auth schemas
// ---------------------------------------------------------------------------

export const IcebergRestCatalogConnectionSchema = z
  .object({
    mode: z.literal('rest_catalog'),
    catalog_url: AbsoluteHttpsUrlSchema.describe('REST Catalog endpoint URL'),
    warehouse: z.string().optional().describe('Catalog warehouse identifier'),
    default_namespace: z.string().optional().describe('Default Iceberg namespace'),
  })
  .strict();

export const IcebergDirectConnectionSchema = z
  .object({
    mode: z.literal('direct'),
    warehouse_path: z.string().describe('S3/GCS path to the Iceberg warehouse root'),
  })
  .strict();

export const IcebergConnectionSchema = z.discriminatedUnion('mode', [
  IcebergRestCatalogConnectionSchema,
  IcebergDirectConnectionSchema,
]);

export const IcebergOAuth2AuthSchema = z
  .object({
    type: z.literal('oauth2'),
    client_id_env: z.string().describe('Env var holding the OAuth2 client ID'),
    client_secret_env: z.string().describe('Env var holding the OAuth2 client secret'),
    token_url: AbsoluteHttpsUrlSchema.describe('OAuth2 token endpoint URL'),
    scope: z.string().optional().describe('OAuth2 scope'),
  })
  .strict();

export const IcebergTokenAuthSchema = z
  .object({
    type: z.literal('token'),
    token_env: z.string().describe('Env var holding the bearer token'),
  })
  .strict();

export const IcebergAuthSchema = z.discriminatedUnion('type', [
  IcebergOAuth2AuthSchema,
  IcebergTokenAuthSchema,
]);

// ---------------------------------------------------------------------------
// Delta Lake connection schema
// ---------------------------------------------------------------------------

export const DeltaConnectionSchema = z
  .object({
    storage_url: z.string().describe('S3/GCS base path for Delta tables'),
    default_schema: z.string().optional().describe('Default schema/directory for tables'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Replication configuration
// ---------------------------------------------------------------------------

export const ReplicationMethodValues = [
  'full_refresh',
  'incremental_append',
  'incremental_merge',
  'change_tracking',
] as const;

export const ReplicationMethodSchema = z.enum(ReplicationMethodValues);
export type ReplicationMethod = z.infer<typeof ReplicationMethodSchema>;

export const SnowflakeChangeTrackingSchema = z
  .object({
    information: z
      .enum(['default', 'append_only'])
      .describe('Snowflake CHANGES clause information mode'),
  })
  .strict();

export const BigQueryChangeTrackingSchema = z
  .object({
    type: z.enum(['appends', 'changes']).describe('BigQuery change tracking TVF type'),
  })
  .strict();

export const PostgresChangeTrackingSchema = z
  .object({
    plugin: z.literal('pgoutput').optional().describe('Logical decoding output plugin'),
    slot_name: z.string().describe('Logical replication slot name'),
    publication_name: z.string().describe('Publication used for pgoutput decoding'),
  })
  .strict();

export const DeltaChangeTrackingSchema = z
  .object({
    type: z.literal('cdf').describe('Delta Change Data Feed'),
  })
  .strict();

export const ReplicationConfigSchema = z
  .object({
    method: ReplicationMethodSchema.describe('Replication strategy'),
    cursor_field: z.string().optional().describe('Column used for incremental cursor'),
    cursor_type: CursorTypeSchema.optional().describe('Data type of the cursor column'),
    primary_key: z
      .array(z.string())
      .optional()
      .describe('Primary key columns for merge deduplication'),
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
  .strict()
  .refine(
    (val) => val.method !== 'incremental_merge' || (val.primary_key && val.primary_key.length > 0),
    { message: 'incremental_merge method requires at least one primary_key column' }
  );

export type ReplicationConfig = z.infer<typeof ReplicationConfigSchema>;

// ---------------------------------------------------------------------------
// Source configuration (resource-level)
// ---------------------------------------------------------------------------

export const SourceConfigSchema = z
  .object({
    table: z
      .string()
      .optional()
      .describe('Source table name (plain identifier — no project/dataset/schema qualifier)')
      .refine((val) => val === undefined || !val.includes('.'), {
        message:
          '[FQN_IN_RESOURCE_TABLE] table: must be a plain name (e.g. "ORDERS"), not a qualified FQN. ' +
          'Put the dataset/schema/database in the dedicated dataset: / schema: / database: fields instead.',
      }),
    sql: z.string().max(100_000).optional().describe('Custom SQL query'),
    database: z.string().optional().describe('Database override'),
    schema: z.string().optional().describe('Schema override (Snowflake, PostgreSQL)'),
    dataset: z.string().optional().describe('Dataset override (BigQuery)'),
  })
  .strict()
  .refine((val) => val.table !== undefined || val.sql !== undefined, {
    message: 'Either table or sql must be specified',
  })
  .refine((val) => !(val.schema !== undefined && val.dataset !== undefined), {
    message:
      '[BQ_USES_DATASET] Both schema: and dataset: are set — pick one. BigQuery resources use dataset:; ' +
      'Snowflake/PostgreSQL/Redshift use schema:. Setting both is contradictory.',
    path: ['dataset'],
  });

export type SourceConfig = z.infer<typeof SourceConfigSchema>;

// ---------------------------------------------------------------------------
// Inferred types for connections and auth
// ---------------------------------------------------------------------------

export type SnowflakeConnection = z.infer<typeof SnowflakeConnectionSchema>;
export type BigQueryConnection = z.infer<typeof BigQueryConnectionSchema>;
export type PostgresConnection = z.infer<typeof PostgresConnectionSchema>;
export type RedshiftConnection = z.infer<typeof RedshiftConnectionSchema>;
export type MysqlConnection = z.infer<typeof MysqlConnectionSchema>;
export type ClickHouseConnection = z.infer<typeof ClickHouseConnectionSchema>;
export type SnowflakeAuth = z.infer<typeof SnowflakeAuthSchema>;
export type BigQueryAuth = z.infer<typeof BigQueryAuthSchema>;
export type DatabaseAuth = z.infer<typeof DatabaseAuthSchema>;
export type PostgresSslConfig = z.infer<typeof PostgresSslConfigSchema>;
export type RedshiftSslConfig = z.infer<typeof RedshiftSslConfigSchema>;
export type MysqlSslConfig = z.infer<typeof MysqlSslConfigSchema>;
export type ClickHouseSslConfig = z.infer<typeof ClickHouseSslConfigSchema>;
export type SnowflakeChangeTracking = z.infer<typeof SnowflakeChangeTrackingSchema>;
export type BigQueryChangeTracking = z.infer<typeof BigQueryChangeTrackingSchema>;
export type PostgresChangeTracking = z.infer<typeof PostgresChangeTrackingSchema>;
export type DeltaChangeTracking = z.infer<typeof DeltaChangeTrackingSchema>;
export type StorageAuth = z.infer<typeof StorageAuthSchema>;
export type IcebergConnection = z.infer<typeof IcebergConnectionSchema>;
export type IcebergAuth = z.infer<typeof IcebergAuthSchema>;
export type DeltaConnection = z.infer<typeof DeltaConnectionSchema>;
