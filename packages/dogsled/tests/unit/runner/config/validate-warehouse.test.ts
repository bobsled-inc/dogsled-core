import { describe, expect, it } from 'vitest';

import type {
  IntegrationsLib,
  ResolvedModelPipeline,
  ResolvedPipeline,
  ResolvedResource,
  ValidationIssue,
} from '../../../../src/runner/config/loader.js';
import {
  PER_RESOURCE_WAREHOUSE_REJECTION,
  validateModelWarehouseSelections,
  validateWarehouseSelections,
} from '../../../../src/runner/config/validate-warehouse.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipeline(overrides: Partial<ResolvedPipeline> = {}): ResolvedPipeline {
  return {
    name: 'warehouse_pipeline',
    schedule: 'daily',
    cron: '0 0 * * *',
    trigger: 'schedule',
    source: 'snowflake_src',
    destinationNames: ['warehouse'],
    resources: [],
    tablePrefix: 'warehouse_pipeline__',
    enabled: true,
    runner: 'managed',
    ...overrides,
  };
}

function makeModelPipeline(overrides: Partial<ResolvedModelPipeline> = {}): ResolvedModelPipeline {
  return {
    name: 'models_pipeline',
    schedule: 'daily',
    cron: '0 0 * * *',
    trigger: 'schedule',
    connection: 'snowflake_src',
    models: '*',
    enabled: true,
    ...overrides,
  };
}

function makeResource(name: string, warehouse?: string): ResolvedResource {
  return {
    name,
    override: warehouse !== undefined ? { warehouse } : undefined,
  };
}

/**
 * Minimal IntegrationsLib stub — only `getIntegration` is exercised by the
 * warehouse validator. `declared` controls the integration's declared
 * warehouses set; pass `undefined` to model a source with no warehouse-ID map.
 *
 * NOTE: this stub feeds `warehouses` directly into the `getIntegration`
 * return shape, exercising the function in isolation. In production, the
 * `warehouses` set is populated by `readDeclaredWarehouses` in loader.ts
 * from the `@bobsled-inc/integrations` source spec. Bundled API
 * integrations never carry a Snowflake connection, so `declared` is
 * effectively always `undefined` for them — selectors are rejected because a
 * stable warehouse ID map is required to execute one safely.
 */
function makeLib(declared?: Record<string, string>): IntegrationsLib {
  return {
    getIntegration(name) {
      if (name === 'snowflake_src') {
        return {
          meta: {},
          resource_names: [],
          transports: [{ id: 'rest' }],
          default_transport: 'rest',
          warehouses: declared,
        };
      }
      throw new Error(`Unknown integration: ${name}`);
    },
    getResources: () => [],
    listEntities: () => [],
    getEntityVariants: () => [],
  };
}

// ---------------------------------------------------------------------------
// Extract pipeline tests
// ---------------------------------------------------------------------------

describe('validateWarehouseSelections (extract pipelines)', () => {
  const declared = { small: 'COMPUTE_WH', large: 'BIG_WH' };

  it('accepts a pipeline-level selector that matches a declared warehouse ID', () => {
    const errors: ValidationIssue[] = [];
    validateWarehouseSelections(makePipeline({ warehouse: 'large' }), makeLib(declared), errors);
    expect(errors).toEqual([]);
  });

  it('rejects a provider warehouse name in favor of its declared ID', () => {
    const errors: ValidationIssue[] = [];
    validateWarehouseSelections(makePipeline({ warehouse: 'BIG_WH' }), makeLib(declared), errors);
    expect(errors[0]?.message).toContain('Declared warehouse IDs: small, large.');
  });

  it('rejects a pipeline-level selector naming an undeclared warehouse', () => {
    const errors: ValidationIssue[] = [];
    validateWarehouseSelections(makePipeline({ warehouse: 'GHOST_WH' }), makeLib(declared), errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('dogsled.yml:pipelines.warehouse_pipeline.warehouse');
    expect(errors[0]?.message).toMatch(/not a declared warehouse ID on source/);
    expect(errors[0]?.message).toContain('Declared warehouse IDs: small, large.');
  });

  it('rejects a per-resource warehouse override with the exact deferred message', () => {
    const errors: ValidationIssue[] = [];
    validateWarehouseSelections(
      makePipeline({ resources: [makeResource('orders', 'BIG_WH')] }),
      makeLib(declared),
      errors
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(PER_RESOURCE_WAREHOUSE_REJECTION);
    expect(errors[0]?.message).toBe(
      'Per-resource warehouse selection is not supported yet. ' +
        'Set `warehouse:` at the pipeline level instead.'
    );
    expect(errors[0]?.path).toBe(
      'dogsled.yml:pipelines.warehouse_pipeline.resources.orders.warehouse'
    );
  });

  it('rejects a per-resource override even when the integrations lib is unavailable', () => {
    // The runtime can never honor a per-resource warehouse, so the rejection
    // must not depend on integrations metadata loading.
    const errors: ValidationIssue[] = [];
    validateWarehouseSelections(
      makePipeline({ resources: [makeResource('orders', 'BIG_WH')] }),
      undefined,
      errors
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(PER_RESOURCE_WAREHOUSE_REJECTION);
  });

  it('rejects a selector when the source declares no warehouse IDs', () => {
    const errors: ValidationIssue[] = [];
    validateWarehouseSelections(
      makePipeline({ warehouse: 'anything' }),
      makeLib(undefined),
      errors
    );
    expect(errors[0]?.path).toBe('dogsled.yml:pipelines.warehouse_pipeline.warehouse');
    expect(errors[0]?.message).toContain('declares no warehouse IDs');
    expect(errors[0]?.message).toContain('Declared warehouse IDs: (none).');
  });

  it('does nothing when no warehouse fields are present', () => {
    const errors: ValidationIssue[] = [];
    validateWarehouseSelections(
      makePipeline({ resources: [makeResource('orders')] }),
      makeLib(declared),
      errors
    );
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Model pipeline tests
// ---------------------------------------------------------------------------

describe('validateModelWarehouseSelections (model pipelines)', () => {
  const declared = { small: 'COMPUTE_WH', large: 'BIG_WH' };

  it('accepts a pipeline-level selector that matches a declared warehouse ID', () => {
    const errors: ValidationIssue[] = [];
    validateModelWarehouseSelections(
      makeModelPipeline({ warehouse: 'large' }),
      makeLib(declared),
      errors
    );
    expect(errors).toEqual([]);
  });

  it('rejects a provider warehouse name in favor of its declared ID', () => {
    const errors: ValidationIssue[] = [];
    validateModelWarehouseSelections(
      makeModelPipeline({ warehouse: 'BIG_WH' }),
      makeLib(declared),
      errors
    );
    expect(errors[0]?.message).toContain('Declared warehouse IDs: small, large.');
  });

  it('rejects a pipeline-level selector naming an undeclared warehouse', () => {
    const errors: ValidationIssue[] = [];
    validateModelWarehouseSelections(
      makeModelPipeline({ warehouse: 'GHOST_WH' }),
      makeLib(declared),
      errors
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('dogsled.yml:pipelines.models_pipeline.warehouse');
    expect(errors[0]?.message).toMatch(/not a declared warehouse ID on connection/);
    expect(errors[0]?.message).toContain('Declared warehouse IDs: small, large.');
  });

  it('rejects a selector when the connection declares no warehouse IDs', () => {
    const errors: ValidationIssue[] = [];
    validateModelWarehouseSelections(
      makeModelPipeline({ warehouse: 'anything' }),
      makeLib(undefined),
      errors
    );
    expect(errors[0]?.path).toBe('dogsled.yml:pipelines.models_pipeline.warehouse');
    expect(errors[0]?.message).toContain('declares no warehouse IDs');
    expect(errors[0]?.message).toContain('Declared warehouse IDs: (none).');
  });

  it('does nothing when no warehouse is set', () => {
    const errors: ValidationIssue[] = [];
    validateModelWarehouseSelections(makeModelPipeline(), makeLib(declared), errors);
    expect(errors).toEqual([]);
  });

  it('silently skips when the connection is not found in the integration lib', () => {
    // Connection-not-found is reported by validateModelPipelineMembership;
    // the warehouse validator should not duplicate that error.
    const errors: ValidationIssue[] = [];
    validateModelWarehouseSelections(
      makeModelPipeline({ connection: 'unknown_conn', warehouse: 'BIG_WH' }),
      makeLib(declared),
      errors
    );
    expect(errors).toEqual([]);
  });
});
