import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { buildDag, inferDagIntegrations } from '@bobsled-inc/model-spec';

import {
  discoverModels,
  expandAuthoredModelPipelines,
} from '../../../../src/runner/config/loader.js';

describe('agentic model discovery', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-discovery-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write(name: string, fields: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, `${name}.yml`), stringify({ type: 'model', name, ...fields }));
  }

  it('preserves the derived → agentic → derived edges in host manifests', () => {
    write('prepared_pairs', { source: { ref: 'warehouse.raw_pairs' } });
    write('advice', {
      model_kind: 'agentic',
      sources: {
        pairs: { ref: 'prepared_pairs' },
        old_advice: { ref: 'advice' },
        repeated: { ref: 'prepared_pairs' },
        context: { ref: 'warehouse.context' },
      },
      materialization: { type: 'table' },
    });
    write('decisions', { source: { ref: 'advice' }, materialization: { type: 'table' } });

    const discovered = discoverModels(dir);
    expect(discovered.get('advice')).toEqual({
      connection: 'warehouse',
      materialization: 'table',
      refs: ['prepared_pairs'],
    });
    expect(discovered.get('decisions')?.connection).toBe('warehouse');
    const [pipeline] = expandAuthoredModelPipelines(
      [
        {
          name: 'review',
          schedule: 'hourly',
          cron: '0 * * * *',
          trigger: 'schedule',
          connection: 'warehouse',
          models: '*',
          enabled: true,
        },
      ],
      discovered
    );
    expect(pipeline?.modelNodes).toEqual(
      expect.arrayContaining([
        { name: 'prepared_pairs', refs: [] },
        { name: 'advice', refs: ['prepared_pairs'] },
        { name: 'decisions', refs: ['advice'] },
      ])
    );
  });

  it('does not infer ownership from only the first of conflicting sources', () => {
    write('advice', {
      model_kind: 'agentic',
      sources: { pairs: { ref: 'one.pairs' }, context: { ref: 'two.context' } },
    });
    expect(discoverModels(dir).get('advice')?.connection).toBeUndefined();
  });

  it('keeps tool-only model dependencies without using them to select compute', () => {
    write('prepared', { source: { ref: 'warehouse.rows' } });
    write('context', { source: { ref: 'reference.rows' } });
    write('advice', {
      model_kind: 'agentic',
      sources: { rows: { ref: 'prepared' }, context: { ref: 'context' } },
      plan: { steps: [{ source: { ref: 'rows' } }] },
    });
    expect(discoverModels(dir).get('advice')).toMatchObject({
      connection: 'warehouse',
      refs: ['prepared', 'context'],
    });
  });

  it('checks prepared inputs on every step when inferring compute', () => {
    write('advice', {
      model_kind: 'agentic',
      sources: { first: { ref: 'one.rows' }, later: { ref: 'two.rows' } },
      plan: { steps: [{ source: { ref: 'first' } }, { source: { ref: 'later' } }] },
    });
    expect(discoverModels(dir).get('advice')?.connection).toBeUndefined();
  });

  it('honors the declared engine for agentic ownership and preserves all dependency edges', () => {
    write('prepared', { source: { ref: 'one.pairs' } });
    write('advice', {
      model_kind: 'agentic',
      sources: { pairs: { ref: 'prepared' }, context: { ref: 'two.context' } },
      execution: { engine: 'warehouse' },
      publish: 'destination',
    });
    expect(discoverModels(dir).get('advice')).toMatchObject({
      connection: 'warehouse',
      refs: ['prepared'],
    });
  });

  it('keeps cyclic and missing inputs unresolved without recursion failure', () => {
    write('a', { model_kind: 'agentic', sources: { b: { ref: 'b' } } });
    write('b', { source: { ref: 'a' } });
    write('missing', {
      model_kind: 'agentic',
      sources: { absent: { ref: 'absent' }, known: { ref: 'wh.rows' } },
    });
    const discovered = discoverModels(dir);
    expect(discovered.get('a')?.connection).toBeUndefined();
    expect(discovered.get('b')?.connection).toBeUndefined();
    expect(discovered.get('missing')?.connection).toBeUndefined();
  });

  it('agrees with the canonical model DAG on valid mixed-model dependencies and ownership', () => {
    const base = { spec_version: '0.2', description: 'Synthetic pair review.', grain: ['pair_id'] };
    write('prepared', {
      ...base,
      source: { ref: 'warehouse.pairs' },
      columns: [{ name: 'pair_id', expr: 'pair_id' }],
      materialization: { type: 'table' },
    });
    write('advice', {
      ...base,
      model_kind: 'agentic',
      sources: {
        pairs: { ref: 'prepared' },
        old: { ref: 'advice' },
        documents: { ref: 'notion.documents' },
      },
      llm: { profile: 'review' },
      limits: { tokens: 1000, timeout_seconds: 60 },
      plan: {
        steps: [
          {
            id: 'assess',
            source: { ref: 'pairs' },
            map: { over: 'pairs', group_by: ['pair_id'] },
            execution: { mode: 'agent_loop' },
            instructions: 'Assess the supplied pair.',
            columns: [{ name: 'pair_id', type: 'string', nullable: false }],
          },
        ],
      },
      output: { from: 'assess' },
      materialization: { type: 'table', strategy: 'replace_processed_keys', keys: ['pair_id'] },
    });
    write('decisions', {
      ...base,
      source: { ref: 'advice' },
      columns: [{ name: 'pair_id', expr: 'pair_id' }],
      materialization: { type: 'table' },
    });
    const dag = buildDag(fs.readdirSync(dir).map((name) => path.join(dir, name)));
    expect(dag.ok).toBe(true);
    if (!dag.ok) throw new Error(dag.error);
    inferDagIntegrations(dag.order);
    expect(dag.order.map((node) => node.name)).toEqual(['prepared', 'advice', 'decisions']);
    const discovered = discoverModels(dir);
    for (const node of dag.order) {
      expect(discovered.get(node.name)).toMatchObject({
        refs: node.refs,
        connection: node.integration,
        materialization: node.materialization,
      });
    }
  });
});
