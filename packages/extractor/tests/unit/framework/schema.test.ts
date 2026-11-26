import { describe, expect, it } from 'vitest';
import type { ColumnType } from '@bobsled-inc/protocol';
import type { FieldType } from '../../../src/framework/core/shared.js';

import {
  IntegrationSpecSchema,
  ResourceSpecSchema,
  WarehouseResourceV2SpecSchema,
} from '../../../src/framework/extractor/index.js';
import { buildSchemaColumns } from '../../../src/runtime/schema-message.js';
import {
  SnowflakeConnectionSchema,
  SnowflakePatAuthSchema,
  SnowflakeRsaKeyAuthSchema,
  SnowflakeOAuthSchema,
  BigQueryServiceAccountAuthSchema,
} from '../../../src/framework/core/warehouse.js';

// Compile-time assertion: extractor field types must stay protocol-compatible.
// Protocol may add downstream-only types like `vector` before extractor authors use them directly.
type _AssertFieldExtendsColumn = FieldType extends ColumnType ? true : never;
const _fieldColumnCheck: _AssertFieldExtendsColumn = true;
void _fieldColumnCheck;

describe('IntegrationSpecSchema', () => {
  it('parses a valid integration transport config', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['GITHUB_TOKEN'],
      spec_version: '1',
      type: 'integration',
      name: 'github',
      transport: {
        base_url: 'https://api.github.com',
        headers: {
          Accept: 'application/json',
        },
        auth: {
          type: 'bearer',
          token: '${{ env.GITHUB_TOKEN }}',
        },
        retry: {
          retry_on: [429, 503],
          max_retries: 3,
          backoff: 'exponential',
          retry_after_header: true,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects insecure base URLs', () => {
    const result = IntegrationSpecSchema.safeParse({
      spec_version: '1',
      type: 'integration',
      name: 'github',
      transport: {
        base_url: 'http://api.github.com',
      },
    });

    expect(result.success).toBe(false);
  });

  it.each([
    [0, true],
    [10, true],
    [11, false],
    [-1, false],
    [2.5, false],
  ])('checks retry.max_retries of %s against the limit of 10', (maxRetries, accepted) => {
    const result = IntegrationSpecSchema.safeParse({
      spec_version: '1',
      type: 'integration',
      name: 'github',
      transport: {
        base_url: 'https://api.github.com',
        retry: { max_retries: maxRetries },
      },
    });

    expect(result.success).toBe(accepted);
  });

  it('accepts env-templated HTTPS base URLs', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['ZENDESK_SUBDOMAIN'],
      spec_version: '1',
      type: 'integration',
      name: 'zendesk',
      transport: {
        base_url: 'https://${{ env.ZENDESK_SUBDOMAIN }}.zendesk.com/api/v2',
      },
    });

    expect(result.success).toBe(true);
  });

  it('parses oauth2 authorization_code transport auth', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: [
        'GOOGLE_ADS_CLIENT_ID',
        'GOOGLE_ADS_CLIENT_SECRET',
        'GOOGLE_ADS_REFRESH_TOKEN',
      ],
      spec_version: '1',
      type: 'integration',
      name: 'google_ads',
      transport: {
        base_url: 'https://googleads.googleapis.com',
        auth: {
          type: 'oauth2',
          grant_type: 'authorization_code',
          token_url: 'https://oauth2.googleapis.com/token',
          client_id: '${{ env.GOOGLE_ADS_CLIENT_ID }}',
          client_secret: '${{ env.GOOGLE_ADS_CLIENT_SECRET }}',
          refresh_token: '${{ env.GOOGLE_ADS_REFRESH_TOKEN }}',
          scopes: ['https://www.googleapis.com/auth/adwords'],
          token_prefix: 'Bearer',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('parses an RFC 8707 resource on oauth2 client_credentials transport auth', () => {
    const result = IntegrationSpecSchema.safeParse({
      spec_version: '1',
      type: 'integration',
      name: 'example_api',
      transport: {
        base_url: 'https://api.example.com',
        auth: {
          type: 'oauth2',
          grant_type: 'client_credentials',
          token_url: 'https://auth.example.com/oauth/token',
          client_id: '${{ env.EXAMPLE_CLIENT_ID }}',
          client_secret: '${{ env.EXAMPLE_CLIENT_SECRET }}',
          scopes: ['api:read'],
          resource: 'https://api.example.com/',
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('ResourceSpecSchema', () => {
  it('parses a resource with pagination, incremental state, and lookup', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'issues',
      integration: 'github',
      description: 'Extract issues',
      api: {
        endpoint: '/repos/${{ input.owner }}/${{ input.repo }}/issues',
        method: 'GET',
        query_params: {
          per_page: '${{ input.per_page }}',
        },
      },
      input: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        per_page: { type: 'integer', default: 100 },
      },
      output: {
        id: { type: 'integer', path: '$.id' },
        updated_at: { type: 'timestamp', path: '$.updated_at' },
      },
      extract: {
        record_path: '$',
        pagination: {
          type: 'link_header',
        },
        incremental: {
          cursor_field: 'updated_at',
          cursor_param: 'since',
          cursor_type: 'timestamp',
        },
        table: {
          primary_key: ['id'],
        },
      },
      lookup: {
        description: 'Fetch one issue',
        api: {
          endpoint: '/repos/${{ input.owner }}/${{ input.repo }}/issues/${{ input.id }}',
          method: 'GET',
        },
        input: {
          owner: { type: 'string', required: true },
          repo: { type: 'string', required: true },
          id: { type: 'string', required: true },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects incremental and primary key references to missing output fields', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'issues',
      integration: 'github',
      description: 'Extract issues',
      api: {
        endpoint: '/issues',
        method: 'GET',
      },
      input: {},
      output: {
        id: { type: 'integer', path: '$.id' },
      },
      extract: {
        record_path: '$',
        incremental: {
          cursor_field: 'updated_at',
          cursor_param: 'since',
        },
        table: {
          primary_key: ['id', 'external_id'],
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects contextual outputs when the resource has no fan-out parent', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'events',
      integration: 'example',
      description: 'Events',
      api: { endpoint: '/events', method: 'GET' },
      input: {},
      output: {
        project_id: {
          type: 'integer',
          from: { resource: 'projects', path: '$.id' },
        },
      },
      extract: { record_path: '$' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'contextual output fields require extract.for_each' }),
      ])
    );
  });
});

// ---------------------------------------------------------------------------
// MCP — tool-only resource (no api block)
// ---------------------------------------------------------------------------

describe('MCP resource spec', () => {
  it('parses a resource with tool (no api block)', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'issues',
      integration: 'linear',
      description: 'Extract issues via MCP tool',
      tool: {
        tool_name: 'list_issues',
        arguments: { first: 50 },
      },
      input: {},
      output: {
        id: { type: 'string', path: '$.id' },
        title: { type: 'string', path: '$.title' },
        updated_at: { type: 'timestamp', path: '$.updatedAt' },
      },
      extract: {
        record_path: '$.issues',
        pagination: {
          type: 'mcp_cursor',
          cursor_path: '$.pageInfo.endCursor',
          cursor_argument: 'after',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a resource with neither api nor tool', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'issues',
      integration: 'test',
      description: 'Missing both api and tool',
      input: {},
      output: {
        id: { type: 'string', path: '$.id' },
      },
      extract: {
        record_path: '$',
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a resource with both api and tool', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'issues',
      integration: 'test',
      description: 'Has both api and tool',
      api: {
        endpoint: '/issues',
        method: 'GET',
      },
      tool: {
        tool_name: 'list_issues',
      },
      input: {},
      output: {
        id: { type: 'string', path: '$.id' },
      },
      extract: {
        record_path: '$',
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Slack — bearer auth, cursor pagination, POST-based Web API
// ---------------------------------------------------------------------------

describe('Slack', () => {
  const slackIntegration = {
    auth_env_vars: ['SLACK_BOT_TOKEN'],
    spec_version: '1',
    type: 'integration',
    name: 'slack',
    transport: {
      base_url: 'https://slack.com/api',
      auth: {
        type: 'bearer',
        token: '${{ env.SLACK_BOT_TOKEN }}',
      },
      retry: {
        retry_on: [429],
        max_retries: 5,
        backoff: 'exponential',
        retry_after_header: true,
      },
      rate_limit: {
        requests_per_second: 1,
        burst: 1,
      },
    },
  } as const;

  it('parses a Slack integration spec', () => {
    expect(IntegrationSpecSchema.safeParse(slackIntegration).success).toBe(true);
  });

  it('parses a Slack conversations.history resource (POST, cursor pagination)', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'conversations_history',
      integration: 'slack',
      description: 'Extract messages from a Slack channel',
      api: {
        endpoint: '/conversations.history',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        request_body: {
          channel: '${{ input.channel_id }}',
          limit: '${{ input.limit }}',
        },
      },
      input: {
        channel_id: { type: 'string', required: true },
        limit: { type: 'integer', default: 200, minimum: 1, maximum: 1000 },
      },
      output: {
        ts: { type: 'string', path: '$.ts' },
        user: { type: 'string', path: '$.user' },
        text: { type: 'string', path: '$.text' },
        thread_ts: { type: 'string', path: '$.thread_ts' },
        updated_at: { type: 'timestamp', path: '$.ts' },
      },
      extract: {
        record_path: '$.messages',
        pagination: {
          type: 'cursor',
          cursor_path: '$.response_metadata.next_cursor',
          cursor_param: 'cursor',
        },
        incremental: {
          cursor_field: 'updated_at',
          cursor_param: 'oldest',
          cursor_type: 'timestamp',
        },
        table: {
          primary_key: ['ts'],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('parses a Slack users.list resource (GET, cursor pagination, nested output)', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'users',
      integration: 'slack',
      description: 'Extract Slack workspace users',
      api: {
        endpoint: '/users.list',
        method: 'GET',
        query_params: {
          limit: '${{ input.limit }}',
        },
      },
      input: {
        limit: { type: 'integer', default: 200 },
      },
      output: {
        id: { type: 'string', path: '$.id' },
        name: { type: 'string', path: '$.name' },
        real_name: { type: 'string', path: '$.real_name' },
        email: { type: 'string', path: '$.profile.email' },
        is_bot: { type: 'boolean', path: '$.is_bot' },
        updated: { type: 'timestamp', path: '$.updated' },
      },
      extract: {
        record_path: '$.members',
        pagination: {
          type: 'cursor',
          cursor_path: '$.response_metadata.next_cursor',
          cursor_param: 'cursor',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Notion — bearer auth with version header, POST body-based pagination
// ---------------------------------------------------------------------------

describe('Notion', () => {
  const notionIntegration = {
    auth_env_vars: ['NOTION_API_KEY'],
    spec_version: '1',
    type: 'integration',
    name: 'notion',
    transport: {
      base_url: 'https://api.notion.com',
      headers: {
        'Notion-Version': '2022-06-28',
      },
      auth: {
        type: 'bearer',
        token: '${{ env.NOTION_API_KEY }}',
      },
      retry: {
        retry_on: [429, 502, 503],
        max_retries: 3,
        backoff: 'exponential',
      },
    },
  } as const;

  it('parses a Notion integration spec', () => {
    expect(IntegrationSpecSchema.safeParse(notionIntegration).success).toBe(true);
  });

  it('parses a Notion database query resource (POST, cursor pagination)', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'database_rows',
      integration: 'notion',
      description: 'Query rows from a Notion database',
      api: {
        endpoint: '/v1/databases/${{ input.database_id }}/query',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        request_body: {
          page_size: '${{ input.page_size }}',
        },
      },
      input: {
        database_id: { type: 'string', required: true },
        page_size: { type: 'integer', default: 100, minimum: 1, maximum: 100 },
      },
      output: {
        id: { type: 'string', path: '$.id' },
        created_time: { type: 'timestamp', path: '$.created_time' },
        last_edited_time: { type: 'timestamp', path: '$.last_edited_time' },
        url: { type: 'string', path: '$.url' },
        archived: { type: 'boolean', path: '$.archived' },
      },
      extract: {
        record_path: '$.results',
        pagination: {
          type: 'cursor',
          cursor_path: '$.next_cursor',
          cursor_param: 'start_cursor',
        },
        incremental: {
          cursor_field: 'last_edited_time',
          cursor_param: 'filter.timestamp.last_edited_time.after',
          cursor_type: 'timestamp',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('parses a Notion pages search resource (POST, next_url pagination)', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'pages',
      integration: 'notion',
      description: 'Search all Notion pages',
      api: {
        endpoint: '/v1/search',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        request_body: {
          filter: { value: 'page', property: 'object' },
          page_size: '${{ input.page_size }}',
        },
      },
      input: {
        page_size: { type: 'integer', default: 100 },
      },
      output: {
        id: { type: 'string', path: '$.id' },
        title: { type: 'string', path: '$.properties.title.title[0].plain_text' },
        last_edited_time: { type: 'timestamp', path: '$.last_edited_time' },
      },
      extract: {
        record_path: '$.results',
        pagination: {
          type: 'cursor',
          cursor_path: '$.next_cursor',
          cursor_param: 'start_cursor',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Linear — API key auth, cursor pagination, GraphQL-style POST
// ---------------------------------------------------------------------------

describe('Linear', () => {
  const linearIntegration = {
    auth_env_vars: ['LINEAR_API_KEY'],
    spec_version: '1',
    type: 'integration',
    name: 'linear',
    transport: {
      base_url: 'https://api.linear.app',
      headers: {
        'Content-Type': 'application/json',
      },
      auth: {
        type: 'api-key',
        header: 'Authorization',
        key: '${{ env.LINEAR_API_KEY }}',
      },
      retry: {
        retry_on: [429, 500, 502, 503],
        max_retries: 3,
        backoff: 'exponential',
      },
      rate_limit: {
        requests_per_second: 10,
        burst: 50,
      },
    },
  } as const;

  it('parses a Linear integration spec (api-key auth with rate limiting)', () => {
    expect(IntegrationSpecSchema.safeParse(linearIntegration).success).toBe(true);
  });

  it('parses a Linear issues resource (POST/GraphQL, cursor pagination, nested objects)', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'issues',
      integration: 'linear',
      description: 'Extract Linear issues via GraphQL',
      api: {
        endpoint: '/graphql',
        method: 'POST',
        request_body: {
          query:
            'query($after: String) { issues(first: 50, after: $after) { nodes { id title state { name } assignee { name email } updatedAt } pageInfo { hasNextPage endCursor } } }',
        },
      },
      input: {},
      output: {
        id: { type: 'string', path: '$.id' },
        title: { type: 'string', path: '$.title' },
        state_name: { type: 'string', path: '$.state.name' },
        assignee_name: { type: 'string', path: '$.assignee.name' },
        assignee_email: { type: 'string', path: '$.assignee.email' },
        updated_at: { type: 'timestamp', path: '$.updatedAt' },
      },
      extract: {
        record_path: '$.data.issues.nodes',
        pagination: {
          type: 'cursor',
          cursor_path: '$.data.issues.pageInfo.endCursor',
          cursor_param: 'variables.after',
        },
        incremental: {
          cursor_field: 'updated_at',
          cursor_param: 'variables.updatedAtAfter',
          cursor_type: 'timestamp',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('parses a Linear teams resource (POST/GraphQL, offset pagination)', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'teams',
      integration: 'linear',
      description: 'Extract Linear teams',
      api: {
        endpoint: '/graphql',
        method: 'POST',
        request_body: {
          query: 'query { teams { nodes { id name key description } } }',
        },
      },
      input: {},
      output: {
        id: { type: 'string', path: '$.id' },
        name: { type: 'string', path: '$.name' },
        key: { type: 'string', path: '$.key' },
        description: { type: 'string', path: '$.description' },
      },
      extract: {
        record_path: '$.data.teams.nodes',
        pagination: {
          type: 'none',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dual-shape env-var fields (new ${{ env.X }} + legacy *_env)
// ---------------------------------------------------------------------------

describe('Snowflake dual-shape connection fields', () => {
  const base = { role: 'READER_ROLE' };

  it('accepts new-shape with ${{ env.X }} interpolation', () => {
    const result = SnowflakeConnectionSchema.safeParse({
      ...base,
      account_identifier: '${{ env.SNOWFLAKE_ACCOUNT }}',
      warehouse: '${{ env.SNOWFLAKE_WAREHOUSE }}',
    });
    expect(result.success).toBe(true);
  });

  it('accepts legacy _env shape', () => {
    const result = SnowflakeConnectionSchema.safeParse({
      ...base,
      account_identifier_env: 'SNOWFLAKE_ACCOUNT',
      warehouse_env: 'SNOWFLAKE_WAREHOUSE',
    });
    expect(result.success).toBe(true);
  });

  it('rejects both new and legacy for the same field', () => {
    const result = SnowflakeConnectionSchema.safeParse({
      ...base,
      account_identifier: '${{ env.SNOWFLAKE_ACCOUNT }}',
      account_identifier_env: 'SNOWFLAKE_ACCOUNT',
      warehouse: '${{ env.SNOWFLAKE_WAREHOUSE }}',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('Cannot set both'))).toBe(true);
    }
  });

  it('rejects neither new nor legacy for required field', () => {
    const result = SnowflakeConnectionSchema.safeParse({
      ...base,
      warehouse: '${{ env.SNOWFLAKE_WAREHOUSE }}',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('must be set'))).toBe(true);
    }
  });

  it('allows optional user pair to be absent', () => {
    const result = SnowflakeConnectionSchema.safeParse({
      ...base,
      account_identifier: '${{ env.SNOWFLAKE_ACCOUNT }}',
      warehouse: '${{ env.SNOWFLAKE_WAREHOUSE }}',
    });
    expect(result.success).toBe(true);
  });
});

describe('Snowflake dual-shape auth fields', () => {
  it('accepts new-shape pat token', () => {
    const result = SnowflakePatAuthSchema.safeParse({
      type: 'pat',
      token: '${{ env.SNOWFLAKE_PAT }}',
    });
    expect(result.success).toBe(true);
  });

  it('rejects both token and token_env', () => {
    const result = SnowflakePatAuthSchema.safeParse({
      type: 'pat',
      token: '${{ env.SNOWFLAKE_PAT }}',
      token_env: 'SNOWFLAKE_PAT',
    });
    expect(result.success).toBe(false);
  });

  it('rejects neither token nor token_env', () => {
    const result = SnowflakePatAuthSchema.safeParse({ type: 'pat' });
    expect(result.success).toBe(false);
  });

  it('accepts new-shape rsa_key fields', () => {
    const result = SnowflakeRsaKeyAuthSchema.safeParse({
      type: 'rsa_key',
      private_key_path: '${{ env.SNOWFLAKE_PRIVATE_KEY_PATH }}',
      private_key_passphrase: '${{ env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE }}',
    });
    expect(result.success).toBe(true);
  });

  it('rejects both private_key_path and private_key_path_env', () => {
    const result = SnowflakeRsaKeyAuthSchema.safeParse({
      type: 'rsa_key',
      private_key_path: '${{ env.SNOWFLAKE_PRIVATE_KEY_PATH }}',
      private_key_path_env: 'SNOWFLAKE_PRIVATE_KEY_PATH',
    });
    expect(result.success).toBe(false);
  });

  it('accepts new-shape oauth fields', () => {
    const result = SnowflakeOAuthSchema.safeParse({
      type: 'oauth',
      client_id: '${{ env.SNOWFLAKE_CLIENT_ID }}',
      client_secret: '${{ env.SNOWFLAKE_CLIENT_SECRET }}',
      token_url: 'https://example.com/oauth/token',
    });
    expect(result.success).toBe(true);
  });
});

describe('BigQuery dual-shape service_account auth', () => {
  it('accepts new-shape credentials', () => {
    const result = BigQueryServiceAccountAuthSchema.safeParse({
      type: 'service_account',
      credentials: '${{ env.GOOGLE_APPLICATION_CREDENTIALS }}',
    });
    expect(result.success).toBe(true);
  });

  it('accepts legacy credentials_env', () => {
    const result = BigQueryServiceAccountAuthSchema.safeParse({
      type: 'service_account',
      credentials_env: 'GOOGLE_APPLICATION_CREDENTIALS',
    });
    expect(result.success).toBe(true);
  });

  it('rejects both credentials and credentials_env', () => {
    const result = BigQueryServiceAccountAuthSchema.safeParse({
      type: 'service_account',
      credentials: '${{ env.GOOGLE_APPLICATION_CREDENTIALS }}',
      credentials_env: 'GOOGLE_APPLICATION_CREDENTIALS',
    });
    expect(result.success).toBe(false);
  });

  it('rejects neither credentials nor credentials_env', () => {
    const result = BigQueryServiceAccountAuthSchema.safeParse({
      type: 'service_account',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Three-block warehouse resource spec (extract / load / schema)
// ---------------------------------------------------------------------------

describe('WarehouseResourceV2SpecSchema (three-block)', () => {
  const validV2Resource = {
    spec_version: '1',
    type: 'resource',
    name: 'pga_players',
    extract: {
      integration: 'snowflake_source',
      source: {
        table: 'PGA_PLAYERS',
        database: 'PGA',
        schema: 'PUBLIC',
      },
      replication: {
        method: 'incremental_merge',
        cursor_field: 'created_at',
        cursor_type: 'timestamp',
      },
      trust_tier: 'bronze',
    },
    // V2 resource load block carries only overrides and defaults — never the
    // destination integration. The destination binding comes from the pipeline
    // (dogsled.yml), CLI --load-integration, or extractor.yml default_load.
    load: {
      overrides: {
        role: 'LOADER_ROLE',
        database: 'DOGSLED_RAW',
      },
      defaults: {
        load_strategy: 'merge',
        schema_behavior: 'evolve',
        buffer_size: 100000,
      },
    },
    schema: {
      primary_key: ['dg_id'],
      columns: {
        dg_id: { type: 'integer' },
        player_name: { type: 'string' },
        created_at: { type: 'timestamp' },
      },
    },
  };

  it('parses a valid three-block warehouse resource', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse(validV2Resource);
    expect(result.success).toBe(true);
  });

  it('parses without optional load block', () => {
    const { load: _drop, ...rest } = validV2Resource;
    const result = WarehouseResourceV2SpecSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it('parses with empty load block (no fields)', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      load: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects integration field on resource load block (binding belongs to pipeline/CLI)', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      load: { integration: 'snowflake_warehouse' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level field', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      bogus: 'oops',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing extract block', () => {
    const { extract: _drop, ...rest } = validV2Resource;
    const result = WarehouseResourceV2SpecSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects missing schema block', () => {
    const { schema: _drop, ...rest } = validV2Resource;
    const result = WarehouseResourceV2SpecSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects missing schema.columns', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      schema: { primary_key: ['dg_id'] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty schema.columns map with the resource name', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      extract: {
        ...validV2Resource.extract,
        replication: { method: 'full_refresh' },
      },
      schema: { columns: {} },
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(
      result.error.issues.some(
        (issue) =>
          issue.path.join('.') === 'schema.columns' &&
          issue.message.includes('Resource "pga_players" declares no columns')
      )
    ).toBe(true);
  });

  it('validates primary_key references columns', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      schema: {
        primary_key: ['nonexistent'],
        columns: { dg_id: { type: 'integer' } },
      },
    });
    expect(result.success).toBe(false);
  });

  it('validates cursor_field references columns', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      extract: {
        ...validV2Resource.extract,
        replication: {
          method: 'incremental_append',
          cursor_field: 'nonexistent',
          cursor_type: 'timestamp',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('requires primary_key for incremental_merge replication', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      schema: {
        columns: {
          dg_id: { type: 'integer' },
          created_at: { type: 'timestamp' },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts full_refresh without primary_key', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      extract: {
        ...validV2Resource.extract,
        replication: { method: 'full_refresh' },
      },
      schema: {
        columns: {
          dg_id: { type: 'integer' },
          created_at: { type: 'timestamp' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown field inside extract block', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      extract: { ...validV2Resource.extract, bogus: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown field inside load block', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      load: { ...validV2Resource.load, bogus: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown field inside schema block', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      schema: { ...validV2Resource.schema, bogus: true },
    });
    expect(result.success).toBe(false);
  });

  it('accepts change_tracking replication with appropriate config', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      extract: {
        integration: 'snowflake_source',
        source: { table: 'ORDERS', database: 'ANALYTICS', schema: 'PUBLIC' },
        replication: {
          method: 'change_tracking',
          change_tracking: { information: 'default' },
        },
      },
      schema: {
        primary_key: ['order_id'],
        columns: {
          order_id: { type: 'integer' },
          created_at: { type: 'timestamp' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts Postgres CDC change_tracking with slot_name and publication_name', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...validV2Resource,
      extract: {
        integration: 'postgres_source',
        source: { table: 'customers', schema: 'public' },
        replication: {
          method: 'change_tracking',
          change_tracking: {
            plugin: 'pgoutput',
            slot_name: 'dogsled_slot',
            publication_name: 'dogsled_pub',
          },
        },
      },
      schema: {
        primary_key: ['id'],
        columns: {
          id: { type: 'integer' },
          name: { type: 'string' },
          _change_type: { type: 'string' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('V2 Postgres CDC fields survive V2-to-V1 transform through ResourceSpecSchema', () => {
    const v2PostgresCdc = {
      spec_version: '1' as const,
      type: 'resource' as const,
      name: 'customers_cdc',
      extract: {
        integration: 'postgres_source',
        source: { table: 'customers', schema: 'public' },
        replication: {
          method: 'change_tracking' as const,
          change_tracking: {
            plugin: 'pgoutput' as const,
            slot_name: 'dogsled_slot',
            publication_name: 'dogsled_pub',
          },
        },
      },
      schema: {
        primary_key: ['id'],
        columns: {
          id: { type: 'integer' as const },
          name: { type: 'string' as const },
          _change_type: { type: 'string' as const },
        },
      },
    };
    const result = ResourceSpecSchema.safeParse(v2PostgresCdc);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      const replication = data['replication'] as Record<string, unknown>;
      expect(replication['method']).toBe('change_tracking');
      expect(replication['primary_key']).toEqual(['id']);
      const ct = replication['change_tracking'] as Record<string, unknown>;
      expect(ct['slot_name']).toBe('dogsled_slot');
      expect(ct['publication_name']).toBe('dogsled_pub');
      expect(ct['plugin']).toBe('pgoutput');
    }
  });

  it('V2 resource parses through unified ResourceSpecSchema and normalizes to V1 shape', () => {
    const result = ResourceSpecSchema.safeParse(validV2Resource);
    expect(result.success).toBe(true);
    if (result.success) {
      // Normalized to V1 shape: top-level source, replication, output
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('source');
      expect(data).toHaveProperty('replication');
      expect(data).toHaveProperty('output');
      expect(data).toHaveProperty('name', 'pga_players');
      expect(data['output']).toEqual(validV2Resource.schema.columns);
      expect(buildSchemaColumns(data as Parameters<typeof buildSchemaColumns>[0])).toEqual([
        { name: 'dg_id', type: 'integer', primary_key: true },
        { name: 'player_name', type: 'string' },
        { name: 'created_at', type: 'timestamp' },
      ]);
      // primary_key migrated from schema to replication
      expect((data['replication'] as Record<string, unknown>)['primary_key']).toEqual(['dg_id']);
    }
  });
});

describe('Snowflake new-shape integration spec (end-to-end)', () => {
  it('parses a full new-shape Snowflake integration', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: [
        'SNOWFLAKE_ACCOUNT',
        'SNOWFLAKE_PRIVATE_KEY_PASSPHRASE',
        'SNOWFLAKE_PRIVATE_KEY_PATH',
        'SNOWFLAKE_USER',
        'SNOWFLAKE_WAREHOUSE',
      ],
      spec_version: '1',
      type: 'integration',
      name: 'snowflake_source',
      source_type: 'snowflake',
      connection: {
        account_identifier: '${{ env.SNOWFLAKE_ACCOUNT }}',
        warehouse: '${{ env.SNOWFLAKE_WAREHOUSE }}',
        user: '${{ env.SNOWFLAKE_USER }}',
        role: 'READER_ROLE',
      },
      auth: {
        type: 'rsa_key',
        private_key_path: '${{ env.SNOWFLAKE_PRIVATE_KEY_PATH }}',
        private_key_passphrase: '${{ env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE }}',
      },
    });
    expect(result.success).toBe(true);
  });

  it('parses a full new-shape BigQuery service_account integration', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['GOOGLE_APPLICATION_CREDENTIALS'],
      spec_version: '1',
      type: 'integration',
      name: 'bigquery_source',
      source_type: 'bigquery',
      connection: {
        project_ids: ['my-project'],
        billing_project_id: 'my-project',
        default_location: 'US',
      },
      auth: {
        type: 'service_account',
        credentials: '${{ env.GOOGLE_APPLICATION_CREDENTIALS }}',
      },
    });
    expect(result.success).toBe(true);
  });
});
