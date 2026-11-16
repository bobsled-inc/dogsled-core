import { describe, it, expect } from 'vitest';

import { SourceSpecSchema } from '../src/validate.js';

const baseMcpSource = {
  auth_env_vars: ['MY_TEAM_MCP_TOKEN'],
  spec_version: '2',
  type: 'source',
  name: 'my_team_mcp',
  transports: [
    {
      id: 'default',
      type: 'mcp_http',
      url: 'https://mcp.example.com/mcp',
      auth: { type: 'bearer', token: '${{ env.MY_TEAM_MCP_TOKEN }}' },
    },
  ],
  default_transport: 'default',
};

describe('custom_mcp source schema', () => {
  it('accepts source_type: custom_mcp with an inline mcp_http transport', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseMcpSource,
      source_type: 'custom_mcp',
      auth_env_vars: ['MY_TEAM_MCP_TOKEN'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts custom_mcp with auth.type: none', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseMcpSource,
      source_type: 'custom_mcp',
      transports: [
        {
          id: 'default',
          type: 'mcp_http',
          url: 'https://mcp.example.com/mcp',
          auth: { type: 'none' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts custom_mcp with auth.type: api-key', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseMcpSource,
      source_type: 'custom_mcp',
      auth_env_vars: ['MY_TEAM_MCP_KEY'],
      transports: [
        {
          id: 'default',
          type: 'mcp_http',
          url: 'https://mcp.example.com/mcp',
          auth: { type: 'api-key', header: 'x-api-key', key: '${{ env.MY_TEAM_MCP_KEY }}' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('tolerates the bobsled_source_kind extension key by stripping it', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseMcpSource,
      source_type: 'custom_mcp',
      bobsled_source_kind: 'custom_mcp',
      auth_env_vars: ['MY_TEAM_MCP_TOKEN'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('bobsled_source_kind' in result.data).toBe(false);
    }
  });

  it('rejects mcp_stdio transports on a custom_mcp source', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseMcpSource,
      source_type: 'custom_mcp',
      transports: [
        {
          id: 'default',
          type: 'mcp_stdio',
          command: 'node',
          args: ['./mcp.js'],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('mcp_http transports'))).toBe(true);
    }
  });

  it('rejects http (REST) transports on a custom_mcp source', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseMcpSource,
      source_type: 'custom_mcp',
      transports: [
        {
          id: 'default',
          base_url: 'https://api.example.com',
          auth: { type: 'bearer', token: '${{ env.MY_TEAM_MCP_TOKEN }}' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-HTTPS url on a custom_mcp mcp_http transport', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseMcpSource,
      source_type: 'custom_mcp',
      transports: [
        {
          id: 'default',
          type: 'mcp_http',
          url: 'http://mcp.example.com/mcp',
          auth: { type: 'bearer', token: '${{ env.MY_TEAM_MCP_TOKEN }}' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('still allows mcp_stdio when source_type is omitted (bundled MCP source)', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseMcpSource,
      transports: [
        {
          id: 'default',
          type: 'mcp_stdio',
          command: 'node',
          args: ['./mcp.js'],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
