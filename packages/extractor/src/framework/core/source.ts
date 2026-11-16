import { AuthEnvVarsSchema } from '@bobsled-inc/protocol';
import {
  BLUEPRINT_EXTENSION_KEY_PREFIXES,
  LegacyBlueprintKeyConflictError,
  normalizeLegacyBlueprintKeys,
} from '@bobsled-inc/protocol';

import { z } from 'zod';

import { TransportConfigSchema } from './integration.js';
import { SpecNameSchema } from './shared.js';
import {
  BigQueryAuthSchema,
  BigQueryConnectionSchema,
  ClickHouseAuthSchema,
  ClickHouseConnectionSchema,
  ClickHouseSslConfigSchema,
  DatabaseAuthSchema,
  DeltaConnectionSchema,
  IcebergAuthSchema,
  IcebergConnectionSchema,
  MysqlConnectionSchema,
  MysqlSslConfigSchema,
  PostgresConnectionSchema,
  PostgresSslConfigSchema,
  RedshiftConnectionSchema,
  RedshiftSslConfigSchema,
  SnowflakeAuthSchema,
  SnowflakeConnectionSchema,
  StorageAuthSchema,
} from './warehouse.js';
import { TransportPolicySchema } from './transport-policy.js';

export const SqlTransportDialectValues = [
  'snowflake',
  'bigquery',
  'postgres',
  'redshift',
  'mysql',
  'clickhouse',
  'iceberg',
  'delta',
] as const;

export const SqlTransportTypeValues = SqlTransportDialectValues.map(
  (dialect) => `sql_${dialect}` as const
);

export const SqlTransportDialectSchema = z.enum(SqlTransportDialectValues);
export const SqlTransportTypeSchema = z.enum(SqlTransportTypeValues);

const TransportIdentitySchema = z
  .object({
    id: SpecNameSchema,
    description: z.string().optional(),
    policy: TransportPolicySchema.optional(),
  })
  .strict();

const HttpSourceTransportSchema = TransportConfigSchema.and(TransportIdentitySchema).refine(
  (value) => value.type === 'http',
  { message: 'expected HTTP transport', path: ['type'] }
);
const McpHttpSourceTransportSchema = TransportConfigSchema.and(TransportIdentitySchema).refine(
  (value) => value.type === 'mcp_http',
  { message: 'expected MCP HTTP transport', path: ['type'] }
);
const McpStdioSourceTransportSchema = TransportConfigSchema.and(TransportIdentitySchema).refine(
  (value) => value.type === 'mcp_stdio',
  { message: 'expected MCP stdio transport', path: ['type'] }
);

const SnowflakeSqlTransportSchema = TransportIdentitySchema.extend({
  type: z.literal('sql_snowflake'),
  connection: SnowflakeConnectionSchema,
  auth: SnowflakeAuthSchema,
}).strict();

const BigQuerySqlTransportSchema = TransportIdentitySchema.extend({
  type: z.literal('sql_bigquery'),
  connection: BigQueryConnectionSchema,
  auth: BigQueryAuthSchema,
}).strict();

const PostgresSqlTransportSchema = TransportIdentitySchema.extend({
  type: z.literal('sql_postgres'),
  connection: PostgresConnectionSchema,
  auth: DatabaseAuthSchema,
  ssl: PostgresSslConfigSchema.optional(),
}).strict();

const RedshiftSqlTransportSchema = TransportIdentitySchema.extend({
  type: z.literal('sql_redshift'),
  connection: RedshiftConnectionSchema,
  auth: DatabaseAuthSchema,
  ssl: RedshiftSslConfigSchema.optional(),
}).strict();

const MysqlSqlTransportSchema = TransportIdentitySchema.extend({
  type: z.literal('sql_mysql'),
  connection: MysqlConnectionSchema,
  auth: DatabaseAuthSchema,
  ssl: MysqlSslConfigSchema.optional(),
}).strict();

const ClickHouseSqlTransportSchema = TransportIdentitySchema.extend({
  type: z.literal('sql_clickhouse'),
  connection: ClickHouseConnectionSchema,
  auth: ClickHouseAuthSchema,
  ssl: ClickHouseSslConfigSchema.optional(),
}).strict();

const IcebergSqlTransportSchema = TransportIdentitySchema.extend({
  type: z.literal('sql_iceberg'),
  connection: IcebergConnectionSchema,
  auth: IcebergAuthSchema.optional(),
  storage: StorageAuthSchema.optional(),
}).strict();

const DeltaSqlTransportSchema = TransportIdentitySchema.extend({
  type: z.literal('sql_delta'),
  connection: DeltaConnectionSchema,
  storage: StorageAuthSchema,
}).strict();

export const TransportSchema = z.union([
  HttpSourceTransportSchema,
  McpHttpSourceTransportSchema,
  McpStdioSourceTransportSchema,
  SnowflakeSqlTransportSchema,
  BigQuerySqlTransportSchema,
  PostgresSqlTransportSchema,
  RedshiftSqlTransportSchema,
  MysqlSqlTransportSchema,
  ClickHouseSqlTransportSchema,
  IcebergSqlTransportSchema,
  DeltaSqlTransportSchema,
]);

/**
 * Reserved prefixes for orchestrator-specific extension keys at the top
 * level of a source / integration / resource spec. Dogsled ignores these
 * fields — the orchestrator wrapping Dogsled (e.g. an internal control
 * plane, a SaaS scheduler, or a CI runner) reads them. Standalone
 * Dogsled CLI users won't author them; the prefix is the signal that
 * "this field is for some other tool."
 *
 * - `x-*`     — generic, OpenAPI-style extension namespace.
 * - `bobsled_*` — fields used by a host application's managed ELT
 *               adapter (e.g. `bobsled_connection_ref` linking the
 *               source to a host-managed connection row).
 *
 * We preprocess these out of the input BEFORE the strict schema runs.
 * This keeps the inferred Source type clean (no `[k: string]: unknown`
 * index signature from `.passthrough()`) so existing
 * `'transport' in integration` discriminator narrowing stays correct
 * across consumers in this repo.
 */
const SOURCE_EXTENSION_KEY_PREFIXES = ['x-', ...BLUEPRINT_EXTENSION_KEY_PREFIXES];

const isSourceExtensionKey = (key: string): boolean =>
  SOURCE_EXTENSION_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

function stripExtensionKeys(input: unknown, ctx: z.RefinementCtx): unknown {
  try {
    input = normalizeLegacyBlueprintKeys(input, { kind: 'integration' }).document;
  } catch (error) {
    if (!(error instanceof LegacyBlueprintKeyConflictError)) throw error;
    ctx.addIssue({ code: 'custom', message: error.message, params: { code: error.code } });
    return z.NEVER;
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSourceExtensionKey(key)) continue;
    out[key] = value;
  }
  return out;
}

export const SourceSchema = z.preprocess(
  stripExtensionKeys,
  z
    .object({
      spec_version: z.literal('2'),
      // `integration` is the canonical type for new files; `source` stays
      // valid for existing ones.
      type: z.enum(['integration', 'source']),
      // Self-describing source kinds — authored purely in YAML, no bundled
      // connector module. The only Dogsled-CLI-visible source_type values on a
      // v2 source (warehouse/file/legacy specs use their own schemas):
      //
      //   - `custom_api`  — REST / GraphQL APIs (inline `http` transport).
      //   - `custom_mcp`  — Remote MCP servers (inline `mcp_http` transport).
      //                     `mcp_stdio` is rejected; running a customer-supplied
      //                     binary inside the hosted extractor is not in scope.
      //
      // Omitted for ordinary bundled HTTP / MCP sources.
      source_type: z.enum(['custom_api', 'custom_mcp']).optional(),
      name: SpecNameSchema,
      description: z.string().optional(),
      // Declarative list of env var names the inline transports interpolate via
      // `${{ env.X }}`. Lets a self-describing source document its required
      // secrets without a separate meta.yml `auth_setup` block.
      auth_env_vars: AuthEnvVarsSchema,
      default_transport: SpecNameSchema.optional(),
      // Empty transports[] is permitted so orchestrator-managed bundles
      // that exist purely as semantic-model metadata (Model Spec sources, no
      // ETL) can omit the transport block entirely. Standalone Dogsled
      // CLI users still need ≥1 transport in practice — resources
      // reference one via `via:`, and `resolveVia` throws if the
      // referenced id is missing. Defaults to [] when omitted.
      transports: z.array(TransportSchema).optional().default([]),
    })
    .strict()
    .superRefine((value, ctx) => {
      const ids = new Set<string>();
      for (const [index, transport] of value.transports.entries()) {
        if (ids.has(transport.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `transport id "${transport.id}" must be unique`,
            path: ['transports', index, 'id'],
          });
        }
        ids.add(transport.id);
      }

      if (value.default_transport && !ids.has(value.default_transport)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `default_transport "${value.default_transport}" must reference a transport id`,
          path: ['default_transport'],
        });
      }

      // custom_mcp is HTTP-only on purpose: the hosted extractor doesn't run
      // customer-supplied stdio binaries. mcp_stdio remains available for
      // internal / catalog integrations whose binaries we control.
      if (value.source_type === 'custom_mcp') {
        for (const [index, transport] of value.transports.entries()) {
          if (transport.type !== 'mcp_http') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `custom_mcp sources may only declare mcp_http transports (got "${transport.type}")`,
              path: ['transports', index, 'type'],
            });
          }
        }
      }
    })
);

export type SqlTransportDialect = z.infer<typeof SqlTransportDialectSchema>;
export type SqlTransportType = z.infer<typeof SqlTransportTypeSchema>;
export type Transport = z.infer<typeof TransportSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type SqlTransport = Extract<Transport, { type: SqlTransportType }>;

export function isSourceSpec(spec: unknown): spec is Source {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    'transports' in spec &&
    Array.isArray((spec as Record<string, unknown>).transports)
  );
}

export function findTransport(source: Source, id: string): Transport | undefined {
  return source.transports.find((transport) => transport.id === id);
}

export function resolveVia(source: Source, via?: string): Transport {
  const resolvedId = via ?? source.default_transport;

  if (resolvedId) {
    const transport = findTransport(source, resolvedId);
    if (!transport) {
      throw new Error(`Transport "${resolvedId}" not found in source "${source.name}"`);
    }
    return transport;
  }

  if (source.transports.length === 1) {
    return source.transports[0] as Transport;
  }

  throw new Error(`Source "${source.name}" requires via because it has multiple transports`);
}

export function listTransportTypes(source: Source): Transport['type'][] {
  return Array.from(new Set(source.transports.map((transport) => transport.type)));
}

export function isSqlTransport(transport: Transport): transport is SqlTransport {
  return SqlTransportTypeValues.includes(transport.type as SqlTransportType);
}

export function getSqlDialect(transport: Transport): SqlTransportDialect | undefined {
  if (!isSqlTransport(transport)) {
    return undefined;
  }

  return transport.type.slice('sql_'.length) as SqlTransportDialect;
}
