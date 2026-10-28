import { describe, expect, it } from 'vitest';

import { SourceSchema } from '../../src/framework/core/source.js';
import { collectIntegrationStructuralFindings } from '../../src/commands/verify-shared.js';
import type { IntegrationSpec } from '../../src/types/index.js';

function customMcpSource(overrides: Record<string, unknown> = {}): unknown {
  return {
    spec_version: '2',
    type: 'source',
    source_type: 'custom_mcp',
    name: 'my_team_mcp',
    auth_env_vars: ['MY_TEAM_MCP_TOKEN'],
    transports: [
      {
        id: 'default',
        type: 'mcp_http',
        url: 'https://mcp.example.com/mcp',
        auth: {
          type: 'bearer',
          token: '${{ env.MY_TEAM_MCP_TOKEN }}',
        },
      },
    ],
    default_transport: 'default',
    ...overrides,
  };
}

describe('custom_mcp SourceSchema', () => {
  it('accepts source_type: custom_mcp with inline mcp_http transport and auth_env_vars', () => {
    const parsed = SourceSchema.parse(customMcpSource());
    expect(parsed.source_type).toBe('custom_mcp');
    expect(parsed.auth_env_vars).toEqual(['MY_TEAM_MCP_TOKEN']);
    expect(parsed.transports[0]?.type).toBe('mcp_http');
  });

  it('strips the dogsled_source_kind orchestrator marker', () => {
    const parsed = SourceSchema.parse(customMcpSource({ dogsled_source_kind: 'custom_mcp' }));
    expect('dogsled_source_kind' in parsed).toBe(false);
    expect(parsed.source_type).toBe('custom_mcp');
  });

  it('accepts custom_mcp with auth.type: none (public MCP server)', () => {
    const parsed = SourceSchema.parse(
      customMcpSource({
        auth_env_vars: undefined,
        transports: [
          {
            id: 'default',
            type: 'mcp_http',
            url: 'https://mcp.example.com/mcp',
            auth: { type: 'none' },
          },
        ],
      })
    );
    expect(parsed.transports[0]?.type).toBe('mcp_http');
  });

  it('accepts custom_mcp with auth.type: api-key', () => {
    const parsed = SourceSchema.parse(
      customMcpSource({
        auth_env_vars: ['MY_TEAM_MCP_KEY'],
        transports: [
          {
            id: 'default',
            type: 'mcp_http',
            url: 'https://mcp.example.com/mcp',
            auth: { type: 'api-key', header: 'x-api-key', key: '${{ env.MY_TEAM_MCP_KEY }}' },
          },
        ],
      })
    );
    expect(parsed.transports[0]?.type).toBe('mcp_http');
  });

  it('rejects an mcp_stdio transport on a custom_mcp source', () => {
    const result = SourceSchema.safeParse(
      customMcpSource({
        transports: [
          {
            id: 'default',
            type: 'mcp_stdio',
            command: 'node',
            args: ['./mcp.js'],
          },
        ],
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('mcp_http transports'))).toBe(true);
    }
  });

  it('rejects an http (REST) transport on a custom_mcp source', () => {
    const result = SourceSchema.safeParse(
      customMcpSource({
        transports: [
          {
            id: 'default',
            type: 'http',
            base_url: 'https://api.example.com',
            auth: { type: 'bearer', token: '${{ env.MY_TEAM_MCP_TOKEN }}' },
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects a non-HTTPS url on a custom_mcp mcp_http transport', () => {
    const result = SourceSchema.safeParse(
      customMcpSource({
        transports: [
          {
            id: 'default',
            type: 'mcp_http',
            url: 'http://mcp.example.com/mcp',
            auth: { type: 'bearer', token: '${{ env.MY_TEAM_MCP_TOKEN }}' },
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it('still allows mcp_stdio for bundled (source_type omitted) sources', () => {
    const parsed = SourceSchema.parse(
      customMcpSource({
        source_type: undefined,
        auth_env_vars: undefined,
        transports: [
          {
            id: 'default',
            type: 'mcp_stdio',
            command: 'node',
            args: ['./mcp.js'],
          },
        ],
      })
    );
    expect(parsed.transports[0]?.type).toBe('mcp_stdio');
  });
});

describe('verify env-var gate honors auth_env_vars on custom_mcp', () => {
  const rawYaml = `
transports:
  - id: default
    type: mcp_http
    url: https://mcp.example.com/mcp
    auth:
      type: bearer
      token: \${{ env.MY_TEAM_MCP_TOKEN }}
`;

  it('passes when env refs are covered by auth_env_vars alone (no meta auth_setup)', () => {
    const spec = SourceSchema.parse(customMcpSource()) as unknown as IntegrationSpec;
    const findings = collectIntegrationStructuralFindings('my_team_mcp', spec, rawYaml, null);
    expect(findings.some((f) => f.code === 'MISSING_AUTH_SETUP')).toBe(false);
  });

  it('flags an env ref that is declared in neither auth_env_vars nor auth_setup', () => {
    const spec = SourceSchema.parse(customMcpSource()) as unknown as IntegrationSpec;
    const raw = `${rawYaml}      extra: \${{ env.UNDECLARED_TOKEN }}\n`;
    const findings = collectIntegrationStructuralFindings('my_team_mcp', spec, raw, null);
    expect(findings.some((f) => f.code === 'MISSING_AUTH_SETUP')).toBe(true);
  });
});
