import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadProjectPipelineConfig,
  resolveProjectPipelines,
  BobsledProjectValidationError,
  validateProjectPipelines,
} from '../../../../src/runner/config/project-resolver.js';

const roots: string[] = [];

function project(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-project-config-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function modelsPipeline(connection: string): string {
  return `type: models\nconnection: ${connection}\nschedule: daily\nmodels: '*'\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('loadProjectPipelineConfig', () => {
  it('merges root and nested fragments in path order and records owners', () => {
    const root = project({
      'bobsled.yml': `pipelines:\n  zeta:\n${modelsPipeline('warehouse')
        .split('\n')
        .filter(Boolean)
        .map((line) => `    ${line}`)
        .join('\n')}\n`,
      'golf/pipelines.yml': `type: pipeline_config\npipelines:\n  alpha:\n${modelsPipeline(
        'warehouse'
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => `    ${line}`)
        .join('\n')}\n`,
      'golf/datagolf/pga.yml': `type: pipeline_config\npipelines:\n  pga:\n${modelsPipeline(
        'warehouse'
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => `    ${line}`)
        .join('\n')}\n`,
    });

    const loaded = loadProjectPipelineConfig({ projectRoot: root });

    expect(Object.keys(loaded.config.pipelines)).toEqual(['zeta', 'pga', 'alpha']);
    expect(loaded.configPaths).toEqual([
      'bobsled.yml',
      'golf/datagolf/pga.yml',
      'golf/pipelines.yml',
    ]);
    expect([...loaded.pipelinePathByName]).toEqual([
      ['zeta', 'bobsled.yml'],
      ['pga', 'golf/datagolf/pga.yml'],
      ['alpha', 'golf/pipelines.yml'],
    ]);
  });

  it('returns an in-memory empty config when the project has no pipeline config', () => {
    const root = project({ 'models/orders.yml': 'type: model\nname: orders\n' });

    const loaded = loadProjectPipelineConfig({ projectRoot: root });

    expect(loaded.config.pipelines).toEqual({});
    expect(loaded.config.destinations).toEqual({});
    expect(loaded.configPaths).toEqual([]);
    expect(loaded.pipelinePathByName.size).toBe(0);
  });

  it('rejects duplicate pipeline names and identifies both fragments', () => {
    const pipeline = modelsPipeline('warehouse')
      .split('\n')
      .filter(Boolean)
      .map((line) => `    ${line}`)
      .join('\n');
    const root = project({
      'a.yml': `type: pipeline_config\npipelines:\n  shared:\n${pipeline}\n`,
      'b.yml': `type: pipeline_config\npipelines:\n  shared:\n${pipeline}\n`,
    });

    expect(() => loadProjectPipelineConfig({ projectRoot: root })).toThrow(
      'Duplicate pipeline "shared" is declared in both a.yml and b.yml.'
    );
    try {
      loadProjectPipelineConfig({ projectRoot: root });
      throw new Error('Expected duplicate pipeline rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BobsledProjectValidationError);
      expect((error as BobsledProjectValidationError).issues).toMatchObject([
        {
          filePath: 'a.yml',
          fieldPath: 'pipelines.shared',
          relatedFilePaths: ['b.yml'],
        },
      ]);
    }
  });

  it('rejects repeated top-level sections even when they match', () => {
    const root = project({
      'a.yml': 'type: pipeline_config\ndefaults:\n  timeout: 2h\n',
      'b.yml': 'type: pipeline_config\ndefaults:\n  timeout: 2h\n',
    });

    expect(() => loadProjectPipelineConfig({ projectRoot: root })).toThrow(
      'Pipeline config section "defaults" is declared in both a.yml and b.yml.'
    );
  });

  it('keeps explicit config mode limited to that file while using the caller root', () => {
    const root = project({
      'bobsled.yml': `pipelines:\n  legacy:\n${modelsPipeline('warehouse')
        .split('\n')
        .filter(Boolean)
        .map((line) => `    ${line}`)
        .join('\n')}\n`,
      'golf/bobsled.yml': `type: pipeline_config\npipelines:\n  selected:\n${modelsPipeline(
        'warehouse'
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => `    ${line}`)
        .join('\n')}\n`,
    });

    const loaded = loadProjectPipelineConfig({ projectRoot: root, configPath: 'golf/bobsled.yml' });

    expect(Object.keys(loaded.config.pipelines)).toEqual(['selected']);
    expect(loaded.configPaths).toEqual(['golf/bobsled.yml']);
  });

  it('reports validation errors at the owning nested fragment', async () => {
    const root = project({
      'golf/datagolf/pga/pipelines.yml': `type: pipeline_config\ndestinations:\n  local:\n    type: duckdb\n    db_path: ./warehouse.duckdb\npipelines:\n  pga_extract:\n    type: extract\n    source: missing_source\n    destination: local\n    schedule: manual\n    resources: [missing_resource]\n`,
    });

    await expect(resolveProjectPipelines({ projectRoot: root })).rejects.toThrow(
      'golf/datagolf/pga/pipelines.yml:pipelines.pga_extract.source:'
    );
  });
});

describe('validateProjectPipelines', () => {
  it('returns the resolved project and ownership maps on success', async () => {
    const root = project({
      'nested/config.yml': `type: pipeline_config\npipelines:\n  models:\n    ${modelsPipeline('warehouse').trim().replaceAll('\n', '\n    ')}\n`,
    });

    const result = await validateProjectPipelines({ projectRoot: root });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('Expected valid result');
    expect(result.project.configPaths).toEqual(['nested/config.yml']);
    expect(result.project.pipelinePathByName.get('models')).toBe('nested/config.yml');
    expect(result.warnings).toEqual(result.project.warnings);
  });

  it('returns structured duplicate ownership with both project relative file paths', async () => {
    const pipeline = modelsPipeline('warehouse').trim().replaceAll('\n', '\n    ');
    const root = project({
      'a.yml': `type: pipeline_config\npipelines:\n  shared:\n    ${pipeline}\n`,
      'b.yml': `type: pipeline_config\npipelines:\n  shared:\n    ${pipeline}\n`,
    });

    const result = await validateProjectPipelines({ projectRoot: root });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('Expected invalid result');
    expect(result.issues[0]).toMatchObject({
      fieldPath: 'pipelines.shared',
      filePath: 'a.yml',
      relatedFilePaths: ['b.yml'],
    });
    expect(result.issues[0]?.message).toContain('Duplicate pipeline "shared"');
  });

  it('reports malformed YAML positions without echoing source excerpts', async () => {
    const secretMarker = 'synthetic-secret-marker';
    const root = project({
      'nested/pipelines.yml': `type: pipeline_config\npipelines:\n  broken: [${secretMarker}\n`,
    });

    const result = await validateProjectPipelines({ projectRoot: root });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('Expected invalid result');
    expect(result.issues[0]).toMatchObject({ filePath: 'nested/pipelines.yml' });
    expect(result.issues[0]?.message).toContain('line');
    expect(JSON.stringify(result.issues)).not.toContain(secretMarker);

    const explicitResult = await validateProjectPipelines({
      projectRoot: root,
      configPath: 'nested/pipelines.yml',
    });
    expect(explicitResult.status).toBe('invalid');
    expect(JSON.stringify(explicitResult)).not.toContain(secretMarker);
  });

  it('returns missing explicit config paths as validation issues while the throwing API keeps exit code 2', async () => {
    const root = project({});

    const result = await validateProjectPipelines({
      projectRoot: root,
      configPath: 'nested/missing.yml',
    });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('Expected invalid result');
    expect(result.issues[0]).toMatchObject({ filePath: 'nested/missing.yml' });
    await expect(
      resolveProjectPipelines({ projectRoot: root, configPath: 'nested/missing.yml' })
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(() =>
      loadProjectPipelineConfig({ projectRoot: root, configPath: 'nested/missing.yml' })
    ).toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  it('returns explicit paths outside the Project as validation issues', async () => {
    const root = project({});

    const result = await validateProjectPipelines({
      projectRoot: root,
      configPath: '../outside.yml',
    });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('Expected invalid result');
    expect(result.issues[0]).toMatchObject({ filePath: '.' });
    await expect(
      resolveProjectPipelines({ projectRoot: root, configPath: '../outside.yml' })
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('returns an explicit config symlink escape as a validation issue', async () => {
    const root = project({});
    const outsideRoot = project({ 'outside.yml': 'pipelines: {}\n' });
    fs.symlinkSync(path.join(outsideRoot, 'outside.yml'), path.join(root, 'escape.yml'));

    const result = await validateProjectPipelines({ projectRoot: root, configPath: 'escape.yml' });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('Expected invalid result');
    expect(result.issues[0]).toMatchObject({ filePath: 'escape.yml' });
    await expect(
      resolveProjectPipelines({ projectRoot: root, configPath: 'escape.yml' })
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('returns duplicate section ownership with both project relative paths', async () => {
    const root = project({
      'a.yml': 'type: pipeline_config\ndefaults:\n  timeout: 2h\n',
      'b.yml': 'type: pipeline_config\ndefaults:\n  timeout: 2h\n',
    });

    const result = await validateProjectPipelines({ projectRoot: root });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('Expected invalid result');
    expect(result.issues[0]).toMatchObject({
      filePath: 'a.yml',
      fieldPath: 'defaults',
      relatedFilePaths: ['b.yml'],
    });
  });

  it('maps reference failures to the owning fragment and field path', async () => {
    const root = project({
      'golf/datagolf/pga/pipelines.yml': `type: pipeline_config\ndestinations:\n  local:\n    type: duckdb\n    db_path: ./warehouse.duckdb\npipelines:\n  pga_extract:\n    type: extract\n    source: missing_source\n    destination: local\n    schedule: manual\n    resources: [missing_resource]\n`,
    });

    const result = await validateProjectPipelines({ projectRoot: root });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('Expected invalid result');
    expect(result.issues[0]?.filePath).toBe('golf/datagolf/pga/pipelines.yml');
    expect(result.issues[0]?.fieldPath).toMatch(/^pipelines\.pga_extract/u);
    expect(result.issues[0]?.path).toBe(
      'golf/datagolf/pga/pipelines.yml:pipelines.pga_extract.source'
    );
    expect(result.issues[0]?.path).not.toContain(result.issues[0]?.message);
    await expect(resolveProjectPipelines({ projectRoot: root })).rejects.toThrow(
      `${result.issues[0]?.path}: ${result.issues[0]?.message}`
    );
  });

  it('keeps explicit config mode scoped to the selected file', async () => {
    const root = project({
      'bobsled.yml': `pipelines:\n  legacy:\n${modelsPipeline('warehouse')
        .split('\n')
        .filter(Boolean)
        .map((line) => `    ${line}`)
        .join('\n')}\n`,
      'golf/bobsled.yml': `type: pipeline_config\npipelines:\n  selected:\n${modelsPipeline(
        'warehouse'
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => `    ${line}`)
        .join('\n')}\n`,
    });

    const result = await validateProjectPipelines({
      projectRoot: root,
      configPath: 'golf/bobsled.yml',
    });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('Expected valid result');
    expect(Object.keys(result.project.config.pipelines)).toEqual(['selected']);
    expect(result.project.configPaths).toEqual(['golf/bobsled.yml']);
  });
});
