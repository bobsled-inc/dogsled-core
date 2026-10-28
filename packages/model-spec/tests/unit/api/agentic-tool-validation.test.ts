import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import {
  compileProject,
  loadProject,
  runProject,
  validateProject,
} from '../../../src/api/index.js';
import { selectIntegrationContexts } from '../../../src/api/load-project.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentic-tool-validation-'));
  roots.push(root);
  for (const dir of ['integrations', 'sources', 'models']) mkdirSync(join(root, dir));
  const write = (path: string, value: unknown) => writeFileSync(join(root, path), stringify(value));
  write('integrations/lake.yml', {
    spec_version: '1',
    type: 'integration',
    name: 'lake',
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: '/tmp/unused.duckdb' },
  });
  write('sources/pairs.yml', {
    spec_version: '0.2',
    type: 'source',
    name: 'pairs',
    source_type: 'warehouse_table',
    connection: 'lake',
    table: 'raw.pairs',
    schema: { columns: [{ name: 'pair_id', type: 'STRING' }] },
  });
  write('sources/documents.yml', {
    spec_version: '0.2',
    type: 'source',
    name: 'documents',
    source_type: 'api_resource',
    connection: 'notion',
    integration: 'notion',
    resource: 'documents',
    mode: 'live',
    schema: { columns: [{ name: 'id', type: 'string' }] },
  });
  const model = parse(
    readFileSync(new URL('../../fixtures/agentic/prepared-pairs.yml', import.meta.url), 'utf8')
  );
  model.sources.pairs.ref = 'lake.pairs';
  model.sources.documents = { ref: 'notion.documents' };
  model.plan.steps[0].execution.mode = 'agent_loop';
  model.plan.steps[0].context_sources = ['documents'];
  write('models/agentic.yml', model);
  return { root, model, write };
}

async function loaded(root: string) {
  const project = await loadProject(root, { skipIntegrations: true });
  project.integrations.set('lake', {
    handle: 'lake',
    dialect: 'duckdb',
    targetSchema: 'main',
    integration: {
      spec_version: '1',
      type: 'integration',
      name: 'lake',
      source_type: 'duckdb',
      connection: {},
      auth: { type: 'memory' },
    },
  });
  return project;
}

it.each([undefined, 'lake'])(
  'validates live agentic tools with integration %s',
  async (integration) => {
    const { root } = fixture();
    const project = await loaded(root);
    expect(project.models[0]?.integration).toBe('lake');
    const [context] = selectIntegrationContexts(project, { integration });
    expect(context?.registry.has('notion.documents')).toBe(true);
    expect(context?.entryRegistry.get('notion.documents')?.kind).toBe('api_resource');
    const validation = await validateProject(root, { integration, project });
    expect(validation.byIntegration[0]?.results[0]?.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect((await compileProject(root, { integration, project })).ok).toBe(true);
  }
);

it('still rejects an undeclared agentic tool source', async () => {
  const { root, model, write } = fixture();
  model.sources.documents.ref = 'notion.missing';
  write('models/agentic.yml', model);
  const project = await loaded(root);
  const result = await validateProject(root, { project });
  expect(result.ok).toBe(false);
  expect(result.byIntegration[0]?.results[0]?.errors).toContain(
    'Unknown agentic input "notion.missing"'
  );
});

it('dispatches a warehouse assignment with a scoped live source tool', async () => {
  const { root } = fixture();
  const project = await loaded(root);
  const source = vi.fn(async () => ({ text: 'A specification' }));
  const publish = vi.fn(async () => {});
  const result = await runProject(root, {
    project,
    experimentalAgenticProbe: {
      supportedDialects: ['duckdb'],
      tokensPerAssignment: 100,
      inputs: { 'lake.pairs': [{ name: 'pair_id', type: 'string', nullable: false }] },
      platform: {
        models: {
          review: {
            provider: 'openai',
            model: 'fake',
            api_key: '$FAKE_KEY',
            auth_env_vars: ['FAKE_KEY'],
          },
        },
      },
      prepare: async () => [{ pair_id: 'p1' }],
      sources: source,
      publish,
      executeAgent: async (request) => {
        if (request.assignment.mode !== 'agent_loop' || !request.sources) {
          throw new Error('Expected agent loop');
        }
        await request.sources({
          source: 'notion.documents',
          operation: 'search',
          arguments: { search: 'p1' },
        });
        return {
          contract_version: 2,
          attempt_id: request.assignment.attempt_id,
          status: 'succeeded',
          usage: { status: 'measured', input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          rows: [
            {
              pair_id: 'p1',
              assessment: 'spec',
              _dogsled_evidence: null,
              _dogsled_confidence: null,
              _dogsled_reason: null,
            },
          ],
        };
      },
    },
  });
  expect(result.ok).toBe(true);
  expect(source).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({ integration: 'lake' }),
    [expect.objectContaining({ pair_id: 'p1', assessment: 'spec' })],
    [{ pair_id: 'p1' }]
  );
});
