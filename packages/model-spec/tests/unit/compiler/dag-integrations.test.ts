import { describe, expect, it } from 'vitest';

import { filterDagByIntegration, inferDagIntegrations } from '../../../src/compiler/dag.js';

import type { DagNode } from '../../../src/compiler/dag.js';

function node(overrides: Partial<DagNode> & { name: string }): DagNode {
  return {
    refs: [],
    sourceRefs: [],
    filePath: `${overrides.name}.yml`,
    materialization: 'view',
    parsedSpec: {} as DagNode['parsedSpec'],
    ...overrides,
  };
}

describe('inferDagIntegrations', () => {
  it('stamps direct-source nodes with the source handle', () => {
    const dag: DagNode[] = [node({ name: 'stg_orders', sourceRefs: ['ecom.raw_orders'] })];
    inferDagIntegrations(dag);
    expect(dag[0]?.integration).toBe('ecom');
  });

  it('inherits integration transitively through bare model refs', () => {
    const dag: DagNode[] = [
      node({ name: 'stg_orders', sourceRefs: ['ecom.raw_orders'] }),
      node({ name: 'fct_orders', refs: ['stg_orders'] }),
    ];
    inferDagIntegrations(dag);
    expect(dag[0]?.integration).toBe('ecom');
    expect(dag[1]?.integration).toBe('ecom');
  });

  it('throws when a single model mixes handles across direct sources', () => {
    const dag: DagNode[] = [
      node({
        name: 'bad_model',
        sourceRefs: ['ecom.raw_orders', 'analytics.events'],
      }),
    ];
    expect(() => inferDagIntegrations(dag)).toThrow(/mixes sources from multiple integrations/);
  });

  it('throws when a model mixes handles across direct sources + transitive upstream', () => {
    const dag: DagNode[] = [
      node({ name: 'stg_orders', sourceRefs: ['ecom.raw_orders'] }),
      node({
        name: 'hybrid',
        sourceRefs: ['analytics.events'],
        refs: ['stg_orders'],
      }),
    ];
    inferDagIntegrations([dag[0]!]);
    expect(() => inferDagIntegrations(dag)).toThrow(/mixes sources from multiple integrations/);
  });

  it('leaves integration unset for nodes with no refs at all', () => {
    const dag: DagNode[] = [node({ name: 'isolated' })];
    inferDagIntegrations(dag);
    expect(dag[0]?.integration).toBeUndefined();
  });

  it('stamps publish-only nodes (no source/model refs) with the publish target', () => {
    const dag: DagNode[] = [
      node({
        name: 'publish_only',
        parsedSpec: { publish: 'dest_handle' } as DagNode['parsedSpec'],
      }),
    ];
    inferDagIntegrations(dag);
    expect(dag[0]?.integration).toBe('dest_handle');
  });

  it('stamps publish nodes whose upstream lacks an integration via the publish target', () => {
    const dag: DagNode[] = [
      node({ name: 'orphan' }),
      node({
        name: 'publish_via_orphan',
        refs: ['orphan'],
        parsedSpec: { publish: 'dest_handle' } as DagNode['parsedSpec'],
      }),
    ];
    inferDagIntegrations(dag);
    expect(dag[0]?.integration).toBeUndefined();
    expect(dag[1]?.integration).toBe('dest_handle');
  });

  it('execution.engine exempts a mixed-handle model and stamps the engine integration', () => {
    const dag: DagNode[] = [
      node({
        name: 'mixed_d',
        sourceRefs: ['api.signups', 'snowflake.accounts', 'bigquery.events'],
        parsedSpec: { execution: { engine: 'lake' } } as DagNode['parsedSpec'],
      }),
    ];
    // Without execution.engine this throws (mixed handles); with it the engine
    // is the declared co-location point, so the model is stamped, not rejected.
    expect(() => inferDagIntegrations(dag)).not.toThrow();
    expect(dag[0]?.integration).toBe('lake');
  });

  it('execution.engine takes precedence over publish when both are set', () => {
    const dag: DagNode[] = [
      node({
        name: 'engine_wins',
        sourceRefs: ['api.signups', 'snowflake.accounts'],
        parsedSpec: {
          execution: { engine: 'bigquery' },
          publish: 'mart',
        } as DagNode['parsedSpec'],
      }),
    ];
    inferDagIntegrations(dag);
    expect(dag[0]?.integration).toBe('bigquery');
  });

  it('supports the object form of publish: { target, ... }', () => {
    const dag: DagNode[] = [
      node({
        name: 'publish_object_form',
        parsedSpec: {
          publish: { target: 'dest_handle', target_schema: 'analytics' },
        } as DagNode['parsedSpec'],
      }),
    ];
    inferDagIntegrations(dag);
    expect(dag[0]?.integration).toBe('dest_handle');
  });
});

describe('filterDagByIntegration', () => {
  it('preserves topological order of matching nodes', () => {
    const dag: DagNode[] = [
      node({ name: 'stg_orders', integration: 'ecom' }),
      node({ name: 'events', integration: 'analytics' }),
      node({ name: 'fct_orders', integration: 'ecom' }),
    ];
    expect(filterDagByIntegration(dag, 'ecom').map((n) => n.name)).toEqual([
      'stg_orders',
      'fct_orders',
    ]);
  });

  it('returns an empty array when no node matches', () => {
    const dag: DagNode[] = [node({ name: 'stg_orders', integration: 'ecom' })];
    expect(filterDagByIntegration(dag, 'analytics')).toEqual([]);
  });

  it('treats unstamped nodes as non-matching', () => {
    const dag: DagNode[] = [node({ name: 'isolated' })];
    expect(filterDagByIntegration(dag, 'ecom')).toEqual([]);
  });
});
