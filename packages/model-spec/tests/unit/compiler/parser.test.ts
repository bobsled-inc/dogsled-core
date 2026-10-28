import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bucketColumnType,
  buildInMemorySourceEntryRegistry,
  buildModelRegistry,
  buildSourceRegistry,
  getSourceEntry,
  parseTransformSpec,
  parseTransformSpecFromParsed,
  resolveRef,
} from '../../../src/compiler/parser.js';

import type { ModelRegistry, SourceRegistry } from '../../../src/compiler/parser.js';
import { SourceSpecSchema, TransformSpecSchema } from '../../../src/compiler/schemas.js';
import type { TransformSpec } from '../../../src/compiler/schemas.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/specs');
const SOURCES_DIR = path.join(FIXTURES_DIR, 'sources');
const MODELS_DIR = path.join(FIXTURES_DIR, 'models');

describe('buildSourceRegistry', () => {
  it('builds a registry from source YAML files', () => {
    const result = buildSourceRegistry(SOURCES_DIR);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.registry.size).toBe(4);
      expect(result.registry.get('ecom.raw_orders')).toBe('RAW.RAW_ORDERS');
      expect(result.registry.get('ecom.raw_customers')).toBe('RAW.RAW_CUSTOMERS');
      expect(result.registry.get('ecom.raw_order_items')).toBe('RAW.RAW_ORDER_ITEMS');
      expect(result.registry.get('ecom.raw_products')).toBe('RAW.RAW_PRODUCTS');
    }
  });

  it('returns empty registry for non-existent directory', () => {
    const result = buildSourceRegistry('/does-not-exist');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registry.size).toBe(0);
    }
  });

  it('rejects case-only source collisions from files', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-case-'));
    const sourceYaml = (connection: string, name: string) => `spec_version: '0.2'
name: ${name}
type: source
source_type: api_resource
integration: crm
resource: users
connection: ${connection}
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`;
    fs.writeFileSync(path.join(dir, 'first.yml'), sourceYaml('CRM', 'Users'));
    fs.writeFileSync(path.join(dir, 'second.yml'), sourceYaml('crm', 'users'));
    try {
      const result = buildSourceRegistry(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/Duplicate source ref.*case-insensitive/i);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('resolveRef', () => {
  const registry: SourceRegistry = new Map([
    ['ecom.raw_orders', 'RAW.RAW_ORDERS'],
    ['ecom.raw_products', 'RAW.RAW_PRODUCTS'],
  ]);

  it('resolves a valid ref', () => {
    const result = resolveRef('ecom.raw_orders', registry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fqTableName).toBe('RAW.RAW_ORDERS');
    }
  });

  it('resolves qualified source refs without regard to case', () => {
    const result = resolveRef('ECOM.Raw_Orders', registry);
    expect(result).toEqual({ ok: true, fqTableName: 'RAW.RAW_ORDERS' });
  });

  it('returns error for unknown dotted ref', () => {
    const result = resolveRef('ecom.unknown_table', registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown source ref');
      expect(result.error).toContain('ecom.unknown_table');
    }
  });

  it('resolves bare ref via model registry', () => {
    const modelReg: ModelRegistry = buildModelRegistry(
      ['stg_orders', 'stg_customers'],
      'DOGSLED_WORKSPACE'
    );
    const result = resolveRef('stg_orders', registry, modelReg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fqTableName).toBe('DOGSLED_WORKSPACE.STG_ORDERS');
    }
  });

  it('resolves dotted ref via source registry even with model registry', () => {
    const modelReg: ModelRegistry = new Map();
    const result = resolveRef('ecom.raw_orders', registry, modelReg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fqTableName).toBe('RAW.RAW_ORDERS');
    }
  });

  it('returns error for unknown bare ref', () => {
    const modelReg: ModelRegistry = new Map();
    const result = resolveRef('nonexistent_model', registry, modelReg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown ref');
      expect(result.error).toContain('nonexistent_model');
    }
  });
});

describe('case-insensitive source identity', () => {
  it('preserves authored registry keys while lookup ignores case', () => {
    const source = SourceSpecSchema.parse({
      spec_version: '0.2',
      name: 'Users',
      type: 'source',
      source_type: 'api_resource',
      integration: 'crm',
      resource: 'users',
      connection: 'CRM',
      mode: 'live',
      schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
    });
    const result = buildInMemorySourceEntryRegistry([source]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect([...result.registry.keys()]).toEqual(['CRM.Users']);
    expect(result.registry.get('CRM.Users')).toBe('sources.Users');
    expect(resolveRef('crm.users', result.registry)).toEqual({
      ok: true,
      fqTableName: 'sources.Users',
    });
    expect(getSourceEntry(result.entryRegistry, 'cRm.UsErS')?.sourceRef).toBe('CRM.Users');
  });

  it('lets different Connections reuse a source name with distinct runtime tables', () => {
    const source = (connection: string) =>
      SourceSpecSchema.parse({
        spec_version: '0.2',
        name: 'users',
        type: 'source',
        source_type: 'api_resource',
        integration: `${connection}_integration`,
        resource: 'users',
        connection,
        mode: 'live',
        schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
      });
    const result = buildInMemorySourceEntryRegistry([source('product_api'), source('support_api')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const product = result.entryRegistry.get('product_api.users');
    const support = result.entryRegistry.get('support_api.users');
    expect(product?.sourceRef).toBe('product_api.users');
    expect(support?.sourceRef).toBe('support_api.users');
    expect(product?.fqRef).not.toBe(support?.fqRef);
  });
});

describe('buildModelRegistry with overrides', () => {
  it('uses per-model target_schema override', () => {
    const overrides = new Map([['staging_model', { targetSchema: 'CUSTOM_SCHEMA' }]]);
    const reg = buildModelRegistry(
      ['staging_model', 'normal_model'],
      'DEFAULT_SCHEMA',
      'snowflake',
      overrides
    );
    expect(reg.get('staging_model')).toBe('CUSTOM_SCHEMA.STAGING_MODEL');
    expect(reg.get('normal_model')).toBe('DEFAULT_SCHEMA.NORMAL_MODEL');
  });

  it('uses per-model target_database for 3-part name', () => {
    const overrides = new Map([
      ['cross_db_model', { targetSchema: 'ANALYTICS', targetDatabase: 'PROD_DB' }],
    ]);
    const reg = buildModelRegistry(['cross_db_model'], 'DEFAULT_SCHEMA', 'snowflake', overrides);
    // 3-part name uses quoteIdentifier
    expect(reg.get('cross_db_model')).toBe('"PROD_DB"."ANALYTICS"."CROSS_DB_MODEL"');
  });
});

describe('parseTransformSpec', () => {
  let registry: SourceRegistry;

  // Build registry once from fixtures
  const registryResult = buildSourceRegistry(SOURCES_DIR);
  if (registryResult.ok) {
    registry = registryResult.registry;
  } else {
    throw new Error('Failed to build source registry for tests');
  }

  it('parses stg_orders transform spec', () => {
    const result = parseTransformSpec(path.join(MODELS_DIR, 'stg_orders.yml'), registry);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.spec.name).toBe('stg_orders');
      expect(result.spec.source.fqTableName).toBe('RAW.RAW_ORDERS');
      expect(result.spec.source.alias).toBe('t0');
      expect(result.spec.joins).toHaveLength(0);
      expect(result.spec.columns).toHaveLength(3);
    }
  });

  it('parses order_items transform spec with joins', () => {
    const result = parseTransformSpec(path.join(MODELS_DIR, 'order_items.yml'), registry);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.spec.name).toBe('order_items');
      expect(result.spec.source.fqTableName).toBe('RAW.RAW_ORDER_ITEMS');
      expect(result.spec.source.alias).toBe('t0');
      expect(result.spec.joins).toHaveLength(1);
      expect(result.spec.joins[0]!.fqTableName).toBe('RAW.RAW_PRODUCTS');
      expect(result.spec.joins[0]!.alias).toBe('t1');
      expect(result.spec.joins[0]!.type).toBe('left');
      // Verify ref-to-alias replacement in ON clause
      expect(result.spec.joins[0]!.on).toBe('t0.PRODUCT_ID = t1.ID');
      expect(result.spec.columns).toHaveLength(5);
    }
  });

  it('returns error for unknown source ref', () => {
    const emptyRegistry: SourceRegistry = new Map();
    const result = parseTransformSpec(path.join(MODELS_DIR, 'stg_orders.yml'), emptyRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown source ref');
    }
  });

  it('carries metadata fields through to resolved spec', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const yaml = await import('yaml');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const specFile = path.join(tmpDir, 'test_model.yml');

    const spec = {
      spec_version: '0.2',
      name: 'test_model',
      type: 'model',
      description: 'A test model',
      grain: ['order_id', 'line_id'],
      tags: ['core'],
      owner: 'data-team',
      source: { ref: 'ecom.raw_orders', filter: "STATUS = 'active'" },
      columns: [
        {
          name: 'ORDER_ID',
          expr: 'ID',
          description: 'Primary key',
          primary_key: true,
          semantic_role: 'entity_id',
        },
      ],
      materialization: { type: 'view' },
    };

    fs.writeFileSync(specFile, yaml.stringify(spec), 'utf-8');

    const result = parseTransformSpec(specFile, registry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.description).toBe('A test model');
      expect(result.spec.grain).toEqual(['order_id', 'line_id']);
      expect(result.spec.tags).toEqual(['core']);
      expect(result.spec.owner).toBe('data-team');
      expect(result.spec.sourceRef).toBe('ecom.raw_orders');
      expect(result.spec.source.filter).toBe("STATUS = 'active'");
      expect(result.spec.columns[0]!.description).toBe('Primary key');
      expect(result.spec.columns[0]!.primary_key).toBe(true);
      expect(result.spec.columns[0]!.semantic_role).toBe('entity_id');
    }

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('carries sourceRef and join refs through', () => {
    const result = parseTransformSpec(path.join(MODELS_DIR, 'order_items.yml'), registry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.sourceRef).toBe('ecom.raw_order_items');
      expect(result.spec.joins[0]!.ref).toBe('ecom.raw_products');
    }
  });
});

describe('materialization on_schema_change parsing', () => {
  const registry: SourceRegistry = new Map([['ecom.raw_orders', 'RAW.RAW_ORDERS']]);

  const baseSpec = {
    spec_version: '0.2',
    name: 'test_model',
    type: 'model',
    description: 'A test model',
    grain: 'id',
    source: { ref: 'ecom.raw_orders' },
    columns: [{ name: 'id', expr: 'ID' }],
  } satisfies Partial<TransformSpec>;

  it('defaults incremental on_schema_change to fail', () => {
    const parsed = parseTransformSpecFromParsed(
      TransformSpecSchema.parse({
        ...baseSpec,
        materialization: { type: 'incremental', strategy: 'merge', unique_key: 'id' },
      }),
      registry
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.spec.materializationConfig?.on_schema_change).toBe('fail');
    }
  });

  it('carries incremental on_schema_change full_refresh', () => {
    const parsed = parseTransformSpecFromParsed(
      TransformSpecSchema.parse({
        ...baseSpec,
        materialization: {
          type: 'incremental',
          strategy: 'merge',
          unique_key: 'id',
          on_schema_change: 'full_refresh',
        },
      }),
      registry
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.spec.materializationConfig?.on_schema_change).toBe('full_refresh');
    }
  });

  it('rejects snapshot on_schema_change values other than fail', () => {
    const parsed = TransformSpecSchema.safeParse({
      ...baseSpec,
      materialization: {
        type: 'snapshot',
        unique_key: 'id',
        on_schema_change: 'full_refresh',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('carries dynamic table options', () => {
    const parsed = parseTransformSpecFromParsed(
      TransformSpecSchema.parse({
        ...baseSpec,
        materialization: {
          type: 'dynamic_table',
          target_lag: '1 hour',
          warehouse: 'TRANSFORM_WH',
        },
      }),
      registry
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.spec.materializationConfig).toEqual({
        target_lag: '1 hour',
        warehouse: 'TRANSFORM_WH',
      });
    }
  });

  it('validates BigQuery max_staleness range', () => {
    const invalid = TransformSpecSchema.safeParse({
      ...baseSpec,
      materialization: {
        type: 'materialized_view',
        max_staleness: '10 minute',
      },
    });

    expect(invalid.success).toBe(false);
  });
});

describe('bucketColumnType', () => {
  it('buckets source and select column types into schema-change categories', () => {
    expect(bucketColumnType('VARCHAR(255)')).toBe('string');
    expect(bucketColumnType('BIGINT')).toBe('integer');
    expect(bucketColumnType('DECIMAL(18, 2)')).toBe('number');
    expect(bucketColumnType('BOOLEAN')).toBe('boolean');
    expect(bucketColumnType('TIMESTAMP_NTZ')).toBe('timestamp');
    expect(bucketColumnType('ARRAY<STRING>')).toBe('array');
    expect(bucketColumnType('INTEGER[]')).toBe('array');
    expect(bucketColumnType('varchar[]')).toBe('array');
    expect(bucketColumnType('STRUCT<id INT64>')).toBe('object');
  });
});

describe('replaceRefQualifiers edge cases', () => {
  // Test via parseTransformSpecFromParsed which calls replaceRefQualifiers internally.
  // We build specs with carefully-chosen ref names to verify word-boundary matching.

  const sourceRegistry: SourceRegistry = new Map([
    ['ecom.raw_orders', 'RAW.RAW_ORDERS'],
    ['ecom.raw_orders_v2', 'RAW.RAW_ORDERS_V2'],
  ]);

  it('does NOT partially match model_b when model_b_match exists in expression', () => {
    const modelReg: ModelRegistry = new Map([
      ['model_b', 'SCHEMA.MODEL_B'],
      ['model_b_match', 'SCHEMA.MODEL_B_MATCH'],
    ]);

    const spec: TransformSpec = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'model_b' },
      joins: [{ ref: 'model_b_match', type: 'left', on: 'model_b.id = model_b_match.id' }],
      columns: [
        { name: 'col_a', expr: 'model_b.col' },
        { name: 'col_b', expr: 'model_b_match.col' },
      ],
      materialization: { type: 'view' },
    };

    const result = parseTransformSpecFromParsed(spec, sourceRegistry, modelReg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // model_b → t0, model_b_match → t1
    expect(result.spec.columns[0]!.expr).toBe('t0.col');
    expect(result.spec.columns[1]!.expr).toBe('t1.col');
    expect(result.spec.joins[0]!.on).toBe('t0.id = t1.id');
  });

  it('does NOT partially match stg_orders when stg_orders_v2 exists in expression', () => {
    const modelReg: ModelRegistry = new Map([
      ['stg_orders', 'SCHEMA.STG_ORDERS'],
      ['stg_orders_v2', 'SCHEMA.STG_ORDERS_V2'],
    ]);

    const spec: TransformSpec = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'stg_orders' },
      joins: [{ ref: 'stg_orders_v2', type: 'left', on: 'stg_orders.id = stg_orders_v2.id' }],
      columns: [{ name: 'id', expr: 'stg_orders_v2.id' }],
      materialization: { type: 'view' },
    };

    const result = parseTransformSpecFromParsed(spec, sourceRegistry, modelReg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // stg_orders_v2 should be t1, NOT partially matched by stg_orders
    expect(result.spec.columns[0]!.expr).toBe('t1.id');
    expect(result.spec.joins[0]!.on).toBe('t0.id = t1.id');
  });

  it('does NOT partially match dotted source ref when suffixed version exists', () => {
    const spec: TransformSpec = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      joins: [
        {
          ref: 'ecom.raw_orders_v2',
          type: 'left',
          on: 'ecom.raw_orders.id = ecom.raw_orders_v2.id',
        },
      ],
      columns: [{ name: 'id', expr: 'ecom.raw_orders_v2.id' }],
      materialization: { type: 'view' },
    };

    const result = parseTransformSpecFromParsed(spec, sourceRegistry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ecom.raw_orders_v2 → t1, should NOT be affected by ecom.raw_orders → t0
    expect(result.spec.columns[0]!.expr).toBe('t1.id');
    expect(result.spec.joins[0]!.on).toBe('t0.id = t1.id');
  });

  it('preserves normal ref replacement behavior', () => {
    const spec: TransformSpec = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      joins: [],
      columns: [
        { name: 'order_id', expr: 'ecom.raw_orders.ORDER_ID' },
        { name: 'total', expr: 'ecom.raw_orders.TOTAL' },
      ],
      materialization: { type: 'view' },
    };

    const result = parseTransformSpecFromParsed(spec, sourceRegistry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.spec.columns[0]!.expr).toBe('t0.ORDER_ID');
    expect(result.spec.columns[1]!.expr).toBe('t0.TOTAL');
  });
});
