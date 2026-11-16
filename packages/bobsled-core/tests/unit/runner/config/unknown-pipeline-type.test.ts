/**
 * UNKNOWN_PIPELINE_TYPE — make the "your pipeline type is not in the enum"
 * error fix-suggesting instead of opaque "invalid_union_discriminator".
 */

import { describe, expect, it } from 'vitest';

import { PipelineConfigSchema } from '../../../../src/runner/config/schema.js';

describe('UNKNOWN_PIPELINE_TYPE', () => {
  it('rejects an unknown pipeline type with a fix-suggesting message', () => {
    const result = PipelineConfigSchema.safeParse({
      type: 'transform',
      schedule: '0 * * * *',
      source: 'ecom',
      destination: 'warehouse',
      resources: [{ resource: 'orders' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('[UNKNOWN_PIPELINE_TYPE]');
      expect(msg).toContain("'extract', 'models', or 'entity-graph'");
    }
  });

  it('hints that github-actions belongs in runner: not type:', () => {
    const result = PipelineConfigSchema.safeParse({
      type: 'managed',
      schedule: '0 * * * *',
      source: 'ecom',
      destination: 'warehouse',
      resources: [{ resource: 'orders' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('[UNKNOWN_PIPELINE_TYPE]');
      expect(msg).toContain('runner:');
    }
  });

  it('still accepts type: extract', () => {
    const result = PipelineConfigSchema.safeParse({
      type: 'extract',
      schedule: '0 * * * *',
      source: 'ecom',
      destination: 'warehouse',
      resources: [{ resource: 'orders' }],
    });
    expect(result.success).toBe(true);
  });

  it('still accepts type: models', () => {
    const result = PipelineConfigSchema.safeParse({
      type: 'models',
      connection: 'snowflake',
      schedule: '0 6 * * *',
      models: '*',
    });
    expect(result.success).toBe(true);
  });

  it('accepts type: entity-graph', () => {
    const result = PipelineConfigSchema.safeParse({
      type: 'entity-graph',
      connection: 'snowflake',
      schedule: '0 6 * * *',
      entities: '*',
    });
    expect(result.success).toBe(true);
  });
});
