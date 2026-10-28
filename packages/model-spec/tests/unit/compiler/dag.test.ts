import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import {
  buildDag,
  computeEffectiveTiers,
  subgraph,
  withEphemeralAncestors,
} from '../../../src/compiler/dag.js';
import { resolveSelection, type SelectableNode } from '../../../src/selection.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/specs');

/** Helper: create a temp model YAML file */
function createModelFile(dir: string, spec: Record<string, unknown>): string {
  const name = spec.name as string;
  const filePath = path.join(dir, `${name}.yml`);
  fs.writeFileSync(filePath, stringify(spec), 'utf-8');
  return filePath;
}

/** Helper: create a minimal model spec */
function modelSpec(
  name: string,
  sourceRef: string,
  joins: Array<{ ref: string; alias: string; type: string; on: string }> = []
): Record<string, unknown> {
  return {
    spec_version: '0.2',
    name,
    type: 'model',
    description: `Model ${name}.`,
    grain: 'id',
    source: { ref: sourceRef, alias: 'a' },
    joins,
    columns: [{ name: 'ID', expr: 'ID' }],
    materialization: { type: 'view' },
  };
}

describe('buildDag', () => {
  it('compiles source-only models in alphabetical order', () => {
    const modelDir = path.join(FIXTURES_DIR, 'models');
    // Only use source-ref models (stg_orders, stg_customers, order_items)
    const files = [
      path.join(modelDir, 'stg_orders.yml'),
      path.join(modelDir, 'stg_customers.yml'),
      path.join(modelDir, 'order_items.yml'),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All have zero model deps → alphabetical
    const names = result.order.map((n) => n.name);
    expect(names).toEqual(['order_items', 'stg_customers', 'stg_orders']);
  });

  it('orders linear chain: A → B → C', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const files = [
      createModelFile(tmpDir, modelSpec('model_c', 'ecom.raw_orders')),
      createModelFile(tmpDir, modelSpec('model_b', 'model_c')),
      createModelFile(tmpDir, modelSpec('model_a', 'model_b')),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.order.map((n) => n.name);
    expect(names).toEqual(['model_c', 'model_b', 'model_a']);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('orders diamond: D first, then B+C alphabetical, then A', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const files = [
      createModelFile(tmpDir, modelSpec('model_d', 'ecom.raw_orders')),
      createModelFile(tmpDir, modelSpec('model_b', 'model_d')),
      createModelFile(tmpDir, modelSpec('model_c', 'model_d')),
      createModelFile(
        tmpDir,
        modelSpec('model_a', 'model_b', [
          { ref: 'model_c', alias: 'c', type: 'left', on: 'a.ID = c.ID' },
        ])
      ),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.order.map((n) => n.name);
    expect(names).toEqual(['model_d', 'model_b', 'model_c', 'model_a']);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('detects cycles: A → B → A', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const files = [
      createModelFile(tmpDir, modelSpec('model_a', 'model_b')),
      createModelFile(tmpDir, modelSpec('model_b', 'model_a')),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Circular dependency');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('detects self-reference', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const files = [createModelFile(tmpDir, modelSpec('model_a', 'model_a'))];

    const result = buildDag(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('references itself');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('detects duplicate model names', () => {
    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const tmpDir2 = path.join(tmpDir1, 'subdir');
    fs.mkdirSync(tmpDir2);

    const files = [
      createModelFile(tmpDir1, modelSpec('model_a', 'ecom.raw_orders')),
      createModelFile(tmpDir2, modelSpec('model_a', 'ecom.raw_customers')),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Duplicate model name');
    expect(result.error).toContain('model_a');

    fs.rmSync(tmpDir1, { recursive: true });
  });

  it('reports error for unknown model ref', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const files = [createModelFile(tmpDir, modelSpec('model_a', 'nonexistent_model'))];

    const result = buildDag(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown model');
    expect(result.error).toContain('nonexistent_model');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('handles fixture models with model refs (fct_orders)', () => {
    const modelDir = path.join(FIXTURES_DIR, 'models');
    const files = [
      path.join(modelDir, 'stg_orders.yml'),
      path.join(modelDir, 'stg_customers.yml'),
      path.join(modelDir, 'fct_orders.yml'),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.order.map((n) => n.name);
    // stg_customers and stg_orders have no model deps, come first alphabetically
    // fct_orders depends on both, comes last
    expect(names).toEqual(['stg_customers', 'stg_orders', 'fct_orders']);
  });

  it('populates parsedSpec on each node', () => {
    const modelDir = path.join(FIXTURES_DIR, 'models');
    const files = [path.join(modelDir, 'stg_orders.yml')];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stgOrders = result.order.find((n) => n.name === 'stg_orders');
    expect(stgOrders).toBeDefined();
    expect(stgOrders!.parsedSpec).toBeDefined();
    expect(stgOrders!.parsedSpec.name).toBe('stg_orders');
    expect(stgOrders!.parsedSpec.source.ref).toBe('ecom.raw_orders');
    expect(stgOrders!.parsedSpec.columns.length).toBeGreaterThan(0);
  });

  it('populates materialization field on DagNode', () => {
    const modelDir = path.join(FIXTURES_DIR, 'models');
    const files = [path.join(modelDir, 'stg_orders.yml')];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stgOrders = result.order.find((n) => n.name === 'stg_orders');
    expect(stgOrders).toBeDefined();
    expect(stgOrders!.materialization).toBe('view');
  });

  it('populates materialization for table type', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const spec = {
      ...modelSpec('model_a', 'ecom.raw_orders'),
      materialization: { type: 'table' },
    };
    const files = [createModelFile(tmpDir, spec)];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.order[0]!.materialization).toBe('table');
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('populates sourceRefs for models with dotted refs', () => {
    const modelDir = path.join(FIXTURES_DIR, 'models');
    const files = [path.join(modelDir, 'stg_orders.yml')];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stgOrders = result.order.find((n) => n.name === 'stg_orders');
    expect(stgOrders).toBeDefined();
    expect(stgOrders!.sourceRefs).toContain('ecom.raw_orders');
    expect(stgOrders!.refs).toEqual([]);
  });

  it('populates empty sourceRefs for model-to-model refs', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const files = [
      createModelFile(tmpDir, modelSpec('model_b', 'ecom.raw_orders')),
      createModelFile(tmpDir, modelSpec('model_a', 'model_b')),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const modelA = result.order.find((n) => n.name === 'model_a');
    expect(modelA!.sourceRefs).toEqual([]);
    expect(modelA!.refs).toEqual(['model_b']);

    const modelB = result.order.find((n) => n.name === 'model_b');
    expect(modelB!.sourceRefs).toEqual(['ecom.raw_orders']);
    expect(modelB!.refs).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('subgraph', () => {
  it('returns only requested model and its deps', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const files = [
      createModelFile(tmpDir, modelSpec('model_c', 'ecom.raw_orders')),
      createModelFile(tmpDir, modelSpec('model_b', 'model_c')),
      createModelFile(tmpDir, modelSpec('model_a', 'model_b')),
    ];

    const dagResult = buildDag(files);
    expect(dagResult.ok).toBe(true);
    if (!dagResult.ok) return;

    // Requesting model_a should return all three in order
    const sub = subgraph(dagResult.order, ['model_a']);
    expect(sub.map((n) => n.name)).toEqual(['model_c', 'model_b', 'model_a']);

    // Requesting model_c should return just model_c
    const sub2 = subgraph(dagResult.order, ['model_c']);
    expect(sub2.map((n) => n.name)).toEqual(['model_c']);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('handles case-insensitive requests', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-test-'));
    const files = [createModelFile(tmpDir, modelSpec('model_a', 'ecom.raw_orders'))];

    const dagResult = buildDag(files);
    expect(dagResult.ok).toBe(true);
    if (!dagResult.ok) return;

    const sub = subgraph(dagResult.order, ['MODEL_A']);
    expect(sub.map((n) => n.name)).toEqual(['model_a']);

    fs.rmSync(tmpDir, { recursive: true });
  });

  // Locks the back-compat contract documented on `subgraph`'s JSDoc: the
  // retained upstream-closure helper is exactly the new selector's `+X`. A bare
  // selection is now EXACTLY the model (the dbt-parity breaking change).
  it('stays equivalent to resolveSelection("+X"); bare selection is exact', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-parity-'));
    const files = [
      createModelFile(tmpDir, modelSpec('model_c', 'ecom.raw_orders')),
      createModelFile(tmpDir, modelSpec('model_b', 'model_c')),
      createModelFile(tmpDir, modelSpec('model_a', 'model_b')),
    ];
    const dagResult = buildDag(files);
    expect(dagResult.ok).toBe(true);
    if (!dagResult.ok) return;

    const selectable: SelectableNode[] = dagResult.order.map((node) => ({
      name: node.name,
      refs: node.refs,
      tags: node.parsedSpec.tags,
    }));

    // `subgraph(['model_a'])` (upstream closure) === `resolveSelection(['+model_a'])`.
    expect(resolveSelection(selectable, ['+model_a'])).toEqual(
      subgraph(dagResult.order, ['model_a']).map((n) => n.name)
    );
    // Bare selection is now exact — NOT the closure subgraph would return.
    expect(resolveSelection(selectable, ['model_a'])).toEqual(['model_a']);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('computeEffectiveTiers', () => {
  it('computes effective tiers based on upstream dependencies', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-tier-'));
    const files = [
      createModelFile(tmpDir, { ...modelSpec('model_b', 'ecom.raw_orders'), trust_tier: 'gold' }),
      createModelFile(tmpDir, { ...modelSpec('model_a', 'model_b'), trust_tier: 'gold' }),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tiers = computeEffectiveTiers(result.order);
    expect(tiers.get('model_b')).toBe('gold');
    expect(tiers.get('model_a')).toBe('gold');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('demotes effective tier when upstream is lower', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-tier-'));
    const files = [
      createModelFile(tmpDir, { ...modelSpec('model_b', 'ecom.raw_orders'), trust_tier: 'bronze' }),
      createModelFile(tmpDir, { ...modelSpec('model_a', 'model_b'), trust_tier: 'gold' }),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tiers = computeEffectiveTiers(result.order);
    expect(tiers.get('model_b')).toBe('bronze');
    expect(tiers.get('model_a')).toBe('bronze');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('propagates through multi-level chain (A→B→C)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-tier-'));
    const files = [
      createModelFile(tmpDir, { ...modelSpec('model_c', 'ecom.raw_orders'), trust_tier: 'bronze' }),
      createModelFile(tmpDir, { ...modelSpec('model_b', 'model_c'), trust_tier: 'silver' }),
      createModelFile(tmpDir, { ...modelSpec('model_a', 'model_b'), trust_tier: 'gold' }),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tiers = computeEffectiveTiers(result.order);
    expect(tiers.get('model_c')).toBe('bronze');
    expect(tiers.get('model_b')).toBe('bronze');
    expect(tiers.get('model_a')).toBe('bronze');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('diamond: takes min of both branches', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-tier-'));
    // Diamond: D depends on both B(silver) and C(bronze) via source
    const files = [
      createModelFile(tmpDir, { ...modelSpec('model_b', 'ecom.raw_orders'), trust_tier: 'silver' }),
      createModelFile(tmpDir, { ...modelSpec('model_c', 'ecom.raw_orders'), trust_tier: 'bronze' }),
      createModelFile(tmpDir, {
        ...modelSpec('model_d', 'model_b', [
          { ref: 'model_c', alias: 'c', type: 'left', on: 'a.ID = c.ID' },
        ]),
        trust_tier: 'gold',
      }),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tiers = computeEffectiveTiers(result.order);
    expect(tiers.get('model_d')).toBe('bronze');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('considers source tiers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-tier-'));
    const files = [
      createModelFile(tmpDir, { ...modelSpec('model_a', 'ecom.raw_orders'), trust_tier: 'gold' }),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sourceTiers = new Map([['ecom.raw_orders', 'silver' as const]]);
    const tiers = computeEffectiveTiers(result.order, sourceTiers);
    expect(tiers.get('model_a')).toBe('silver');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Union ref collection
// ---------------------------------------------------------------------------

describe('buildDag — union refs', () => {
  it('includes union branch refs in DAG dependencies', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-union-'));
    const files = [
      createModelFile(tmpDir, modelSpec('model_a', 'ecom.raw_orders')),
      createModelFile(tmpDir, {
        ...modelSpec('model_b', 'ecom.raw_orders'),
        union: [{ ref: 'model_a' }],
      }),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // model_b should come after model_a
    const names = result.order.map((n) => n.name);
    expect(names.indexOf('model_a')).toBeLessThan(names.indexOf('model_b'));

    // model_b should have model_a in its refs
    const bNode = result.order.find((n) => n.name === 'model_b');
    expect(bNode?.refs).toContain('model_a');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe('buildDag — cycle detection', () => {
  it('detects 3-node cycle A→B→C→A', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-cycle-'));
    const files = [
      createModelFile(tmpDir, modelSpec('model_a', 'model_c')),
      createModelFile(tmpDir, modelSpec('model_b', 'model_a')),
      createModelFile(tmpDir, modelSpec('model_c', 'model_b')),
    ];

    const result = buildDag(files);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Circular dependency');
    }

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('withEphemeralAncestors', () => {
  /** A model spec with an explicit materialization type. */
  function specWithMat(name: string, sourceRef: string, mat: string): Record<string, unknown> {
    return {
      spec_version: '0.2',
      name,
      type: 'model',
      description: `Model ${name}.`,
      grain: 'id',
      source: { ref: sourceRef, alias: 'a' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: mat },
    };
  }

  it('pulls ephemeral ancestors into the execution set but leaves non-ephemeral ones out', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-eph-'));
    // grandparent (table) -> parent (ephemeral) -> child (table)
    const files = [
      createModelFile(tmpDir, specWithMat('grandparent', 'ecom.raw_orders', 'table')),
      createModelFile(tmpDir, specWithMat('parent', 'grandparent', 'ephemeral')),
      createModelFile(tmpDir, specWithMat('child', 'parent', 'table')),
    ];
    const dagResult = buildDag(files);
    expect(dagResult.ok).toBe(true);
    if (!dagResult.ok) return;

    // Exact-selecting `child` must also pull in `parent` (ephemeral → must be
    // inlined as a CTE) but NOT `grandparent` (non-ephemeral → resolves to its
    // physical table via the registry). Returned in topological order.
    const exec = withEphemeralAncestors(dagResult.order, new Set(['child']));
    expect(exec.map((n) => n.name)).toEqual(['parent', 'child']);

    // Case-insensitive selection input.
    const execCi = withEphemeralAncestors(dagResult.order, new Set(['CHILD']));
    expect(execCi.map((n) => n.name)).toEqual(['parent', 'child']);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns just the selected model when it has no ephemeral ancestors', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-eph-'));
    const files = [
      createModelFile(tmpDir, specWithMat('stg', 'ecom.raw_orders', 'view')),
      createModelFile(tmpDir, specWithMat('fct', 'stg', 'table')),
    ];
    const dagResult = buildDag(files);
    expect(dagResult.ok).toBe(true);
    if (!dagResult.ok) return;

    expect(withEphemeralAncestors(dagResult.order, new Set(['fct'])).map((n) => n.name)).toEqual([
      'fct',
    ]);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('buildDag validation messages', () => {
  it('names the missing SQL model fields instead of a bare union failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-messages-'));
    try {
      const filePath = createModelFile(dir, {
        spec_version: '0.2',
        type: 'model',
        name: 'customer_revenue',
        source: { ref: 'warehouse.orders' },
        columns: [{ name: 'customer', expr: 'customer' }],
        materialization: { type: 'table' },
      });
      const result = buildDag([filePath]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('grain:');
      expect(result.error).toContain('description:');
      expect(result.error).not.toMatch(/Validation failed: : /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports agentic model fields when model_kind is agentic', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-messages-'));
    try {
      const filePath = createModelFile(dir, {
        spec_version: '0.2',
        type: 'model',
        model_kind: 'agentic',
        name: 'assessments',
        description: 'Assessments',
        grain: ['id'],
      });
      const result = buildDag([filePath]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('sources:');
      expect(result.error).not.toContain('columns:');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
