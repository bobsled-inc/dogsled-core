import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildProjectSkillReferenceCatalog,
  BobsledProjectSkillReferenceCatalog,
} from '../../../src/project-skills/reference-catalog.js';
import { discoverProjectModels } from '../../../src/runner/config/model-discovery.js';
import { openBobsledProject } from '../../../src/runner/config/project-files.js';
import { loadProjectPipelineConfig } from '../../../src/runner/config/project-resolver.js';
import type { BobsledConfig } from '../../../src/runner/config/schema.js';

describe('BobsledProjectSkillReferenceCatalog', () => {
  const catalog = new BobsledProjectSkillReferenceCatalog({
    model: ['orders'],
    resource: ['github/users', 'product/users', 'product/tickets'],
    action: ['github/create-issue'],
    pipeline: ['daily-sync'],
  });

  it.each([
    ['model', 'orders'],
    ['resource', 'product/tickets'],
    ['action', 'create-issue'],
    ['pipeline', 'daily-sync'],
  ] as const)('resolves a known %s reference', (kind, name) => {
    expect(catalog.resolve(kind, name).status).toBe('found');
  });

  it('rejects an unknown reference', () => {
    expect(catalog.resolve('model', 'missing')).toEqual({ status: 'not_found' });
  });

  it('reports an ambiguous bare reference with qualified candidates', () => {
    expect(catalog.resolve('resource', 'users')).toEqual({
      status: 'ambiguous',
      candidates: ['github/users', 'product/users'],
    });
  });
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DECLARED_PROJECT: Readonly<Record<string, string>> = {
  'settings/runtime.yml': `type: pipeline_config
platform:
  models:
    default:
      provider: openai
      model: synthetic-model
      api_key: $SYNTHETIC_MODEL_KEY
      auth_env_vars: [SYNTHETIC_MODEL_KEY]
`,
  'pipelines/extract.yml': `type: pipeline_config
destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  stripe:
    schedule: daily
    source: stripe
    destination: warehouse
    resources: [charges]
    embed:
      provider: openai
      model: text-embedding-3-small
      api_key: $SYNTHETIC_EMBED_KEY
      auth_env_vars: [SYNTHETIC_EMBED_KEY]
      streams:
        charges: [{ field: description }]
`,
  'pipelines/backfill.yml': `type: pipeline_config
pipelines:
  github-backfill:
    schedule: weekly
    source: github
    destination: warehouse
    resources: [issues]
`,
  'models/orders.yml': `spec_version: '0.2'
type: model
name: orders
source:
  ref: duckdb.raw_orders
`,
  'marts/customers.yml': `spec_version: '0.2'
type: model
name: customers
source:
  ref: duckdb.raw_customers
`,
};

function writeProject(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-reference-names-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content, 'utf8');
  }
  return root;
}

const EXAMPLES = fileURLToPath(new URL('../../../../../examples/', import.meta.url));

function fullLoaderNames(root: string): { model: string[]; pipeline: string[] } | undefined {
  const project = openBobsledProject(root);
  let config: BobsledConfig;
  try {
    config = loadProjectPipelineConfig({ projectRoot: project.root, index: project.index }).config;
  } catch {
    return undefined;
  }
  return {
    model: [...discoverProjectModels(config, project).keys()].sort(),
    pipeline: Object.keys(config.pipelines).sort(),
  };
}

describe('buildProjectSkillReferenceCatalog names', () => {
  const projects = readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('reads models and pipelines from every config fragment', async () => {
    const root = writeProject(DECLARED_PROJECT);
    const catalog = await buildProjectSkillReferenceCatalog(root);
    expect(catalog.names.model).toEqual(['customers', 'orders']);
    expect(catalog.names.pipeline).toEqual(['github-backfill', 'stripe']);
    expect(fullLoaderNames(root)).toEqual({
      model: catalog.names.model,
      pipeline: catalog.names.pipeline,
    });
  });

  it('matches the validated pipeline config names on every example Project', async () => {
    let compared = 0;
    for (const name of projects) {
      const root = path.join(EXAMPLES, name);
      const expected = fullLoaderNames(root);
      if (!expected) continue;
      const catalog = await buildProjectSkillReferenceCatalog(root);
      expect({ name, model: catalog.names.model, pipeline: catalog.names.pipeline }).toEqual({
        name,
        ...expected,
      });
      compared += 1;
    }
    expect(compared).toBeGreaterThanOrEqual(10);
  });
});
