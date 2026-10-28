import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  formatSpecValidationMessage,
  formatZodIssues,
  reportSpecValidationError,
} from '../../src/spec-validation-error.js';

describe('formatZodIssues', () => {
  it('emits one bullet per Zod issue with code-specific detail', () => {
    const schema = z.object({ name: z.string() }).strict();
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodIssues(result.error);
    expect(out).toMatch(/- name: .* \(code: invalid_type; expected: string; got: undefined\)/);
  });

  it('appends the offending key to the path for unrecognized_keys', () => {
    const schema = z
      .object({
        load: z.object({ defaults: z.unknown().optional() }).strict(),
      })
      .strict();
    const result = schema.safeParse({ load: { integration: 'xyz' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodIssues(result.error, { schema });
    expect(out).toContain('- load.integration: Unrecognized key');
    expect(out).toContain('accepted: ["defaults"]');
    expect(out).toContain('code: unrecognized_keys');
  });

  it('surfaces the accepted values for invalid_value', () => {
    const schema = z.object({
      extract: z.object({
        replication: z.object({
          method: z.enum([
            'full_refresh',
            'incremental_append',
            'incremental_merge',
            'change_tracking',
          ]),
        }),
      }),
    });
    const result = schema.safeParse({
      extract: { replication: { method: 'wrong_value' } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodIssues(result.error);
    expect(out).toContain('- extract.replication.method:');
    expect(out).toContain(
      'accepted: ["full_refresh","incremental_append","incremental_merge","change_tracking"]'
    );
  });

  it('names the discriminator field and accepted values for invalid_union', () => {
    const schema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('http'), url: z.string() }),
      z.object({ type: z.literal('sql_postgres'), host: z.string() }),
      z.object({ type: z.literal('sql_mysql'), host: z.string() }),
    ]);
    const result = schema.safeParse({ type: 'sftp', url: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodIssues(result.error, { schema });
    expect(out).toContain('discriminator: type');
    expect(out).toContain('accepted: ["http", "sql_postgres", "sql_mysql"]');
  });

  it('lists multiple missing fields in one error', () => {
    const schema = z.object({
      transports: z.array(
        z.object({
          connection: z.object({ host_env: z.string() }),
          auth: z.object({
            username_env: z.string(),
            password_env: z.string(),
          }),
        })
      ),
    });
    const result = schema.safeParse({
      transports: [{ connection: {}, auth: {} }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodIssues(result.error);
    expect(out).toContain('transports.0.connection.host_env');
    expect(out).toContain('transports.0.auth.username_env');
    expect(out).toContain('transports.0.auth.password_env');
  });

  it('drills into a non-discriminated z.union to surface the closest variant', () => {
    // Mirrors the production SourceSchema shape: transports is an array of
    // a `z.union([...])` of per-SQL-dialect transports. Without recursing
    // into the closest-matching variant, the error would collapse to
    // "transports.0: Invalid input" with no field-level detail.
    const httpTransport = z
      .object({
        id: z.string(),
        type: z.literal('http'),
        url: z.string(),
      })
      .strict();
    const sqlPostgresTransport = z
      .object({
        id: z.string(),
        type: z.literal('sql_postgres'),
        connection: z.object({
          host_env: z.string(),
        }),
        auth: z.object({
          username_env: z.string(),
          password_env: z.string(),
        }),
      })
      .strict();
    const sqlMysqlTransport = z
      .object({
        id: z.string(),
        type: z.literal('sql_mysql'),
        connection: z.object({ host_env: z.string() }),
        auth: z.object({ username_env: z.string(), password_env: z.string() }),
      })
      .strict();

    const schema = z.object({
      spec_version: z.literal('2'),
      type: z.literal('source'),
      name: z.string(),
      transports: z.array(z.union([httpTransport, sqlPostgresTransport, sqlMysqlTransport])),
    });

    const result = schema.safeParse({
      spec_version: '2',
      type: 'source',
      name: 'demo_postgres',
      transports: [{ id: 'pg', type: 'sql_postgres', connection: {}, auth: {} }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodIssues(result.error, { schema });
    expect(out).toContain('transports.0.connection.host_env');
    expect(out).toContain('transports.0.auth.username_env');
    expect(out).toContain('transports.0.auth.password_env');
    // The HTTP/mysql variants must NOT leak into the output — the user
    // wrote sql_postgres and that's the variant we should surface.
    expect(out).not.toContain('url');
    expect(out).not.toContain('sql_mysql');
  });

  it('prefers the variant that accepts every root key over one with more issues', () => {
    const apiResource = z
      .object({
        name: z.string(),
        api: z.object({ query_params: z.record(z.string(), z.string()) }).strict(),
        output: z.record(z.string(), z.unknown()),
        extract: z.object({ record_path: z.string(), table: z.object({}) }).strict(),
      })
      .strict();
    const tableResource = z
      .object({
        name: z.string(),
        extract: z
          .object({
            source: z.object({ table: z.string() }),
            replication: z.object({ method: z.string() }),
          })
          .strict(),
        schema: z.object({ columns: z.record(z.string(), z.unknown()) }).strict(),
      })
      .strict();
    const schema = z.union([tableResource, apiResource]);

    const result = schema.safeParse({
      name: 'tickets',
      api: { query_params: { per_page: 3 } },
      output: { id: {} },
      extract: { record_path: '$.data', table: {} },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodIssues(result.error, { schema });
    expect(out).toContain('api.query_params.per_page');
    expect(out).not.toContain('extract.source');
    expect(out).not.toContain('schema:');
  });

  it('does not pick a sibling variant that only matches before a type refine', () => {
    const transportCore = z.discriminatedUnion('type', [
      z.object({
        type: z.literal('http'),
        base_url: z.string().min(1, 'base_url is required'),
      }),
      z.object({
        type: z.literal('mcp_http'),
        url: z.string(),
      }),
    ]);
    const identity = z.object({ id: z.string() });
    const httpTransport = transportCore.and(identity).refine((value) => value.type === 'http', {
      message: 'expected HTTP transport',
      path: ['type'],
    });
    const mcpHttpTransport = transportCore
      .and(identity)
      .refine((value) => value.type === 'mcp_http', {
        message: 'expected MCP HTTP transport',
        path: ['type'],
      });
    const schema = z.object({
      transports: z.array(z.union([httpTransport, mcpHttpTransport])),
    });

    const result = schema.safeParse({
      transports: [{ id: 'default', type: 'http', base_url: '' }],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodIssues(result.error, { schema });
    expect(out).toContain('transports.0.base_url');
    expect(out).not.toContain('expected MCP HTTP transport');
  });
});

describe('formatSpecValidationMessage', () => {
  it('formats the header as "Invalid <kind> spec at <path>"', () => {
    const schema = z.object({ name: z.string() }).strict();
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const msg = formatSpecValidationMessage('integration', '/tmp/x.yml', result.error);
    expect(msg).toMatch(/^Invalid integration spec at \/tmp\/x\.yml\n/);
  });

  it('appends an optional hint line', () => {
    const schema = z.object({ name: z.string() }).strict();
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const msg = formatSpecValidationMessage('target', '/tmp/x.yml', result.error, {
      hint: 'Expected V2 resource or target YAML.',
    });
    expect(msg).toContain('Expected V2 resource or target YAML.');
  });
});

describe('reportSpecValidationError', () => {
  it('returns an Error ready to throw', () => {
    const schema = z.object({ name: z.string() }).strict();
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const err = reportSpecValidationError('resource', '/tmp/r.yml', result.error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^Invalid resource spec at \/tmp\/r\.yml\n/);
  });
});
