import { describe, expect, it } from 'vitest';

import {
  collectModelRelationInputs,
  createDeferredModelGuard,
  planDeferredModels,
  plannedModelOrder,
} from '../../../src/api/dag-preflight.js';

import type { DagNode, SqlStatement } from '../../../src/compiler/index.js';

function node(
  name: string,
  materialization: DagNode['materialization'],
  refs: string[] = [],
  sourceRefs: string[] = []
): DagNode {
  return {
    name,
    filePath: `${name}.yml`,
    refs,
    sourceRefs,
    materialization,
    parsedSpec: {} as DagNode['parsedSpec'],
  };
}

const statement = (modelName: string, sql = `CREATE ${modelName}`): SqlStatement => ({
  modelName,
  sql,
});

describe('DAG preflight scheduling', () => {
  const nodes = [
    node('staged', 'view', [], ['wh.raw']),
    node('inline', 'ephemeral', ['staged']),
    node('rollup', 'table', ['inline', 'external_model']),
    node('report', 'view', ['rollup']),
    node('mirror', 'table', [], ['wh.staged_copy']),
  ];
  const statements = ['staged', 'rollup', 'rollup', 'report', 'mirror'].map((name) =>
    statement(name)
  );

  it('orders planned models by first statement', () => {
    expect(plannedModelOrder(statements)).toEqual(['staged', 'rollup', 'report', 'mirror']);
  });

  it('classifies upstream inputs through inlined ephemeral models', () => {
    const inputs = collectModelRelationInputs({ orderedNodes: nodes }, statements, {
      sourceToInRunModel: (ref) => (ref === 'wh.staged_copy' ? 'staged' : undefined),
    });

    expect(inputs.get('staged')).toEqual({
      inRunModels: [],
      externalModels: [],
      sourceRefs: ['wh.raw'],
    });
    expect(inputs.get('rollup')).toEqual({
      inRunModels: ['staged'],
      externalModels: ['external_model'],
      sourceRefs: [],
    });
    expect(inputs.get('report')?.inRunModels).toEqual(['rollup']);
    // A source over a table this run builds counts as an in-run upstream.
    expect(inputs.get('mirror')).toEqual({
      inRunModels: ['staged'],
      externalModels: [],
      sourceRefs: [],
    });
  });

  it('keeps a source as a source when its producer runs after the reader', () => {
    const late: string[] = [];
    const built: string[] = [];
    const reversed = [statement('mirror'), ...statements.filter((s) => s.modelName !== 'mirror')];
    const inputs = collectModelRelationInputs({ orderedNodes: nodes }, reversed, {
      sourceToInRunModel: (ref) => (ref === 'wh.staged_copy' ? 'staged' : undefined),
      onLateSource: (model, ref, producer) => late.push(`${model}:${ref}:${producer}`),
      onBuiltSource: (reader, ref) => built.push(`${reader}:${ref}`),
    });

    expect(inputs.get('mirror')).toEqual({
      inRunModels: [],
      externalModels: [],
      sourceRefs: ['wh.staged_copy'],
    });
    expect(late).toEqual(['mirror:wh.staged_copy:staged']);
    expect(built).toEqual([]);
  });

  it('defers models whose in-run upstream is missing or itself deferred', () => {
    const inputs = collectModelRelationInputs({ orderedNodes: nodes }, statements);
    const order = plannedModelOrder(statements);

    expect([...planDeferredModels(order, inputs, () => false)]).toEqual([
      ['rollup', ['staged']],
      ['report', ['rollup']],
    ]);
    expect(planDeferredModels(order, inputs, () => true).size).toBe(0);
    // rollup exists but waits on a missing staged view, so report waits too.
    expect([...planDeferredModels(order, inputs, (model) => model !== 'staged').keys()]).toEqual([
      'rollup',
      'report',
    ]);
  });

  it('builds a guard only for deferred models', async () => {
    const checked: string[] = [];
    expect(createDeferredModelGuard(new Map(), async () => undefined)).toBeUndefined();
    const guard = createDeferredModelGuard(new Map([['report', ['rollup']]]), async (model) => {
      checked.push(model);
      return { error: `blocked ${model}` };
    });

    await expect(guard?.('staged')).resolves.toBeUndefined();
    await expect(guard?.('REPORT')).resolves.toEqual({ error: 'blocked report' });
    expect(checked).toEqual(['report']);
  });
});
