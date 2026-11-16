import { describe, expect, it } from 'vitest';

import { BobsledConfigSchema } from '../../../src/runner/config/schema.js';

const baseConfig = {
  destinations: {
    local_files: {
      type: 'local',
      format: 'jsonl',
    },
  },
  pipelines: {
    daily: {
      schedule: '0 0 * * *',
      source: 'github',
      destination: 'local_files',
      resources: ['issues'],
    },
  },
};

describe('BobsledConfigSchema platform.models', () => {
  it('accepts Bedrock and OpenRouter model roles', () => {
    const result = BobsledConfigSchema.safeParse({
      ...baseConfig,
      platform: {
        models: {
          default_embedding_v1: {
            provider: 'amazon-bedrock',
            model: 'amazon.titan-embed-text-v2:0',
            region: 'us-east-1',
            dimension: 1024,
          },
          mention_disambiguation_v1: {
            provider: 'openrouter',
            model: 'moonshotai/kimi-k2',
            api_key: '${{ env.OPENROUTER_API_KEY }}',
          },
        },
        budget: {
          ai_cost_daily_usd: 50,
          per_source_rpm: 60,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('requires env placeholders for API-key model providers', () => {
    const result = BobsledConfigSchema.safeParse({
      ...baseConfig,
      platform: {
        models: {
          extraction: {
            provider: 'openrouter',
            model: 'moonshotai/kimi-k2',
            api_key: 'raw-secret',
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts ${{ env.VARNAME }} placeholders for destination secrets', () => {
    const result = BobsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          type: 'postgres',
          host: 'db.example.com',
          database: 'analytics',
          username: 'loader',
          password: '${{ env.PG_PASSWORD }}',
        },
      },
      pipelines: {
        daily: {
          schedule: '0 0 * * *',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('BobsledConfigSchema resource input matrices', () => {
  it('accepts a bounded static matrix on a resource override', () => {
    const result = BobsledConfigSchema.safeParse({
      ...baseConfig,
      pipelines: {
        daily: {
          ...baseConfig.pipelines.daily,
          resources: [
            {
              resource: 'issues',
              input_matrix: {
                axes: {
                  mode: ['compact', 'full'],
                  page_size: [25, 50],
                },
                concurrency: 2,
              },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty matrix axis', () => {
    const result = BobsledConfigSchema.safeParse({
      ...baseConfig,
      pipelines: {
        daily: {
          ...baseConfig.pipelines.daily,
          resources: [
            {
              resource: 'issues',
              input_matrix: { axes: { mode: [] } },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
