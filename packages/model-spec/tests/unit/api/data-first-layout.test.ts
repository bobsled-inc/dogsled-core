import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadProject, validateProject, type LoadedProject } from '../../../src/api/index.js';

const EXAMPLE_ROOT = fileURLToPath(
  new URL('../../../../../examples/multi-connection', import.meta.url)
);

/** Conventional path → data-first path. Warehouse folders hold everything they own. */
function dataFirstPath(relativePath: string): string {
  const warehouse = (prefix: string) => (prefix === 'bq' ? 'bigquery' : 'snowflake');
  const [folder, ...rest] = relativePath.split('/');
  const file = rest.join('/');
  const owner = /^(bq|sf)_/.exec(file)?.[1];
  switch (folder) {
    case 'integrations':
      return `${file.replace(/\.yml$/, '')}/connection.yml`;
    case 'sources':
      return `${rest[0]}/raw/${rest.slice(1).join('/')}`;
    case 'models':
      return `${warehouse(owner ?? '')}/transform/${file}`;
    case 'metrics':
    case 'relationships':
    case 'vqs':
      return `${warehouse(owner ?? '')}/semantic/${folder}-${file}`;
    case 'model-spec.yml':
      return 'shared/settings.yml';
    default:
      return relativePath;
  }
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function copyExample(layout: 'conventional' | 'data-first'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `model-spec-${layout}-`));
  roots.push(root);
  const walk = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!/\.ya?ml$/.test(entry.name)) continue;
      let content = fs.readFileSync(absolute, 'utf-8');
      let target = relative;
      if (layout === 'data-first') {
        target = dataFirstPath(relative);
        if (relative === 'model-spec.yml') content = `type: model_spec_config\n${content}`;
      }
      fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
      fs.writeFileSync(path.join(root, target), content);
    }
  };
  walk(EXAMPLE_ROOT, '');
  return root;
}

function summarize(project: LoadedProject) {
  return {
    config: {
      sourcesDir: project.config.sourcesDir,
      modelsDir: project.config.modelsDir,
      integrationsDir: project.config.integrationsDir,
    },
    integrations: [...project.integrations.entries()].map(([handle, integration]) => [
      handle,
      integration.dialect,
      integration.targetSchema,
    ]),
    sources: [...project.sources.entries()].sort(),
    sourceColumns: [...project.sourceColumns.entries()].sort(),
    models: project.models.map((node) => [node.name, node.refs, node.sourceRefs, node.integration]),
    metrics: [...project.entities.metrics.keys()].sort(),
    relationships: [...project.entities.relationships.keys()].sort(),
    vqs: [...project.entities.vqs.keys()].sort(),
  };
}

describe('data-first project layouts', () => {
  it('loads an untyped multi-model metric from a nested conventional folder', async () => {
    const root = copyExample('conventional');
    const metricPath = path.join(root, 'golf/datagolf/pga/metrics/order_conversion_rate.yml');
    fs.mkdirSync(path.dirname(metricPath), { recursive: true });
    fs.writeFileSync(
      metricPath,
      [
        "spec_version: '0.2'",
        'name: order_conversion_rate',
        'description: Orders divided by customer orders',
        'expression: SUM(total)',
        'models: [bq_fct_orders, sf_fct_orders]',
        '',
      ].join('\n')
    );

    const project = await loadProject(root);
    expect(project.entities.metrics.get('order_conversion_rate')).toMatchObject({
      name: 'order_conversion_rate',
      models: ['bq_fct_orders', 'sf_fct_orders'],
    });
  });

  it('loads the same project from conventional and data-first folders', async () => {
    const conventional = await loadProject(copyExample('conventional'));
    const dataFirst = await loadProject(copyExample('data-first'));

    expect(conventional.models.length).toBeGreaterThan(0);
    expect(conventional.entities.metrics.size).toBeGreaterThan(0);
    expect(summarize(dataFirst)).toEqual(summarize(conventional));
    expect(
      dataFirst.models.every((node) => /\/(bigquery|snowflake)\/transform\//.test(node.filePath))
    ).toBe(true);
  });

  it('validates both layouts identically', async () => {
    const conventionalRoot = copyExample('conventional');
    const dataFirstRoot = copyExample('data-first');
    const strip = (result: Awaited<ReturnType<typeof validateProject>>) =>
      JSON.parse(
        JSON.stringify(result)
          .replaceAll(conventionalRoot, '<root>')
          .replaceAll(dataFirstRoot, '<root>')
      );

    const conventional = await validateProject(conventionalRoot);
    const dataFirst = await validateProject(dataFirstRoot);

    expect(conventional.ok).toBe(true);
    expect(strip(dataFirst)).toEqual(strip(conventional));
  });

  it('names both files when two folders define the same model', async () => {
    const root = copyExample('data-first');
    fs.copyFileSync(
      path.join(root, 'bigquery/transform/bq_fct_orders.yml'),
      path.join(root, 'snowflake/transform/bq_fct_orders.yml')
    );
    await expect(loadProject(root)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(
          /Duplicate model name "bq_fct_orders" defined in:[\s\S]*bigquery\/transform\/bq_fct_orders\.yml[\s\S]*snowflake\/transform\/bq_fct_orders\.yml/
        ),
      }),
    });
  });

  it('rejects an unknown type in a Dogsled folder with its path before loading anything', async () => {
    const root = copyExample('data-first');
    fs.mkdirSync(path.join(root, 'metrics'));
    fs.writeFileSync(path.join(root, 'metrics/typo.yml'), 'type: metrc\nname: x\n');
    await expect(loadProject(root)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('metrics/typo.yml: Unknown type "metrc"'),
      }),
    });
  });

  it('rejects a malformed file that declares a Dogsled type wherever it lives', async () => {
    const root = copyExample('data-first');
    fs.writeFileSync(
      path.join(root, 'bigquery/semantic/broken.yml'),
      'spec_version: "0.2"\ntype: metric\nname: [\n'
    );
    await expect(loadProject(root)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('bigquery/semantic/broken.yml: Invalid YAML'),
      }),
    });
  });

  it('loads the project around files owned by other tools', async () => {
    const root = copyExample('data-first');
    const before = await loadProject(root);
    fs.mkdirSync(path.join(root, 'deploy/chart/templates'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'deploy/chart/Chart.yaml'),
      'apiVersion: v2\ntype: application\nname: api\n'
    );
    fs.writeFileSync(
      path.join(root, 'deploy/chart/templates/service.yaml'),
      'kind: Service\nspec:\n  {{- toYaml .Values.service | nindent 2 }}\n'
    );
    const after = await loadProject(root);
    expect(after.models.map((model) => model.name)).toEqual(
      before.models.map((model) => model.name)
    );
    expect([...after.sources.keys()]).toEqual([...before.sources.keys()]);
  });
});
