import { describe, expect, it } from 'vitest';

import {
  ResourceSpecSchema,
  WarehouseResourceV2SpecSchema,
} from '../../src/framework/extractor/resource.js';

describe('resource-level target:', () => {
  const warehouseResource = {
    spec_version: '1',
    type: 'resource',
    name: 'orders',
    integration: 'finance_snowflake',
    source: {
      table: 'ORDERS',
      database: 'ANALYTICS',
      schema: 'PUBLIC',
    },
    replication: {
      method: 'incremental_merge',
      cursor_field: 'updated_at',
      cursor_type: 'timestamp',
      primary_key: ['order_id'],
    },
    output: {
      order_id: { type: 'integer' },
      updated_at: { type: 'timestamp' },
    },
  };

  it('accepts an optional target field on a warehouse resource', () => {
    const result = ResourceSpecSchema.safeParse({
      ...warehouseResource,
      target: 'main_warehouse',
    });
    expect(result.success).toBe(true);
  });

  it('accepts absence of target field (backwards compatible)', () => {
    expect(ResourceSpecSchema.safeParse(warehouseResource).success).toBe(true);
  });

  it('rejects non-string target', () => {
    const result = ResourceSpecSchema.safeParse({
      ...warehouseResource,
      target: 123,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string target', () => {
    const result = ResourceSpecSchema.safeParse({
      ...warehouseResource,
      target: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-snake_case target (mixed case with dashes)', () => {
    const result = ResourceSpecSchema.safeParse({
      ...warehouseResource,
      target: 'Main-Prod',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid snake_case target', () => {
    const result = ResourceSpecSchema.safeParse({
      ...warehouseResource,
      target: 'main_warehouse',
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V2 three-block: extract.integration + load.integration
// ---------------------------------------------------------------------------

describe('V2 resource — extract.integration + load.integration', () => {
  const v2Resource = {
    spec_version: '1',
    type: 'resource',
    name: 'orders',
    extract: {
      integration: 'finance_snowflake',
      source: {
        table: 'ORDERS',
        database: 'ANALYTICS',
        schema: 'PUBLIC',
      },
      replication: {
        method: 'incremental_merge',
        cursor_field: 'updated_at',
        cursor_type: 'timestamp',
      },
    },
    load: {
      // V2 resource load block: defaults + overrides only. The destination
      // binding (integration) lives elsewhere — pipeline / CLI / extractor.yml.
      overrides: { role: 'LOADER_ROLE', database: 'BOBSLED_CORE_RAW' },
      defaults: { load_strategy: 'merge' },
    },
    schema: {
      primary_key: ['order_id'],
      columns: {
        order_id: { type: 'integer' },
        updated_at: { type: 'timestamp' },
      },
    },
  };

  it('accepts extract.integration + load (no integration on load)', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse(v2Resource);
    expect(result.success).toBe(true);
  });

  it('accepts extract.integration without load (optional)', () => {
    const { load: _drop, ...rest } = v2Resource;
    const result = WarehouseResourceV2SpecSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it('rejects empty-string extract.integration', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...v2Resource,
      extract: { ...v2Resource.extract, integration: '' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts V2 resource without extract.integration (optional self-description)', () => {
    const { integration: _drop, ...extractWithoutIntegration } = v2Resource.extract;
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...v2Resource,
      extract: extractWithoutIntegration,
    });
    expect(result.success).toBe(true);
  });

  it('rejects integration field on resource load block', () => {
    // Resource load block is defaults+overrides only; the destination binding
    // (integration) belongs on the pipeline (dogsled.yml) or CLI flag.
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...v2Resource,
      load: { ...v2Resource.load, integration: 'main_warehouse' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects both top-level integration and extract.integration (V1 vs V2 clash)', () => {
    const result = WarehouseResourceV2SpecSchema.safeParse({
      ...v2Resource,
      integration: 'finance_snowflake',
    });
    expect(result.success).toBe(false);
  });
});
