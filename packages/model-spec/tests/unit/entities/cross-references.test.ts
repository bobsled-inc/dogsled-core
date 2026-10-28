import { describe, expect, it } from 'vitest';

import { validateMetadataReferences } from '../../../src/entities/cross-references.js';
import type { MetricSpec } from '../../../src/entities/metric.js';
import type { RelationshipSpec } from '../../../src/entities/relationship.js';
import type { VqSpec } from '../../../src/entities/vq.js';

const emptyRegistry = {
  metrics: new Map<string, MetricSpec>(),
  relationships: new Map<string, RelationshipSpec>(),
  vqs: new Map<string, VqSpec>(),
};

const emptyCtx = {
  modelNames: new Set<string>(),
  sourceKeys: new Set<string>(),
  integrationHandles: new Set<string>(),
};

describe('validateMetadataReferences — metrics', () => {
  it('accepts metrics that reference real models', () => {
    const metric: MetricSpec = {
      spec_version: '0.2',
      type: 'metric',
      name: 'orders_total',
      expression: 'SUM(amount)',
      model: 'fct_orders',
    };
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, metrics: new Map([['orders_total', metric]]) },
        { ...emptyCtx, modelNames: new Set(['fct_orders']) }
      )
    ).not.toThrow();
  });

  it('accepts metrics that reference real sources', () => {
    const metric: MetricSpec = {
      spec_version: '0.2',
      type: 'metric',
      name: 'orders_total',
      expression: 'SUM(amount)',
      model: 'warehouse.raw_orders',
    };
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, metrics: new Map([['orders_total', metric]]) },
        { ...emptyCtx, sourceKeys: new Set(['warehouse.raw_orders']) }
      )
    ).not.toThrow();
  });

  it('rejects metrics that reference unknown models', () => {
    const metric: MetricSpec = {
      spec_version: '0.2',
      type: 'metric',
      name: 'orders_total',
      expression: 'SUM(amount)',
      model: 'nope',
    };
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, metrics: new Map([['orders_total', metric]]) },
        emptyCtx
      )
    ).toThrow(/unknown model "nope"/);
  });

  it('rejects metrics that reference unknown sources', () => {
    const metric: MetricSpec = {
      spec_version: '0.2',
      type: 'metric',
      name: 'orders_total',
      expression: 'SUM(amount)',
      model: 'warehouse.missing_orders',
    };
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, metrics: new Map([['orders_total', metric]]) },
        emptyCtx
      )
    ).toThrow(/unknown source "warehouse\.missing_orders"/);
  });

  it('rejects multi-model metrics with at least one unknown model', () => {
    const metric: MetricSpec = {
      spec_version: '0.2',
      type: 'metric',
      name: 'ratio',
      expression: 'a / b',
      models: ['fct_orders', 'phantom'],
    };
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, metrics: new Map([['ratio', metric]]) },
        { ...emptyCtx, modelNames: new Set(['fct_orders']) }
      )
    ).toThrow(/unknown model "phantom"/);
  });
});

describe('validateMetadataReferences — relationships', () => {
  it('accepts relationships where both endpoints are real models', () => {
    const rel: RelationshipSpec = {
      spec_version: '0.2',
      type: 'relationship',
      name: 'orders_to_customers',
      left_model: 'fct_orders',
      right_model: 'dim_customers',
      join_columns: [{ left: 'customer_id', right: 'id' }],
      join_type: 'inner',
      relationship_type: 'many_to_one',
    };
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, relationships: new Map([['orders_to_customers', rel]]) },
        { ...emptyCtx, modelNames: new Set(['fct_orders', 'dim_customers']) }
      )
    ).not.toThrow();
  });

  it('accepts relationships between a source and a derived model', () => {
    const rel: RelationshipSpec = {
      spec_version: '0.2',
      type: 'relationship',
      name: 'orders_to_customers',
      left_model: 'warehouse.raw_orders',
      right_model: 'dim_customers',
      join_columns: [{ left: 'customer_id', right: 'id' }],
      join_type: 'inner',
      relationship_type: 'many_to_one',
    };
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, relationships: new Map([['orders_to_customers', rel]]) },
        {
          ...emptyCtx,
          modelNames: new Set(['dim_customers']),
          sourceKeys: new Set(['warehouse.raw_orders']),
        }
      )
    ).not.toThrow();
  });

  it('rejects when left_model is unknown', () => {
    const rel: RelationshipSpec = {
      spec_version: '0.2',
      type: 'relationship',
      name: 'broken',
      left_model: 'phantom',
      right_model: 'dim_customers',
      join_columns: [{ left: 'a', right: 'b' }],
      join_type: 'inner',
      relationship_type: 'many_to_one',
    };
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, relationships: new Map([['broken', rel]]) },
        { ...emptyCtx, modelNames: new Set(['dim_customers']) }
      )
    ).toThrow(/left_model "phantom"/);
  });
});

describe('validateMetadataReferences — VQs', () => {
  function vq(overrides: Partial<VqSpec> = {}): VqSpec {
    return {
      spec_version: '0.2',
      type: 'vq',
      name: 'q1',
      nlq: 'Some question',
      sql: 'SELECT * FROM {fct_orders}',
      ...overrides,
    };
  }

  it('accepts VQs whose tokens resolve to known models or sources', () => {
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, vqs: new Map([['q1', vq()]]) },
        { ...emptyCtx, modelNames: new Set(['fct_orders']) }
      )
    ).not.toThrow();

    expect(() =>
      validateMetadataReferences(
        {
          ...emptyRegistry,
          vqs: new Map([['q1', vq({ sql: 'SELECT * FROM {ecom.raw_orders}' })]]),
        },
        { ...emptyCtx, sourceKeys: new Set(['ecom.raw_orders']) }
      )
    ).not.toThrow();
  });

  it('accepts declared parameter tokens without treating them as model references', () => {
    expect(() =>
      validateMetadataReferences(
        {
          ...emptyRegistry,
          vqs: new Map([
            [
              'q1',
              vq({
                sql: 'SELECT * FROM {fct_orders} WHERE ordered_at >= {start_date}',
                parameters: [{ name: 'start_date', type: 'date', required: true }],
              }),
            ],
          ]),
        },
        { ...emptyCtx, modelNames: new Set(['fct_orders']) }
      )
    ).not.toThrow();
  });

  it('rejects VQ model tokens for unknown models', () => {
    expect(() =>
      validateMetadataReferences({ ...emptyRegistry, vqs: new Map([['q1', vq()]]) }, emptyCtx)
    ).toThrow(/unknown model token \{fct_orders\}/);
  });

  it('rejects VQ source tokens for unknown sources', () => {
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, vqs: new Map([['q1', vq({ sql: 'SELECT * FROM {ecom.phantom}' })]]) },
        emptyCtx
      )
    ).toThrow(/unknown source token \{ecom\.phantom\}/);
  });

  it('rejects VQs pinned to unknown integrations (when handles are declared)', () => {
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, vqs: new Map([['q1', vq({ connection: 'unknown_handle' })]]) },
        {
          ...emptyCtx,
          modelNames: new Set(['fct_orders']),
          integrationHandles: new Set(['ecom_sf']),
        }
      )
    ).toThrow(/integration "unknown_handle"/);
  });

  it('skips integration-handle validation when no handles are declared', () => {
    expect(() =>
      validateMetadataReferences(
        { ...emptyRegistry, vqs: new Map([['q1', vq({ connection: 'whatever' })]]) },
        { ...emptyCtx, modelNames: new Set(['fct_orders']) }
      )
    ).not.toThrow();
  });

  it('aggregates multiple errors into a single CommandError', () => {
    const registry = {
      ...emptyRegistry,
      vqs: new Map([
        ['q1', vq({ sql: 'SELECT * FROM {phantom_one}' })],
        ['q2', vq({ name: 'q2', sql: 'SELECT * FROM {phantom_two}' })],
      ]),
    };
    try {
      validateMetadataReferences(registry, emptyCtx);
      expect.fail('Expected CommandError');
    } catch (err) {
      expect((err as Error).message).toContain('phantom_one');
      expect((err as Error).message).toContain('phantom_two');
    }
  });
});
