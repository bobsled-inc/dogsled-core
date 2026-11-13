import {
  BLUEPRINT_EXTENSION_KEY_PREFIXES,
  LegacyBlueprintKeyConflictError,
  normalizeLegacyBlueprintKeys,
} from '@bobsled-inc/protocol';

import * as path from 'node:path';

import { z } from 'zod';
import {
  ActionSpecSchema,
  ResourceSpecSchema as LegacyResourceSpecSchema,
} from '@bobsled-inc/extractor/extractor';
import { TransportConfigSchema } from '@bobsled-inc/extractor/core';

export const CATEGORIES = [
  'developer-tools',
  'crm',
  'marketing',
  'finance',
  'communication',
  'analytics',
  'cloud-infra',
  'productivity',
  'support',
  'task-management',
] as const;

const OpenApiSourceSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('https://') || (!value.includes('://') && !path.isAbsolute(value)),
    'Must be an HTTPS URL or a repo-relative file path'
  );

const AuthSetupEntrySchema = z
  .object({
    env: z.string(),
    description: z.string(),
    docs_url: z.string().url().optional(),
  })
  .strict();

export const MetaSpecSchema = z
  .object({
    display_name: z.string().min(1),
    category: z.enum(CATEGORIES),
    status: z.string().min(1).optional(),
    tags: z.array(z.string()).min(1),
    logo_url: z.string().url().optional(),
    docs_url: z.string().url(),
    openapi_url: OpenApiSourceSchema.optional(),
    // Optional: a self-describing `custom_api` source documents its required
    // env vars inline via source.yml `auth_env_vars` instead, so meta.yml need
    // not carry an auth_setup block. Bundled first-party sources still declare
    // it (enforced by the integrations test suite, not the schema).
    auth_setup: z.array(AuthSetupEntrySchema).min(1).optional(),
  })
  .strict();

const SourceTransportSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough()
  .transform((value, ctx) => {
    const { id: _id, ...transport } = value;
    const result = TransportConfigSchema.safeParse(transport);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: issue.path,
        });
      }
      return z.NEVER;
    }
    return { id: value.id, ...result.data };
  });

// Host application extension namespaces (e.g. `dogsled_source_kind`) and
// OpenAPI-style `x-*` keys are tolerated and stripped before strict validation,
// mirroring the extractor's `SourceSchema` so a self-describing source.yml
// validates identically here and at extract time.
const SOURCE_EXTENSION_KEY_PREFIXES = ['x-', ...BLUEPRINT_EXTENSION_KEY_PREFIXES];

function stripSourceExtensionKeys(input: unknown, ctx: z.RefinementCtx): unknown {
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
    if (SOURCE_EXTENSION_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}

export const SourceSpecSchema = z.preprocess(
  stripSourceExtensionKeys,
  z
    .object({
      spec_version: z.literal('2'),
      type: z.literal('source'),
      // Self-describing source kinds — author the source purely in YAML with
      // an inline transport, no bundled connector module required.
      //
      //   - `custom_api`  — REST / GraphQL APIs (inline `http` transport).
      //   - `custom_mcp`  — Remote MCP servers (inline `mcp_http` transport).
      //                     `mcp_stdio` is rejected: running a customer-supplied
      //                     binary inside the hosted extractor is not in scope.
      //
      // Omitted for ordinary bundled HTTP / MCP sources.
      source_type: z.enum(['custom_api', 'custom_mcp']).optional(),
      name: z.string().min(1),
      description: z.string().optional(),
      // Env var names the inline transports interpolate via `${{ env.X }}`.
      auth_env_vars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
      default_transport: z.string().min(1).optional(),
      transports: z.array(SourceTransportSchema).min(1),
      hooks: z.unknown().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const transportIds = new Set<string>();
      for (const [index, transport] of value.transports.entries()) {
        if (transportIds.has(transport.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate transport id "${transport.id}"`,
            path: ['transports', index, 'id'],
          });
        }
        transportIds.add(transport.id);
      }

      if (value.default_transport !== undefined && !transportIds.has(value.default_transport)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `default_transport "${value.default_transport}" must reference a transport id`,
          path: ['default_transport'],
        });
      }

      // custom_mcp is HTTP-only on purpose: the hosted extractor doesn't run
      // customer-supplied stdio binaries. mcp_stdio remains available for
      // internal/catalog integrations whose binaries we control.
      if (value.source_type === 'custom_mcp') {
        for (const [index, transport] of value.transports.entries()) {
          const transportType = (transport as { type?: unknown }).type;
          if (transportType !== 'mcp_http') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `custom_mcp sources may only declare mcp_http transports (got "${String(transportType)}")`,
              path: ['transports', index, 'type'],
            });
          }
        }
      }
    })
);

function cloneYamlObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeResourceForLegacySchema(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const resource = cloneYamlObject(value);
  const transport = resource['transport'];
  if (resource['via'] === undefined && typeof transport === 'string') {
    resource['via'] = transport;
  }

  const incremental = resource['incremental'];
  if (incremental && typeof incremental === 'object' && !Array.isArray(incremental)) {
    const nextIncremental = { ...(incremental as Record<string, unknown>) };
    if (nextIncremental['strategy'] === 'server_filter') {
      if (nextIncremental['since_argument'] || nextIncremental['filter_argument']) {
        nextIncremental['strategy'] = 'filter';
      } else if (nextIncremental['cursor_param']) {
        nextIncremental['strategy'] = 'cursor';
        delete nextIncremental['since_argument'];
        delete nextIncremental['until_argument'];
        delete nextIncremental['filter_argument'];
        delete nextIncremental['value_format'];
        delete nextIncremental['lookback_seconds'];
        delete nextIncremental['initial_lookback_seconds'];
        delete nextIncremental['window_size_seconds'];
      }
    }
    resource['incremental'] = nextIncremental;
  }

  delete resource['transport'];
  return resource;
}

export const ResourceSpecSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resource spec must be a YAML object',
      });
      return;
    }

    const resource = value as Record<string, unknown>;
    if ('spec_version' in resource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resource specs inherit source.yml spec_version and must not set spec_version',
        path: ['spec_version'],
      });
    }
    if ('integration' in resource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resource specs inherit source.yml name and must not set integration',
        path: ['integration'],
      });
    }

    const incremental = resource['incremental'];
    if (incremental && typeof incremental === 'object' && !Array.isArray(incremental)) {
      const strategy = (incremental as Record<string, unknown>)['strategy'];
      if (strategy !== 'server_filter' && strategy !== 'cursor' && strategy !== 'full_refresh') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'incremental.strategy must be "server_filter", "cursor", or "full_refresh"',
          path: ['incremental', 'strategy'],
        });
      }
    }

    const legacyResult = LegacyResourceSpecSchema.safeParse(
      normalizeResourceForLegacySchema(value)
    );
    if (!legacyResult.success) {
      for (const issue of legacyResult.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path,
        });
      }
    }
  })
  .transform((value) => LegacyResourceSpecSchema.parse(normalizeResourceForLegacySchema(value)));

export const IntegrationSpecSchema = SourceSpecSchema;

export { ActionSpecSchema };
