import { describe, expect, it } from 'vitest';

import {
  DestinationSchema,
  NamedDestinationSchema,
  PipelineRunnerSchema,
  DogsledConfigSchema,
} from '../../../../src/runner/config/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bigqueryDestination() {
  return {
    type: 'bigquery' as const,
    project: 'my-project',
    dataset: 'raw',
  };
}

function snowflakeDestination() {
  return {
    type: 'snowflake' as const,
    account: 'acme-org',
    username: 'loader',
    warehouse: 'compute_wh',
    database: 'raw',
  };
}

function minimalValidConfig() {
  return {
    destinations: {
      warehouse: bigqueryDestination(),
    },
    pipelines: {
      stripe: {
        schedule: 'hourly',
        source: 'stripe',
        destination: 'warehouse',
        resources: ['charges'],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level shape
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — top level', () => {
  it.each([
    ['state', { backend: 'variables' }],
    ['runner', { runs_on: 'ubuntu-latest' }],
    ['agent', { enabled: true }],
    ['console', { title: 'Console' }],
  ])('rejects retired root setting %s', (key, value) => {
    expect(
      DogsledConfigSchema.safeParse({ ...minimalValidConfig(), [String(key)]: value }).success
    ).toBe(false);
  });

  it('rejects the GitHub Actions pipeline runner', () => {
    const config = minimalValidConfig();
    const name = Object.keys(config.pipelines)[0]!;
    expect(
      DogsledConfigSchema.safeParse({
        ...config,
        pipelines: { [name]: { ...config.pipelines[name], runner: 'github-actions' } },
      }).success
    ).toBe(false);
  });

  it('parses minimal valid config (destinations map + one pipeline)', () => {
    const result = DogsledConfigSchema.safeParse(minimalValidConfig());
    expect(result.success).toBe(true);
  });

  it('defaults an omitted pipeline runner to managed execution', () => {
    const result = DogsledConfigSchema.safeParse(minimalValidConfig());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipelines.stripe).toMatchObject({ runner: 'managed' });
    }
  });

  it('parses full config with all sections', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          location: 'US',
          credentials_secret: 'GCP_SERVICE_ACCOUNT_JSON',
        },
        archive: {
          type: 's3',
          bucket: 'my-archive',
          format: 'parquet',
        },
      },
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destinations: ['warehouse', 'archive'],
          resources: ['charges', 'customers'],
          enabled: true,
        },
        hubspot: {
          schedule: 'every 4h',
          source: 'hubspot',
          destination: 'warehouse',
          resources: ['contacts', 'deals'],
        },
      },
      defaults: {
        timeout: '4h',
        retry: { attempts: 3, backoff: 'exponential' },
      },
      models: {
        project: './models',
        schedule: 'daily',
        after: ['stripe'],
        sequence: ['dim_customer', 'fct_revenue'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects config without destinations', () => {
    const config = minimalValidConfig() as Partial<ReturnType<typeof minimalValidConfig>>;
    delete config.destinations;
    const result = DogsledConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects config without pipelines', () => {
    const config = minimalValidConfig() as Partial<ReturnType<typeof minimalValidConfig>>;
    delete config.pipelines;
    const result = DogsledConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects config with empty destinations map when an extract pipeline is present', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {},
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a model-only config that omits destinations entirely', () => {
    const result = DogsledConfigSchema.safeParse({
      pipelines: {
        bigquery_silver: {
          type: 'models',
          connection: 'bigquery',
          schedule: 'hourly',
          models: ['bq_stg_orders_enriched'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys at the root', () => {
    const result = DogsledConfigSchema.safeParse({
      ...minimalValidConfig(),
      extraneous: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('DogsledConfigSchema — schema_behavior', () => {
  it.each(['evolve', 'strict', 'freeze'] as const)(
    'accepts %s at destination, pipeline, and resource levels',
    (schemaBehavior) => {
      const config = minimalValidConfig();
      Object.assign(config.destinations.warehouse, { schema_behavior: schemaBehavior });
      Object.assign(config.pipelines.stripe, {
        schema_behavior: schemaBehavior,
        resources: [{ resource: 'charges', schema_behavior: schemaBehavior }],
      });

      expect(DogsledConfigSchema.safeParse(config).success).toBe(true);
    }
  );

  it.each([
    [
      'destination',
      (config: ReturnType<typeof minimalValidConfig>) =>
        Object.assign(config.destinations.warehouse, { schema_behavior: 'ignore' }),
    ],
    [
      'pipeline',
      (config: ReturnType<typeof minimalValidConfig>) =>
        Object.assign(config.pipelines.stripe, { schema_behavior: 'ignore' }),
    ],
    [
      'resource',
      (config: ReturnType<typeof minimalValidConfig>) =>
        Object.assign(config.pipelines.stripe, {
          resources: [{ resource: 'charges', schema_behavior: 'ignore' }],
        }),
    ],
  ] as const)('rejects an invalid %s value with the allowed values', (_level, mutate) => {
    const config = minimalValidConfig();
    mutate(config);

    const result = DogsledConfigSchema.safeParse(config);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/evolve.*strict.*freeze/);
    }
  });
});

// ---------------------------------------------------------------------------
// Old-shape rejections (breaking changes)
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — rejects old shapes', () => {
  it('rejects top-level singular destination (replaced by destinations map)', () => {
    const result = DogsledConfigSchema.safeParse({
      destination: bigqueryDestination(),
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(false);
  });

  it('rejects string-shorthand pipeline form', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: 'hourly',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects inline destination object on a pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: bigqueryDestination(),
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects inline destinations array of objects on a pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destinations: [{ name: 'warehouse', ...bigqueryDestination() }],
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects only field on a pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          only: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects exclude field on a pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          exclude: ['traffic'],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pipeline shape
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — pipelines', () => {
  it('requires source on every pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          destination: 'warehouse',
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('requires schedule on every pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('requires destination or destinations', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects both destination and destinations on the same pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: bigqueryDestination(),
        archive: { type: 's3', bucket: 'b', format: 'parquet' },
      },
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          destinations: ['warehouse', 'archive'],
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts destinations as a list of names (fan-out)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: bigqueryDestination(),
        archive: { type: 's3', bucket: 'b', format: 'parquet' },
      },
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destinations: ['warehouse', 'archive'],
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty destinations array on a pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destinations: [],
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('requires resources to be present', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty resources array', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: [],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('parses inputs on a pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          inputs: { account_id: 'acct_123', include_deleted: true, limit: 100 },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('parses scalar array inputs on a pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['repos'],
          inputs: { repo_names: ['dogsled', 'demo-repo'], include_archived: [false] },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('parses GitHub Actions runner selection', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        hubspot: {
          schedule: 'every 30m',
          source: 'hubspot',
          destination: 'warehouse',
          resources: ['contacts'],
          runner: 'managed',
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const hubspot = result.data.pipelines['hubspot'];
      expect(hubspot).toBeDefined();
      expect(hubspot).toMatchObject({ runner: 'managed' });
    }
  });

  it('rejects the pre-bridge runner alias', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        hubspot: {
          schedule: 'every 30m',
          source: 'hubspot',
          destination: 'warehouse',
          resources: ['contacts'],
          runner: 'langgraph',
        },
      },
    });

    expect(result.success).toBe(false);
    expect(PipelineRunnerSchema.options).toEqual(['managed']);
  });

  it('rejects the retired bobsled-managed runner spelling', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        hubspot: {
          schedule: 'every 30m',
          source: 'hubspot',
          destination: 'warehouse',
          resources: ['contacts'],
          runner: 'bobsled-managed',
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown runner targets', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        hubspot: {
          schedule: 'every 30m',
          source: 'hubspot',
          destination: 'warehouse',
          resources: ['contacts'],
          runner: 'airflow',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys in pipeline objects', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          extraneous: 'nope',
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resources field
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — resources', () => {
  it('accepts bare-name resource strings', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges', 'customers', 'subscriptions'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts path-like nested resource strings', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        finance: {
          schedule: 'daily',
          source: 'snowflake_prod',
          destination: 'warehouse',
          resources: ['finance/invoices', 'finance/payments', 'sales/regions/us'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts object-form resource overrides', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: [
            'charges',
            {
              resource: 'subscriptions',
              load_strategy: 'append',
              table: 'raw_stripe__subs_v2',
              inputs: { mode: 'extended' },
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('requires an exact table when a resource declares an ownership marker', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: [{ resource: 'subscriptions', table_ownership_marker: 'dataset-123' }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unsafe object-form table overrides at canonical config validation', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: [{ resource: 'subscriptions', table: 'raw.stripe subscriptions' }],
        },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pipelines', 'stripe', 'resources', 0, 'table']);
  });

  it('rejects object-form override without resource field', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: [{ load_strategy: 'append' }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys in object-form override', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: [{ resource: 'charges', extraneous: 'nope' }],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Destinations map shape
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — destinations map', () => {
  it('parses optional bigquery credentials secret', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          credentials_secret: 'GCP_SERVICE_ACCOUNT_JSON',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
  });

  it('parses optional bigquery credentials_access_token (env var placeholder)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          credentials_access_token: '$BIGQUERY_CREDENTIALS_JSON',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
  });

  it('rejects bigquery credentials_access_token without $ prefix', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          credentials_access_token: 'literal-token-bad',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(false);
  });

  it('accepts both credentials_secret and credentials_access_token simultaneously', () => {
    // Both fields are optional and independent. Loader precedence:
    // credentials_access_token > credentials > keyFilename. The Dogsled
    // schema doesn't enforce mutual exclusion — that's a runtime
    // concern, not a config-shape concern.
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          credentials_secret: 'GCP_SERVICE_ACCOUNT_JSON',
          credentials_access_token: '$BIGQUERY_CREDENTIALS_JSON',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
  });

  it('parses optional bigquery credentials_token_command (env var placeholder)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          credentials_token_command: '$BIGQUERY_TOKEN_COMMAND',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
  });

  it('rejects bigquery credentials_token_command without $ prefix', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          credentials_token_command: 'gcloud auth print-access-token',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(false);
  });

  it('accepts both credentials_access_token and credentials_token_command simultaneously', () => {
    // Both optional; loader precedence is token_command > access_token. The
    // Dogsled schema doesn't enforce mutual exclusion — a runtime concern.
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          credentials_access_token: '$BIGQUERY_CREDENTIALS_JSON',
          credentials_token_command: '$BIGQUERY_TOKEN_COMMAND',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
  });

  it('parses Snowflake OIDC credential placeholders', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...snowflakeDestination(),
          credentials_access_token: '$SNOWFLAKE_OIDC_TOKEN',
          credentials_token_command: '${{ env.SNOWFLAKE_OIDC_TOKEN_COMMAND }}',
        },
      },
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it.each(['literal-token', 'mint-token --json'])(
    'rejects non-placeholder Snowflake OIDC values',
    (value) => {
      const result = DogsledConfigSchema.safeParse({
        destinations: {
          warehouse: {
            ...snowflakeDestination(),
            credentials_access_token: value,
          },
        },
        pipelines: {
          stripe: {
            schedule: 'hourly',
            source: 'stripe',
            destination: 'warehouse',
            resources: ['charges'],
          },
        },
      });
      expect(result.success).toBe(false);
    }
  );

  it('parses a Snowflake workload identity credential placeholder', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          type: 'snowflake',
          account: 'acme-org',
          username: 'loader',
          warehouse: 'compute_wh',
          database: 'raw',
          credentials_workload_identity_token: '$SNOWFLAKE_WIF_TOKEN',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });

    expect(result.success).toBe(true);
  });

  it('rejects a literal Snowflake workload identity token', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...snowflakeDestination(),
          credentials_workload_identity_token: 'literal-token',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });

    expect(result.success).toBe(false);
  });

  it('keeps the Snowflake credential-mode check on named destinations', () => {
    const named = {
      ...snowflakeDestination(),
      name: 'warehouse',
      credentials_workload_identity_token: '$SNOWFLAKE_WIF_TOKEN',
    };

    expect(NamedDestinationSchema.safeParse(named).success).toBe(true);
    expect(
      NamedDestinationSchema.safeParse({ ...named, password: '$SNOWFLAKE_PASSWORD' }).success
    ).toBe(false);
    expect(NamedDestinationSchema.safeParse({ ...named, extra: true }).success).toBe(false);
  });

  it.each([
    ['password', '$SNOWFLAKE_PASSWORD'],
    ['private_key_path', '/tmp/snowflake-key.pem'],
    ['private_key_passphrase', '$SNOWFLAKE_PRIVATE_KEY_PASSPHRASE'],
    ['credentials_access_token', '$SNOWFLAKE_ACCESS_TOKEN'],
    ['credentials_token_command', '$SNOWFLAKE_TOKEN_COMMAND'],
  ])('rejects workload identity with %s', (conflictingField, conflictingValue) => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...snowflakeDestination(),
          credentials_workload_identity_token: '$SNOWFLAKE_WIF_TOKEN',
          [conflictingField]: conflictingValue,
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.message).not.toContain('SNOWFLAKE_WIF_TOKEN');
    }
  });

  it.each([
    [
      'snowflake',
      {
        type: 'snowflake' as const,
        account: 'acme-org',
        username: 'loader',
        warehouse: 'compute_wh',
        database: 'raw',
      },
    ],
    [
      'postgres',
      {
        type: 'postgres' as const,
        host: 'db.example.com',
        database: 'analytics',
        username: 'loader',
        password: '$PG_PASSWORD',
      },
    ],
    [
      'mysql',
      {
        type: 'mysql' as const,
        host: 'db.example.com',
        database: 'analytics',
        user: 'loader',
      },
    ],
    [
      'clickhouse',
      {
        type: 'clickhouse' as const,
        host: 'ch.example.com',
        database: 'analytics',
        password: '$CLICKHOUSE_PASSWORD',
        ssl: true,
      },
    ],
    [
      'turbopuffer',
      {
        type: 'turbopuffer' as const,
        api_key: '$TURBOPUFFER_API_KEY',
        region: 'gcp-us-central1',
        full_text_columns: ['title'],
      },
    ],
    [
      'duckdb',
      {
        type: 'duckdb' as const,
        db_path: './data.duckdb',
      },
    ],
    [
      'gcs',
      {
        type: 'gcs' as const,
        bucket: 'my-bucket',
        format: 'parquet' as const,
      },
    ],
    [
      's3',
      {
        type: 's3' as const,
        bucket: 'my-bucket',
        format: 'parquet' as const,
      },
    ],
    [
      'local',
      {
        type: 'local' as const,
        format: 'jsonl' as const,
      },
    ],
  ])('parses minimal %s destination', (_name, destination) => {
    const result = DogsledConfigSchema.safeParse({
      destinations: { warehouse: destination },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid destination type', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: { warehouse: { type: 'redis' } },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys in destination variants', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: { type: 'local', format: 'parquet', bucket: 'nope' },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(false);
  });

  it.each([
    {
      type: 'snowflake' as const,
      account: 'acme-org',
      username: 'loader',
      password: 'plaintext',
      warehouse: 'compute_wh',
      database: 'raw',
    },
    {
      type: 'postgres' as const,
      host: 'db.example.com',
      database: 'analytics',
      username: 'loader',
      password: 'plaintext',
    },
    {
      type: 'mysql' as const,
      host: 'db.example.com',
      database: 'analytics',
      user: 'loader',
      password: 'plaintext',
    },
    {
      type: 'clickhouse' as const,
      host: 'h',
      database: 'd',
      password: 'plaintext',
    },
    {
      type: 'turbopuffer' as const,
      api_key: 'plaintext',
    },
  ])('rejects literal database secrets', (destination) => {
    const result = DogsledConfigSchema.safeParse({
      destinations: { warehouse: destination },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(false);
  });

  it.each(['local', 'gcs', 's3'])(
    'rejects file destination "%s" without an explicit format',
    (type) => {
      const dest =
        type === 'local' ? { type: type as 'local' } : { type: type as 'gcs' | 's3', bucket: 'b' };
      const result = DogsledConfigSchema.safeParse({
        destinations: { warehouse: dest },
        pipelines: minimalValidConfig().pipelines,
      });
      expect(result.success).toBe(false);
    }
  );

  it('rejects invalid destination map keys (must be name-shaped)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: { 'bad name with spaces': bigqueryDestination() },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator extension keys on destinations (mirrors V2 SourceSchema's
// reservation of `x-*` and `dogsled_*` prefixes)
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — destinations orchestrator-extension keys', () => {
  it('tolerates dogsled_* keys on a destination block', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          dogsled_connection_ref: 'warehouse-prod',
          dogsled_destination_kind: 'dogsled_managed',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
  });

  it('tolerates x-* keys on a destination block', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          'x-orchestrator': 'langsmith',
          'x-deployment-id': 'dep_abc123',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
  });

  it('strips extension keys from the parsed destination (not exposed on inferred type)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          dogsled_connection_ref: 'warehouse-prod',
          'x-orchestrator': 'langsmith',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data.destinations.warehouse;
      expect(parsed).not.toHaveProperty('dogsled_connection_ref');
      expect(parsed).not.toHaveProperty('x-orchestrator');
    }
  });

  it('still rejects unknown non-extension keys (typos like base_ulr)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...bigqueryDestination(),
          // typo of "location"; not an extension prefix, must fail loud
          loctaion: 'US',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(false);
  });

  it.each([
    [
      'snowflake',
      {
        type: 'snowflake' as const,
        account: 'acme-org',
        username: 'loader',
        warehouse: 'compute_wh',
        database: 'raw',
      },
    ],
    [
      'postgres',
      {
        type: 'postgres' as const,
        host: 'db.example.com',
        database: 'analytics',
        username: 'loader',
        password: '$PG_PASSWORD',
      },
    ],
    [
      'gcs',
      {
        type: 'gcs' as const,
        bucket: 'my-bucket',
        format: 'parquet' as const,
      },
    ],
  ])('tolerates extension keys on %s destination too', (_name, destination) => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...destination,
          dogsled_connection_ref: 'some-slug',
          'x-deployment-id': 'dep_abc',
        },
      },
      pipelines: minimalValidConfig().pipelines,
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dogsled-managed destination (orchestrator-resolved type).
// Dogsled CLI never executes this destination — the orchestrator (Dogsled
// host application) expands it into a concrete warehouse-native destination block
// (today: bigquery) before invocation. Schema validation lives here so
// bundles authored against this offering pass Dogsled's parse step at
// upload time.
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — dogsled_managed destination', () => {
  it('accepts a minimal `dogsled_managed` destination block', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        lakehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: 'dogsled_managed',
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const dest = result.data.destinations['lakehouse'];
      // Strip helper must short-circuit on `dogsled_*` types so the
      // ref survives parsing — the orchestrator needs it to look up
      // the connection row and expand the block.
      expect(dest).toEqual({
        type: 'dogsled_managed',
        dogsled_connection_ref: 'dogsled_managed',
      });
    }
  });

  it('rejects the unsupported destination type with a migration hint', () => {
    const result = DestinationSchema.safeParse({
      type: 'bobsled_lakehouse',
      dogsled_connection_ref: 'warehouse-prod',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('use dogsled_managed');
  });

  it('normalizes and strips the connection alias on concrete destinations', () => {
    expect(
      DestinationSchema.parse({
        type: 'duckdb',
        db_path: ':memory:',
        bobsled_connection_ref: 'warehouse-prod',
      })
    ).toEqual({ type: 'duckdb', db_path: ':memory:' });
  });

  it('preserves dogsled_connection_ref through preprocess (does NOT strip it)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        lakehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: 'andyup-managed-bq',
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.destinations['lakehouse']).toHaveProperty(
        'dogsled_connection_ref',
        'andyup-managed-bq'
      );
    }
  });

  it('rejects when dogsled_connection_ref is missing', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        lakehouse: {
          type: 'dogsled_managed',
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['whitespace', '   '],
    ['leading hyphen', '-dogsled_managed'],
    ['trailing underscore', 'dogsled_managed_'],
    ['uppercase', 'Dogsled_Managed'],
    ['double separator', 'dogsled--managed'],
    ['special char', 'dogsled.managed'],
  ])('rejects dogsled_connection_ref with %s', (_label, ref) => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        lakehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: ref,
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['kebab-case', 'bobsled-managed'],
    ['snake_case', 'dogsled_managed'],
    ['mixed separators', 'andyup-prod_bq'],
    ['digits', 'cust-123'],
    ['single char', 'x'],
  ])('accepts valid slug shape: %s', (_label, ref) => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        lakehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: ref,
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty dogsled_connection_ref', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        lakehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: '',
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra fields on the block (strict)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        lakehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: 'dogsled_managed',
          // typo of dogsled_connection_ref — not the same field, must
          // fail; strict mode on the schema rejects unknown keys.
          dogsled_connecton_ref: 'typo',
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('allows shared destination fields (load_strategy, table_prefix)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        lakehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: 'dogsled_managed',
          load_strategy: 'full_refresh',
          table_prefix: 'raw_',
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('strips `x-*` extension keys on a managed destination block (still passes strict validation)', () => {
    // Regression: when this branch was first added, the strip helper
    // short-circuited entirely for managed types — preserving
    // `dogsled_*` correctly but ALSO leaving `x-*` keys in place,
    // which then tripped `.strict()`. The two-axis fix preserves
    // dogsled_* for managed types only, while always stripping
    // `x-*` (generic OpenAPI extension namespace, ignored by Dogsled).
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        lakehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: 'dogsled_managed',
          'x-orchestrator': 'langsmith',
          'x-deployment-id': 'dep_abc123',
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const dest = result.data.destinations['lakehouse'];
      // dogsled_connection_ref preserved (orchestrator-resolved
      // type's schema) but x-* keys stripped (generic extensions).
      expect(dest).toHaveProperty('dogsled_connection_ref', 'dogsled_managed');
      expect(dest).not.toHaveProperty('x-orchestrator');
      expect(dest).not.toHaveProperty('x-deployment-id');
    }
  });

  it('coexists with other destination types in the same map', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          type: 'snowflake',
          account: 'acme',
          username: 'loader',
          warehouse: 'compute_wh',
          database: 'raw',
        },
        lakehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: 'dogsled_managed',
        },
      },
      pipelines: {
        linear: {
          schedule: 'daily',
          source: 'linear',
          destination: 'warehouse',
          resources: ['teams'],
        },
        linear_bq: {
          schedule: 'daily',
          source: 'linear',
          destination: 'lakehouse',
          resources: ['teams'],
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Embed block
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — embed block', () => {
  it('parses an optional embed block', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        hubspot: {
          schedule: 'daily',
          source: 'hubspot',
          destination: 'warehouse',
          resources: ['companies'],
          embed: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            api_key: '$OPENAI_API_KEY',
            streams: {
              companies: [{ field: 'description', as: 'embedding' }],
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('still allows pipelines without embed config', () => {
    const result = DogsledConfigSchema.safeParse(minimalValidConfig());
    expect(result.success).toBe(true);
  });

  it('rejects embed config with invalid provider', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        hubspot: {
          schedule: 'daily',
          source: 'hubspot',
          destination: 'warehouse',
          resources: ['companies'],
          embed: {
            provider: 'bogus',
            model: 'text-embedding-3-small',
            api_key: '$OPENAI_API_KEY',
            streams: { companies: [{ field: 'description' }] },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects embed config with empty streams', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        hubspot: {
          schedule: 'daily',
          source: 'hubspot',
          destination: 'warehouse',
          resources: ['companies'],
          embed: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            api_key: '$OPENAI_API_KEY',
            streams: {},
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Defaults / state
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — defaults', () => {
  it('applies defaults for optional sections', () => {
    const result = DogsledConfigSchema.safeParse(minimalValidConfig());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults).toBeUndefined();
      expect(result.data.state).toBeUndefined();
      expect(result.data.runner).toBeUndefined();
    }
  });

  it('rejects invalid state backend', () => {
    const result = DogsledConfigSchema.safeParse({
      ...minimalValidConfig(),
      state: { backend: 'redis' },
    });
    expect(result.success).toBe(false);
  });

  it('parses defaults.models.schedule (orphan-model fallback)', () => {
    const result = DogsledConfigSchema.safeParse({
      ...minimalValidConfig(),
      defaults: { models: { schedule: 'daily' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults?.models).toEqual({ schedule: 'daily' });
    }
  });

  it('rejects empty defaults.models.schedule', () => {
    const result = DogsledConfigSchema.safeParse({
      ...minimalValidConfig(),
      defaults: { models: { schedule: '' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys under defaults.models', () => {
    const result = DogsledConfigSchema.safeParse({
      ...minimalValidConfig(),
      defaults: { models: { schedule: 'daily', extraneous: 'nope' } },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pipeline `type:` discriminator (extract default + models pipelines)
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — pipeline type discriminator', () => {
  it('defaults a pipeline with no `type:` to `extract` (back-compat)', () => {
    const result = DogsledConfigSchema.safeParse(minimalValidConfig());
    expect(result.success).toBe(true);
    if (result.success) {
      const stripe = result.data.pipelines['stripe'];
      expect(stripe).toBeDefined();
      expect(stripe).toMatchObject({ type: 'extract' });
    }
  });

  it('accepts an explicit `type: extract` pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          type: 'extract',
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown `type:` value', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        weird: {
          type: 'transform',
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a `type: models` pipeline with explicit list', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom_gold: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'every 6h',
          models: ['fct_revenue', 'mart_customer_360'],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const ecom = result.data.pipelines['ecom_gold'];
      expect(ecom).toMatchObject({
        type: 'models',
        connection: 'snowflake',
        schedule: 'every 6h',
        models: ['fct_revenue', 'mart_customer_360'],
      });
    }
  });

  it('accepts a `type: models` pipeline with wildcard', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom_silver: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: '*',
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipelines['ecom_silver']).toMatchObject({
        type: 'models',
        models: '*',
      });
    }
  });

  it('accepts extract and models pipelines side by side', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      defaults: { models: { schedule: 'daily' } },
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
        },
        ecom_silver: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: '*',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it.each(['queryTag', 'query_tag'])(
    'rejects authored %s on model and extract pipelines',
    (key) => {
      const models = DogsledConfigSchema.safeParse({
        destinations: minimalValidConfig().destinations,
        pipelines: {
          ecom_silver: {
            type: 'models',
            connection: 'snowflake',
            schedule: 'hourly',
            models: '*',
            [key]: 'authored-tag',
          },
        },
      });
      const extract = DogsledConfigSchema.safeParse({
        destinations: minimalValidConfig().destinations,
        pipelines: {
          source_orders: {
            type: 'extract',
            source: 'snowflake',
            destination: 'warehouse',
            schedule: 'hourly',
            resources: ['orders'],
            [key]: 'authored-tag',
          },
        },
      });

      expect(models.success).toBe(false);
      expect(extract.success).toBe(false);
    }
  );

  it('accepts destination_warehouse only on a singular managed extract destination', () => {
    const accepted = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: 'warehouse-prod',
        },
      },
      pipelines: {
        posthog_ingestion: {
          type: 'extract',
          source: 'posthog',
          destination: 'warehouse',
          runner: 'managed',
          schedule: 'manual',
          resources: ['events'],
          destination_warehouse: 'medium',
        },
      },
    });
    const model = DogsledConfigSchema.safeParse({
      pipelines: {
        models: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'manual',
          models: '*',
          destination_warehouse: 'medium',
        },
      },
    });
    const fanout = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        posthog_ingestion: {
          type: 'extract',
          source: 'posthog',
          destinations: ['warehouse'],
          schedule: 'manual',
          resources: ['events'],
          destination_warehouse: 'medium',
        },
      },
    });

    expect(accepted.success).toBe(true);
    expect(model.success).toBe(false);
    expect(fanout.success).toBe(false);
  });

  it('does not allow a per-resource destination_warehouse override', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        posthog_ingestion: {
          type: 'extract',
          source: 'posthog',
          destination: 'warehouse',
          schedule: 'manual',
          resources: [{ resource: 'events', destination_warehouse: 'medium' }],
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects the trusted destinationWarehouse runtime option in authored YAML', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        posthog_ingestion: {
          type: 'extract',
          source: 'posthog',
          destination: 'warehouse',
          schedule: 'manual',
          resources: ['events'],
          destinationWarehouse: 'PHYSICAL_WH',
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects models pipeline without `connection`', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom: {
          type: 'models',
          schedule: 'hourly',
          models: '*',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects models pipeline without `schedule`', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom: {
          type: 'models',
          connection: 'snowflake',
          models: '*',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects models pipeline without `models`', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects models pipeline with empty connection', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom: {
          type: 'models',
          connection: '',
          schedule: 'hourly',
          models: '*',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects models pipeline with empty models list', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: [],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it.each(['glob_*', 'stg_*', 'tag:bronze'])(
    'rejects v2-only `models:` selector "%s" (string that is not the wildcard)',
    (selector) => {
      // Glob/tag selectors are explicitly v2 — only "*" or an array of names
      // is accepted in v1.
      const result = DogsledConfigSchema.safeParse({
        destinations: minimalValidConfig().destinations,
        pipelines: {
          ecom: {
            type: 'models',
            connection: 'snowflake',
            schedule: 'hourly',
            models: selector,
          },
        },
      });
      expect(result.success).toBe(false);
    }
  );

  it('rejects `depends_on:` field on models pipeline (v2)', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: '*',
          depends_on: ['stripe'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional description on an extract pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          description: 'Pulls Stripe charges into the warehouse.',
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipelines['stripe']).toMatchObject({
        description: 'Pulls Stripe charges into the warehouse.',
      });
    }
  });

  it('accepts an optional description on a models pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom_gold: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'every 6h',
          models: ['fct_revenue'],
          description: 'Refreshes the gold-layer revenue marts.',
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipelines['ecom_gold']).toMatchObject({
        description: 'Refreshes the gold-layer revenue marts.',
      });
    }
  });

  it('rejects a non-string description', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          description: 42,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts description at the 2000-char boundary', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          description: 'a'.repeat(2000),
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects description longer than 2000 characters', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          description: 'a'.repeat(2001),
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract-only fields (source/destination) on a models pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        ecom: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: '*',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pipeline-level and per-resource `via:` (transport selection)
// ---------------------------------------------------------------------------

describe('DogsledConfigSchema — via: transport selection', () => {
  it('accepts pipeline-level `via:` on an extract pipeline', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        linear_mcp: {
          type: 'extract',
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          via: 'mcp',
          resources: ['cycles_mcp'],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipelines['linear_mcp']).toMatchObject({
        type: 'extract',
        via: 'mcp',
      });
    }
  });

  it('accepts per-resource override `via:`', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        linear: {
          type: 'extract',
          schedule: 'hourly',
          source: 'linear',
          destination: 'warehouse',
          resources: [{ resource: 'teams_mcp', via: 'mcp' }, { resource: 'initiatives' }],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const pipeline = result.data.pipelines['linear'] as { resources: unknown[] };
      expect(pipeline.resources[0]).toMatchObject({ resource: 'teams_mcp', via: 'mcp' });
    }
  });

  it('rejects empty-string `via:` at pipeline level', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        bad: {
          type: 'extract',
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          via: '',
          resources: ['cycles_mcp'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string `via:` on a resource override', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: minimalValidConfig().destinations,
      pipelines: {
        bad: {
          type: 'extract',
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          resources: [{ resource: 'teams_mcp', via: '' }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('keeps existing pipelines without `via:` valid (back-compat)', () => {
    const result = DogsledConfigSchema.safeParse(minimalValidConfig());
    expect(result.success).toBe(true);
    if (result.success) {
      const stripe = result.data.pipelines['stripe'] as { via?: unknown };
      expect(stripe.via).toBeUndefined();
    }
  });
});
