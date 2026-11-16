import { describe, expect, it } from 'vitest';

import { ExtractorConfigSchema } from '../../src/schemas/config.js';

// ---------------------------------------------------------------------------
// default_load — project-level load block (V2 resource spec refactor)
// ---------------------------------------------------------------------------

describe('extractor config — default_load', () => {
  it('accepts a full default_load block', () => {
    const result = ExtractorConfigSchema.safeParse({
      default_load: {
        integration: 'snowflake_warehouse',
        overrides: { role: 'LOADER_ROLE', database: 'BOBSLED_CORE_RAW' },
        defaults: { load_strategy: 'merge', schema_behavior: 'evolve', buffer_size: 50000 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default_load?.integration).toBe('snowflake_warehouse');
    }
  });

  it('accepts a minimal default_load (integration only)', () => {
    const result = ExtractorConfigSchema.safeParse({
      default_load: { integration: 'snowflake_warehouse' },
    });
    expect(result.success).toBe(true);
  });

  it('default_load is optional', () => {
    const result = ExtractorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default_load).toBeUndefined();
    }
  });

  it('rejects default_load without integration', () => {
    const result = ExtractorConfigSchema.safeParse({
      default_load: { overrides: { role: 'LOADER_ROLE' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown field inside default_load', () => {
    const result = ExtractorConfigSchema.safeParse({
      default_load: { integration: 'snowflake_warehouse', bogus: true },
    });
    expect(result.success).toBe(false);
  });
});

describe('extractor config — default_target', () => {
  it('accepts a default_target handle', () => {
    const result = ExtractorConfigSchema.safeParse({
      default_target: 'main_warehouse',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default_target).toBe('main_warehouse');
    }
  });

  it('default_target is optional', () => {
    const result = ExtractorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default_target).toBeUndefined();
    }
  });

  it('rejects empty-string default_target', () => {
    const result = ExtractorConfigSchema.safeParse({
      default_target: '',
    });
    expect(result.success).toBe(false);
  });
});
