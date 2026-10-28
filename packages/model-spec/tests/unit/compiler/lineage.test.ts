import { describe, expect, it } from 'vitest';

import { extractColumnLineage } from '../../../src/compiler/column-lineage.js';
import { renderLineage } from '../../../src/compiler/lineage.js';

import type { DagNode } from '../../../src/compiler/dag.js';
import type { ResolvedTransformSpec } from '../../../src/compiler/parser.js';
import type { TransformSpec } from '../../../src/compiler/schemas.js';

/** Helper to create a minimal parsedSpec for DagNode */
function minimalParsedSpec(name: string, trustTier: string = 'bronze'): TransformSpec {
  return {
    spec_version: '0.2',
    name,
    type: 'model',
    description: `Model ${name}.`,
    grain: 'id',
    trust_tier: trustTier as 'bronze' | 'silver' | 'gold',
    source: { ref: 'db.table' },
    joins: [],
    columns: [{ name: 'ID', expr: 'ID' }],
    materialization: { type: 'view' },
  };
}

describe('renderLineage', () => {
  it('renders source-only models', () => {
    const nodes: DagNode[] = [
      {
        name: 'stg_orders',
        filePath: '/models/stg_orders.yml',
        refs: [],
        sourceRefs: ['ecom.raw_orders'],
        parsedSpec: minimalParsedSpec('stg_orders'),
        materialization: 'view',
      },
    ];

    const result = renderLineage(nodes);
    expect(result).toContain('stg_orders');
    expect(result).toContain('ecom.raw_orders (source)');
  });

  it('renders model-to-model refs', () => {
    const nodes: DagNode[] = [
      {
        name: 'stg_orders',
        filePath: '/models/stg_orders.yml',
        refs: [],
        sourceRefs: ['ecom.raw_orders'],
        parsedSpec: minimalParsedSpec('stg_orders'),
        materialization: 'view',
      },
      {
        name: 'fct_orders',
        filePath: '/models/fct_orders.yml',
        refs: ['stg_orders', 'stg_customers'],
        sourceRefs: [],
        parsedSpec: minimalParsedSpec('fct_orders'),
        materialization: 'view',
      },
    ];

    const result = renderLineage(nodes);
    expect(result).toContain('fct_orders');
    expect(result).toContain('stg_orders (model)');
    expect(result).toContain('stg_customers (model)');
  });

  it('renders mixed source and model refs', () => {
    const nodes: DagNode[] = [
      {
        name: 'enriched_orders',
        filePath: '/models/enriched_orders.yml',
        refs: ['stg_orders'],
        sourceRefs: ['external.lookup_table'],
        parsedSpec: minimalParsedSpec('enriched_orders'),
        materialization: 'view',
      },
    ];

    const result = renderLineage(nodes);
    expect(result).toContain('external.lookup_table (source)');
    expect(result).toContain('stg_orders (model)');
  });

  it('renders empty DAG as empty string', () => {
    expect(renderLineage([])).toBe('');
  });

  it('preserves topological order', () => {
    const nodes: DagNode[] = [
      {
        name: 'a',
        filePath: '/a.yml',
        refs: [],
        sourceRefs: ['db.t'],
        parsedSpec: minimalParsedSpec('a'),
        materialization: 'view',
      },
      {
        name: 'b',
        filePath: '/b.yml',
        refs: ['a'],
        sourceRefs: [],
        parsedSpec: minimalParsedSpec('b'),
        materialization: 'view',
      },
      {
        name: 'c',
        filePath: '/c.yml',
        refs: ['b'],
        sourceRefs: [],
        parsedSpec: minimalParsedSpec('c'),
        materialization: 'view',
      },
    ];

    const result = renderLineage(nodes);
    const lines = result.split('\n').filter((l) => !l.startsWith(' ') && l.length > 0);
    // Lines now include tier info like "a [bronze]"
    const modelNames = lines.map((l) => l.split(' ')[0]);
    expect(modelNames).toEqual(['a', 'b', 'c']);
  });

  it('includes trust tier in output', () => {
    const nodes: DagNode[] = [
      {
        name: 'stg_orders',
        filePath: '/models/stg_orders.yml',
        refs: [],
        sourceRefs: ['ecom.raw_orders'],
        parsedSpec: minimalParsedSpec('stg_orders', 'silver'),
        materialization: 'view',
      },
    ];

    const result = renderLineage(nodes);
    expect(result).toContain('[silver]');
  });

  it('shows effective tier when different from declared', () => {
    const nodes: DagNode[] = [
      {
        name: 'stg_orders',
        filePath: '/models/stg_orders.yml',
        refs: [],
        sourceRefs: ['ecom.raw_orders'],
        parsedSpec: minimalParsedSpec('stg_orders', 'gold'),
        materialization: 'view',
      },
    ];

    const effectiveTiers = new Map([['stg_orders', 'bronze' as const]]);
    const result = renderLineage(nodes, effectiveTiers);
    expect(result).toContain('effective: bronze');
  });

  it('shows just tier when effective matches declared', () => {
    const nodes: DagNode[] = [
      {
        name: 'stg_orders',
        filePath: '/models/stg_orders.yml',
        refs: [],
        sourceRefs: ['ecom.raw_orders'],
        parsedSpec: minimalParsedSpec('stg_orders', 'gold'),
        materialization: 'view',
      },
    ];

    const effectiveTiers = new Map([['stg_orders', 'gold' as const]]);
    const result = renderLineage(nodes, effectiveTiers);
    expect(result).toContain('[gold]');
    expect(result).not.toContain('effective');
  });

  it('renders multi-hop source and model refs', () => {
    const nodes: DagNode[] = [
      {
        name: 'base',
        filePath: '/models/base.yml',
        refs: [],
        sourceRefs: ['ecom.raw_orders'],
        parsedSpec: minimalParsedSpec('base'),
        materialization: 'view',
      },
      {
        name: 'derived',
        filePath: '/models/derived.yml',
        refs: ['base'],
        sourceRefs: ['ecom.raw_items'],
        parsedSpec: minimalParsedSpec('derived'),
        materialization: 'view',
      },
    ];

    const result = renderLineage(nodes);
    expect(result).toContain('ecom.raw_orders');
    expect(result).toContain('ecom.raw_items');
    expect(result).toContain('base');
  });

  it('renders empty DAG with effective tiers', () => {
    const result = renderLineage([]);
    expect(result).toBe('');
  });

  it('renders single model with no refs', () => {
    const nodes: DagNode[] = [
      {
        name: 'standalone',
        filePath: '/models/standalone.yml',
        refs: [],
        sourceRefs: [],
        parsedSpec: minimalParsedSpec('standalone'),
        materialization: 'view',
      },
    ];

    const result = renderLineage(nodes);
    expect(result).toContain('standalone');
  });
});

describe('extractColumnLineage', () => {
  function makeSpec(
    columns: Array<{ name: string; expr: string }>,
    joins?: ResolvedTransformSpec['joins'],
    overrides: Partial<ResolvedTransformSpec> = {}
  ): ResolvedTransformSpec {
    return {
      name: 'test_model',
      description: 'test',
      grain: 'id',
      trustTier: 'bronze',
      materialization: 'view',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      columns: columns.map((c) => ({ ...c })),
      joins: joins ?? [],
      includeAllColumns: false,
      ...overrides,
    };
  }

  it('extracts simple column ref', () => {
    const spec = makeSpec([{ name: 'order_id', expr: 't0.ID' }]);
    const lineage = extractColumnLineage(spec);

    expect(lineage).toHaveLength(1);
    expect(lineage[0].column).toBe('order_id');
    expect(lineage[0].upstream).toHaveLength(1);
    expect(lineage[0].upstream[0]).toEqual({
      alias: 't0',
      source: 'ecom.raw_orders',
      column: 'ID',
    });
    expect(lineage[0].isComplete).toBe(true);
  });

  it('extracts multiple column refs from expression', () => {
    const spec = makeSpec(
      [{ name: 'total', expr: 't0.price + t1.tax' }],
      [
        {
          fqTableName: 'RAW.RAW_TAXES',
          ref: 'ecom.raw_taxes',
          alias: 't1',
          type: 'left',
          on: 't0.id = t1.order_id',
        },
      ]
    );
    const lineage = extractColumnLineage(spec);

    expect(lineage).toHaveLength(1);
    expect(lineage[0].upstream).toHaveLength(4);
    expect(lineage[0].upstream[0]).toEqual({
      alias: 't0',
      source: 'ecom.raw_orders',
      column: 'price',
    });
    expect(lineage[0].upstream[1]).toEqual({
      alias: 't1',
      source: 'ecom.raw_taxes',
      column: 'tax',
    });
    expect(lineage[0].upstream[2]).toEqual({
      alias: 't0',
      source: 'ecom.raw_orders',
      column: 'id',
    });
    expect(lineage[0].upstream[3]).toEqual({
      alias: 't1',
      source: 'ecom.raw_taxes',
      column: 'order_id',
    });
  });

  it('extracts column refs from function call args', () => {
    const spec = makeSpec([{ name: 'total', expr: 'COALESCE(t0.amount, 0)' }]);
    const lineage = extractColumnLineage(spec);

    expect(lineage[0].upstream).toHaveLength(1);
    expect(lineage[0].upstream[0].column).toBe('amount');
    expect(lineage[0].isComplete).toBe(true);
  });

  it('traces CASE expression branches', () => {
    const spec = makeSpec([
      { name: 'status', expr: 'CASE WHEN t0.is_active = TRUE THEN t0.name ELSE t0.fallback END' },
    ]);
    const lineage = extractColumnLineage(spec);

    expect(lineage[0].upstream).toHaveLength(3);
    const cols = lineage[0].upstream.map((u) => u.column);
    expect(cols).toContain('is_active');
    expect(cols).toContain('name');
    expect(cols).toContain('fallback');
  });

  it('marks raw_sql expression as incomplete', () => {
    const spec = makeSpec([{ name: 'custom', expr: 'raw_sql(LATERAL FLATTEN(col))' }]);
    const lineage = extractColumnLineage(spec);

    expect(lineage[0].isComplete).toBe(false);
  });

  it('handles unqualified column refs', () => {
    const spec = makeSpec([{ name: 'id', expr: 'ID' }]);
    const lineage = extractColumnLineage(spec);

    expect(lineage[0].upstream).toHaveLength(1);
    expect(lineage[0].upstream[0]).toEqual({
      alias: undefined,
      source: undefined,
      column: 'ID',
    });
  });

  it('handles literal-only expression with no upstream', () => {
    const spec = makeSpec([{ name: 'constant', expr: '42' }]);
    const lineage = extractColumnLineage(spec);

    expect(lineage[0].upstream).toHaveLength(0);
    expect(lineage[0].isComplete).toBe(true);
  });

  it('expands include_all_columns passthrough columns when source schema is available', () => {
    const spec = makeSpec([{ name: 'status', expr: 'UPPER(t0.status)' }], undefined, {
      includeAllColumns: true,
      excludeColumns: ['internal_note'],
    });
    const lineage = extractColumnLineage(spec, {
      sourceColumns: new Map([
        [
          'ecom.raw_orders',
          {
            columns: ['id', 'status', 'created_at', 'internal_note'],
            hasUnknownPassthrough: false,
          },
        ],
      ]),
    });

    expect(lineage.map((entry) => entry.column)).toEqual(['status', 'id', 'created_at']);
    expect(lineage.find((entry) => entry.column === 'id')).toEqual({
      model: 'test_model',
      column: 'id',
      upstream: [{ alias: 't0', source: 'ecom.raw_orders', column: 'id' }],
      isComplete: true,
    });
  });

  it('expands passthrough when source columns are provided as SourceColumnState', () => {
    const spec = makeSpec([], undefined, { includeAllColumns: true });
    const lineage = extractColumnLineage(spec, {
      sourceColumns: new Map([
        ['ecom.raw_orders', { columns: ['id', 'created_at'], hasUnknownPassthrough: false }],
      ]),
    });

    expect(lineage.map((entry) => entry.column)).toEqual(['id', 'created_at']);
    expect(lineage.every((entry) => entry.isComplete)).toBe(true);
  });

  it('marks include_all_columns incomplete when source schema is unavailable', () => {
    const spec = makeSpec([], undefined, { includeAllColumns: true });
    const lineage = extractColumnLineage(spec);

    expect(lineage).toEqual([
      {
        model: 'test_model',
        column: '*',
        upstream: [{ alias: 't0', source: 'ecom.raw_orders', column: '*' }],
        isComplete: false,
      },
    ]);
  });

  it('falls back to wildcard passthrough when source schema is empty', () => {
    const spec = makeSpec([], undefined, {
      includeAllColumns: true,
      where: 't0.is_deleted = FALSE',
    });
    const lineage = extractColumnLineage(spec, {
      sourceColumns: new Map([['ecom.raw_orders', { columns: [], hasUnknownPassthrough: false }]]),
    });

    expect(lineage).toEqual([
      {
        model: 'test_model',
        column: '*',
        upstream: [
          { alias: 't0', source: 'ecom.raw_orders', column: '*' },
          { alias: 't0', source: 'ecom.raw_orders', column: 'is_deleted' },
        ],
        isComplete: false,
      },
    ]);
  });

  it('keeps wildcard passthrough incomplete when upstream has unknown columns', () => {
    const spec = makeSpec([], undefined, { includeAllColumns: true });
    const lineage = extractColumnLineage(spec, {
      sourceColumns: new Map([
        ['ecom.raw_orders', { columns: ['id', 'created_at'], hasUnknownPassthrough: true }],
      ]),
    });

    expect(lineage).toEqual([
      {
        model: 'test_model',
        column: 'id',
        upstream: [{ alias: 't0', source: 'ecom.raw_orders', column: 'id' }],
        isComplete: false,
      },
      {
        model: 'test_model',
        column: 'created_at',
        upstream: [{ alias: 't0', source: 'ecom.raw_orders', column: 'created_at' }],
        isComplete: false,
      },
      {
        model: 'test_model',
        column: '*',
        upstream: [{ alias: 't0', source: 'ecom.raw_orders', column: '*' }],
        isComplete: false,
      },
    ]);
  });

  it('adds join ON clause refs for output columns that use the joined table', () => {
    const spec = makeSpec(
      [{ name: 'customer_name', expr: 't1.name' }],
      [
        {
          fqTableName: 'RAW.RAW_CUSTOMERS',
          ref: 'ecom.raw_customers',
          alias: 't1',
          type: 'left',
          on: 't0.customer_id = t1.id',
        },
      ]
    );
    const lineage = extractColumnLineage(spec);
    const refs = lineage[0].upstream.map((upstream) => `${upstream.source}.${upstream.column}`);

    expect(refs).toEqual([
      'ecom.raw_customers.name',
      'ecom.raw_orders.customer_id',
      'ecom.raw_customers.id',
    ]);
  });

  it('adds filter refs to every output column', () => {
    const spec = makeSpec([{ name: 'id', expr: 't0.id' }], undefined, {
      where: 't0.is_deleted = FALSE',
      having: 'COUNT(t0.id) > 0',
    });
    const lineage = extractColumnLineage(spec);
    const refs = lineage[0].upstream.map((upstream) => upstream.column);

    expect(refs).toContain('id');
    expect(refs).toContain('is_deleted');
  });

  it('marks opaque filter and join predicates incomplete', () => {
    const filterSpec = makeSpec([{ name: 'id', expr: 't0.id' }], undefined, {
      where: 'raw_sql(EXISTS (SELECT 1 FROM audit WHERE audit.id = t0.id))',
    });
    const joinSpec = makeSpec(
      [{ name: 'customer_name', expr: 't1.name' }],
      [
        {
          fqTableName: 'RAW.RAW_CUSTOMERS',
          ref: 'ecom.raw_customers',
          alias: 't1',
          type: 'left',
          on: 'raw_sql(t0.customer_id = t1.id AND t1.is_active = TRUE)',
        },
      ]
    );

    expect(extractColumnLineage(filterSpec)[0].isComplete).toBe(false);
    expect(extractColumnLineage(joinSpec)[0].isComplete).toBe(false);
  });

  it('marks flatten, pivot, and unpivot lineage incomplete', () => {
    const flattenSpec = makeSpec([{ name: 'id', expr: 't0.id' }], undefined, {
      flattenJson: [{ column: 'payload' }],
    });
    const pivotSpec = makeSpec([{ name: 'id', expr: 't0.id' }], undefined, {
      pivot: { column: 'status', values: ['open'], aggregate: 'COUNT(*)', value_column: 'id' },
    });
    const unpivotSpec = makeSpec([{ name: 'id', expr: 't0.id' }], undefined, {
      unpivot: { columns: ['a', 'b'], field_name: 'metric', value_name: 'value' },
    });

    expect(extractColumnLineage(flattenSpec)[0].isComplete).toBe(false);
    expect(extractColumnLineage(pivotSpec)[0].isComplete).toBe(false);
    expect(extractColumnLineage(unpivotSpec)[0].isComplete).toBe(false);
  });
});
