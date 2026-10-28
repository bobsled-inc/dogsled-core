/**
 * Tests for the `type: entity-graph` pipeline:
 *   - schema acceptance + rejection
 *   - `resolveEntityGraphPipelines` (parsed → resolved shape)
 *   - `phases` default + duplicate / empty rejection
 *   - `schedule: manual` propagation
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  EntityGraphPipelineConfigSchema,
  PipelineConfigSchema,
  DogsledConfigSchema,
  type DogsledConfig,
} from '../../../src/runner/config/schema.js';
import { resolveEntityGraphPipelines } from '../../../src/runner/config/loader.js';

const minimalDestinations = {
  warehouse: {
    type: 'bigquery' as const,
    project: 'p',
    dataset: 'd',
  },
};

type PipelineFixture = z.input<typeof PipelineConfigSchema>;

function configWithPipelines(pipelines: Record<string, PipelineFixture>): DogsledConfig {
  return DogsledConfigSchema.parse({
    destinations: minimalDestinations,
    pipelines,
  });
}

describe('EntityGraphPipelineConfigSchema — acceptance', () => {
  it('accepts a wildcard-entity entity-graph pipeline', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: '*',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // `phases` default applies — both resolve and cluster.
      expect(result.data.phases).toEqual(['resolve', 'cluster']);
    }
  });

  it('accepts an explicit entity list and a single phase', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'hourly',
      entities: ['company', 'contact'],
      phases: ['resolve'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entities).toEqual(['company', 'contact']);
      expect(result.data.phases).toEqual(['resolve']);
    }
  });

  it('accepts schedule: manual', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'manual',
      entities: '*',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the construction phases extract_mentions and extract_relationships', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: ['company'],
      phases: ['extract_mentions', 'extract_relationships'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phases).toEqual(['extract_mentions', 'extract_relationships']);
    }
  });

  it('accepts an explicit profile phase', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: ['company'],
      phases: ['resolve', 'cluster', 'profile'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phases).toEqual(['resolve', 'cluster', 'profile']);
    }
  });

  it('accepts a chunk_sources array and applies chunking defaults', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: ['company'],
      phases: ['extract_mentions'],
      chunk_sources: [
        {
          entity: 'company',
          source_table: 'raw.documents',
          text_column: 'body',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chunk_sources).toEqual([
        {
          entity: 'company',
          source_table: 'raw.documents',
          text_column: 'body',
          max_tokens: 512,
          overlap_tokens: 64,
          tokenizer: 'cl100k_base',
        },
      ]);
    }
  });

  it('accepts a chunk_sources array with all optional fields and overrides', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: ['document'],
      phases: ['extract_mentions', 'extract_relationships'],
      chunk_sources: [
        {
          entity: 'document',
          source_table: 'raw.filings',
          text_column: 'content',
          uri_column: 'source_uri',
          title_column: 'title',
          max_tokens: 1024,
          overlap_tokens: 0,
          tokenizer: 'o200k_base',
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('EntityGraphPipelineConfigSchema — rejection', () => {
  it('rejects an empty entities array', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('non-empty list or the wildcard');
    }
  });

  it('rejects an empty phases array', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: '*',
      phases: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        'must include at least one entity-graph phase'
      );
    }
  });

  it('rejects duplicate phases', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: '*',
      phases: ['resolve', 'resolve'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('must not contain duplicates');
    }
  });

  it('rejects an unknown phase value', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: '*',
      phases: ['validate'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an upper-cased connection handle', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'Snowflake',
      schedule: 'daily',
      entities: '*',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields under strict mode', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: '*',
      extraField: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key inside a chunk source (strict)', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: ['company'],
      phases: ['extract_mentions'],
      chunk_sources: [
        {
          entity: 'company',
          source_table: 'raw.documents',
          text_column: 'body',
          bogus_key: 'nope',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a chunk source missing required fields', () => {
    const result = EntityGraphPipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: 'daily',
      entities: ['company'],
      phases: ['extract_mentions'],
      chunk_sources: [
        {
          entity: 'company',
          // missing source_table + text_column
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('resolveEntityGraphPipelines', () => {
  it('returns the parsed pipeline with phases default applied', () => {
    const config = configWithPipelines({
      eg_companies: {
        type: 'entity-graph',
        connection: 'snowflake',
        schedule: 'daily',
        entities: '*',
      },
    });
    const resolved = resolveEntityGraphPipelines(config);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      name: 'eg_companies',
      connection: 'snowflake',
      entities: '*',
      phases: ['resolve', 'cluster'],
      default_run_mode: 'incremental',
      schedule: 'daily',
      trigger: 'schedule',
      enabled: true,
    });
    expect(resolved[0]?.cron).not.toBeNull();
  });

  it('returns trigger: manual + cron: null for schedule: manual', () => {
    const config = configWithPipelines({
      eg_companies: {
        type: 'entity-graph',
        connection: 'snowflake',
        schedule: 'manual',
        entities: ['company'],
      },
    });
    const resolved = resolveEntityGraphPipelines(config);
    expect(resolved[0]?.trigger).toBe('manual');
    expect(resolved[0]?.cron).toBeNull();
    expect(resolved[0]?.default_run_mode).toBe('full');
  });

  it('ignores extract and models pipelines', () => {
    const config = configWithPipelines({
      stripe_sync: {
        type: 'extract',
        schedule: 'hourly',
        source: 'stripe',
        destination: 'warehouse',
        resources: ['charges'],
      },
      bigquery_silver: {
        type: 'models',
        connection: 'bigquery',
        schedule: 'daily',
        models: '*',
      },
      eg_companies: {
        type: 'entity-graph',
        connection: 'snowflake',
        schedule: 'daily',
        entities: '*',
      },
    });
    const resolved = resolveEntityGraphPipelines(config);
    expect(resolved.map((p) => p.name)).toEqual(['eg_companies']);
  });
});
