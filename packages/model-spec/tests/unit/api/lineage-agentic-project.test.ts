import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, expect, it } from 'vitest';
import { lineageProject } from '../../../src/api/index.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentic-lineage-'));
  roots.push(root);
  for (const dir of ['integrations', 'sources', 'models']) mkdirSync(join(root, dir));
  writeFileSync(
    join(root, 'integrations/lake.yml'),
    stringify({
      spec_version: '1',
      type: 'integration',
      name: 'lake',
      source_type: 'duckdb',
      connection: { schema: 'main' },
      auth: { type: 'file', path: '/tmp/lineage-unused.duckdb' },
    })
  );
  writeFileSync(
    join(root, 'sources/pairs.yml'),
    stringify({
      spec_version: '0.2',
      name: 'pairs',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'lake',
      table: 'raw.pairs',
      schema: { columns: [{ name: 'pair_id', type: 'STRING' }] },
    })
  );
  writeFileSync(
    join(root, 'models/undecided_pairs.yml'),
    stringify({
      spec_version: '0.2',
      type: 'model',
      name: 'undecided_pairs',
      description: 'Prepared pairs',
      grain: 'pair_id',
      materialization: { type: 'table' },
      source: { ref: 'lake.pairs' },
      columns: [{ name: 'pair_id', expr: 'pair_id' }],
    })
  );
  const agentic = parse(
    readFileSync(new URL('../../fixtures/agentic/prepared-pairs.yml', import.meta.url), 'utf8')
  );
  agentic.sources.previous = { ref: agentic.name };
  writeFileSync(join(root, 'models/agentic.yml'), stringify(agentic));
  writeFileSync(
    join(root, 'models/advice.yml'),
    stringify({
      spec_version: '0.2',
      type: 'model',
      name: 'advice',
      description: 'Published advice',
      grain: 'pair_id',
      materialization: { type: 'table' },
      source: { ref: 'pair_assessments' },
      include_all_columns: true,
      columns: [],
    })
  );
  return root;
}

it('preserves the mixed DAG and exposes agentic columns as an opaque provenance boundary', async () => {
  const result = await lineageProject(fixture());
  const group = result.byIntegration[0]!;
  expect(group.models.map((node) => ({ name: node.name, refs: node.refs }))).toEqual([
    { name: 'undecided_pairs', refs: [] },
    { name: 'pair_assessments', refs: ['undecided_pairs'] },
    { name: 'advice', refs: ['pair_assessments'] },
  ]);
  const names = [
    'pair_id',
    'assessment',
    '_dogsled_run_id',
    '_dogsled_evidence',
    '_dogsled_confidence',
    '_dogsled_reason',
  ];
  expect(group.columnLineage.filter((entry) => entry.model === 'pair_assessments')).toEqual(
    names.map((column) => ({ model: 'pair_assessments', column, upstream: [], isComplete: false }))
  );
  // The downstream SQL edge is known; the agentic node's internal origins remain opaque.
  expect(group.columnLineage.filter((entry) => entry.model === 'advice')).toEqual(
    names.map((column) => ({
      model: 'advice',
      column,
      upstream: [{ alias: 't0', source: 'pair_assessments', column }],
      isComplete: true,
    }))
  );
});

it('supports exact agentic selection and exact downstream passthrough selection', async () => {
  const root = fixture();
  const agentic = await lineageProject(root, { models: ['pair_assessments'] });
  expect(agentic.byIntegration[0]?.models.map((node) => node.name)).toEqual(['pair_assessments']);
  expect(agentic.byIntegration[0]?.columnLineage).toHaveLength(6);
  const downstream = await lineageProject(root, { models: ['advice'] });
  expect(downstream.byIntegration[0]?.models.map((node) => node.name)).toEqual(['advice']);
  expect(downstream.byIntegration[0]?.columnLineage.map((entry) => entry.column)).toContain(
    '_dogsled_run_id'
  );
  expect(downstream.byIntegration[0]?.columnLineage.some((entry) => entry.column === '*')).toBe(
    false
  );
});
